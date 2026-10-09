import { inflateRawSync } from 'node:zlib';
import {
  fetchWithBackoff, getJson, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  HEADERS, pdfMetinCikar,
  type Belediye, type YerelKararSonucu, type YerelUyeSonucu,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Samsun');

const SAMSUN_BASE = 'https://samsun.bel.tr';
const SAMSUN_KARARLAR_API = `${SAMSUN_BASE}/api/public/kurumsal/meclis-kararlari`;
const SAMSUN_UYELER_API = `${SAMSUN_BASE}/api/public/personeller/meclis-uyeleri`;

interface SamsunKararKayit {
  id: string;
  title: string;
  slug: string;
  documents: { url: string; filename: string }[];
  publishedAt: string;
}
interface SamsunKararListResponse {
  data: SamsunKararKayit[];
  pagination: { total: number; page: number; limit: number; hasMore: boolean };
}

async function tumKararKayitlariniCek(): Promise<SamsunKararKayit[]> {
  const sonuc: SamsunKararKayit[] = [];
  let page = 1;
  for (;;) {
    const j = await getJson<SamsunKararListResponse>(
      `${SAMSUN_KARARLAR_API}?page=${page}&limit=100`, { headers: HEADERS, timeoutMs: 30000 },
    );
    sonuc.push(...j.data);
    if (!j.pagination.hasMore || j.data.length === 0) break;
    page++;
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

function kNoAyikla(metin: string): { no: string | null; kalan: string } {
  const m = metin.match(/^\s*\(K\.NO:(\d+)\)\s*/);
  if (!m) return { no: null, kalan: metin };
  return { no: m[1], kalan: metin.slice(m[0].length) };
}

function sentetikKararNo(slug: string, maddeNo: number): string {
  const sonParca = slug.split('/').pop() || slug;
  return `${sonParca}#${maddeNo}`;
}

const PDF_MADDE_ADAY_RE = /(\d{1,3})\.\s{2,}(?=(?:\(K\.NO:\d+\)\s*)?[A-ZÇĞİÖŞÜ])/g;

function pdfKararlariniAyristir(hamMetin: string): string[] {
  const adaylar: { n: number; esasBaslangic: number; icerikBaslangic: number }[] = [];
  let m: RegExpExecArray | null;
  PDF_MADDE_ADAY_RE.lastIndex = 0;
  while ((m = PDF_MADDE_ADAY_RE.exec(hamMetin))) {
    adaylar.push({ n: Number(m[1]), esasBaslangic: m.index, icerikBaslangic: m.index + m[0].length });
  }
  const kabul: typeof adaylar = [];
  let beklenen = 1;
  for (const a of adaylar) {
    if (a.n === beklenen) { kabul.push(a); beklenen++; }
  }
  const parcalar: string[] = [];
  for (let i = 0; i < kabul.length; i++) {
    const bitis = i + 1 < kabul.length ? kabul[i + 1].esasBaslangic : hamMetin.length;
    parcalar.push(hamMetin.slice(kabul[i].icerikBaslangic, bitis));
  }
  return parcalar.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function samsunDocumentXmlCikar(buf: Buffer): string | null {
  let offset = 0;
  while (offset < buf.length - 4) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) { offset++; continue; }
    const compMethod = buf.readUInt16LE(offset + 8);
    const compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buf.slice(nameStart, nameStart + nameLen).toString('utf8');
    const dataStart = nameStart + nameLen + extraLen;
    if (name === 'word/document.xml') {
      const compData = buf.slice(dataStart, dataStart + compSize);
      const xml = compMethod === 0 ? compData : inflateRawSync(compData);
      return xml.toString('utf8');
    }
    offset = dataStart + compSize;
  }
  return null;
}

function samsunDocxKararlariniAyristir(buf: Buffer): string[] {
  const xml = samsunDocumentXmlCikar(buf);
  if (!xml) return [];
  const paragraflar = xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) ?? [];
  const parcalar: string[] = [];
  let mevcut: string[] | null = null;
  for (const p of paragraflar) {
    const metinler = [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
    if (/<w:numPr>/.test(p)) {
      if (mevcut) parcalar.push(mevcut.join(' '));
      mevcut = metinler ? [metinler] : [''];
    } else if (mevcut) {
      if (metinler) mevcut.push(metinler);
    }
  }
  if (mevcut) parcalar.push(mevcut.join(' '));
  return parcalar.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

async function belgeyiIsleyipKararlariCikar(
  kayit: SamsunKararKayit, tarih: string,
): Promise<YerelKararSonucu[]> {
  const belge = kayit.documents[0];
  const uzanti = (belge.url.match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? '').toLowerCase();
  if (uzanti !== 'pdf' && uzanti !== 'docx') {
    return [];
  }
  const res = await fetchWithBackoff(belge.url, { headers: HEADERS, timeoutMs: 45000 }, 3);
  if (!res.ok) {
    logger.error(`[yerel-samsun] belge indirilemedi (${kayit.title}): HTTP ${res.status}`);
    return [];
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const maddeler = uzanti === 'pdf'
    ? pdfKararlariniAyristir(await pdfMetinCikar(new Uint8Array(buf)))
    : samsunDocxKararlariniAyristir(buf);

  const sonuc: YerelKararSonucu[] = [];
  for (let i = 0; i < maddeler.length; i++) {
    const { no, kalan } = kNoAyikla(maddeler[i]);
    const metin = kalan.trim();
    if (metin.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({
      belediye: 'Samsun', karar_no: no ?? sentetikKararNo(kayit.slug, i + 1), tarih, konu: null,
      metin, oylama_sonucu: oylamaSonucuCikar(metin), kaynak_url: belge.url,
    });
  }
  return sonuc;
}

export async function fetchSamsunKararlar(): Promise<YerelKararSonucu[]> {
  const tumKayitlar = await tumKararKayitlariniCek();
  const kapsamdaki = tumKayitlar.filter((k) => (k.publishedAt || '').slice(0, 10) >= BASLANGIC_TARIHI);
  const sonuc: YerelKararSonucu[] = [];
  for (const kayit of kapsamdaki) {
    if (!kayit.documents?.length) continue;
    const tarih = kayit.publishedAt.slice(0, 10);
    try {
      sonuc.push(...await belgeyiIsleyipKararlariCikar(kayit, tarih));
    } catch (e) {
      logger.error(`[yerel-samsun] belge (${kayit.title}): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

interface SamsunUyeFiltre { name: string; value: string }
interface SamsunUyeKayit { title: string; filters?: SamsunUyeFiltre[]; ilcesi?: unknown[] }
interface SamsunUyeListResponse {
  data: SamsunUyeKayit[];
  pagination: { total: number; page: number; limit: number; hasMore: boolean };
}

const SAMSUN_PARTI_ETIKET: Record<string, string> = {
  'ak-parti': 'AK Parti', mhp: 'MHP', chp: 'CHP', 'i̇yi-parti': 'İyi Parti',
  'bağımsız': 'Bağımsız', 'yeniden-refah-partisi': 'Yeniden Refah Partisi',
  'büyük-birlik-partisi': 'Büyük Birlik Partisi',
};

export async function fetchSamsunUyeler(): Promise<YerelUyeSonucu[]> {
  const sonuc: YerelUyeSonucu[] = [];
  let page = 1;
  for (;;) {
    const j = await getJson<SamsunUyeListResponse>(
      `${SAMSUN_UYELER_API}?page=${page}&limit=100`, { headers: HEADERS, timeoutMs: 30000 },
    );
    for (const r of j.data) {
      const partiFiltre = (r.filters ?? []).find((f) => f.name === 'parti-sec');
      const ad = (r.title || '').trim();
      if (!ad || !partiFiltre?.value) continue;
      const hamParti = SAMSUN_PARTI_ETIKET[partiFiltre.value] ?? partiFiltre.value;
      const kanonik = normParti(hamParti);
      sonuc.push({ belediye: 'Samsun', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
    }
    if (!j.pagination.hasMore || j.data.length === 0) break;
    page++;
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}
