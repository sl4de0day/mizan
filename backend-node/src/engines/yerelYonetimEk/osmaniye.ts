import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  pdfMetinCikar, type YerelKararSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Osmaniye');

const OSMANIYE_BASE = 'https://osmaniye-bld.gov.tr';

const NEZAKET_MS = 180;
function bekle(): Promise<void> {
  return new Promise((r) => setTimeout(r, NEZAKET_MS));
}

function kararLinkleriniCikar(html: string): string[] {
  const $ = cheerio.load(html);
  const sonuc: string[] = [];
  const gorulen = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || !/\.pdf(\?|$)/i.test(href)) return;
    const metin = $(el).text().replace(/\s+/g, ' ').trim().toLocaleLowerCase('tr');
    if (!metin.startsWith('karar')) return;
    if (gorulen.has(href)) return;
    gorulen.add(href);
    sonuc.push(href);
  });
  return sonuc;
}

interface OsmaniyeKararSatiri { kararNo: string; tarih: string; startIndex: number; endIndex: number }

const KARAR_SATIR_RE = /(?<=^|\s)(\d(?:\s?\d){0,2})\s+(\d{2})\.(\d{2})\.(\d{4})\s*(?=\()/g;

const KARAR_VERILDI_RE = /karar\s*verild\s*i(?:ler)?\s*\.?/;

function kararSatirlariniBul(metin: string): OsmaniyeKararSatiri[] {
  const sonuc: OsmaniyeKararSatiri[] = [];
  let m: RegExpExecArray | null;
  KARAR_SATIR_RE.lastIndex = 0;
  while ((m = KARAR_SATIR_RE.exec(metin))) {
    sonuc.push({
      kararNo: m[1].replace(/\s+/g, ''),
      tarih: `${m[4]}-${m[3]}-${m[2]}`,
      startIndex: m.index,
      endIndex: m.index + m[0].length,
    });
  }
  return sonuc;
}

function kararlariAyristir(metin: string, kaynakUrl: string): YerelKararSonucu[] {
  const satirlar = kararSatirlariniBul(metin);
  const duz = metin.toLocaleLowerCase('tr');
  const sonuc: YerelKararSonucu[] = [];
  for (let i = 0; i < satirlar.length; i++) {
    const satir = satirlar[i];
    const sertSinir = i + 1 < satirlar.length ? satirlar[i + 1].startIndex : metin.length;
    const aramaBolgesi = duz.slice(satir.endIndex, sertSinir);
    const bitisM = KARAR_VERILDI_RE.exec(aramaBolgesi);
    const govdeSonu = bitisM ? satir.endIndex + bitisM.index + bitisM[0].length : sertSinir;
    const govde = metin.slice(satir.endIndex, govdeSonu).replace(/\s+/g, ' ').trim();
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    if (satir.tarih < BASLANGIC_TARIHI) continue;
    sonuc.push({
      belediye: 'Osmaniye', karar_no: satir.kararNo, tarih: satir.tarih, konu: null, metin: govde,
      oylama_sonucu: oylamaSonucuCikar(govde), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

const KARAR_BASLIK_RE = /Karar\s*Tarihi\s+(\d{2})\.(\d{2})\.(\d{4})\s+Karar\s*No\s+(\d(?:\s?\d){0,2})/g;
const KARAR_LABEL_RE = /karar\s*:/;

function formatBSatirlariniBul(metin: string): OsmaniyeKararSatiri[] {
  const sonuc: OsmaniyeKararSatiri[] = [];
  let m: RegExpExecArray | null;
  KARAR_BASLIK_RE.lastIndex = 0;
  while ((m = KARAR_BASLIK_RE.exec(metin))) {
    sonuc.push({
      kararNo: m[4].replace(/\s+/g, ''),
      tarih: `${m[3]}-${m[2]}-${m[1]}`,
      startIndex: m.index,
      endIndex: m.index + m[0].length,
    });
  }
  return sonuc;
}

function formatBAyristir(metin: string, kaynakUrl: string): YerelKararSonucu[] {
  const satirlar = formatBSatirlariniBul(metin);
  const duz = metin.toLocaleLowerCase('tr');
  const sonuc: YerelKararSonucu[] = [];
  for (let i = 0; i < satirlar.length; i++) {
    const satir = satirlar[i];
    const kayitSonu = i + 1 < satirlar.length ? satirlar[i + 1].startIndex : metin.length;
    const labelM = KARAR_LABEL_RE.exec(duz.slice(satir.endIndex, kayitSonu));
    const govdeBaslangic = labelM ? satir.endIndex + labelM.index + labelM[0].length : satir.endIndex;
    const bitisM = KARAR_VERILDI_RE.exec(duz.slice(govdeBaslangic, kayitSonu));
    const govdeSonu = bitisM ? govdeBaslangic + bitisM.index + bitisM[0].length : kayitSonu;
    const govde = metin.slice(govdeBaslangic, govdeSonu).replace(/\s+/g, ' ').trim();
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    if (satir.tarih < BASLANGIC_TARIHI) continue;
    sonuc.push({
      belediye: 'Osmaniye', karar_no: satir.kararNo, tarih: satir.tarih, konu: null, metin: govde,
      oylama_sonucu: oylamaSonucuCikar(govde), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

export async function fetchOsmaniyeKararlar(): Promise<YerelKararSonucu[]> {
  const baslangicYil = Number(BASLANGIC_TARIHI.slice(0, 4));
  const suankiYil = new Date().getUTCFullYear();

  const adayUrlSeti = new Set<string>();
  for (let yil = baslangicYil; yil <= suankiYil; yil++) {
    const sayfaUrl = `${OSMANIYE_BASE}/${yil}-meclis-gundem-ve-kararlari`;
    try {
      const res = await fetchWithBackoff(sayfaUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!res.ok) { logger.error(`[yerel-osmaniye] yıl sayfası (${yil}): HTTP ${res.status}`); continue; }
      for (const href of kararLinkleriniCikar(await res.text())) {
        adayUrlSeti.add(href.startsWith('http') ? href : `${OSMANIYE_BASE}${href}`);
      }
    } catch (e) {
      logger.error(`[yerel-osmaniye] yıl sayfası (${yil}): ${(e as Error).message}`);
    }
    await bekle();
  }

  const sonuc: YerelKararSonucu[] = [];
  const gorulenKarar = new Set<string>();
  for (const pdfUrl of adayUrlSeti) {
    if (!/\.pdf(\?|$)/i.test(pdfUrl)) {
      logger.warn(`[yerel-osmaniye] desteklenmeyen dosya uzantısı, atlanıyor: ${pdfUrl}`);
      continue;
    }
    try {
      const pres = await fetchWithBackoff(pdfUrl, { headers: HEADERS, timeoutMs: 45000 }, 3);
      if (!pres.ok) { logger.error(`[yerel-osmaniye] PDF indirilemedi (${pdfUrl}): HTTP ${pres.status}`); continue; }
      const metin = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
      if (metin.trim().length < ASGARI_KARAR_UZUNLUK) {
        logger.warn(`[yerel-osmaniye] PDF metni çok kısa/boş (muhtemelen taranmış görüntü ya da yanlışlıkla Gündem PDF'i), atlanıyor: ${pdfUrl}`);
        continue;
      }
      let kararlar = kararlariAyristir(metin, pdfUrl);
      if (kararlar.length === 0) kararlar = formatBAyristir(metin, pdfUrl);
      for (const k of kararlar) {
        const anahtar = `${k.karar_no}|${k.tarih}`;
        if (gorulenKarar.has(anahtar)) continue;
        gorulenKarar.add(anahtar);
        sonuc.push(k);
      }
    } catch (e) {
      logger.error(`[yerel-osmaniye] PDF (${pdfUrl}): ${(e as Error).message}`);
    }
    await bekle();
  }
  return sonuc;
}
