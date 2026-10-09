import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as cheerio from 'cheerio';
import {
  type YerelKararSonucu, type YerelUyeSonucu,
  BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar, HEADERS, fetchWithBackoff,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Kayseri');

const KAYSERI_BASE = 'https://www.kayseri.bel.tr';
const KAYSERI_LISTE_URL = `${KAYSERI_BASE}/karar-ozetleri`;
const KAYSERI_UYELER_URL = `${KAYSERI_BASE}/meclis-uyeleri`;

const AY_KISALTMA: Record<string, string> = {
  'Ocak': '01', 'Şubat': '02', 'Mart': '03', 'Nisan': '04', 'Mayıs': '05', 'Haziran': '06',
  'Temmuz': '07', 'Ağustos': '08', 'Eylül': '09', 'Ekim': '10', 'Kasım': '11', 'Aralık': '12',
};
function baslikTarihiCikar(baslik: string): string | null {
  const m = baslik.match(/^(\d{1,2})\s+(\S+)\s+(\d{4})\s+Tarihli/);
  if (!m) return null;
  const ay = AY_KISALTMA[m[2]];
  if (!ay) return null;
  return `${m[3]}-${ay}-${m[1].padStart(2, '0')}`;
}

interface ListeSatiri { baslik: string; detayHref: string; tarih: string | null }
function listeSayfasiniAyristir(html: string): ListeSatiri[] {
  const $ = cheerio.load(html);
  const sonuc: ListeSatiri[] = [];
  $("td[data-th='BAŞLIK']").each((_, el) => {
    const baslik = $(el).text().trim();
    const href = $(el).next("td[data-th='DETAY']").find('a[href]').attr('href');
    if (!baslik || !href) return;
    sonuc.push({ baslik, detayHref: href, tarih: baslikTarihiCikar(baslik) });
  });
  return sonuc;
}

const KARAR_SAYFA_RE = /(?:Karar|Rapor)\s*No\s+(?:(\d{4})\s*\/\s*)?(\d+)\s+Toplantı\s+(?:Tarihi\s+)?Konusu\s+(\d{2})\/(\d{2})\/(\d{4})\s+(.*?)\s*:\s*:\s*:\s*(.*)/s;

async function tekPdfdenKararlar(pdfUrl: string): Promise<Omit<YerelKararSonucu, 'belediye'>[]> {
  const res = await fetchWithBackoff(pdfUrl, { headers: HEADERS, timeoutMs: 45000 }, 3);
  if (!res.ok) { logger.error(`[yerel-kayseri] PDF indirilemedi (${pdfUrl}): HTTP ${res.status}`); return []; }
  const data = new Uint8Array(await res.arrayBuffer());
  const doc = await getDocument({ data, verbosity: 0 }).promise;
  const sonuc: Omit<YerelKararSonucu, 'belediye'>[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await doc.getPage(p).then((pg) => pg.getTextContent());
    const metinTam = (tc.items as { str: string }[]).map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
    if (!metinTam) continue;
    const m = metinTam.match(KARAR_SAYFA_RE);
    if (!m) continue;
    const [, yil, no, gg, aa, yyyy, konuHam, metinHam] = m;
    const tarih = `${yyyy}-${aa}-${gg}`;
    if (tarih < BASLANGIC_TARIHI) continue;
    const metin = metinHam.trim();
    if (metin.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({
      karar_no: yil ? `${yil}/${no}` : no,
      tarih,
      konu: konuHam.trim() || null,
      metin,
      oylama_sonucu: oylamaSonucuCikar(metin),
      kaynak_url: pdfUrl,
    });
  }
  return sonuc;
}

export async function fetchKayseriKararlar(): Promise<YerelKararSonucu[]> {
  const sonuc: YerelKararSonucu[] = [];
  for (let page = 1; page <= 40; page++) {
    const res = await fetchWithBackoff(`${KAYSERI_LISTE_URL}?page=${page}`, { headers: HEADERS, timeoutMs: 30000 }, 3);
    if (!res.ok) throw new Error(`[yerel-kayseri] liste sayfası ${page}: HTTP ${res.status}`);
    const satirlar = listeSayfasiniAyristir(await res.text());
    if (!satirlar.length) break;
    let sayfadaEski = false;
    for (const satir of satirlar) {
      if (!satir.tarih) { logger.error(`[yerel-kayseri] başlık tarihi parse edilemedi: "${satir.baslik}"`); continue; }
      if (satir.tarih < BASLANGIC_TARIHI) { sayfadaEski = true; continue; }
      const detayUrl = satir.detayHref.startsWith('http') ? satir.detayHref : `${KAYSERI_BASE}/${satir.detayHref}`;
      try {
        const dres = await fetchWithBackoff(detayUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
        if (!dres.ok) { logger.error(`[yerel-kayseri] detay sayfası (${satir.baslik}): HTTP ${dres.status}`); continue; }
        const $ = cheerio.load(await dres.text());
        const pdfHref = $('#contentHolder_pageContent a.file-pdf[href]').attr('href')
          ?? $('#contentHolder_pageContent a[href]').toArray()
            .map((el) => $(el).attr('href'))
            .find((h): h is string => !!h && /\.pdf$/i.test(h));
        if (!pdfHref) { logger.error(`[yerel-kayseri] PDF linki bulunamadı: ${detayUrl}`); continue; }
        const pdfUrl = pdfHref.startsWith('http') ? pdfHref : `${KAYSERI_BASE}${pdfHref}`;
        const kararlar = await tekPdfdenKararlar(pdfUrl);
        for (const k of kararlar) sonuc.push({ belediye: 'Kayseri', ...k });
      } catch (e) {
        logger.error(`[yerel-kayseri] toplantı (${satir.baslik}): ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 180));
    }
    if (sayfadaEski) break;
  }
  return sonuc;
}

export async function fetchKayseriUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(KAYSERI_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-kayseri-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  const tablo = $('table').toArray().find((el) =>
    $(el).find('thead th').toArray().some((th) => $(th).text().trim() === 'Partisi'));
  if (!tablo) throw new Error('[yerel-kayseri-uye] "Partisi" başlıklı tablo bulunamadı (site yapısı değişmiş olabilir)');
  $(tablo).find('tbody tr').each((_, el) => {
    const $row = $(el);
    const ad = $row.find('td[data-th="Ad / Soyad"]').text().replace(/\s+/g, ' ').trim();
    const unvan = $row.find('td[data-th="Unvanı"]').text().replace(/\s+/g, ' ').trim();
    const hamParti = $row.find('td[data-th="Partisi"]').text().replace(/\s+/g, ' ').trim();
    if (!ad || !hamParti) return;
    const ilceM = unvan.match(/^(.+?)\s+(?:Meclis\s+Üyesi|Belediye\s+Başkanı)/i);
    const ilce = ilceM && ilceM[1] !== 'Büyükşehir' ? ilceM[1] : null;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Kayseri', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce });
  });
  return sonuc;
}
