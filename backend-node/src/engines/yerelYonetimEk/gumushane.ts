import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  kararNoSiraDoldur, type YerelKararSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Gumushane');

const GUMUSHANE_BASE = 'https://www.gumushane.bel.tr';
const GUMUSHANE_KARARLAR_URL = `${GUMUSHANE_BASE}/belediye-meclisi-kararlari/`;

const WAYBACK_TIMESTAMP = '20251211173651';
const WAYBACK_URL = `https://web.archive.org/web/${WAYBACK_TIMESTAMP}id_/${GUMUSHANE_KARARLAR_URL}`;

const AYLAR: Record<string, number> = {
  ocak: 1, şubat: 2, mart: 3, nisan: 4, mayıs: 5, haziran: 6,
  temmuz: 7, ağustos: 8, eylül: 9, ekim: 10, kasım: 11, aralık: 12,
};

function tarihCoz(ayYilMetni: string): string | null {
  const parcalar = ayYilMetni.toLocaleLowerCase('tr').split(/\s+/).filter(Boolean);
  if (parcalar.length !== 2) return null;
  const [ayAdi, yilStr] = parcalar;
  const ay = AYLAR[ayAdi];
  if (!ay || !/^\d{4}$/.test(yilStr)) return null;
  return `${yilStr}-${String(ay).padStart(2, '0')}-01`;
}

interface GumushaneSatir { tarih: string; metin: string }

function satirlariCikar(html: string): GumushaneSatir[] {
  const $ = cheerio.load(html);
  const sonuc: GumushaneSatir[] = [];
  $('table.table-hover tr').each((_, el) => {
    const tds = $(el).find('td');
    if (tds.length < 3) return;
    const tarih = $(tds[1]).text().replace(/\s+/g, ' ').trim();
    const metin = $(tds[2]).text().replace(/\s+/g, ' ').trim();
    if (!tarih || !metin) return;
    sonuc.push({ tarih, metin });
  });
  return sonuc;
}

export async function fetchGumushaneKararlar(): Promise<YerelKararSonucu[]> {
  let html: string | null = null;
  let kaynakUrl = GUMUSHANE_KARARLAR_URL;

  try {
    const canliRes = await fetchWithBackoff(GUMUSHANE_KARARLAR_URL, { headers: HEADERS, timeoutMs: 30000 });
    if (canliRes.ok) {
      html = await canliRes.text();
    } else {
      logger.error(`[yerel-gumushane] canlı site: HTTP ${canliRes.status} (Cloudflare engeli beklenen durum, bkz. dosya başı) — Wayback Machine yedeğine düşülüyor`);
    }
  } catch (e) {
    logger.error(`[yerel-gumushane] canlı site erişilemedi: ${(e as Error).message} — Wayback Machine yedeğine düşülüyor`);
  }

  if (!html) {
    await new Promise((r) => setTimeout(r, 180));
    const waybackRes = await fetchWithBackoff(WAYBACK_URL, { timeoutMs: 30000 }, 3);
    if (!waybackRes.ok) {
      throw new Error(`[yerel-gumushane] canlı site VE Wayback Machine yedeği başarısız: HTTP ${waybackRes.status}`);
    }
    html = await waybackRes.text();
    kaynakUrl = WAYBACK_URL;
  }

  const satirlar = satirlariCikar(html);
  const sonuc: YerelKararSonucu[] = [];
  const gorulen = new Set<string>();
  for (const { tarih: ayYilMetni, metin } of satirlar) {
    const tarih = tarihCoz(ayYilMetni);
    if (!tarih) {
      logger.error(`[yerel-gumushane] tarih ayrıştırılamadı, atlanıyor: "${ayYilMetni}"`);
      continue;
    }
    if (tarih < BASLANGIC_TARIHI) continue;
    if (metin.length < ASGARI_KARAR_UZUNLUK) continue;
    const anahtar = `${tarih}|${metin}`;
    if (gorulen.has(anahtar)) continue;
    gorulen.add(anahtar);
    sonuc.push({
      belediye: 'Gümüşhane', karar_no: null, tarih, konu: null, metin,
      oylama_sonucu: oylamaSonucuCikar(metin), kaynak_url: kaynakUrl,
    });
  }
  return kararNoSiraDoldur(sonuc);
}

