import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { inflateRawSync } from 'node:zlib';
import { fetchWithBackoff as _fetchWithBackoff, getJson as _getJson, proxyUrlForKaynak, type HttpOptions } from '../lib/http.js';

const KAYNAK = 'yerel_yonetim';
export function fetchWithBackoff(url: string, opts: HttpOptions = {}, retries?: number) { return _fetchWithBackoff(url, { proxyUrl: proxyUrlForKaynak(KAYNAK), ...opts }, retries); }
export function getJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> { return _getJson<T>(url, { proxyUrl: proxyUrlForKaynak(KAYNAK), ...opts }); }

export const BASLANGIC_TARIHI = '2024-04-01';

export const YEREL_YONETIM_BELEDIYELERI = [
  'İstanbul', 'Ankara', 'İzmir', 'Bursa', 'Konya', 'Diyarbakır',
  'Muğla', 'Şanlıurfa', 'Kayseri', 'Kocaeli', 'Erzurum', 'Ordu', 'Eskişehir', 'Mardin',
  'Aydın', 'Mersin', 'Tekirdağ', 'Adana', 'Denizli', 'Zonguldak', 'Elazığ',
  'Malatya', 'Samsun', 'Manisa', 'Sakarya',
  'Antalya', 'Gaziantep', 'Hatay', 'Trabzon', 'Kahramanmaraş',
  'Sinop', 'Tokat', 'Uşak', 'Şırnak', 'Bartın', 'Ardahan', 'Iğdır', 'Karabük',
  'Osmaniye', 'Düzce', 'Aksaray', 'Karaman', 'Yozgat', 'Bayburt', 'Kırıkkale', 'Niğde', 'Batman',
  'Afyonkarahisar', 'Ağrı', 'Amasya', 'Artvin', 'Bilecik', 'Bolu', 'Burdur', 'Çanakkale',
  'Çorum', 'Edirne', 'Erzincan', 'Giresun', 'Isparta', 'Kars', 'Kastamonu', 'Kırklareli',
  'Kırşehir', 'Kütahya', 'Rize',
  'Sivas', 'Bitlis', 'Adıyaman', 'Balıkesir', 'Çankırı', 'Muş', 'Tunceli', 'Siirt',
  'Bingöl', 'Nevşehir', 'Gümüşhane', 'Yalova',
  'Van (Tuşba)',
] as const;
export type Belediye = (typeof YEREL_YONETIM_BELEDIYELERI)[number];

export const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

export interface YerelKararSonucu {
  belediye: Belediye;
  karar_no: string | null;
  tarih: string;
  konu: string | null;
  metin: string;
  oylama_sonucu: 'oybirlik' | 'oycoklugu' | null;
  kaynak_url: string;
}
export interface YerelUyeSonucu {
  belediye: Belediye;
  ad_soyad: string;
  parti: string;
  ilce: string | null;
}

export function kararNoSiraDoldur(kararlar: YerelKararSonucu[]): YerelKararSonucu[] {
  const sayac = new Map<string, number>();
  for (const k of kararlar) {
    if (k.karar_no !== null) continue;
    const n = (sayac.get(k.tarih) ?? 0) + 1;
    sayac.set(k.tarih, n);
    k.karar_no = `sira-${n}`;
  }
  return kararlar;
}

export function oylamaSonucuCikar(metin: string): 'oybirlik' | 'oycoklugu' | null {
  const duz = metin.toLocaleLowerCase('tr').replace(/\s+/g, ' ');
  if (/oy\s*birliği/.test(duz)) return 'oybirlik';
  if (/oy\s*çokluğu/.test(duz)) return 'oycoklugu';
  return null;
}

export const ASGARI_KARAR_UZUNLUK = 80;

export function gunAy(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function docxMetinCikar(buf: Buffer): string | null {
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
      const parcalar = [...xml.toString('utf8').matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]);
      return parcalar.join('');
    }
    offset = dataStart + compSize;
  }
  return null;
}

export async function pdfMetinCikar(data: Uint8Array): Promise<string> {
  const doc = await getDocument({ data, verbosity: 0 }).promise;
  let metin = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await doc.getPage(p).then((pg) => pg.getTextContent());
    metin += (tc.items as { str: string }[]).map((i) => i.str).join(' ') + '\n';
  }
  return metin;
}

const SISTEM_CHROMIUM_ADAYLARI = ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/snap/bin/chromium'];
let sistemChromiumYolu: string | null | undefined;

async function sistemChromiumBul(): Promise<string | null> {
  if (sistemChromiumYolu !== undefined) return sistemChromiumYolu;
  const { existsSync } = await import('node:fs');
  sistemChromiumYolu = SISTEM_CHROMIUM_ADAYLARI.find((p) => existsSync(p)) ?? null;
  return sistemChromiumYolu;
}

export interface RenderliGetirSecenek {
  bekleSelector?: string;
  timeoutMs?: number;
}

export async function renderliHtmlGetir(url: string, secenek: RenderliGetirSecenek = {}): Promise<string> {
  const yol = await sistemChromiumBul();
  if (!yol) throw new Error('[renderliHtmlGetir] sistem Chromium bulunamadı (aday yollar: ' + SISTEM_CHROMIUM_ADAYLARI.join(', ') + ') — playwright kendi tarayıcısını indirmedi, bu ortamda kurulu değil');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath: yol, headless: true });
  try {
    const page = await browser.newPage({ userAgent: HEADERS['User-Agent'] });
    await page.goto(url, { waitUntil: 'networkidle', timeout: secenek.timeoutMs ?? 30000 });
    if (secenek.bekleSelector) {
      await page.waitForSelector(secenek.bekleSelector, { timeout: 10000 }).catch(() => {
      });
    }
    return await page.content();
  } finally {
    await browser.close();
  }
}
