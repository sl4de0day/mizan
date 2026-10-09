import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  pdfMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Agri');

const AGRI_BASE = 'https://www.agri.bel.tr';
const AGRI_KARARLAR_URL = `${AGRI_BASE}/meclis-kararlari/`;
const AGRI_UYELER_URL = `${AGRI_BASE}/profiller/belediye-meclis-uyeleri/`;

const NEZAKET_MS = 180;
function bekle(): Promise<void> {
  return new Promise((r) => setTimeout(r, NEZAKET_MS));
}

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

interface AgriAday { href: string; baslik: string }

function adaylariCikar(html: string): AgriAday[] {
  const $ = cheerio.load(html);
  const sonuc: AgriAday[] = [];
  const gorulen = new Set<string>();
  $('.blog-home a[href*="/karar/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || gorulen.has(href)) return;
    const baslik = ($(el).find('h5').first().text() || $(el).text()).replace(/\s+/g, ' ').trim();
    gorulen.add(href);
    sonuc.push({ href, baslik });
  });
  return sonuc;
}

interface AgriDetay { pdfUrl: string | null; kararNo: string | null }

function detayCikar(html: string): AgriDetay {
  const $ = cheerio.load(html);
  let pdfUrl: string | null = null;
  $('table.table-bordered a[href$=".pdf"]').each((_, el) => {
    if (pdfUrl) return;
    const href = $(el).attr('href');
    if (href) pdfUrl = href.startsWith('http') ? href : `${AGRI_BASE}${href}`;
  });
  let kararNo: string | null = null;
  $('td').each((_, el) => {
    if (kararNo) return;
    const etiket = $(el).text().replace(/\s+/g, ' ').trim();
    if (/^Karar\s*No\s*:?$/i.test(etiket)) {
      const deger = $(el).next('td').text().replace(/\s+/g, ' ').trim();
      if (deger) kararNo = deger;
    }
  });
  return { pdfUrl, kararNo };
}

export async function fetchAgriKararlar(): Promise<YerelKararSonucu[]> {
  const listRes = await fetchWithBackoff(AGRI_KARARLAR_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!listRes.ok) throw new Error(`[yerel-agri] liste sayfası: HTTP ${listRes.status}`);
  const tumAdaylar = adaylariCikar(await listRes.text());

  if (tumAdaylar.length === 0) {
    logger.warn(
      '[yerel-agri] GERÇEK DUVAR: liste sayfası (www.agri.bel.tr/meclis-kararlari/) 0 kart döndürdü ' +
      '— sayfanın KENDİ sayfalama bileşeni "9 kayıt" iddia ediyor ama liste alanı boş; hem düz fetch ' +
      'hem Playwright JS-render ile doğrulandı (ikisi de aynı boş sonuç → sunucu taraflı arıza, ' +
      'istemci render sorunu değil). Wayback Machine 2025-12-11 anlık görüntüsü liste DOLUYDU, ' +
      '2026-04-11 anlık görüntüsü ZATEN bugünkü gibi boştu. Ayrıca belediye Mayıs 2024\'ten (id 10) ' +
      'beri yeni karar yayımlamamış görünüyor (id 11+ /hata/\'ya 302) ve BASLANGIC_TARIHI sonrasına ' +
      'düşen TEK aday PDF\'i %100 taranmış görüntü (metin katmanı yok, ölçüldü). bkz. dosya başı notu. ' +
      'Kararlar boş dönüyor.'
    );
    return [];
  }

  const adaylar = tumAdaylar
    .map((a) => ({ ...a, ayYil: ayYilCikar(a.baslik) }))
    .filter((a) => {
      if (!a.ayYil) { logger.error(`[yerel-agri] başlık ayrıştırılamadı, atlanıyor: "${a.baslik}"`); return false; }
      const tarih = `${a.ayYil.yil}-${String(a.ayYil.ay).padStart(2, '0')}-01`;
      return tarih >= BASLANGIC_TARIHI;
    });
  if (adaylar.length === 0) return [];

  let kanaryaGercek = false;
  for (const aday of adaylar.slice(0, 2)) {
    await bekle();
    try {
      const detayUrl = aday.href.startsWith('http') ? aday.href : `${AGRI_BASE}${aday.href}`;
      const dres = await fetchWithBackoff(detayUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!dres.ok) { logger.error(`[yerel-agri] kanarya detay (${aday.baslik}): HTTP ${dres.status}`); continue; }
      const { pdfUrl } = detayCikar(await dres.text());
      if (!pdfUrl) continue;
      const pres = await fetchWithBackoff(pdfUrl, { headers: HEADERS, timeoutMs: 45000 }, 2);
      if (!pres.ok) continue;
      const metin = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
      if (metin.trim().length >= ASGARI_KARAR_UZUNLUK) { kanaryaGercek = true; break; }
    } catch (e) {
      logger.error(`[yerel-agri] kanarya (${aday.baslik}): ${(e as Error).message}`);
    }
  }

  if (!kanaryaGercek) {
    logger.warn(`[yerel-agri] kanarya kontrolü GERÇEK DUVAR'ı doğruladı (PDF taranmış görüntü / eki yok) — ${adaylar.length} aday indirilmeden atlandı, kararlar boş dönüyor. bkz. dosya başı notu.`);
    return [];
  }

  const sonuc: YerelKararSonucu[] = [];
  for (const aday of adaylar) {
    await bekle();
    try {
      const detayUrl = aday.href.startsWith('http') ? aday.href : `${AGRI_BASE}${aday.href}`;
      const dres = await fetchWithBackoff(detayUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!dres.ok) { logger.error(`[yerel-agri] detay (${aday.baslik}): HTTP ${dres.status}`); continue; }
      const { pdfUrl, kararNo } = detayCikar(await dres.text());
      if (!pdfUrl) { logger.error(`[yerel-agri] (${aday.baslik}): PDF eki yok (muhtemelen gömülü JPG), atlanıyor`); continue; }
      const pres = await fetchWithBackoff(pdfUrl, { headers: HEADERS, timeoutMs: 45000 }, 3);
      if (!pres.ok) { logger.error(`[yerel-agri] PDF indirilemedi (${aday.baslik}): HTTP ${pres.status}`); continue; }
      const metin = (await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()))).trim();
      if (metin.length < ASGARI_KARAR_UZUNLUK) { logger.error(`[yerel-agri] (${aday.baslik}): metin katmanı yok/çok kısa, atlanıyor`); continue; }
      const tarih = `${aday.ayYil!.yil}-${String(aday.ayYil!.ay).padStart(2, '0')}-01`;
      sonuc.push({
        belediye: 'Ağrı', karar_no: kararNo, tarih, konu: null, metin,
        oylama_sonucu: oylamaSonucuCikar(metin), kaynak_url: pdfUrl,
      });
    } catch (e) {
      logger.error(`[yerel-agri] (${aday.baslik}): ${(e as Error).message}`);
    }
  }
  return sonuc;
}

function rolOnekiSil(hamParti: string): string {
  const duz = hamParti.toLocaleUpperCase('tr').trim();
  for (const onek of ['EŞ BAŞKAN', 'BAŞKAN VEKİLİ', 'BAŞKAN']) {
    if (duz.startsWith(onek)) return hamParti.slice(onek.length).trim();
  }
  return hamParti.trim();
}

export async function fetchAgriUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(AGRI_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-agri-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  const gorulen = new Set<string>();
  $('.col-lg-4.col-md-6.m-b-30').each((_, kart) => {
    const ham = $(kart).find('h5').first().text().replace(/\s+/g, ' ').trim();
    if (!ham) return;
    const numarasiz = ham.replace(/^\d{1,3}-\s*/, '');
    const m = numarasiz.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (!m) return;
    const ad = m[1].trim();
    const hamParti = rolOnekiSil(m[2].trim());
    if (!ad || !hamParti) return;
    const anahtar = `${ad}|${hamParti}`;
    if (gorulen.has(anahtar)) return;
    gorulen.add(anahtar);
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Ağrı', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
