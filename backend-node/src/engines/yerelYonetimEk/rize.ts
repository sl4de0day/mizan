import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  type YerelKararSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Rize');

const RIZE_KARARLAR_URL = 'https://www.rize.bel.tr/meclis-kararlari';

interface RizeSatir { tarih: string; kararNo: string; ozet: string }

function ddmmyyyyToIso(s: string): string | null {
  const m = s.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function satirlariAyristir(html: string): RizeSatir[] {
  const $ = cheerio.load(html);
  const sonuc: RizeSatir[] = [];
  $('#data-table tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 3) return;
    const tarih = ddmmyyyyToIso($(tds[0]).text());
    const kararNo = $(tds[1]).text().replace(/\s+/g, ' ').trim();
    const ozet = $(tds[2]).text().replace(/\s+/g, ' ').trim();
    if (!tarih) return;
    sonuc.push({ tarih, kararNo, ozet });
  });
  return sonuc;
}

export async function fetchRizeKararlar(): Promise<YerelKararSonucu[]> {
  const res = await fetchWithBackoff(RIZE_KARARLAR_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-rize] liste sayfası: HTTP ${res.status}`);
  const satirlar = satirlariAyristir(await res.text());
  if (satirlar.length === 0) {
    logger.error('[yerel-rize] 0 satır ayrıştırıldı — format değişmiş olabilir (#data-table bulunamadı)');
    return [];
  }

  const sonuc: YerelKararSonucu[] = [];
  for (const s of satirlar) {
    if (s.tarih < BASLANGIC_TARIHI) break;
    if (s.ozet.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({
      belediye: 'Rize', karar_no: s.kararNo || null, tarih: s.tarih, konu: null,
      metin: s.ozet, oylama_sonucu: oylamaSonucuCikar(s.ozet), kaynak_url: RIZE_KARARLAR_URL,
    });
  }
  return sonuc;
}

