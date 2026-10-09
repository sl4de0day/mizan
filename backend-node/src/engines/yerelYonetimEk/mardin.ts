import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  docxMetinCikar, pdfMetinCikar, type YerelKararSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Mardin');

const MARDIN = 'Mardin' as unknown as Belediye;

const MARDIN_BASE = 'https://www.mardin.bel.tr';

const KARAR_SATIR_RE = /(\d{2})\.(\d{2})\.(\d{4})\s*-\s*(\d+)\s*:/g;

interface AyKararParcasi { tarih: string; kararNo: string; metin: string }

function kararlaraBol(duzMetin: string): AyKararParcasi[] {
  const eslesmeler = [...duzMetin.matchAll(KARAR_SATIR_RE)];
  const sonuc: AyKararParcasi[] = [];
  for (let i = 0; i < eslesmeler.length; i++) {
    const m = eslesmeler[i];
    const baslangic = (m.index ?? 0) + m[0].length;
    const bitis = i + 1 < eslesmeler.length ? eslesmeler[i + 1].index! : duzMetin.length;
    const metin = duzMetin.slice(baslangic, bitis).replace(/İLAN OLUNUR\.?\s*$/i, '').trim();
    const [, gg, aa, yyyy, kararNo] = m;
    sonuc.push({ tarih: `${yyyy}-${aa}-${gg}`, kararNo, metin });
  }
  return sonuc;
}

async function belgeMetniIndir(url: string): Promise<string | null> {
  const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) { logger.error(`[yerel-mardin] belge indirilemedi: HTTP ${res.status} — ${url}`); return null; }
  const buf = Buffer.from(await res.arrayBuffer());
  if (/\.pdf$/i.test(url)) {
    return (await pdfMetinCikar(new Uint8Array(buf))).replace(/\s+/g, ' ').trim();
  }
  const metin = docxMetinCikar(buf);
  return metin ? metin.replace(/\s+/g, ' ').trim() : null;
}

async function belgedenKararlarCikar(url: string): Promise<YerelKararSonucu[]> {
  let duz: string | null;
  try {
    duz = await belgeMetniIndir(url);
  } catch (e) {
    logger.error(`[yerel-mardin] belge hata: ${(e as Error).message} — ${url}`);
    return [];
  }
  if (!duz) return [];
  const sonuc: YerelKararSonucu[] = [];
  for (const { tarih, kararNo, metin } of kararlaraBol(duz)) {
    if (tarih < BASLANGIC_TARIHI) continue;
    if (metin.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({
      belediye: MARDIN, karar_no: kararNo, tarih, konu: null, metin,
      oylama_sonucu: oylamaSonucuCikar(metin), kaynak_url: url,
    });
  }
  return sonuc;
}

async function yilSayfasiBelgeleriniAl(yil: number): Promise<string[]> {
  const url = `${MARDIN_BASE}/${yil}-yili-meclis-kararlari`;
  const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) { logger.error(`[yerel-mardin] yıl sayfası ${yil}: HTTP ${res.status}`); return []; }
  const $ = cheerio.load(await res.text());
  const hrefler: string[] = [];
  $('.custom-table-row').each((_, row) => {
    const href = $(row).find('[data-header="Kaynak"] a[href]').attr('href');
    if (!href) return;
    hrefler.push(href.startsWith('http') ? href : `${MARDIN_BASE}${href}`);
  });
  return hrefler;
}

const MARDIN_2024_BELGELER: readonly string[] = [
  '/kurumlar/mardin.bel.tr/Yazi-Isleri/Meclis-Karar-Ozetleri/MeclisKararOzetleri2022/MeclisKararOzetleri2023/MeclisKararOzetleri2024/nisan2024kararzetleri.docx',
  '/kurumlar/mardin.bel.tr/Yazi-Isleri/Meclis-Karar-Ozetleri/MeclisKararOzetleri2022/MeclisKararOzetleri2023/MeclisKararOzetleri2024/mayis-2024-karar-ozetleri.docx',
  '/kurumlar/mardin.bel.tr/Yazi-Isleri/Meclis-Karar-Ozetleri/MeclisKararOzetleri2022/MeclisKararOzetleri2023/MeclisKararOzetleri2024/Haziran-2024-karar-ozetleri.docx',
  '/kurumlar/mardin.bel.tr/Yazi-Isleri/Meclis-Karar-Ozetleri/MeclisKararOzetleri2022/MeclisKararOzetleri2023/MeclisKararOzetleri2024/Temmuz-2024-karar-ozetleri.docx',
  '/kurumlar/mardin.bel.tr/Yazi-Isleri/Meclis-Karar-Ozetleri/MeclisKararOzetleri2022/MeclisKararOzetleri2023/MeclisKararOzetleri2024/Agustos-2024-karar-ozetleri.docx',
  '/kurumlar/mardin.bel.tr/Yazi-Isleri/Meclis-Karar-Ozetleri/MeclisKararOzetleri2022/MeclisKararOzetleri2023/MeclisKararOzetleri2024/Eylul-2024-karar-ozetleri.docx',
  '/kurumlar/mardin.bel.tr/Yazi-Isleri/Meclis-Karar-Ozetleri/MeclisKararOzetleri2022/MeclisKararOzetleri2023/MeclisKararOzetleri2024/Ekim-2024-karar-ozetleri.docx',
  '/kurumlar/mardin.bel.tr/Yazi-Isleri/Meclis-Karar-Ozetleri/MeclisKararOzetleri2022/MeclisKararOzetleri2023/MeclisKararOzetleri2024/KASIM-KARAR-OZETLERI.docx',
];

export async function fetchMardinKararlar(): Promise<YerelKararSonucu[]> {
  const sonuc: YerelKararSonucu[] = [];

  for (const goreliUrl of MARDIN_2024_BELGELER) {
    sonuc.push(...await belgedenKararlarCikar(`${MARDIN_BASE}${goreliUrl}`));
    await new Promise((r) => setTimeout(r, 180));
  }

  const baslangicYil = Math.max(2025, Number(BASLANGIC_TARIHI.slice(0, 4)));
  const suankiYil = new Date().getUTCFullYear();
  for (let yil = baslangicYil; yil <= suankiYil; yil++) {
    const belgeler = await yilSayfasiBelgeleriniAl(yil);
    for (const url of belgeler) {
      sonuc.push(...await belgedenKararlarCikar(url));
      await new Promise((r) => setTimeout(r, 180));
    }
  }

  return sonuc;
}
