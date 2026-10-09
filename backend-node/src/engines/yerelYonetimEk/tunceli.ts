import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  pdfMetinCikar, kararNoSiraDoldur, type YerelKararSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Tunceli');

const TUNCELI_BASE = 'http://tunceli.bel.tr';
const TUNCELI_LISTE_URL = `${TUNCELI_BASE}/meclis-kararlari`;
const NEZAKET_MS = 180;
const SAYFA_LIMIT = 10;

const AY_SLUG: Record<string, string> = {
  ocak: '01', subat: '02', mart: '03', nisan: '04', mayis: '05', haziran: '06',
  temmuz: '07', agustos: '08', eylul: '09', ekim: '10', kasim: '11', aralik: '12',
};

function bekle(): Promise<void> {
  return new Promise((r) => setTimeout(r, NEZAKET_MS));
}

interface TunceliAyLink {
  url: string;
  ayIlkGunu: string;
}

function ayLinkleriniCikar(html: string): TunceliAyLink[] {
  const $ = cheerio.load(html);
  const sonuc: TunceliAyLink[] = [];
  $('.documents a[href^="karar/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const m = href.match(/^karar\/(\d{4})-([a-z]+)-ayi-meclis-kararlari/);
    if (!m) return;
    const ayNo = AY_SLUG[m[2]!];
    if (!ayNo) return;
    sonuc.push({ url: `${TUNCELI_BASE}/${href}`, ayIlkGunu: `${m[1]}-${ayNo}-01` });
  });
  return sonuc;
}

async function ayLinkleriTopla(): Promise<TunceliAyLink[]> {
  const sonuc: TunceliAyLink[] = [];
  const gorulenHref = new Set<string>();
  for (let sayfa = 1; sayfa <= SAYFA_LIMIT; sayfa++) {
    const url = sayfa === 1 ? TUNCELI_LISTE_URL : `${TUNCELI_LISTE_URL}/${sayfa}`;
    const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 30000 }, 3);
    if (!res.ok) throw new Error(`[yerel-tunceli] liste sayfası ${sayfa}: HTTP ${res.status}`);
    const linkler = ayLinkleriniCikar(await res.text());
    let yeniVarMi = false;
    for (const l of linkler) {
      if (gorulenHref.has(l.url)) continue;
      gorulenHref.add(l.url);
      sonuc.push(l);
      yeniVarMi = true;
    }
    if (!yeniVarMi) break;
    await bekle();
  }
  return sonuc;
}

function pdfLinkleriniCikar(html: string): string[] {
  const $ = cheerio.load(html);
  const sonuc: string[] = [];
  const gorulen = new Set<string>();
  $('a[href*="uploads/meclis_kararlari/dosya/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || gorulen.has(href)) return;
    gorulen.add(href);
    sonuc.push(href.startsWith('http') ? href : `${TUNCELI_BASE}/${href}`);
  });
  return sonuc;
}

interface TunceliKararBasligi { headerStart: number; headerEnd: number; kararNo: string; tarih: string | null }

const KARAR_BASLIK_RE = /KARAR\s*(?:NO|NUMARASI)\s*[:：]?\s*(\d+)(?:\s*KARAR\s*TARİHİ\s*[:：]?\s*(\d{1,2})[.\/](\d{1,2})[.\/](\d{4}))?/g;

function basliklariBul(metin: string): TunceliKararBasligi[] {
  const sonuc: TunceliKararBasligi[] = [];
  let m: RegExpExecArray | null;
  KARAR_BASLIK_RE.lastIndex = 0;
  while ((m = KARAR_BASLIK_RE.exec(metin))) {
    sonuc.push({
      headerStart: m.index, headerEnd: m.index + m[0].length, kararNo: m[1]!,
      tarih: m[2] ? `${m[4]}-${m[3]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}` : null,
    });
  }
  return sonuc;
}

function oylamaSonucuTunceliDuzelt(govde: string): 'oybirlik' | 'oycoklugu' | null {
  const dogrudan = oylamaSonucuCikar(govde);
  if (dogrudan) return dogrudan;
  const pencereRe = /[\s\S]{0,40}kabul edil/gi;
  let m: RegExpExecArray | null;
  while ((m = pencereRe.exec(govde))) {
    const sikistirilmis = m[0].replace(/\s+/g, '').toLocaleLowerCase('tr');
    if (sikistirilmis.includes('oybirliği')) return 'oybirlik';
    if (sikistirilmis.includes('oyçokluğu')) return 'oycoklugu';
  }
  return null;
}

function kararlariAyristir(metin: string, kaynakUrl: string, ayIlkGunu: string): YerelKararSonucu[] {
  const basliklar = basliklariBul(metin);
  const sonuc: YerelKararSonucu[] = [];
  for (let i = 0; i < basliklar.length; i++) {
    const b = basliklar[i]!;
    const tarih = b.tarih ?? ayIlkGunu;
    if (tarih < BASLANGIC_TARIHI) continue;
    const blokSonu = i + 1 < basliklar.length ? basliklar[i + 1]!.headerStart : metin.length;
    const govde = metin.slice(b.headerEnd, blokSonu).replace(/\s+/g, ' ').trim();
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({
      belediye: 'Tunceli', karar_no: b.kararNo, tarih, konu: null, metin: govde,
      oylama_sonucu: oylamaSonucuTunceliDuzelt(govde), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

export async function fetchTunceliKararlar(): Promise<YerelKararSonucu[]> {
  const ayLinkleri = await ayLinkleriTopla();
  const kapsamIci = ayLinkleri
    .filter((a) => a.ayIlkGunu >= BASLANGIC_TARIHI)
    .sort((a, b) => a.ayIlkGunu.localeCompare(b.ayIlkGunu));

  const sonuc: YerelKararSonucu[] = [];
  const gorulenKarar = new Set<string>();
  const gorulenPdfMetin = new Set<string>();

  for (const { url: ayUrl, ayIlkGunu } of kapsamIci) {
    let pdfLinkler: string[];
    try {
      const ayRes = await fetchWithBackoff(ayUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!ayRes.ok) { logger.error(`[yerel-tunceli] ay sayfası (${ayUrl}): HTTP ${ayRes.status}`); continue; }
      pdfLinkler = pdfLinkleriniCikar(await ayRes.text());
    } catch (e) {
      logger.error(`[yerel-tunceli] ay sayfası (${ayUrl}): ${(e as Error).message}`);
      continue;
    }
    await bekle();

    if (pdfLinkler.length === 0) continue;

    for (const pdfUrl of pdfLinkler) {
      try {
        const pres = await fetchWithBackoff(pdfUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
        if (!pres.ok) { logger.error(`[yerel-tunceli] PDF indirilemedi (${pdfUrl}): HTTP ${pres.status}`); continue; }
        const metin = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
        if (!metin || metin.trim().length < ASGARI_KARAR_UZUNLUK) {
          logger.error(`[yerel-tunceli] PDF neredeyse boş metin döndürdü, taranmış görüntü olabilir: ${pdfUrl}`);
          await bekle();
          continue;
        }
        if (gorulenPdfMetin.has(metin)) {
          logger.warn(`[yerel-tunceli] bu PDF'in metni daha önce işlenen başka bir ayın PDF'iyle birebir aynı — kaynağın kendi yükleme hatası olabilir (bkz. dosya başı Mart/Nisan notu), atlanıyor: ${pdfUrl}`);
          await bekle();
          continue;
        }
        gorulenPdfMetin.add(metin);
        for (const k of kararlariAyristir(metin, pdfUrl, ayIlkGunu)) {
          const anahtar = `${k.karar_no}|${k.tarih}`;
          if (gorulenKarar.has(anahtar)) continue;
          gorulenKarar.add(anahtar);
          sonuc.push(k);
        }
      } catch (e) {
        logger.error(`[yerel-tunceli] PDF (${pdfUrl}): ${(e as Error).message}`);
      }
      await bekle();
    }
  }
  return kararNoSiraDoldur(sonuc);
}

