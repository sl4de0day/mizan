import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar, kararNoSiraDoldur,
  pdfMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Bilecik');

const BILECIK_BASE = 'https://www.bilecik.bel.tr/';
const MECLIS_DETAY_AJAX_URL = `${BILECIK_BASE}MeclisDetayAjax`;
const BILECIK_UYELER_URL = `${BILECIK_BASE}BelediyeMeclisi`;

const NEZAKET_MS = 180;
function bekle(): Promise<void> {
  return new Promise((r) => setTimeout(r, NEZAKET_MS));
}

function ayYilAraligiUret(): { ay: number; yil: number }[] {
  const [baslangicYilStr, baslangicAyStr] = BASLANGIC_TARIHI.split('-');
  const baslangicYil = Number(baslangicYilStr);
  const baslangicAy = Number(baslangicAyStr);
  const simdi = new Date();
  const guncelYil = simdi.getFullYear();
  const guncelAy = simdi.getMonth() + 1;
  const sonuc: { ay: number; yil: number }[] = [];
  for (let yil = baslangicYil; yil <= guncelYil; yil++) {
    const ayBas = yil === baslangicYil ? baslangicAy : 1;
    const aySon = yil === guncelYil ? guncelAy : 12;
    for (let ay = ayBas; ay <= aySon; ay++) sonuc.push({ ay, yil });
  }
  return sonuc;
}

interface BilecikAday { url: string; tarih: string }

async function ayListesiGetir(ay: number, yil: number): Promise<BilecikAday[]> {
  const govde = new URLSearchParams({ ay: String(ay), yil: String(yil) });
  const res = await fetchWithBackoff(MECLIS_DETAY_AJAX_URL, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
    body: govde.toString(),
    timeoutMs: 30000,
  }, 3);
  if (!res.ok) { logger.error(`[yerel-bilecik] liste (${yil}-${ay}): HTTP ${res.status}`); return []; }
  const html = await res.text();
  if (!html.trim()) return [];
  const $ = cheerio.load(html);
  const tarih = `${yil}-${String(ay).padStart(2, '0')}-01`;
  const sonuc: BilecikAday[] = [];
  const gorulen = new Set<string>();
  $('a[href$=".pdf"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || gorulen.has(href)) return;
    gorulen.add(href);
    sonuc.push({ url: new URL(href, BILECIK_BASE).href, tarih });
  });
  return sonuc;
}

export async function fetchBilecikKararlar(): Promise<YerelKararSonucu[]> {
  const araliklar = ayYilAraligiUret();
  const adaylar: BilecikAday[] = [];
  const gorulenUrl = new Set<string>();
  for (const { ay, yil } of araliklar) {
    try {
      for (const a of await ayListesiGetir(ay, yil)) {
        if (gorulenUrl.has(a.url)) continue;
        gorulenUrl.add(a.url);
        adaylar.push(a);
      }
    } catch (e) {
      logger.error(`[yerel-bilecik] liste (${yil}-${ay}): ${(e as Error).message}`);
    }
    await bekle();
  }
  if (adaylar.length === 0) return [];

  let kanaryaGercek = false;
  for (const aday of adaylar.slice(0, 2)) {
    try {
      const pres = await fetchWithBackoff(aday.url, { headers: HEADERS, timeoutMs: 60000 }, 2);
      if (pres.ok) {
        const metin = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
        if (metin.trim().length >= ASGARI_KARAR_UZUNLUK) { kanaryaGercek = true; break; }
      } else {
        logger.error(`[yerel-bilecik] kanarya PDF (${aday.url}): HTTP ${pres.status}`);
      }
    } catch (e) {
      logger.error(`[yerel-bilecik] kanarya PDF (${aday.url}): ${(e as Error).message}`);
    }
    await bekle();
  }

  if (!kanaryaGercek) {
    logger.warn(`[yerel-bilecik] kanarya kontrolü GERÇEK DUVAR'ı doğruladı (aylık PDF'ler taranmış görüntü, metin katmanı yok — pdfjs/pdftotext ile ölçüldü, dosya başına birkaç karakter) — ${adaylar.length} aday PDF indirilmeden atlandı, kararlar boş dönüyor. bkz. dosya başı notu.`);
    return [];
  }

  const sonuc: YerelKararSonucu[] = [];
  for (const aday of adaylar) {
    await bekle();
    try {
      const pres = await fetchWithBackoff(aday.url, { headers: HEADERS, timeoutMs: 60000 }, 3);
      if (!pres.ok) { logger.error(`[yerel-bilecik] karar PDF (${aday.url}): HTTP ${pres.status}`); continue; }
      const metin = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
      if (metin.trim().length < ASGARI_KARAR_UZUNLUK) continue;
      sonuc.push({
        belediye: 'Bilecik', karar_no: null, tarih: aday.tarih, konu: null,
        metin: metin.trim(), oylama_sonucu: oylamaSonucuCikar(metin), kaynak_url: aday.url,
      });
    } catch (e) {
      logger.error(`[yerel-bilecik] karar PDF (${aday.url}): ${(e as Error).message}`);
    }
  }
  return kararNoSiraDoldur(sonuc);
}

export async function fetchBilecikUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(BILECIK_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-bilecik-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('h6.card-title').each((_, el) => {
    const ad = $(el).text().replace(/\s+/g, ' ').trim();
    const hamParti = $(el).siblings('.card-text').first().text().replace(/\s+/g, ' ').trim();
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Bilecik', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
