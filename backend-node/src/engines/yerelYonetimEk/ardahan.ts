import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  pdfMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Ardahan');

const ARDAHAN_KARARLAR_URL = 'https://www.ardahan.bel.tr/meclis-kararlari';
const ARDAHAN_UYELER_URL = 'https://www.ardahan.bel.tr/meclis-uyeleri';

const AYLAR: Record<string, number> = {
  ocak: 1, şubat: 2, mart: 3, nisan: 4, mayıs: 5, haziran: 6,
  temmuz: 7, ağustos: 8, eylül: 9, ekim: 10, kasım: 11, aralık: 12,
};

function ayYilCikar(baslik: string): { yil: number; ay: number } | null {
  const duz = baslik.toLocaleLowerCase('tr');
  const yilM = duz.match(/(19|20)\d{2}/);
  if (!yilM) return null;
  const yil = Number(yilM[0]);
  for (const [ad, no] of Object.entries(AYLAR)) {
    if (duz.includes(ad)) return { yil, ay: no };
  }
  return null;
}

interface ArdahanSatir { href: string; baslik: string }

function satirlariCikar(html: string): ArdahanSatir[] {
  const $ = cheerio.load(html);
  const sonuc: ArdahanSatir[] = [];
  $('ul.download-list li').each((_, el) => {
    const href = $(el).find('a[href$=".pdf"]').attr('href');
    const baslik = $(el).find('h5').first().text().replace(/\s+/g, ' ').trim();
    if (!href) return;
    sonuc.push({ href, baslik });
  });
  return sonuc;
}

interface ArdahanKararEslesme { index: number; kararNo: string; tarih: string; konu: string }

const KARAR_RE = /(?:MECLİSİ\s+TEŞKİL\s+EDEN\s+ÜYELER\s+)?T\.C\.\s+ARDAHAN\s+BELEDİYESİ\s+MECLİS\s+KARARI\s+Karar\s+No\s+(\d+)\s+Karar\s+Tarihi\s+(\d{1,2}\.\d{1,2}\.\d{4})\s*:\s*:\s*Karar\s+Konusu\s+(.+?)\s*Birleşim\s+No\s+(\d+)\s*:\s*:\s*Oturum\s+No\s+(\d+)\s*:/g;

function kararlariAyristir(hamMetin: string, kaynakUrl: string): YerelKararSonucu[] {
  const duz = hamMetin.replace(/\s+/g, ' ').trim();
  const eslesmeler: ArdahanKararEslesme[] = [];
  const re = new RegExp(KARAR_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(duz))) {
    const [gg, aa, yyyy] = m[2].split('.');
    if (!gg || !aa || !yyyy) continue;
    const tarih = `${yyyy}-${aa.padStart(2, '0')}-${gg.padStart(2, '0')}`;
    eslesmeler.push({ index: m.index, kararNo: m[1], tarih, konu: m[3].trim() });
  }
  const sonuc: YerelKararSonucu[] = [];
  for (let i = 0; i < eslesmeler.length; i++) {
    const e = eslesmeler[i];
    if (e.tarih < BASLANGIC_TARIHI) continue;
    const govdeSonu = i + 1 < eslesmeler.length ? eslesmeler[i + 1].index : duz.length;
    const metin = duz.slice(e.index, govdeSonu).replace(/\s+/g, ' ').trim();
    if (metin.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({
      belediye: 'Ardahan', karar_no: e.kararNo, tarih: e.tarih, konu: e.konu || null,
      metin, oylama_sonucu: oylamaSonucuCikar(metin), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

export async function fetchArdahanKararlar(): Promise<YerelKararSonucu[]> {
  const listRes = await fetchWithBackoff(ARDAHAN_KARARLAR_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!listRes.ok) throw new Error(`[yerel-ardahan] liste sayfası: HTTP ${listRes.status}`);
  const tumSatirlar = satirlariCikar(await listRes.text());

  const baslangicYil = Number(BASLANGIC_TARIHI.slice(0, 4));
  const baslangicAy = Number(BASLANGIC_TARIHI.slice(5, 7));
  const satirlar = tumSatirlar.filter(({ baslik }) => {
    const ayYil = ayYilCikar(baslik);
    if (!ayYil) { logger.error(`[yerel-ardahan] başlık ayrıştırılamadı, atlanıyor: "${baslik}"`); return false; }
    return ayYil.yil > baslangicYil || (ayYil.yil === baslangicYil && ayYil.ay >= baslangicAy);
  });

  const sonuc: YerelKararSonucu[] = [];
  const gorulenKarar = new Set<string>();
  for (const { href, baslik } of satirlar) {
    const pdfUrl = href.startsWith('http') ? href : `https://www.ardahan.bel.tr/${href}`;
    try {
      const pres = await fetchWithBackoff(pdfUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!pres.ok) { logger.error(`[yerel-ardahan] PDF indirilemedi (${baslik}): HTTP ${pres.status}`); continue; }
      const hamMetin = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
      const kararlar = kararlariAyristir(hamMetin, pdfUrl);
      for (const k of kararlar) {
        const anahtar = `${k.karar_no}|${k.tarih}`;
        if (gorulenKarar.has(anahtar)) continue;
        gorulenKarar.add(anahtar);
        sonuc.push(k);
      }
    } catch (e) {
      logger.error(`[yerel-ardahan] (${baslik}): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

export async function fetchArdahanUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(ARDAHAN_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-ardahan-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.team-block-one').each((_, kart) => {
    const ad = $(kart).find('h4').first().text().replace(/\s+/g, ' ').trim();
    const hamParti = $(kart).find('p').first().text().replace(/\s+/g, ' ').trim();
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Ardahan', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
