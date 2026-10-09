import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as cheerio from 'cheerio';
import {
  type YerelKararSonucu, type YerelUyeSonucu,
  BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar, HEADERS, fetchWithBackoff,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Erzurum');

const ERZURUM_BASE = 'https://erzurum.bel.tr';
const ERZURUM_LISTE_URL = `${ERZURUM_BASE}/meclis-karar-ozetleri`;
const ERZURUM_UYELER_URL = `${ERZURUM_BASE}/meclis-uyeleri`;

const SAYFA_BASLIGI_RE = /MECLİS KARAR ÖZETİ Sayfa No \d+/g;
const OTURUM_GECIS_RE = /(karar verildi\.)\s+[\s\S]{0,120}?Kâtip-Üye\s+Kâtip-Üye[\s\S]{0,4000}?(?:KARAR\s+ÖZETLERİ|$)/g;
const KARAR_BASLIK_RE = /(\d+)\s+(\d{2})\/(\d{2})\/(\d{4})\s+(\d+)\s+.{0,4000}?K\s*A\s*R\s*A\s*R\s*:/g;

interface ListeSatiri { tarih: string; pdfUrl: string }

function listeSayfasiniAyristir(html: string): ListeSatiri[] {
  const $ = cheerio.load(html);
  const sonuc: ListeSatiri[] = [];
  $('.custom-table .custom-table-row').each((_, el) => {
    const $row = $(el);
    const tarihHam = $row.find('.custom-table-cell[data-header="Tarih"]').text().trim();
    const [gg, aa, yyyy] = tarihHam.split('.');
    const tarih = gg && aa && yyyy ? `${yyyy}-${aa}-${gg}` : null;
    const href = $row.find('a[href]').attr('href');
    if (!tarih || !href || !/\.pdf$/i.test(href)) return;
    const pdfUrl = href.startsWith('http') ? href : `${ERZURUM_BASE}${href}`;
    sonuc.push({ tarih, pdfUrl });
  });
  return sonuc;
}

function metniTemizle(full: string): string {
  full = full.replace(SAYFA_BASLIGI_RE, ' ');
  full = full.replace(OTURUM_GECIS_RE, '$1');
  return full.replace(/\s+/g, ' ').trim();
}

async function tekPdfdenKararlar(pdfUrl: string): Promise<Omit<YerelKararSonucu, 'belediye'>[]> {
  const res = await fetchWithBackoff(pdfUrl, { headers: HEADERS, timeoutMs: 45000 }, 3);
  if (!res.ok) { logger.error(`[yerel-erzurum] PDF indirilemedi (${pdfUrl}): HTTP ${res.status}`); return []; }
  const data = new Uint8Array(await res.arrayBuffer());
  const doc = await getDocument({ data, verbosity: 0 }).promise;
  let ham = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await doc.getPage(p).then((pg) => pg.getTextContent());
    ham += (tc.items as { str: string }[]).map((i) => i.str).join(' ') + '\n';
  }
  const full = metniTemizle(ham);

  const eslesmeler: { idx: number; end: number; kararNo: string; tarih: string }[] = [];
  let m: RegExpExecArray | null;
  KARAR_BASLIK_RE.lastIndex = 0;
  while ((m = KARAR_BASLIK_RE.exec(full))) {
    eslesmeler.push({ idx: m.index, end: KARAR_BASLIK_RE.lastIndex, kararNo: m[5]!, tarih: `${m[4]}-${m[3]}-${m[2]}` });
  }

  const sonuc: Omit<YerelKararSonucu, 'belediye'>[] = [];
  for (let i = 0; i < eslesmeler.length; i++) {
    const e = eslesmeler[i]!;
    if (e.tarih < BASLANGIC_TARIHI) continue;
    const metin = full.slice(e.end, eslesmeler[i + 1]?.idx ?? full.length).trim();
    if (metin.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({ karar_no: e.kararNo, tarih: e.tarih, konu: null, metin, oylama_sonucu: oylamaSonucuCikar(metin), kaynak_url: pdfUrl });
  }
  return sonuc;
}

export async function fetchErzurumKararlar(): Promise<YerelKararSonucu[]> {
  const res = await fetchWithBackoff(ERZURUM_LISTE_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-erzurum] liste sayfası: HTTP ${res.status}`);
  const satirlar = listeSayfasiniAyristir(await res.text());
  const sonuc: YerelKararSonucu[] = [];
  for (const satir of satirlar) {
    if (satir.tarih < BASLANGIC_TARIHI) continue;
    try {
      const kararlar = await tekPdfdenKararlar(satir.pdfUrl);
      for (const k of kararlar) sonuc.push({ belediye: 'Erzurum', ...k });
    } catch (e) {
      logger.error(`[yerel-erzurum] toplantı PDF'i (${satir.tarih}, ${satir.pdfUrl}): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

export async function fetchErzurumUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(ERZURUM_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-erzurum-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('table[align="center"] tbody tr').each((_, el) => {
    const cells = $(el).find('td');
    if (cells.length < 4) return;
    const hamParti = $(cells[1]).text().replace(/\s+/g, ' ').trim();
    const ad = $(cells[2]).text().replace(/\s+/g, ' ').trim();
    const unvan = $(cells[3]).text().replace(/\s+/g, ' ').trim();
    if (!ad || !hamParti) return;
    const ilce = unvan === 'BÜYÜKŞEHİR BELEDİYE BAŞKANI' ? null : unvan.replace(/\s*\(BELEDİYE BAŞKANI\)\s*$/, '').trim() || null;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Erzurum', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce });
  });
  return sonuc;
}
