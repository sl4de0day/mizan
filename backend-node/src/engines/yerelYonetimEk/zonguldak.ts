import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  docxMetinCikar, pdfMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Zonguldak');

const ZONGULDAK_BASE = 'https://www.zonguldak.bel.tr';
const ZONGULDAK_KARAR_KATEGORI = `${ZONGULDAK_BASE}/dokumanlar/kategori/6`;
const ZONGULDAK_GRUPLAR_API = 'https://zonguldak.bel.tr/api/meclis-gruplari';

const KARAR_BASLIK_RE =
  /ZONGULDAK\s+BELEDİYE\s+MECLİSİ\s+KARARI\s*KARAR\s+TARİHİ\s*:\s*(\d{2})\.(\d{2})\.(\d{4})\s*BİRLEŞİM\s*:\s*\S+\s*OTURUM\s*:\s*\S+\s*KARAR\s+SAYISI\s*:\s*(\d+)\s*KARAR\s+KONUSU\s*:/g;

interface ZonguldakDokumanSatiri { href: string; }

function dokumanSatirlariniCikar(html: string): ZonguldakDokumanSatiri[] {
  const $ = cheerio.load(html);
  const sonuc: ZonguldakDokumanSatiri[] = [];
  const gorulen = new Set<string>();
  $('a[href^="/dokumanlar/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href === '/dokumanlar' || href.includes('/kategori/') || gorulen.has(href)) return;
    gorulen.add(href);
    sonuc.push({ href });
  });
  return sonuc;
}

function detayBilgisiCikar($: cheerio.CheerioAPI): { tarih: string | null; belgeHref: string | null } {
  const h1 = $('h1').first().text().trim();
  const m = h1.match(/(\d{2})[./](\d{2})[./](\d{4})/);
  const tarih = m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  const belgeHref = $('a[href*="/uploads/"]').first().attr('href') ?? null;
  return { tarih, belgeHref };
}

function kararlaraBol(duzMetin: string, kaynakUrl: string): YerelKararSonucu[] {
  const eslesmeler = [...duzMetin.matchAll(KARAR_BASLIK_RE)];
  const sonuc: YerelKararSonucu[] = [];
  for (let i = 0; i < eslesmeler.length; i++) {
    const m = eslesmeler[i];
    const baslangic = (m.index ?? 0) + m[0].length;
    const bitis = i + 1 < eslesmeler.length ? eslesmeler[i + 1].index! : duzMetin.length;
    const govde = duzMetin.slice(baslangic, bitis).trim();
    const [, gg, aa, yyyy, kararNo] = m;
    const tarih = `${yyyy}-${aa}-${gg}`;
    if (tarih < BASLANGIC_TARIHI) continue;
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({
      belediye: 'Zonguldak', karar_no: kararNo, tarih, konu: null, metin: govde,
      oylama_sonucu: oylamaSonucuCikar(govde), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

async function belgeMetniIndir(url: string): Promise<string | null> {
  const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) { logger.error(`[yerel-zonguldak] belge indirilemedi: HTTP ${res.status} — ${url}`); return null; }
  const buf = Buffer.from(await res.arrayBuffer());
  if (/\.pdf$/i.test(url)) {
    return (await pdfMetinCikar(new Uint8Array(buf))).replace(/\s+/g, ' ').trim();
  }
  if (/\.docx$/i.test(url)) {
    const metin = docxMetinCikar(buf);
    return metin ? metin.replace(/\s+/g, ' ').trim() : null;
  }
  logger.error(`[yerel-zonguldak] desteklenmeyen belge formatı (muhtemelen eski .doc), atlanıyor: ${url}`);
  return null;
}

export async function fetchZonguldakKararlar(): Promise<YerelKararSonucu[]> {
  const listRes = await fetchWithBackoff(ZONGULDAK_KARAR_KATEGORI, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!listRes.ok) throw new Error(`[yerel-zonguldak] kategori sayfası: HTTP ${listRes.status}`);
  const satirlar = dokumanSatirlariniCikar(await listRes.text());

  const sonuc: YerelKararSonucu[] = [];
  for (const { href } of satirlar) {
    const detayUrl = href.startsWith('http') ? href : `${ZONGULDAK_BASE}${href}`;
    try {
      const dres = await fetchWithBackoff(detayUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!dres.ok) { logger.error(`[yerel-zonguldak] detay: HTTP ${dres.status} — ${detayUrl}`); continue; }
      const $ = cheerio.load(await dres.text());
      const { tarih, belgeHref } = detayBilgisiCikar($);
      if (tarih && tarih < BASLANGIC_TARIHI) break;
      if (!belgeHref) { logger.error(`[yerel-zonguldak] belge linki yok: ${detayUrl}`); continue; }
      const belgeUrl = belgeHref.startsWith('http') ? belgeHref : `${ZONGULDAK_BASE}${belgeHref}`;
      const duz = await belgeMetniIndir(belgeUrl);
      if (duz) {
        const kararlar = kararlaraBol(duz, belgeUrl);
        if (!kararlar.length) {
          logger.error(`[yerel-zonguldak] belge indirildi ama beklenen karar başlığı bulunamadı, atlanıyor: ${belgeUrl}`);
        }
        sonuc.push(...kararlar);
      }
    } catch (e) {
      logger.error(`[yerel-zonguldak] (${detayUrl}): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

interface ZonguldakUye { adSoyad: string }
interface ZonguldakGrup { ad: string; uyeler: ZonguldakUye[] }
interface ZonguldakGruplarYanit { success: boolean; data: ZonguldakGrup[] }

export async function fetchZonguldakUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(ZONGULDAK_GRUPLAR_API, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-zonguldak-uye] HTTP ${res.status}`);
  const j = await res.json() as ZonguldakGruplarYanit;
  const sonuc: YerelUyeSonucu[] = [];
  if (!j.success || !Array.isArray(j.data)) return sonuc;
  for (const grup of j.data) {
    if (!grup.ad) continue;
    const kanonik = normParti(grup.ad);
    const parti = kanonik === 'Bilinmiyor' ? grup.ad.trim() : kanonik;
    for (const uye of grup.uyeler ?? []) {
      const ad = uye.adSoyad?.trim();
      if (!ad) continue;
      sonuc.push({ belediye: 'Zonguldak', ad_soyad: ad, parti, ilce: null });
    }
  }
  return sonuc;
}
