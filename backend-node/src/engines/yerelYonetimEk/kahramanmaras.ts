import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  pdfMetinCikar, type YerelKararSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Kahramanmaras');

const KMARAS_BASE = 'https://kahramanmaras.bel.tr';
const KMARAS_LISTE_URL = `${KMARAS_BASE}/toplanti-ozetleri`;

const AY_KISALTMA: Record<string, string> = {
  'ocak': '01', 'şubat': '02', 'mart': '03', 'nisan': '04', 'mayıs': '05', 'haziran': '06',
  'temmuz': '07', 'ağustos': '08', 'eylül': '09', 'ekim': '10', 'kasım': '11', 'aralık': '12',
};

const SAYFA_BASLIK_RE = /T\.C\.\s*KAHRAMANMARAŞ\s*BÜYÜKŞEHİR\s*BELEDİYESİ\s*Büyükşehir\s*Belediye\s*Meclisi\s*\d+\s*\/\s*\d+/gi;

const TOPLANTI_TARIHI_RE = /Toplantı\s*Tarihi?\/Saati:?\s*(\d{1,2})\s+(\S+)\s+(\d{4})/i;

const KARAR_NO_RE = /Karar\s*No\s*[-:]?\s*(\d+)/g;

const KARAR_KAPANIS_RE = /karar\s+verilmiştir\.?\s*(\(ek[^)]*\))?/g;

interface ListeSatiri { tarihMetni: string; pdfHref: string }

function listeSayfasiniAyristir(html: string): ListeSatiri[] {
  const $ = cheerio.load(html);
  const sonuc: ListeSatiri[] = [];
  $('table tbody tr, table tr').each((_, el) => {
    const tds = $(el).find('td');
    if (tds.length < 3) return;
    const tarihMetni = $(tds[1]).text().replace(/\s+/g, ' ').trim();
    const pdfHref = $(el).find('a[href$=".pdf"]').first().attr('href');
    if (!tarihMetni || !pdfHref) return;
    sonuc.push({ tarihMetni, pdfHref: pdfHref.startsWith('http') ? pdfHref : `${KMARAS_BASE}${pdfHref}` });
  });
  return sonuc;
}

function listeTarihiCevir(t: string): string | null {
  const m = t.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

async function tekPdfdenKararlar(pdfUrl: string): Promise<Omit<YerelKararSonucu, 'belediye'>[]> {
  const res = await fetchWithBackoff(pdfUrl, { headers: HEADERS, timeoutMs: 45000 }, 3);
  if (!res.ok) { logger.error(`[yerel-kahramanmaras] PDF indirilemedi (${pdfUrl}): HTTP ${res.status}`); return []; }
  const metinHam = await pdfMetinCikar(new Uint8Array(await res.arrayBuffer()));
  const metinTemiz = metinHam.replace(SAYFA_BASLIK_RE, ' ').replace(/\s+/g, ' ').trim();

  const tarihM = metinTemiz.match(TOPLANTI_TARIHI_RE);
  if (!tarihM) { logger.error(`[yerel-kahramanmaras] toplantı tarihi başlığı bulunamadı: ${pdfUrl}`); return []; }
  const ay = AY_KISALTMA[tarihM[2].toLocaleLowerCase('tr')];
  if (!ay) { logger.error(`[yerel-kahramanmaras] ay adı tanınamadı ("${tarihM[2]}"): ${pdfUrl}`); return []; }
  const tarih = `${tarihM[3]}-${ay}-${tarihM[1].padStart(2, '0')}`;
  if (tarih < BASLANGIC_TARIHI) return [];

  const alinanM = metinTemiz.match(/ALINAN\s*KARARLAR/i);
  const govdeBaslangic = alinanM ? (alinanM.index ?? 0) + alinanM[0].length : 0;

  const duz = metinTemiz.toLocaleLowerCase('tr');

  const markerlar: { index: number; no: string }[] = [];
  let m: RegExpExecArray | null;
  KARAR_NO_RE.lastIndex = 0;
  while ((m = KARAR_NO_RE.exec(metinTemiz))) {
    if (m.index >= govdeBaslangic) markerlar.push({ index: m.index, no: m[1] });
  }

  const kapanislar: { start: number; end: number }[] = [];
  KARAR_KAPANIS_RE.lastIndex = 0;
  while ((m = KARAR_KAPANIS_RE.exec(duz))) {
    if (m.index >= govdeBaslangic) kapanislar.push({ start: m.index, end: m.index + m[0].length });
  }

  if (!markerlar.length || !kapanislar.length) {
    logger.error(`[yerel-kahramanmaras] karar sınırları bulunamadı (format değişmiş olabilir): ${pdfUrl}`);
    return [];
  }

  const parcalar: { start: number; end: number; ustNo: string }[] = [];
  let parcaBaslangic = govdeBaslangic;
  for (const kapanis of kapanislar) {
    let ustNo: string | null = null;
    for (const mk of markerlar) { if (mk.index <= kapanis.end) ustNo = mk.no; else break; }
    if (ustNo) parcalar.push({ start: parcaBaslangic, end: kapanis.end, ustNo });
    parcaBaslangic = kapanis.end;
  }

  const toplamSayac = new Map<string, number>();
  for (const p of parcalar) toplamSayac.set(p.ustNo, (toplamSayac.get(p.ustNo) ?? 0) + 1);
  const goruldu = new Map<string, number>();

  const sonuc: Omit<YerelKararSonucu, 'belediye'>[] = [];
  for (const p of parcalar) {
    const sira = (goruldu.get(p.ustNo) ?? 0) + 1;
    goruldu.set(p.ustNo, sira);
    const toplam = toplamSayac.get(p.ustNo)!;
    const kararNo = toplam > 1 ? `${p.ustNo}-${sira}` : p.ustNo;

    let metin = metinTemiz.slice(p.start, p.end);
    metin = metin.replace(/^\s*Karar\s*No\s*[-:]?\s*\d+\s*:?\s*/i, '');
    metin = metin.replace(/^\s*[a-z]\)\s*/i, '');
    metin = metin.replace(/^\s*\d+\.\d+\.?\s*/, '');
    metin = metin.replace(/\s+/g, ' ').trim();
    if (metin.length < ASGARI_KARAR_UZUNLUK) continue;

    sonuc.push({ karar_no: kararNo, tarih, konu: null, metin, oylama_sonucu: oylamaSonucuCikar(metin), kaynak_url: pdfUrl });
  }
  return sonuc;
}

export async function fetchKahramanmarasKararlar(): Promise<YerelKararSonucu[]> {
  const sonuc: YerelKararSonucu[] = [];
  const gorulenPdf = new Set<string>();
  for (let page = 0; page <= 6; page++) {
    const url = `${KMARAS_LISTE_URL}?field_date_value%5Bvalue%5D%5Byear%5D=&page=${page}`;
    const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 30000 }, 3);
    if (!res.ok) { if (page === 0) throw new Error(`[yerel-kahramanmaras] liste sayfası: HTTP ${res.status}`); break; }
    const satirlar = listeSayfasiniAyristir(await res.text());
    if (!satirlar.length) break;

    let sayfadaEski = false;
    for (const satir of satirlar) {
      if (gorulenPdf.has(satir.pdfHref)) continue;
      gorulenPdf.add(satir.pdfHref);
      const listeTarihi = listeTarihiCevir(satir.tarihMetni);
      if (listeTarihi && listeTarihi < BASLANGIC_TARIHI) sayfadaEski = true;
      try {
        const kararlar = await tekPdfdenKararlar(satir.pdfHref);
        for (const k of kararlar) sonuc.push({ belediye: 'Kahramanmaraş', ...k });
      } catch (e) {
        logger.error(`[yerel-kahramanmaras] PDF (${satir.pdfHref}): ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 180));
    }
    if (sayfadaEski) break;
  }
  return sonuc;
}
