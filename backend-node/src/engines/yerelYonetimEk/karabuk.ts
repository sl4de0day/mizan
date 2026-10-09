import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar, kararNoSiraDoldur,
  pdfMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Karabuk');

const KARABUK_BASE = 'https://www.karabuk.bel.tr';
const KARARLAR_URL = `${KARABUK_BASE}/meclis-kararlari.asp`;
const karararlarSayfaUrl = (shf: number) => `${KARABUK_BASE}/meclis-kararlari.asp?shf=${shf}`;
const UYELER_URL = `${KARABUK_BASE}/meclis-uyeleri.asp`;

const NEZAKET_MS = 180;
function bekle(): Promise<void> {
  return new Promise((r) => setTimeout(r, NEZAKET_MS));
}

function mutlakUrl(href: string): string {
  if (href.startsWith('http')) return href;
  return `${KARABUK_BASE}/${href.replace(/^\//, '')}`;
}

interface KarabukSatir { tarih: string; konu: string; pdfUrl: string }

function satirlariCikar(html: string): KarabukSatir[] {
  const $ = cheerio.load(html);
  const sonuc: KarabukSatir[] = [];
  $('table tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 4) return;
    const tarihHam = $(tds[0]).text().trim();
    const m = tarihHam.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!m) return;
    const tarih = `${m[3]}-${m[2]}-${m[1]}`;
    const konu = $(tds[1]).text().replace(/\s+/g, ' ').trim();
    const kararHref = $(tds[3]).find('a[href]').attr('href');
    const gundemHref = $(tds[2]).find('a[href]').attr('href');
    const href = kararHref || gundemHref;
    if (!href) return;
    sonuc.push({ tarih, konu, pdfUrl: mutlakUrl(href) });
  });
  return sonuc;
}

async function tumAdaylariTopla(): Promise<KarabukSatir[]> {
  const sonuc: KarabukSatir[] = [];
  const gorulenUrl = new Set<string>();
  for (let sayfa = 1; sayfa <= 40; sayfa++) {
    const url = sayfa === 1 ? KARARLAR_URL : karararlarSayfaUrl(sayfa);
    const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 30000 }, 3);
    if (!res.ok) throw new Error(`[yerel-karabuk] liste sayfası ${sayfa}: HTTP ${res.status}`);
    const satirlar = satirlariCikar(await res.text());
    if (!satirlar.length) break;

    let sayfadaGuncelVarMi = false;
    for (const satir of satirlar) {
      if (satir.tarih < BASLANGIC_TARIHI) continue;
      sayfadaGuncelVarMi = true;
      if (gorulenUrl.has(satir.pdfUrl)) continue;
      gorulenUrl.add(satir.pdfUrl);
      sonuc.push(satir);
    }
    if (!sayfadaGuncelVarMi) break;
    await bekle();
  }
  return sonuc;
}

export async function fetchKarabukKararlar(): Promise<YerelKararSonucu[]> {
  const adaylar = await tumAdaylariTopla();
  if (adaylar.length === 0) return [];

  let kanaryaGercek = false;
  for (const aday of adaylar.slice(0, 2)) {
    try {
      const pres = await fetchWithBackoff(aday.pdfUrl, { headers: HEADERS, timeoutMs: 45000 }, 2);
      if (pres.ok) {
        const metin = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
        if (metin.trim().length >= ASGARI_KARAR_UZUNLUK) { kanaryaGercek = true; break; }
      } else {
        logger.error(`[yerel-karabuk] kanarya PDF (${aday.pdfUrl}): HTTP ${pres.status}`);
      }
    } catch (e) {
      logger.error(`[yerel-karabuk] kanarya PDF (${aday.pdfUrl}): ${(e as Error).message}`);
    }
    await bekle();
  }

  if (!kanaryaGercek) {
    logger.warn(`[yerel-karabuk] kanarya kontrolü GERÇEK DUVAR'ı doğruladı (PDF'ler taranmış görüntü, metin katmanı yok) — ${adaylar.length} aday PDF indirilmeden atlandı, kararlar boş dönüyor. bkz. dosya başı notu.`);
    return [];
  }

  const sonuc: YerelKararSonucu[] = [];
  for (const aday of adaylar) {
    await bekle();
    try {
      const pres = await fetchWithBackoff(aday.pdfUrl, { headers: HEADERS, timeoutMs: 45000 }, 3);
      if (!pres.ok) { logger.error(`[yerel-karabuk] karar PDF (${aday.pdfUrl}): HTTP ${pres.status}`); continue; }
      const metin = (await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()))).replace(/\s+/g, ' ').trim();
      if (metin.length < ASGARI_KARAR_UZUNLUK) continue;
      sonuc.push({
        belediye: 'Karabük', karar_no: null, tarih: aday.tarih, konu: aday.konu || null,
        metin, oylama_sonucu: oylamaSonucuCikar(metin), kaynak_url: aday.pdfUrl,
      });
    } catch (e) {
      logger.error(`[yerel-karabuk] karar PDF (${aday.pdfUrl}): ${(e as Error).message}`);
    }
  }
  return kararNoSiraDoldur(sonuc);
}

interface KarabukPartiLink { url: string; hamParti: string }

function partiLinkleriCikar(html: string): KarabukPartiLink[] {
  const $ = cheerio.load(html);
  const sonuc: KarabukPartiLink[] = [];
  const gorulen = new Set<string>();
  $('a[href*="meclis-uyeleri.asp?m=2"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || gorulen.has(href)) return;
    gorulen.add(href);
    const metin = $(el).text().replace(/\s+/g, ' ').trim();
    const hamParti = metin.replace(/\s*Meclis\s*Üyeleri\s*Listesi.*$/i, '').trim();
    if (hamParti) sonuc.push({ url: mutlakUrl(href), hamParti });
  });
  return sonuc;
}

export async function fetchKarabukUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-karabuk-uye] HTTP ${res.status}`);
  const partiler = partiLinkleriCikar(await res.text());

  const sonuc: YerelUyeSonucu[] = [];
  for (const { url, hamParti } of partiler) {
    const kanonik = normParti(hamParti);
    const partiAdi = kanonik === 'Bilinmiyor' ? hamParti : kanonik;
    try {
      const pres = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!pres.ok) { logger.error(`[yerel-karabuk-uye] parti sayfası (${hamParti}): HTTP ${pres.status}`); await bekle(); continue; }
      const $ = cheerio.load(await pres.text());
      $('.layout_post_2 .item_content h4').each((_, el) => {
        const ad = $(el).text().replace(/\s+/g, ' ').trim();
        if (!ad) return;
        sonuc.push({ belediye: 'Karabük', ad_soyad: ad, parti: partiAdi, ilce: null });
      });
    } catch (e) {
      logger.error(`[yerel-karabuk-uye] parti sayfası (${hamParti}): ${(e as Error).message}`);
    }
    await bekle();
  }
  return sonuc;
}
