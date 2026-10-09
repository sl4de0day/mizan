import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  pdfMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Bolu');

const BOLU_BASE = 'https://www.bolu.bel.tr';
const BOLU_WPJSON = `${BOLU_BASE}/wp-json/wp/v2`;
const BOLU_UYELER_URL = `${BOLU_BASE}/meclisuyeleri/`;

interface BoluPost {
  id: number;
  link: string;
  title: { rendered: string };
  content: { rendered: string };
}

async function tumMeclisPostlariniCek(): Promise<BoluPost[]> {
  const tumu: BoluPost[] = [];
  let sayfa = 1;
  for (;;) {
    const url = `${BOLU_WPJSON}/posts?search=Meclis&per_page=100&page=${sayfa}&_fields=id,link,title,content`;
    const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 30000 }, 3);
    if (res.status === 400) break;
    if (!res.ok) throw new Error(`[yerel-bolu] liste sayfa ${sayfa}: HTTP ${res.status}`);
    const veri = (await res.json()) as BoluPost[];
    tumu.push(...veri);
    if (veri.length < 100) break;
    sayfa++;
    await new Promise((r) => setTimeout(r, 180));
  }
  return tumu;
}

function pdfLinkCikar(html: string): string | null {
  const $ = cheerio.load(html);
  const href = $('a.download-link[href]').first().attr('href') ?? $('a[href*="/download/"]').first().attr('href');
  return href ?? null;
}

const AY_ADI: Record<string, string> = {
  'Ocak': '01', 'Şubat': '02', 'Mart': '03', 'Nisan': '04', 'Mayıs': '05', 'Haziran': '06',
  'Temmuz': '07', 'Ağustos': '08', 'Eylül': '09', 'Ekim': '10', 'Kasım': '11', 'Aralık': '12',
};
const AY_ADLARI_ALTERNATIF = Object.keys(AY_ADI).join('|');

function baslikTarihleriniBul(metin: string): { index: number; tarih: string }[] {
  const re = new RegExp(`(\\d(?:\\s*\\d)?)\\s+(${AY_ADLARI_ALTERNATIF})\\s+(\\d(?:\\s*\\d){3})\\s+\\S+\\s+günü`, 'g');
  const sonuc: { index: number; tarih: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(metin))) {
    const gun = m[1].replace(/\s+/g, '').padStart(2, '0');
    const yil = m[3].replace(/\s+/g, '');
    sonuc.push({ index: m.index, tarih: `${yil}-${AY_ADI[m[2]]}-${gun}` });
  }
  return sonuc;
}

interface BoluKararBlok { kararNo: string; startIndex: number; bodyStart: number }

function kararBloklariniBul(metin: string): BoluKararBlok[] {
  const re = /KARAR NO:\s*(\d+)/g;
  const sonuc: BoluKararBlok[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(metin))) {
    sonuc.push({ kararNo: m[1], startIndex: m.index, bodyStart: m.index + m[0].length });
  }
  return sonuc;
}

function kararlariAyristirGenel(metinHam: string, kaynakUrl: string): YerelKararSonucu[] {
  const metin = metinHam.replace(/\s+/g, ' ').trim();
  const basliklar = baslikTarihleriniBul(metin);
  const bloklar = kararBloklariniBul(metin);
  const sonuc: YerelKararSonucu[] = [];
  for (let i = 0; i < bloklar.length; i++) {
    const blok = bloklar[i];
    const govdeSonu = i + 1 < bloklar.length ? bloklar[i + 1].startIndex : metin.length;
    const govde = metin.slice(blok.bodyStart, govdeSonu).trim();
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    let tarih: string | null = null;
    for (const b of basliklar) { if (b.index <= blok.startIndex) tarih = b.tarih; else break; }
    if (!tarih) { logger.error(`[yerel-bolu] tarih bulunamadı (KARAR NO: ${blok.kararNo}, ${kaynakUrl}) — atlanıyor`); continue; }
    if (tarih < BASLANGIC_TARIHI) continue;
    sonuc.push({
      belediye: 'Bolu', karar_no: blok.kararNo, tarih, konu: null, metin: govde,
      oylama_sonucu: oylamaSonucuCikar(govde), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

export async function fetchBoluKararlar(): Promise<YerelKararSonucu[]> {
  const postlar = await tumMeclisPostlariniCek();
  const sonuc: YerelKararSonucu[] = [];
  const gorulen = new Set<string>();
  for (const post of postlar) {
    const duzMetin = cheerio.load(post.content.rendered).root().text().replace(/\s+/g, ' ').trim();
    let kararlar: YerelKararSonucu[];
    if (/KARAR NO:\s*\d+/.test(duzMetin)) {
      kararlar = kararlariAyristirGenel(duzMetin, post.link);
    } else if (post.title.rendered.toLocaleLowerCase('tr').includes('karar')) {
      const pdfHref = pdfLinkCikar(post.content.rendered);
      if (!pdfHref) continue;
      const pdfUrl = pdfHref.startsWith('http') ? pdfHref : `${BOLU_BASE}${pdfHref}`;
      try {
        const pres = await fetchWithBackoff(pdfUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
        if (!pres.ok) { logger.error(`[yerel-bolu] PDF indirilemedi (${post.title.rendered}): HTTP ${pres.status} (${pdfUrl})`); continue; }
        const pdfMetin = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
        if (pdfMetin.replace(/\s+/g, '').length < 200) {
          logger.error(`[yerel-bolu] PDF metni neredeyse boş (${post.title.rendered}, ${pdfUrl}) — taranmış görüntü olabilir, OCR yapılmıyor`);
          continue;
        }
        kararlar = kararlariAyristirGenel(pdfMetin, pdfUrl);
      } catch (e) {
        logger.error(`[yerel-bolu] (${post.title.rendered}): ${(e as Error).message}`);
        continue;
      } finally {
        await new Promise((r) => setTimeout(r, 180));
      }
    } else {
      continue;
    }
    for (const k of kararlar) {
      const anahtar = `${k.karar_no}|${k.tarih}`;
      if (gorulen.has(anahtar)) continue;
      gorulen.add(anahtar);
      sonuc.push(k);
    }
  }
  return sonuc;
}

function baslikCaseTr(s: string): string {
  return s.toLocaleLowerCase('tr').replace(/(^|[\s'-])(\p{L})/gu, (_tam, on: string, harf: string) => on + harf.toLocaleUpperCase('tr'));
}

export async function fetchBoluUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(BOLU_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-bolu-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.fg-item .fg-caption-desc').each((_, el) => {
    const ham = $(el).text().replace(/\s+/g, ' ').trim();
    const m = ham.match(/^(.*?)\s+MECLİS ÜYESİ\s+(.+)$/);
    if (!m) return;
    const hamParti = m[1].trim();
    const adHam = m[2].trim();
    if (!adHam || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Bolu', ad_soyad: baslikCaseTr(adHam), parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
