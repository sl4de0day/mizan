import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { getLogger } from '../lib/logger.js';
import { httpFetch as _httpFetch, proxyUrlForKaynak, type HttpOptions } from '../lib/http.js';
import { STORAGE_DIR } from '../lib/config.js';

const logger = getLogger('PoliticalInsight.Parliament.Minute');

const KAYNAK = 'tbmm';
function httpFetch(url: string, opts: HttpOptions = {}) { return _httpFetch(url, { proxyUrl: proxyUrlForKaynak(KAYNAK), ...opts }); }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function decodeHtmlBuffer(buf: Buffer, contentType?: string | null): string {
  const head = buf.subarray(0, 2048).toString('latin1');
  let charset =
    /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1] ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
    'windows-1254';
  charset = charset.toLowerCase();
  if (charset === 'iso-8859-9') charset = 'windows-1254';
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder('windows-1254').decode(buf);
  }
}

const BASE_URL = 'https://www.tbmm.gov.tr';
const FORM_URL = 'https://www.tbmm.gov.tr/Tutanaklar/TutanakSorgu';
const HEAT_ENDPOINT = 'https://www.tbmm.gov.tr/Tutanaklar/Tutanak-Sorgu-Sonuclari';
const LIST_ENDPOINT = 'https://www.tbmm.gov.tr/Tutanaklar/Tutanaklar-Sonuc-Sayfa';
const CSRF_NAME = 'X-CSRF-TOKEN-TBMM.WEB.Mvc.Prod';
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0';

const PY_WS_CODES = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
  0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

function isPyWs(ch: string): boolean {
  return PY_WS_CODES.has(ch.charCodeAt(0));
}

function pyStrip(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isPyWs(s[start]!)) start++;
  while (end > start && isPyWs(s[end - 1]!)) end--;
  return s.slice(start, end);
}

interface DomNodeLike {
  type: string;
  data?: string;
  children?: DomNodeLike[];
}

function pyGetText(node: DomNodeLike, separator: string, strip: boolean): string {
  const texts: string[] = [];
  const walk = (n: DomNodeLike): void => {
    if (n.type === 'text') {
      texts.push(n.data ?? '');
    } else if (n.type === 'script' || n.type === 'style') {
    } else if (n.children) {
      for (const c of n.children) walk(c);
    }
  };
  walk(node);
  const out: string[] = [];
  for (let t of texts) {
    if (strip) {
      t = pyStrip(t);
      if (t.length === 0) continue;
    }
    out.push(t);
  }
  return out.join(separator);
}

export interface MinuteSearchParams {
  keyword?: string;
  term?: string;
  year?: string;
  startDate?: string;
  endDate?: string;
  sortColumn?: string;
  sortDir?: string;
  ping?: string;
}

interface MinuteRawItem {
  donemVeYasamaYili?: string | null;
  birlesimNo?: string | null;
  tarih?: string | null;
  sayfa?: string | null;
  onizleme?: string;
  tutanakId?: string;
}

export interface MinuteResult {
  donem_yil: string | null;
  birlesim: string | null;
  tarih: string | null;
  sayfa: string | null;
  id: string;
  ozet: string;
  detay_url: string;
}

export interface MinuteEvent {
  step: string;
  message: string;
  progress: number;
  data?: MinuteResult[];
}

interface MinuteFile {
  type: string;
  url: string;
}

export interface MinuteDetail {
  info: string;
  files: MinuteFile[];
  pdf_url: string | null;
  basilmis_url?: string | null;
  html_url: string | null;
  html_content?: string;
}

export class MinuteEngine {
  private baseUrl = BASE_URL;
  private formUrl = FORM_URL;
  private heatEndpoint = HEAT_ENDPOINT;
  private listEndpoint = LIST_ENDPOINT;

  transformListItems(items: MinuteRawItem[]): MinuteResult[] {
    const results: MinuteResult[] = [];
    for (const item of items) {
      const onizleme = item.onizleme ?? '';
      const $ = cheerio.load(onizleme);
      const linkEl = $('a').first();
      const href = linkEl.length ? (linkEl.attr('href') ?? '') : '';

      const uuidMatch = href.match(/Id=([a-f0-9-]+)/);
      const uuid = uuidMatch ? uuidMatch[1]! : '';

      const pageMatch = href.match(/BaslangicSayfa=(\d+)/);
      const page = pageMatch ? pageMatch[1]! : (item.sayfa ?? null);

      const rootNode = $.root().get(0) as unknown as DomNodeLike | undefined;
      const snippet = rootNode ? pyGetText(rootNode, '', true) : '';

      results.push({
        donem_yil: item.donemVeYasamaYili ?? null,
        birlesim: item.birlesimNo ?? null,
        tarih: item.tarih ?? null,
        sayfa: page,
        id: uuid,
        ozet: snippet,
        detay_url: `https://www.tbmm.gov.tr/Tutanaklar/${href}`,
      });
    }
    return results;
  }

  parseDetail(html: string): MinuteDetail {
    const $ = cheerio.load(html);
    const details: MinuteDetail = { info: '', files: [], pdf_url: null, html_url: null, basilmis_url: null };

    const infoDiv = $('div[style*="font-size:16px"]').first();
    if (infoDiv.length) {
      const node = infoDiv.get(0) as unknown as DomNodeLike | undefined;
      if (node) details.info = pyGetText(node, '', true);
    }

    $('a[href]').each((_i, el) => {
      const href = $(el).attr('href') ?? '';
      const low = href.toLowerCase();
      if (low.includes('docx')) {
        details.files.push({ type: 'Word', url: href });
      } else if (low.includes('html')) {
        details.files.push({ type: 'HTML', url: href });
        details.html_url = href;
      } else if (low.includes('/basilmis/') && low.endsWith('.pdf')) {
        details.basilmis_url = href;
        details.files.push({ type: 'PDF-Basılmış', url: href });
      }
    });

    const embed = $('embed#embededPdf').first();
    if (embed.length) {
      const src = embed.attr('src');
      if (src) {
        details.pdf_url = src;
        details.files.push({ type: 'PDF', url: src });
      }
    }

    return details;
  }

  async *searchMinutesStream(p: MinuteSearchParams = {}): AsyncGenerator<MinuteEvent> {
    const keyword = p.keyword ?? '';
    const term = p.term ?? '28';
    const year = p.year ?? '';
    const startDate = p.startDate ?? '';
    const endDate = p.endDate ?? '';
    const sortColumn = p.sortColumn ?? '0';
    const sortDir = p.sortDir ?? 'asc';
    const ping = p.ping ?? 'false';

    const jar = new CookieJar();
    try {
      yield { step: 'starting', message: 'Güvenli bağlantı kuruluyor...', progress: 15 };

      const baseHeaders: Record<string, string> = {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
      };

      const preResp = await httpFetch(this.formUrl, { headers: baseHeaders, timeoutMs: 60000 });
      jar.absorb(preResp);
      const formHtml = await preResp.text();
      const $form = cheerio.load(formHtml);
      let tokenVal = '';
      const tokenInput = $form(`input[name="${CSRF_NAME}"]`).first();
      if (tokenInput.length) {
        tokenVal = tokenInput.attr('value') ?? '';
        jar.set(CSRF_NAME, tokenVal);
      }

      yield { step: 'processing', message: 'Oturum doğrulanıyor...', progress: 35 };

      const heatPayload = new URLSearchParams({
        [CSRF_NAME]: tokenVal,
        Kelime: keyword,
        YasamaDonemi: term || '28',
        YasamaYili: year,
        BaslangicTarihi: startDate,
        BitisTarihi: endDate,
        IcerikArama: '',
      });
      const heatHeaders: Record<string, string> = {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://www.tbmm.gov.tr',
        Referer: this.formUrl,
      };
      if (tokenVal) heatHeaders[CSRF_NAME] = tokenVal;
      const heatCookie = jar.header();
      if (heatCookie) heatHeaders.Cookie = heatCookie;
      const heatResp = await httpFetch(this.heatEndpoint, {
        method: 'POST',
        headers: heatHeaders,
        body: heatPayload,
        timeoutMs: 60000,
      });
      jar.absorb(heatResp);

      yield { step: 'processing', message: 'Tutanak arşivi taranıyor...', progress: 55 };

      const listHeaders: Record<string, string> = {
        'User-Agent': UA,
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: this.heatEndpoint,
      };
      if (tokenVal) listHeaders[CSRF_NAME] = tokenVal;

      const buildParams = (start: string): URLSearchParams => {
        const params = new URLSearchParams();
        params.set('draw', '1');
        const cols = ['donemVeYasamaYili', 'birlesimNo', 'tarih', 'sayfa', 'onizleme'];
        cols.forEach((c, idx) => {
          params.set(`columns[${idx}][data]`, c);
          params.set(`columns[${idx}][name]`, c);
          params.set(`columns[${idx}][searchable]`, 'true');
          params.set(`columns[${idx}][orderable]`, 'false');
          params.set(`columns[${idx}][search][value]`, '');
          params.set(`columns[${idx}][search][regex]`, 'false');
        });
        params.set('order[0][column]', sortColumn);
        params.set('order[0][dir]', sortDir);
        params.set('start', start);
        params.set('length', ping === 'true' ? '1' : '500');
        params.set('search[value]', '');
        params.set('search[regex]', 'false');
        params.set('YasamaDonemi', term || '28');
        params.set('YasamaYili', year);
        params.set('BaslangicTarihi', startDate);
        params.set('BitisTarihi', endDate);
        params.set('Kelime', keyword);
        params.set('DataTableVMProp[draw]', '0');
        params.set('DataTableVMProp[start]', '0');
        params.set('DataTableVMProp[length]', '0');
        params.set('DataTableVMProp[search][value]', '');
        params.set('DataTableVMProp[search][regex]', 'false');
        params.set('_', String(Date.now()));
        return params;
      };

      const listCookie = jar.header();
      if (listCookie) listHeaders.Cookie = listCookie;

      const firstParams = buildParams('0');
      const response = await httpFetch(`${this.listEndpoint}?${firstParams.toString()}`, {
        headers: listHeaders,
        timeoutMs: 60000,
      });
      if (response.status !== 200) {
        throw new Error(`Meclis Sunucu Hatası: ${response.status}`);
      }
      let rawData: { data?: MinuteRawItem[]; recordsFiltered?: number };
      try {
        rawData = (await response.json()) as typeof rawData;
      } catch {
        throw new Error('Tutanak verisi işlenemedi (JSON Hatası).');
      }

      let items = rawData.data ?? [];
      const totalRecords = rawData.recordsFiltered ?? items.length;

      if (ping === 'true') {
        items = items.slice(0, 1);
      } else if (totalRecords > 500) {
        yield {
          step: 'processing',
          message: `Arşiv taranıyor (Toplam ${totalRecords} kayıt bulundu, parçalar birleştiriliyor)...`,
          progress: 65,
        };
        let currentStart = 500;
        while (currentStart < totalRecords) {
          const pageParams = buildParams(String(currentStart));
          try {
            const pageResp = await httpFetch(`${this.listEndpoint}?${pageParams.toString()}`, {
              headers: listHeaders,
              timeoutMs: 60000,
            });
            if (pageResp.status === 200) {
              const pageData = (await pageResp.json()) as { data?: MinuteRawItem[] };
              const pageItems = pageData.data ?? [];
              items = items.concat(pageItems);
            }
          } catch (pageErr) {
            logger.error(`Tutanak sayfa çekme hatası (start=${currentStart}): ${(pageErr as Error).message}`);
          }
          currentStart += 500;
        }
      }

      yield { step: 'counting', message: `${items.length} tutanak parçası bulundu.`, progress: 85 };

      const results = this.transformListItems(items);

      yield { step: 'finished', message: 'Tamamlandı.', progress: 100, data: results };
    } catch (e) {
      logger.error(`Tutanak Hatası: ${(e as Error).message}`);
      yield { step: 'error', message: (e as Error).message, progress: 0 };
    }
  }

  async fetchDetailMeta(uuid: string, page = '1'): Promise<MinuteDetail> {
    const url = `https://www.tbmm.gov.tr/Tutanaklar/Tutanak?Id=${uuid}&BaslangicSayfa=${page}&BitisSayfa=${page}`;
    const resp = await httpFetch(url, { headers: { 'User-Agent': UA }, timeoutMs: 30000 });
    const html = await resp.text();
    return this.parseDetail(html);
  }

  private async fetchHtmlText(htmlUrl: string, timeoutMs: number): Promise<string> {
    let hUrl = htmlUrl;
    if (!hUrl.startsWith('http')) hUrl = this.baseUrl + hUrl;
    const hResp = await httpFetch(hUrl, { headers: { 'User-Agent': UA }, timeoutMs });
    if (!hResp.ok) throw new Error(`HTTP ${hResp.status}`);
    const buf = Buffer.from(await hResp.arrayBuffer());
    const hHtml = decodeHtmlBuffer(buf, hResp.headers.get('content-type'));
    if (!/<body[\s>]/i.test(hHtml)) throw new Error('<body> yok');
    const h$ = cheerio.load(hHtml);
    const bodyNode = h$('body').get(0) as unknown as DomNodeLike | undefined;
    const text = bodyNode ? pyGetText(bodyNode, '\n', true) : '';
    if (text.length < 500) throw new Error(`kısa içerik (${text.length})`);
    return text;
  }

  async fetchMinuteDetail(uuid: string, page = '1'): Promise<MinuteDetail | Record<string, never>> {
    try {
      const details = await this.fetchDetailMeta(uuid, page);
      if (details.html_url) {
        try {
          details.html_content = await this.fetchHtmlText(details.html_url, 30000);
        } catch (he) {
          logger.error(`HTML fetch hatası: ${(he as Error).message}`);
        }
      }
      return details;
    } catch (e) {
      logger.error(`Tutanak Detay Hatası: ${(e as Error).message}`);
      return {};
    }
  }

  async fetchSessionText(
    uuid: string,
    page = '1',
    opts: { noCache?: boolean; timeoutMs?: number; retries?: number } = {},
  ): Promise<string | null> {
    const cacheDir = join(STORAGE_DIR, 'tutanak_cache');
    const cacheFile = join(cacheDir, `${uuid}.txt`);
    if (!opts.noCache && existsSync(cacheFile)) {
      try {
        const t = readFileSync(cacheFile, 'utf-8');
        if (t.length > 100) return t;
      } catch {
      }
    }
    const timeoutMs = opts.timeoutMs ?? 90000;
    const retries = opts.retries ?? 4;
    let htmlUrl: string | null = null;
    try {
      htmlUrl = (await this.fetchDetailMeta(uuid, page)).html_url;
    } catch (e) {
      logger.error(`fetchSessionText meta (${uuid.slice(0, 8)}): ${(e as Error).message}`);
    }
    if (!htmlUrl) return null;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const text = await this.fetchHtmlText(htmlUrl, timeoutMs);
        try {
          mkdirSync(cacheDir, { recursive: true });
          writeFileSync(cacheFile, text, 'utf-8');
        } catch {
        }
        return text;
      } catch (e) {
        logger.error(`fetchSessionText deneme ${attempt + 1}/${retries} (${uuid.slice(0, 8)}): ${(e as Error).message}`);
        if (attempt < retries - 1) await sleep(2000 * 2 ** attempt);
      }
    }
    return null;
  }

  async discoverSessions(
    donem = '28',
    keywords = ['gündem', 'bütçe'],
  ): Promise<MinuteResult[]> {
    const sessions = new Map<string, MinuteResult>();
    for (const kw of keywords) {
      try {
        for await (const ev of this.searchMinutesStream({ keyword: kw, term: donem })) {
          if (!ev.data?.length) continue;
          for (const r of ev.data) {
            const key = `${r.donem_yil}#${r.birlesim}`;
            if (!sessions.has(key)) sessions.set(key, r);
          }
        }
      } catch (e) {
        logger.error(`discoverSessions kw='${kw}': ${(e as Error).message}`);
      }
      await sleep(1500);
    }
    return Array.from(sessions.values());
  }
}

class CookieJar {
  private jar = new Map<string, string>();

  set(name: string, value: string): void {
    this.jar.set(name, value);
  }

  absorb(resp: Response): void {
    const getSetCookie = (resp.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
    const cookies = typeof getSetCookie === 'function' ? getSetCookie.call(resp.headers) : [];
    for (const c of cookies) {
      const first = c.split(';', 1)[0] ?? '';
      const eq = first.indexOf('=');
      if (eq > 0) this.jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
    }
  }

  header(): string {
    return Array.from(this.jar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
}
