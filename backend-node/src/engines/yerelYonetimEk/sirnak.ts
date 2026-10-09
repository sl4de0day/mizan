import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  pdfMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Sirnak');

const SIRNAK_BASE = 'https://www.sirnak.bel.tr';
const KARARLAR_KATEGORI_SLUG = 'meclis-kararlari';
const UYELER_URL = `${SIRNAK_BASE}/belediye-meclisi/`;

const NEZAKET_MS = 180;
function bekle(): Promise<void> {
  return new Promise((r) => setTimeout(r, NEZAKET_MS));
}

async function kategoriIdGetir(slug: string): Promise<number> {
  const url = `${SIRNAK_BASE}/wp-json/wp/v2/categories?slug=${encodeURIComponent(slug)}`;
  const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 20000 }, 3);
  if (!res.ok) throw new Error(`[yerel-sirnak] kategori (${slug}): HTTP ${res.status}`);
  const j = (await res.json()) as { id: number }[];
  if (!j[0]) throw new Error(`[yerel-sirnak] kategori (${slug}): bulunamadı`);
  return j[0].id;
}

interface SirnakYazi { id: number; baslik: string; link: string; yil: number | null }

async function yazilariGetir(kategoriId: number): Promise<SirnakYazi[]> {
  const url = `${SIRNAK_BASE}/wp-json/wp/v2/posts?categories=${kategoriId}&per_page=100`;
  const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 20000 }, 3);
  if (!res.ok) throw new Error(`[yerel-sirnak] yazı listesi: HTTP ${res.status}`);
  const j = (await res.json()) as { id: number; link: string; title: { rendered: string } }[];
  return j.map((p) => {
    const baslik = p.title.rendered.replace(/&#8211;/g, '–').trim();
    const yilM = baslik.match(/\b(20\d{2})\b/);
    return { id: p.id, baslik, link: p.link, yil: yilM ? Number(yilM[1]) : null };
  });
}

function flipBookPdfUrlCikar(html: string): string | null {
  const m = html.match(/FB3D_CLIENT_LOCALE_ENCODED\s*=\s*\{"data":"([^"]+)"\}/);
  if (!m) return null;
  try {
    const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
    const j = JSON.parse(decoded) as { jsData?: { posts?: Record<string, { data?: { guid?: string } }> } };
    const postlar = j.jsData?.posts ?? {};
    for (const k of Object.keys(postlar)) {
      const guid = postlar[k]?.data?.guid;
      if (guid) return guid;
    }
    return null;
  } catch {
    return null;
  }
}

const AY_ADI_NO: Record<string, string> = {
  OCAK: '01', ŞUBAT: '02', MART: '03', NİSAN: '04', MAYIS: '05', HAZİRAN: '06',
  TEMMUZ: '07', AĞUSTOS: '08', EYLÜL: '09', EKİM: '10', KASIM: '11', ARALIK: '12',
};
const AY_ADLARI_DESEN = Object.keys(AY_ADI_NO).join('|');

interface AyBasligi { index: number; tarih: string }

function ayBasliklariniBul(metin: string): AyBasligi[] {
  const re = new RegExp(`(\\d{4})\\s*YILI\\s+(${AY_ADLARI_DESEN})\\s+AYI\\b`, 'g');
  const sonuc: AyBasligi[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(metin))) {
    const yil = m[1]!;
    const ayNo = AY_ADI_NO[m[2]!];
    if (!ayNo) continue;
    sonuc.push({ index: m.index, tarih: `${yil}-${ayNo}-01` });
  }
  return sonuc;
}

interface MaddeBasi { etiket: string; startIndex: number; endIndex: number }

function maddeBaslariniBul(metin: string): MaddeBasi[] {
  const re = /GÜNDEMİN\s*(\d{1,3})\.?\s*MADDESİ|GÜNDEM\s*DIŞI\s*\(\s*EK\s*MADDE\s*-?\s*(\d{1,3})\s*\)/g;
  const sonuc: MaddeBasi[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(metin))) {
    const etiket = m[1] ? `Gündem Maddesi ${m[1]}` : `Ek Madde ${m[2]}`;
    sonuc.push({ etiket, startIndex: m.index, endIndex: m.index + m[0].length });
  }
  return sonuc;
}

function kararlariAyristir(metin: string, kaynakUrl: string): YerelKararSonucu[] {
  const basliklar = ayBasliklariniBul(metin);
  const maddeler = maddeBaslariniBul(metin);
  const sonuc: YerelKararSonucu[] = [];
  for (let i = 0; i < maddeler.length; i++) {
    const madde = maddeler[i]!;
    const govdeSonu = i + 1 < maddeler.length ? maddeler[i + 1]!.startIndex : metin.length;
    const govde = metin.slice(madde.endIndex, govdeSonu).replace(/\s+/g, ' ').trim();
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    let tarih: string | null = null;
    for (const b of basliklar) {
      if (b.index <= madde.startIndex) tarih = b.tarih; else break;
    }
    if (!tarih || tarih < BASLANGIC_TARIHI) continue;
    sonuc.push({
      belediye: 'Şırnak', karar_no: madde.etiket, tarih, konu: null, metin: govde,
      oylama_sonucu: oylamaSonucuCikar(govde), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

export async function fetchSirnakKararlar(): Promise<YerelKararSonucu[]> {
  const esikYil = Number(BASLANGIC_TARIHI.slice(0, 4));
  let kategoriId: number;
  try {
    kategoriId = await kategoriIdGetir(KARARLAR_KATEGORI_SLUG);
  } catch (e) {
    logger.error(`[yerel-sirnak] kategori id çözülemedi: ${(e as Error).message}`);
    return [];
  }
  const tumYazilar = await yazilariGetir(kategoriId);
  const adaylar = tumYazilar.filter((y) => y.yil !== null && y.yil >= esikYil);

  const sonuc: YerelKararSonucu[] = [];
  const gorulenKarar = new Set<string>();
  for (const yazi of adaylar) {
    await bekle();
    try {
      const dres = await fetchWithBackoff(yazi.link, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!dres.ok) { logger.error(`[yerel-sirnak] yazı (${yazi.baslik}): HTTP ${dres.status}`); continue; }
      const html = await dres.text();
      const pdfUrl = flipBookPdfUrlCikar(html);
      if (!pdfUrl) {
        logger.warn(`[yerel-sirnak] yazı (${yazi.baslik}): PDF URL'si (3D FlipBook config) bulunamadı, atlanıyor`);
        continue;
      }
      await bekle();
      const pres = await fetchWithBackoff(pdfUrl, { headers: HEADERS, timeoutMs: 45000 }, 3);
      if (!pres.ok) { logger.error(`[yerel-sirnak] PDF (${yazi.baslik}): HTTP ${pres.status}`); continue; }
      const pdfBuf = new Uint8Array(await pres.arrayBuffer());
      const metin = await pdfMetinCikar(pdfBuf);
      if (metin.trim().length < ASGARI_KARAR_UZUNLUK) {
        logger.warn(`[yerel-sirnak] PDF (${yazi.baslik}): metin katmanı yok/çok kısa (${metin.trim().length} karakter, taranmış görüntü olabilir) — atlanıyor, OCR yapılmıyor`);
        continue;
      }
      const kararlar = kararlariAyristir(metin, pdfUrl);
      for (const k of kararlar) {
        const anahtar = `${k.karar_no}|${k.tarih}`;
        if (gorulenKarar.has(anahtar)) continue;
        gorulenKarar.add(anahtar);
        sonuc.push(k);
      }
    } catch (e) {
      logger.error(`[yerel-sirnak] (${yazi.baslik}): ${(e as Error).message}`);
    }
  }
  return sonuc;
}

export async function fetchSirnakUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-sirnak-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('table tr').each((_, tr) => {
    const hucreler = $(tr).find('td');
    if (hucreler.length < 3) return;
    const ad = hucreler.eq(1).text().replace(/\s+/g, ' ').trim();
    const hamParti = hucreler.eq(2).text().replace(/\s+/g, ' ').trim();
    if (!ad || !hamParti || /ADI SOYADI/i.test(ad)) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Şırnak', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
