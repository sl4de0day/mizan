import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  pdfMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Duzce');

const DUZCE_BASE = 'https://duzce.bel.tr';
const DUZCE_TOPLANTILAR_URL = `${DUZCE_BASE}/dizin/meclis-toplantilari`;
const DUZCE_UYELER_URL = `${DUZCE_BASE}/27-meclis-uyeleri`;

const NEZAKET_MS = 180;
function bekle(): Promise<void> {
  return new Promise((r) => setTimeout(r, NEZAKET_MS));
}

const HEADER_FOOTER_RE = /T\.C\.[\s\S]*?e-posta\s*:\s*yaziisl@duzce\.bel\.tr/g;

const MADDE_BASLIK_RE = /G\s*ü\s*n\s*d\s*e\s*m\s*i\s*n\s+\d(?:\s*\d)*\s*\.\s*M\s*a\s*d\s*d\s*e\s*s\s*i\s*\(\s*(\d(?:\s*\d)*)\s*\)\s*,?/g;

const SON_EK_RE = /\bBu\s+birle[şĢ]imde[\s\S]*$/;

const TARIH_RE = /ça[ğg]r[ıi]s[ıi]\s+[üu]zerine,?\s*(\d\s*\d)\s*[.\/]\s*(\d\s*\d)\s*[.\/]\s*(\d\s*\d\s*\d\s*\d)/;

interface YilSayfasi { yil: number; url: string }

async function yilSayfalariniBul(): Promise<YilSayfasi[]> {
  const res = await fetchWithBackoff(DUZCE_TOPLANTILAR_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-duzce] yıl-dizini: HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YilSayfasi[] = [];
  const gorulen = new Set<number>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const metin = $(el).text().replace(/\s+/g, ' ').trim();
    const m = metin.match(/^(\d{4})\s*Meclis\s*Toplant/i);
    if (!m) return;
    const yil = Number(m[1]);
    if (gorulen.has(yil)) return;
    gorulen.add(yil);
    const mutlakUrl = href.startsWith('http') ? href : `${DUZCE_BASE}${href.startsWith('/') ? '' : '/'}${href}`;
    sonuc.push({ yil, url: mutlakUrl });
  });
  return sonuc;
}

interface BirlesimLink { href: string; etiket: string }

function birlesimLinkleriniCikar(html: string): BirlesimLink[] {
  const $ = cheerio.load(html);
  const sonuc: BirlesimLink[] = [];
  $('a[href$=".pdf"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const etiket = $(el).text().replace(/\s+/g, ' ').trim();
    if (!href || !/birle[şs]im/i.test(etiket)) return;
    const mutlakUrl = href.startsWith('http') ? href : `${DUZCE_BASE}${href.startsWith('/') ? '' : '/'}${href}`;
    sonuc.push({ href: mutlakUrl, etiket });
  });
  return sonuc;
}

function kararlariAyristir(pdfMetin: string, tarih: string, kaynakUrl: string): YerelKararSonucu[] {
  const temiz = pdfMetin.replace(HEADER_FOOTER_RE, ' ').replace(/\s+/g, ' ').trim();
  const eslesmeler = [...temiz.matchAll(MADDE_BASLIK_RE)];
  const sonuc: YerelKararSonucu[] = [];
  const gorulenKararNo = new Map<string, number>();
  for (let i = 0; i < eslesmeler.length; i++) {
    const m = eslesmeler[i];
    const hamKararNo = (m[1] ?? '').replace(/\s+/g, '');
    if (!hamKararNo) continue;
    const basi = (m.index ?? 0) + m[0].length;
    const sonu = i + 1 < eslesmeler.length ? (eslesmeler[i + 1].index ?? temiz.length) : temiz.length;
    const govde = temiz.slice(basi, sonu).replace(SON_EK_RE, '').trim();
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    const tekrar = (gorulenKararNo.get(hamKararNo) ?? 0) + 1;
    gorulenKararNo.set(hamKararNo, tekrar);
    const kararNo = tekrar > 1 ? `${hamKararNo}-${tekrar}` : hamKararNo;
    const konuM = govde.match(/^([^;]{1,150}?);/);
    sonuc.push({
      belediye: 'Düzce', karar_no: kararNo, tarih,
      konu: konuM ? konuM[1].trim() : null,
      metin: govde, oylama_sonucu: oylamaSonucuCikar(govde), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

async function belgeIsle(link: BirlesimLink): Promise<YerelKararSonucu[]> {
  const pres = await fetchWithBackoff(link.href, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!pres.ok) { logger.error(`[yerel-duzce] PDF indirilemedi (${link.etiket}): HTTP ${pres.status} (${link.href})`); return []; }
  const metin = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
  const temizKisa = metin.replace(HEADER_FOOTER_RE, ' ').replace(/\s+/g, ' ').trim();
  const tarihM = temizKisa.match(TARIH_RE);
  if (!tarihM) {
    return [];
  }
  const gg = tarihM[1].replace(/\s+/g, '');
  const aa = tarihM[2].replace(/\s+/g, '');
  const yyyy = tarihM[3].replace(/\s+/g, '');
  const tarih = `${yyyy}-${aa}-${gg}`;
  if (tarih < BASLANGIC_TARIHI) return [];
  return kararlariAyristir(metin, tarih, link.href);
}

export async function fetchDuzceKararlar(): Promise<YerelKararSonucu[]> {
  const yilSayfalar = (await yilSayfalariniBul()).filter((y) => y.yil >= Number(BASLANGIC_TARIHI.slice(0, 4)));
  const sonuc: YerelKararSonucu[] = [];
  for (const { yil, url } of yilSayfalar) {
    let html: string;
    try {
      const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!res.ok) { logger.error(`[yerel-duzce] yıl sayfası ${yil}: HTTP ${res.status}`); continue; }
      html = await res.text();
    } catch (e) {
      logger.error(`[yerel-duzce] yıl sayfası ${yil}: ${(e as Error).message}`);
      continue;
    }
    const linkler = birlesimLinkleriniCikar(html);
    for (const link of linkler) {
      try {
        sonuc.push(...await belgeIsle(link));
      } catch (e) {
        logger.error(`[yerel-duzce] ${link.etiket} (${link.href}): ${(e as Error).message}`);
      }
      await bekle();
    }
  }
  return sonuc;
}

export async function fetchDuzceUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(DUZCE_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-duzce-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.membership-item').each((_, kart) => {
    const ad = $(kart).find('.membership-content h5').first().text().replace(/\s+/g, ' ').trim();
    const hamParti = $(kart).find('.membership-content h6').first().text().replace(/\s+/g, ' ').trim();
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Düzce', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
