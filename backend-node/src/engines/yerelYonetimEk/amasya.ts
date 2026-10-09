import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  docxMetinCikar, type YerelKararSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Amasya');

const AMASYA_BASE = 'https://amasya.bel.tr';
const AMASYA_LISTE_URL = `${AMASYA_BASE}/meclis-kararlari`;

const AY_SLUG: Record<string, string> = {
  ocak: '01', subat: '02', mart: '03', nisan: '04', mayis: '05', haziran: '06',
  temmuz: '07', agustos: '08', eylul: '09', ekim: '10', kasim: '11', aralik: '12',
};

const HEADER_RE = /KARAR\s*TARİHİ\s*(\d{2})\.(\d{2})\.(\d{4})\s*KARAR\s*NO\s*(\d+)\s*KARAR\s*([\s\S]+)/;

function ayLinkleriniCikar(html: string): { url: string; etiket: string }[] {
  const $ = cheerio.load(html);
  const sonuc: { url: string; etiket: string }[] = [];
  const gorulen = new Set<string>();
  $('a[href*="/meclis-kararlari/"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const m = href.match(/\/meclis-kararlari\/(\d{4})-([a-z0-9]+)-ayi/);
    if (!m) return;
    const ayNo = AY_SLUG[m[2]];
    if (!ayNo) return;
    if (`${m[1]}-${ayNo}-01` < BASLANGIC_TARIHI) return;
    const full = href.startsWith('http') ? href : `${AMASYA_BASE}${href}`;
    if (gorulen.has(full)) return;
    gorulen.add(full);
    sonuc.push({ url: full, etiket: `${m[1]}-${m[2]}` });
  });
  return sonuc;
}

function docxLinkleriniCikar(html: string): string[] {
  const $ = cheerio.load(html);
  const sonuc: string[] = [];
  const gorulen = new Set<string>();
  $('a[href$=".docx"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || gorulen.has(href)) return;
    gorulen.add(href);
    sonuc.push(href.startsWith('http') ? href : `${AMASYA_BASE}${href}`);
  });
  $('a[href$=".pdf"], a[href$=".doc"], a[href$=".rar"], a[href$=".zip"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) logger.error(`[yerel-amasya] desteklenmeyen belge formatı, atlanıyor: ${href}`);
  });
  return sonuc;
}

export async function fetchAmasyaKararlar(): Promise<YerelKararSonucu[]> {
  const listRes = await fetchWithBackoff(AMASYA_LISTE_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!listRes.ok) throw new Error(`[yerel-amasya] liste sayfası: HTTP ${listRes.status}`);
  const aylar = ayLinkleriniCikar(await listRes.text());

  const sonuc: YerelKararSonucu[] = [];
  const gorulenKarar = new Set<string>();
  for (const { url: ayUrl, etiket } of aylar) {
    let docxLinkler: string[];
    try {
      const ayRes = await fetchWithBackoff(ayUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!ayRes.ok) { logger.error(`[yerel-amasya] ay sayfası (${etiket}): HTTP ${ayRes.status}`); continue; }
      docxLinkler = docxLinkleriniCikar(await ayRes.text());
    } catch (e) {
      logger.error(`[yerel-amasya] ay sayfası (${etiket}): ${(e as Error).message}`);
      continue;
    }
    await new Promise((r) => setTimeout(r, 180));

    for (const docxUrl of docxLinkler) {
      try {
        const dres = await fetchWithBackoff(docxUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
        if (!dres.ok) { logger.error(`[yerel-amasya] belge (${etiket}): HTTP ${dres.status} — ${docxUrl}`); continue; }
        const buf = Buffer.from(await dres.arrayBuffer());
        const metin = docxMetinCikar(buf);
        if (!metin || metin.trim().length < ASGARI_KARAR_UZUNLUK) {
          logger.error(`[yerel-amasya] belge neredeyse boş metin döndürdü, taranmış görüntü olabilir (${etiket}): ${metin?.length ?? 0} karakter — ${docxUrl}`);
          await new Promise((r) => setTimeout(r, 180));
          continue;
        }
        const m = metin.match(HEADER_RE);
        if (!m) {
          logger.error(`[yerel-amasya] beklenmeyen belge biçimi, KARAR TARİHİ/KARAR NO alanı bulunamadı (${etiket}): ${docxUrl}`);
          await new Promise((r) => setTimeout(r, 180));
          continue;
        }
        const tarih = `${m[3]}-${m[2]}-${m[1]}`;
        const kararNo = m[4];
        const govde = m[5].replace(/\s+/g, ' ').trim();
        if (tarih < BASLANGIC_TARIHI || govde.length < ASGARI_KARAR_UZUNLUK) {
          await new Promise((r) => setTimeout(r, 180));
          continue;
        }
        const anahtar = `${kararNo}|${tarih}`;
        if (!gorulenKarar.has(anahtar)) {
          gorulenKarar.add(anahtar);
          sonuc.push({
            belediye: 'Amasya', karar_no: kararNo, tarih, konu: null, metin: govde,
            oylama_sonucu: oylamaSonucuCikar(govde), kaynak_url: docxUrl,
          });
        }
      } catch (e) {
        logger.error(`[yerel-amasya] belge (${etiket}): ${(e as Error).message} — ${docxUrl}`);
      }
      await new Promise((r) => setTimeout(r, 180));
    }
  }
  return sonuc;
}

