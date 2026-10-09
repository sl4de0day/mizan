import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as cheerio from 'cheerio';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fetchWithBackoff as _fetchWithBackoff, proxyUrlForKaynak, type HttpOptions } from '../lib/http.js';
import { getLogger } from '../lib/logger.js';

const execFileAsync = promisify(execFile);

const logger = getLogger('PoliticalInsight.PartiProgram');

const KAYNAK = 'parti_program';
function fetchWithBackoff(url: string, opts: HttpOptions = {}, retries?: number) { return _fetchWithBackoff(url, { proxyUrl: proxyUrlForKaynak(KAYNAK), ...opts }, retries); }

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

export interface PartiProgramTanimi {
  parti: string;
  belgeAdi: string;
  belgeTuru: 'secim_beyannamesi' | 'parti_programi';
  tarih: string | null;
  url: string;
  format: 'pdf' | 'html';
  htmlSecici?: string;
  curlGerekli?: boolean;
}

export const PARTI_PROGRAM_TANIMLARI: PartiProgramTanimi[] = [
  {
    parti: 'AKP', belgeAdi: '2023 Seçim Beyannamesi', belgeTuru: 'secim_beyannamesi', tarih: '2023-04-14',
    url: 'https://www.akparti.org.tr/media/bwlbgkif/tu-rkiye-yu-zy%C4%B1l%C4%B1-ic-in-dog-ru-ad%C4%B1mlar-2023-sec-im-beyannamesi.pdf',
    format: 'pdf', curlGerekli: true,
  },
  {
    parti: 'CHP', belgeAdi: 'Parti Programı (2025 taslağı)', belgeTuru: 'parti_programi', tarih: null,
    url: 'https://cdn.chp.org.tr/iys/PARTI_PROGRAMI_v2.pdf',
    format: 'pdf',
  },
  {
    parti: 'MHP', belgeAdi: '2023 Seçim Beyannamesi', belgeTuru: 'secim_beyannamesi', tarih: '2023-05-14',
    url: 'https://www.mhp.org.tr/usr_img/_mhp2007/kitaplar/beyanname_14_mayis_2023_opt.pdf',
    format: 'pdf',
  },
  {
    parti: 'DEM', belgeAdi: '2023 Seçim Bildirgesi (Yeşil Sol Parti)', belgeTuru: 'secim_beyannamesi', tarih: '2023-04-09',
    url: 'https://www.hdp.org.tr/Images/UserFiles/Documents/Editor/2023/yesil-sol-parti-2023-sbildirgesi.pdf',
    format: 'pdf',
  },
  {
    parti: 'YENIDEN REFAH', belgeAdi: '2023 Seçim Beyannamesi', belgeTuru: 'secim_beyannamesi', tarih: '2023-04-13',
    url: 'https://yenidenrefahpartisi.org.tr/page/2023-genel-secimleri-beyannamemiz/2501',
    format: 'html', htmlSecici: 'article .sag',
  },
  {
    parti: 'TIP', belgeAdi: '2023 Seçim Bildirgesi Özeti (Halkın Kırmızı Çizgileri)', belgeTuru: 'secim_beyannamesi', tarih: '2023-05-01',
    url: 'https://tip.org.tr/raporlar-belgeler/tip-2023-secim-bildirgesi-halkin-kirmizi-cizgileri',
    format: 'html', htmlSecici: '.post-content',
  },
];

async function pdfMetinCikar(data: Uint8Array): Promise<string> {
  const doc = await getDocument({ data, verbosity: 0 }).promise;
  let metin = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await doc.getPage(p).then((pg) => pg.getTextContent());
    metin += (tc.items as { str: string }[]).map((i) => i.str).join(' ') + '\n';
  }
  return metin;
}

function htmlMetinCikar(html: string, secici: string): string {
  const $ = cheerio.load(html);
  const el = $(secici).first();
  el.find('script,style').remove();
  return el.text().replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

async function curlIleGetir(url: string): Promise<Buffer> {
  const proxyUrl = proxyUrlForKaynak(KAYNAK);
  const { stdout } = await execFileAsync(
    'curl', ['-sSfL', '-A', HEADERS['User-Agent'], '--max-time', '60', url],
    { maxBuffer: 200 * 1024 * 1024, encoding: 'buffer', env: proxyUrl ? { ...process.env, http_proxy: proxyUrl, https_proxy: proxyUrl } : process.env },
  );
  return stdout as unknown as Buffer;
}

export async function fetchPartiProgram(tanim: PartiProgramTanimi): Promise<{ metin: string }> {
  let veri: Buffer;
  if (tanim.curlGerekli) {
    veri = await curlIleGetir(tanim.url);
  } else {
    const res = await fetchWithBackoff(tanim.url, { headers: HEADERS, timeoutMs: 60000 }, 4);
    if (!res.ok) throw new Error(`[parti-program ${tanim.parti}] HTTP ${res.status}`);
    veri = Buffer.from(await res.arrayBuffer());
  }

  let metin: string;
  if (tanim.format === 'pdf') {
    metin = await pdfMetinCikar(new Uint8Array(veri));
  } else {
    metin = htmlMetinCikar(veri.toString('utf8'), tanim.htmlSecici!);
  }
  metin = metin.trim();
  if (metin.length < 2000) {
    throw new Error(`[parti-program ${tanim.parti}] çıkarılan metin çok kısa (${metin.length} karakter) — WAF/hata sayfası olabilir`);
  }
  logger.info(`[parti-program ${tanim.parti}] ${metin.length} karakter çekildi (${tanim.belgeTuru}).`);
  return { metin };
}
