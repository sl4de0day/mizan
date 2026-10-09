import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  pdfMetinCikar, type YerelKararSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Kars');

const KARS_BASE = 'https://kars.bel.tr';
const KARS_KARARLAR_URL = `${KARS_BASE}/meclis-kararlar`;

const AYLAR: Record<string, number> = {
  ocak: 1, şubat: 2, subat: 2, mart: 3, nisan: 4, mayıs: 5, mayis: 5, haziran: 6,
  temmuz: 7, ağustos: 8, agustos: 8, eylül: 9, eylul: 9, ekim: 10, kasım: 11, kasim: 11,
  aralık: 12, aralik: 12,
};

function ayYilCikar(baslik: string, dataHeader: string): { yil: number; ay: number | null } | null {
  const duz = `${dataHeader} ${baslik}`.toLocaleLowerCase('tr');
  const yilM = duz.match(/(19|20)\d{2}/);
  if (!yilM) return null;
  const yil = Number(yilM[0]);
  for (const [ad, no] of Object.entries(AYLAR)) {
    if (duz.includes(ad)) return { yil, ay: no };
  }
  return { yil, ay: null };
}

interface KarsSatir { href: string; baslik: string; dataHeader: string }

function satirlariCikar(html: string): KarsSatir[] {
  const $ = cheerio.load(html);
  const sonuc: KarsSatir[] = [];
  $('.custom-table-row').each((_, el) => {
    const hucre = $(el).find('.custom-table-cell.wide').first();
    const href = $(el).find('a[href$=".pdf"]').first().attr('href');
    const baslik = hucre.text().replace(/\s+/g, ' ').trim();
    const dataHeader = (hucre.attr('data-header') || '').replace(/\s+/g, ' ').trim();
    if (!href) return;
    sonuc.push({ href, baslik, dataHeader });
  });
  return sonuc;
}

function ozetTablosunuKes(metin: string): string {
  const idx = metin.search(/TOPLANTISINA\s+A[İI]T\s+KARAR\s+[ÖO]ZETLER/);
  if (idx === -1) return metin;
  const oncekiNokta = metin.lastIndexOf('.', idx);
  return oncekiNokta === -1 ? metin.slice(0, idx) : metin.slice(0, oncekiNokta + 1);
}

const KAPANIS_CUMLESI_RE = /gereği\s+için\s+alınan\s+bu\s+kararın\s+bir\s+suretinin/g;
function esasOylamaSonucu(metin: string): 'oybirlik' | 'oycoklugu' | null {
  const duz = metin.toLocaleLowerCase('tr');
  const eslesmeler = [...duz.matchAll(KAPANIS_CUMLESI_RE)];
  const esasKisim = eslesmeler.length > 0 ? metin.slice(0, eslesmeler[eslesmeler.length - 1].index) : metin;
  return oylamaSonucuCikar(esasKisim);
}

const KARAR_BASLIK_RE = /T\.C\.\s+KARS\s+BELEDİYE\s+BAŞKANLIĞI\s+MECLİS\s+KARARI\s+Toplantı\s+Dönemi\s+[\d\s/]+?\s+(?:(?:Olağanüstü\s+)?Toplantı\s+[\d\s]+?\s+Birleşim\s+[\d\s]+?\s+Oturum\s+[\d\s]+?\s+)?Karar\s+Tarihi\s+([\d\s]+?)\s*\.\s*([\d\s]+?)\s*\.\s*([\d\s]+?)\s+Karar\s+Numarası\s+([\d\s]+?)\s+Meclis\s+Başkan/g;

function kararlariAyristir(hamMetin: string, kaynakUrl: string): YerelKararSonucu[] {
  const duz = ozetTablosunuKes(hamMetin).replace(/\s+/g, ' ').trim();
  const re = new RegExp(KARAR_BASLIK_RE.source, 'g');
  interface Eslesme { index: number; endIndex: number; tarih: string; kararNo: string }
  const eslesmeler: Eslesme[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(duz))) {
    const gg = m[1].replace(/\s+/g, '').padStart(2, '0');
    const aa = m[2].replace(/\s+/g, '').padStart(2, '0');
    const yyyy = m[3].replace(/\s+/g, '');
    eslesmeler.push({
      index: m.index, endIndex: m.index + m[0].length,
      tarih: `${yyyy}-${aa}-${gg}`, kararNo: m[4].replace(/\s+/g, ''),
    });
  }
  const sonuc: YerelKararSonucu[] = [];
  for (let i = 0; i < eslesmeler.length; i++) {
    const e = eslesmeler[i];
    if (e.tarih < BASLANGIC_TARIHI) continue;
    const govdeSonu = i + 1 < eslesmeler.length ? eslesmeler[i + 1].index : duz.length;
    const metin = duz.slice(e.index, govdeSonu).replace(/\s+/g, ' ').trim();
    if (metin.length < ASGARI_KARAR_UZUNLUK) continue;
    const gövdeMetni = duz.slice(e.endIndex, govdeSonu);
    const konuM = gövdeMetni.match(/KONU\s*:\s*(.+?)\s*KARA\s?R\s*:/);
    const konu = konuM ? konuM[1].trim().replace(/,$/, '') : null;
    sonuc.push({
      belediye: 'Kars', karar_no: e.kararNo, tarih: e.tarih, konu: konu || null,
      metin, oylama_sonucu: esasOylamaSonucu(metin), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

export async function fetchKarsKararlar(): Promise<YerelKararSonucu[]> {
  const listRes = await fetchWithBackoff(KARS_KARARLAR_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!listRes.ok) throw new Error(`[yerel-kars] liste sayfası: HTTP ${listRes.status}`);
  const tumSatirlar = satirlariCikar(await listRes.text());

  const baslangicYil = Number(BASLANGIC_TARIHI.slice(0, 4));
  const baslangicAy = Number(BASLANGIC_TARIHI.slice(5, 7));
  const satirlar = tumSatirlar.filter(({ baslik, dataHeader }) => {
    const ayYil = ayYilCikar(baslik, dataHeader);
    if (!ayYil) { logger.error(`[yerel-kars] yıl ayrıştırılamadı, atlanıyor: "${baslik}" (${dataHeader})`); return false; }
    if (ayYil.yil > baslangicYil) return true;
    if (ayYil.yil < baslangicYil) return false;
    if (ayYil.ay === null) return true;
    return ayYil.ay >= baslangicAy;
  });

  const sonuc: YerelKararSonucu[] = [];
  const gorulenKarar = new Set<string>();
  for (const { href, baslik } of satirlar) {
    const pdfUrl = href.startsWith('http') ? href : `${KARS_BASE}${href}`;
    try {
      const pres = await fetchWithBackoff(pdfUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!pres.ok) { logger.error(`[yerel-kars] PDF indirilemedi (${baslik}): HTTP ${pres.status}`); continue; }
      const hamMetin = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
      if (hamMetin.trim().length < ASGARI_KARAR_UZUNLUK) {
        logger.error(`[yerel-kars] (${baslik}): metin katmanı yok/çok kısa (${hamMetin.trim().length} krk) — muhtemelen taranmış görüntü, OCR yapılmıyor, atlanıyor`);
        continue;
      }
      const kararlar = kararlariAyristir(hamMetin, pdfUrl);
      for (const k of kararlar) {
        const anahtar = `${k.karar_no}|${k.tarih}`;
        if (gorulenKarar.has(anahtar)) continue;
        gorulenKarar.add(anahtar);
        sonuc.push(k);
      }
    } catch (e) {
      logger.error(`[yerel-kars] (${baslik}): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}
