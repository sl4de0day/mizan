import { getJson as _getJson, proxyUrlForKaynak, type HttpOptions } from '../lib/http.js';
import { getLogger } from '../lib/logger.js';
import { normParti } from '../lib/partyResolve.js';

const logger = getLogger('PoliticalInsight.YSK');

const KAYNAK = 'ysk';
function getJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> { return _getJson<T>(url, { proxyUrl: proxyUrlForKaynak(KAYNAK), ...opts }); }

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0',
  Referer: 'https://sonuc.ysk.gov.tr/',
};

export interface YskSecimTanimi {
  donem: number;
  secimId: number;
  tarih: string;
  secimAdi: string;
  secimTuru: number;
}

export const YSK_MILLETVEKILI_SECIMLERI: YskSecimTanimi[] = [
  { donem: 25, secimId: 41754, tarih: '2015-06-07', secimAdi: '25.DÖNEM MİLLETVEKİLİ GENEL SEÇİMİ', secimTuru: 8 },
  { donem: 26, secimId: 44706, tarih: '2015-11-01', secimAdi: '26.DÖNEM MİLLETVEKİLİ GENEL SEÇİMİ', secimTuru: 8 },
  { donem: 27, secimId: 49002, tarih: '2018-06-24', secimAdi: 'CUMHURBAŞKANI VE 27.DÖNEM MİLLETVEKİLİ GENEL SEÇİMİ', secimTuru: 8 },
  { donem: 28, secimId: 60792, tarih: '2023-05-14', secimAdi: 'CUMHURBAŞKANI VE 28.DÖNEM MİLLETVEKİLİ GENEL SEÇİMİ', secimTuru: 8 },
];

interface BaslikItem { sira_NO: number; ad: string; column_NAME: string; }
type SandikSonucRow = Record<string, unknown>;
interface SecimSonucAggregate {
  secmen_SAYISI: number;
  oy_KULLANAN_SECMEN_SAYISI: number;
  gecerli_OY_TOPLAMI: number;
  gecersiz_OY_TOPLAMI: number;
}

export interface YskPartiSonucu { parti: string; oy: number; }
export interface YskSecimSonucuToplu {
  donem: number;
  secimId: number;
  tarih: string;
  secimAdi: string;
  secmenSayisi: number;
  katilanSecmenSayisi: number;
  gecerliOyToplami: number;
  gecersizOyToplami: number;
  katilmaOrani: number;
  partiler: YskPartiSonucu[];
}

export class YskEngine {
  private baseUrl = 'https://sonuc.ysk.gov.tr';

  private async getJsonYsk<T>(path: string): Promise<T> {
    return getJson<T>(`${this.baseUrl}${path}`, { headers: HEADERS, timeoutMs: 20000 });
  }

  async fetchSecimSonucu(tanim: YskSecimTanimi): Promise<YskSecimSonucuToplu> {
    const ortakParam =
      `secimId=${tanim.secimId}&secimTuru=${tanim.secimTuru}&ilId=&ilceId=&beldeId=&birimId=&muhtarlikId=&cezaeviId=` +
      `&sandikTuru=&sandikNoIlk=&sandikNoSon=&ulkeId=&disTemsilcilikId=&gumrukId=&yurtIciDisi=3` +
      `&sandikRumuzIlk=&sandikRumuzSon=&secimCevresiId=&sandikId=`;

    const [baslikListesi, sandikSatirlari, aggregateList] = await Promise.all([
      this.getJsonYsk<BaslikItem[]>(
        `/api/getSandikSecimSonucBaslikList?secimId=${tanim.secimId}&secimCevresiId=&ilId=&bagimsiz=1&secimTuru=${tanim.secimTuru}&yurtIciDisi=3`,
      ),
      this.getJsonYsk<SandikSonucRow[]>(`/api/getSecimSandikSonucList?${ortakParam}&sorguTuru=2`),
      this.getJsonYsk<SecimSonucAggregate[]>(`/api/getSecimSonucList?${ortakParam}`),
    ]);

    const agg = aggregateList[0];
    if (!agg) throw new Error(`[ysk d${tanim.donem}] getSecimSonucList boş döndü — secimId/secimTuru yanlış olabilir`);
    if (!sandikSatirlari.length) throw new Error(`[ysk d${tanim.donem}] getSecimSandikSonucList boş döndü`);

    const partiKolonlari = baslikListesi.filter(
      (b) => b.column_NAME.startsWith('parti') || b.column_NAME === 'bagimsiz_TOPLAM_OY',
    );

    const partiOylari = new Map<string, number>();
    for (const kolon of partiKolonlari) {
      const oy = sandikSatirlari.reduce((toplam, satir) => toplam + (Number(satir[kolon.column_NAME]) || 0), 0);
      if (oy <= 0) continue;
      const hamAd = kolon.ad === 'BAĞIMSIZ TOPLAM OY' ? 'BAĞIMSIZ' : kolon.ad;
      const kanonik = normParti(hamAd);
      const ad = kanonik === 'Bilinmiyor' ? hamAd.trim() : kanonik;
      partiOylari.set(ad, (partiOylari.get(ad) ?? 0) + oy);
    }

    const partiler: YskPartiSonucu[] = [...partiOylari.entries()]
      .map(([parti, oy]) => ({ parti, oy }))
      .sort((a, b) => b.oy - a.oy);

    logger.info(`[ysk d${tanim.donem}] ${partiler.length} parti/bağımsız satırı, ${sandikSatirlari.length} sandık-grubu satırı.`);

    return {
      donem: tanim.donem,
      secimId: tanim.secimId,
      tarih: tanim.tarih,
      secimAdi: tanim.secimAdi,
      secmenSayisi: agg.secmen_SAYISI,
      katilanSecmenSayisi: agg.oy_KULLANAN_SECMEN_SAYISI,
      gecerliOyToplami: agg.gecerli_OY_TOPLAMI,
      gecersizOyToplami: agg.gecersiz_OY_TOPLAMI,
      katilmaOrani: agg.secmen_SAYISI > 0 ? (agg.oy_KULLANAN_SECMEN_SAYISI / agg.secmen_SAYISI) * 100 : 0,
      partiler,
    };
  }
}

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fetchWithBackoff as _fetchWithBackoff } from '../lib/http.js';
function fetchWithBackoff(url: string, opts: HttpOptions = {}, retries?: number) { return _fetchWithBackoff(url, { proxyUrl: proxyUrlForKaynak(KAYNAK), ...opts }, retries); }

export const SANDALYE_PDF: Record<number, string> = {
  25: 'https://www.ysk.gov.tr/doc/dosyalar/docs/Milletvekili/7Haziran2015/KesinSecimSonuclari/ResmiGazete/E.pdf',
  26: 'https://www.ysk.gov.tr/doc/dosyalar/docs/Milletvekili/1Kasim2015/KesinSecimSonuclari/96-E.pdf',
  27: 'https://www.ysk.gov.tr/doc/dosyalar/docs/24Haziran2018/KesinSecimSonuclari/2018MV-96D.pdf',
  28: 'https://www.ysk.gov.tr/doc/dosyalar/docs/14Mayis2023/KesinSecimSonuclari/SIYASI_PARTILERIN_CIKARDIKLARI_MILLETVEKILI_VE_BAGIMSIZLARIN_SAYISI_MM25.pdf',
};

export interface YskSandalyeSonucu { parti: string; sandalye: number }

async function pdfSatirlariniCikar(data: Uint8Array): Promise<string[]> {
  const doc = await getDocument({ data, verbosity: 0 }).promise;
  const satirlar: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await doc.getPage(p).then((pg) => pg.getTextContent());
    const items = (tc.items as { str: string; transform: number[] }[]).filter((i) => i.str.trim());
    const gruplar: { y: number; parcalar: { x: number; t: string }[] }[] = [];
    for (const it of items) {
      const y = it.transform[5]!, x = it.transform[4]!;
      let g = gruplar.find((gr) => Math.abs(gr.y - y) < 2);
      if (!g) { g = { y, parcalar: [] }; gruplar.push(g); }
      g.parcalar.push({ x, t: it.str });
    }
    gruplar.sort((a, b) => b.y - a.y);
    for (const g of gruplar) {
      satirlar.push(g.parcalar.sort((a, b) => a.x - b.x).map((pc) => pc.t).join(' ').replace(/\s+/g, ' ').trim());
    }
  }
  return satirlar;
}

export async function fetchSandalyeSayisi(donem: number): Promise<YskSandalyeSonucu[]> {
  const url = SANDALYE_PDF[donem];
  if (!url) throw new Error(`[ysk-sandalye d${donem}] PDF URL tanımlı değil`);
  const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 30000 });
  if (!res.ok) throw new Error(`[ysk-sandalye d${donem}] HTTP ${res.status}`);
  const data = new Uint8Array(await res.arrayBuffer());
  const satirlar = await pdfSatirlariniCikar(data);

  const baslikIdx = satirlar.findIndex((s) => /SİYASİ PARTİLERİN ÇIKARDIKLARI MİLLETVEKİLİ/i.test(s));
  const toplamIdx = satirlar.findIndex((s) => /TÜRKİYE TOPLAMI/i.test(s));
  if (baslikIdx < 0 || toplamIdx < 0 || toplamIdx <= baslikIdx) {
    throw new Error(`[ysk-sandalye d${donem}] beklenen tablo başlığı/sonu bulunamadı — PDF sayfa yapısı değişmiş olabilir`);
  }

  const partiSandalye = new Map<string, number>();
  for (const satir of satirlar.slice(baslikIdx + 1, toplamIdx)) {
    const m = satir.match(/^([A-ZÇĞİÖŞÜ][A-ZÇĞİÖŞÜ\s]*?)\s+(\d+)$/);
    if (!m) continue;
    const hamAd = m[1] === 'BAĞIMSIZLAR' ? 'BAĞIMSIZ' : m[1]!.trim();
    const kanonik = normParti(hamAd);
    const ad = kanonik === 'Bilinmiyor' ? hamAd : kanonik;
    partiSandalye.set(ad, (partiSandalye.get(ad) ?? 0) + Number(m[2]));
  }

  const toplamM = satirlar[toplamIdx]!.match(/(\d+)\s*$/);
  const beyanEdilen = toplamM ? Number(toplamM[1]) : null;
  const hesaplanan = [...partiSandalye.values()].reduce((s, n) => s + n, 0);
  if (beyanEdilen == null || hesaplanan !== beyanEdilen) {
    throw new Error(`[ysk-sandalye d${donem}] doğrulama kapısı geçmedi: hesaplanan ${hesaplanan} ≠ PDF'in beyanı ${beyanEdilen}`);
  }
  logger.info(`[ysk-sandalye d${donem}] ${partiSandalye.size} parti/bağımsız, toplam ${hesaplanan} sandalye (PDF beyanıyla eşleşti).`);

  return [...partiSandalye.entries()].map(([parti, sandalye]) => ({ parti, sandalye }));
}

export const TARIHSEL_SECIM_PDF: Record<number, { url: string; tarih: string; secimAdi: string }> = {
  20: {
    url: 'https://www.ysk.gov.tr/doc/dosyalar/docs/1995MilletvekiliSecimi/1995_secim_sonuclari.pdf',
    tarih: '1995-12-24',
    secimAdi: '20. DÖNEM MİLLETVEKİLİ GENEL SEÇİMİ',
  },
};
const TARIHSEL_FARK_ESIGI = 0.05;

export interface YskTarihselSonuc {
  donem: number; tarih: string; secimAdi: string;
  secmenSayisi: number; oyKullananSayisi: number; gecerliOyToplami: number; gecersizOyToplami: number;
  katilmaOrani: number;
  partiler: YskPartiSonucu[];
}

interface TItem { x: number; t: string }
interface TRow { y: number; items: TItem[] }

async function tarihselSatirGruplariniCikar(data: Uint8Array): Promise<TRow[]> {
  const doc = await getDocument({ data, verbosity: 0 }).promise;
  const rows: TRow[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await doc.getPage(p).then((pg) => pg.getTextContent());
    const items = (tc.items as { str: string; transform: number[] }[]).filter((i) => i.str.trim());
    const groups: TRow[] = [];
    for (const it of items) {
      const y = it.transform[5]!, x = it.transform[4]!;
      let g = groups.find((gr) => Math.abs(gr.y - y) < 2);
      if (!g) { g = { y, items: [] }; groups.push(g); }
      g.items.push({ x, t: it.str.trim() });
    }
    groups.sort((a, b) => b.y - a.y);
    for (const g of groups) rows.push({ y: g.y, items: g.items.sort((a, b) => a.x - b.x) });
  }
  return rows;
}

function ilVeriSatiriMi(items: TItem[]): boolean {
  const sayilar = items.filter((i) => /^[\d.]+$/.test(i.t));
  return items.length > 3 && sayilar.length >= items.length - 2 && /^[A-ZÇĞİÖŞÜ]/.test(items[0]!.t) && !/İL ADI/i.test(items[0]!.t);
}

export async function fetchTarihselSecimSonucu(donem: number): Promise<YskTarihselSonuc> {
  const tanim = TARIHSEL_SECIM_PDF[donem];
  if (!tanim) throw new Error(`[ysk-tarihsel d${donem}] PDF tanımlı değil (bu dönem v1 kapsamında değil — bkz. dosya başı not)`);
  const res = await fetchWithBackoff(tanim.url, { headers: HEADERS, timeoutMs: 30000 });
  if (!res.ok) throw new Error(`[ysk-tarihsel d${donem}] HTTP ${res.status}`);
  const rows = await tarihselSatirGruplariniCikar(new Uint8Array(await res.arrayBuffer()));

  const ilAdiIdx = rows.findIndex((r) => r.items.some((it) => /İL ADI/i.test(it.t)));
  if (ilAdiIdx < 0) throw new Error(`[ysk-tarihsel d${donem}] "İL ADI" başlığı bulunamadı — PDF yapısı beklenenden farklı`);
  const ilkVeriIdx = rows.findIndex((r, i) => i > ilAdiIdx && ilVeriSatiriMi(r.items));
  if (ilkVeriIdx < 0) throw new Error(`[ysk-tarihsel d${donem}] ilk veri satırı bulunamadı`);
  const refCols = rows[ilkVeriIdx]!.items.map((i) => i.x);

  const ilAdiY = rows[ilAdiIdx]!.y;
  const BASLIK_Y_SINIRI = 20;
  const headerRows = rows.slice(0, ilkVeriIdx).filter((r) => r.y <= ilAdiY + BASLIK_Y_SINIRI);
  const colLabelParts: { y: number; t: string }[][] = refCols.map(() => []);
  for (const hr of headerRows) {
    for (const it of hr.items) {
      let bestIdx = -1, bestDist = Infinity;
      for (let i = 0; i < refCols.length; i++) {
        const d = Math.abs(refCols[i]! - it.x);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      if (bestDist < 20) colLabelParts[bestIdx]!.push({ y: hr.y, t: it.t });
    }
  }
  const headers = colLabelParts.map((arr) => arr.sort((a, b) => b.y - a.y).map((x) => x.t).join(' ').trim());

  const gecerliIdx = headers.findIndex((h) => /GEÇERLİ/i.test(h));
  const gecersizIdx = headers.findIndex((h) => /GEÇERSİZ/i.test(h));
  const oyKullananIdx = headers.findIndex((h) => /OY KULLANAN/i.test(h));
  const secmenIdx = headers.findIndex((h) => /^SEÇMEN SAYISI$/i.test(h));
  const partiBaslangicIdx = headers.findIndex((h, i) => i > 0 && h && !/SEÇMEN|OY KULLANAN|GEÇERLİ|GEÇERSİZ|İL/i.test(h));
  if (gecerliIdx < 0 || partiBaslangicIdx < 0) {
    throw new Error(`[ysk-tarihsel d${donem}] beklenen kolon başlıkları bulunamadı (GEÇERLİ/parti) — kolon eşleme başarısız`);
  }

  const num = (s: string | null | undefined) => Number(String(s ?? '0').replace(/\./g, '')) || 0;
  const partiToplam = new Map<string, number>();
  let secmenToplam = 0, oyKullananToplam = 0, gecerliToplam = 0, gecersizToplam = 0;
  const ilAdlari = new Set<string>();
  let ilSatirSayisi = 0;

  for (const r of rows) {
    if (!ilVeriSatiriMi(r.items)) continue;
    const cellByCol = new Array<string | null>(refCols.length).fill(null);
    for (const it of r.items) {
      let bestIdx = -1, bestDist = Infinity;
      for (let i = 0; i < refCols.length; i++) {
        const d = Math.abs(refCols[i]! - it.x);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      if (bestDist < 15) cellByCol[bestIdx] = it.t;
    }
    ilAdlari.add(r.items[0]!.t);
    ilSatirSayisi++;
    secmenToplam += num(cellByCol[secmenIdx]);
    oyKullananToplam += num(cellByCol[oyKullananIdx]);
    gecerliToplam += num(cellByCol[gecerliIdx]);
    gecersizToplam += num(cellByCol[gecersizIdx]);
    for (let i = partiBaslangicIdx; i < refCols.length; i++) {
      const parti = headers[i];
      if (!parti) continue;
      partiToplam.set(parti, (partiToplam.get(parti) ?? 0) + num(cellByCol[i]));
    }
  }

  if (ilSatirSayisi > ilAdlari.size * 1.3) {
    throw new Error(`[ysk-tarihsel d${donem}] beklenmeyen satır tekrarı (${ilSatirSayisi} satır, ${ilAdlari.size} benzersiz il) — bu dönem çok-panelli formatta olabilir, v1 desteklemiyor`);
  }

  const partiler = [...partiToplam.entries()]
    .map(([hamAd, oy]) => ({ parti: normParti(hamAd) === 'Bilinmiyor' ? hamAd : normParti(hamAd), oy }))
    .filter((p) => p.oy > 0);
  const partiToplamOy = partiler.reduce((s, p) => s + p.oy, 0);
  const farkOrani = gecerliToplam ? Math.abs(partiToplamOy - gecerliToplam) / gecerliToplam : 0;
  if (farkOrani > TARIHSEL_FARK_ESIGI) {
    throw new Error(`[ysk-tarihsel d${donem}] doğrulama kapısı geçmedi: parti toplamı ${partiToplamOy}, geçerli oy ${gecerliToplam} (%${(100 * farkOrani).toFixed(2)} fark, eşik %${100 * TARIHSEL_FARK_ESIGI})`);
  }
  logger.info(`[ysk-tarihsel d${donem}] ${ilAdlari.size} il, ${partiler.length} parti/bağımsız, parti-toplamı ${partiToplamOy} vs geçerli-oy ${gecerliToplam} (%${(100 * farkOrani).toFixed(2)} fark — bkz. dosya başı doğrulama notu).`);

  return {
    donem, tarih: tanim.tarih, secimAdi: tanim.secimAdi,
    secmenSayisi: secmenToplam, oyKullananSayisi: oyKullananToplam,
    gecerliOyToplami: gecerliToplam, gecersizOyToplami: gecersizToplam,
    katilmaOrani: secmenToplam ? Math.round((10000 * oyKullananToplam) / secmenToplam) / 100 : 0,
    partiler,
  };
}
