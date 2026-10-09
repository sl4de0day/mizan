import * as cheerio from 'cheerio';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getLogger } from '../lib/logger.js';
import { httpFetch as _httpFetch, proxyUrlForKaynak, type HttpOptions } from '../lib/http.js';
import { STORAGE_DIR } from '../lib/config.js';

const logger = getLogger('PoliticalInsight.Milletvekili');

const KAYNAK = 'tbmm';
function httpFetch(url: string, opts: HttpOptions = {}) { return _httpFetch(url, { proxyUrl: proxyUrlForKaynak(KAYNAK), ...opts }); }

interface DomNode {
  type: string;
  data?: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
}

function collectText(node: DomNode, acc: string[]): void {
  if (node.type === 'text') {
    acc.push(node.data ?? '');
    return;
  }
  if (node.type === 'comment') return;
  for (const c of node.children ?? []) collectText(c, acc);
}

function getText(node: DomNode | undefined | null, separator = '', strip = false): string {
  if (!node) return '';
  const acc: string[] = [];
  collectText(node, acc);
  if (strip) return acc.map((s) => s.trim()).filter((s) => s.length > 0).join(separator);
  return acc.join(separator);
}

export interface DeputyBio {
  komisyonlar: string[];
  biyografi_paragraflar: string[];
  biyografi_metni: string;
  iletisim: Record<string, string>;
}

export interface AiData {
  cinsiyet: string;
  dogum_yili: number | null;
  ogrenim_durumu: string;
  meslek: string;
  anahtar_kelimeler: string[];
}

export interface DeputyDetail {
  id: string;
  donem_id: string;
  ad_soyad: string;
  komisyonlar: string[];
}

export class MVEngine {
  private cacheDir = join(STORAGE_DIR, 'milletvekili_cache');
  private headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
    Referer: 'https://www.tbmm.gov.tr/milletvekili-arama/liste',
  };

  constructor() {
    if (!existsSync(this.cacheDir)) mkdirSync(this.cacheDir, { recursive: true });
  }

  parseBiographyHtml(html: string): DeputyBio {
    const $ = cheerio.load(html);

    const commissions: string[] = [];
    const commDiv = $('div.profil-komisyon-div').first();
    if (commDiv.length) {
      const text = getText(commDiv.get(0) as unknown as DomNode, '', false);
      for (const line of text.split('\n')) {
        const s = line.trim();
        if (s) commissions.push(s);
      }
    }

    const bioParagraphs: string[] = [];
    const bioDiv = $('div.profile-ozgecmis-div').first();
    if (bioDiv.length) {
      const bioSpan = bioDiv.find('span').first();
      const target = bioSpan.length ? bioSpan : bioDiv;
      target.find('p').each((_, p) => {
        const t = getText(p as unknown as DomNode, '', true);
        if (t) bioParagraphs.push(t);
      });
      if (bioParagraphs.length === 0) {
        const t = getText(target.get(0) as unknown as DomNode, '', true);
        if (t) bioParagraphs.push(t);
      }
    }

    const contact: Record<string, string> = {};
    const addrDiv = $('div.profile-adres-div').first();
    if (addrDiv.length) {
      addrDiv.find('tr').each((_, row) => {
        const cols = $(row).find('td');
        if (cols.length >= 3) {
          const label = getText(cols.get(0) as unknown as DomNode, '', true).replace(/:/g, '').trim();
          const val = getText(cols.get(2) as unknown as DomNode, '', true);
          if (label && val) contact[label] = val;
        }
      });
    }

    return {
      komisyonlar: commissions,
      biyografi_paragraflar: bioParagraphs,
      biyografi_metni: bioParagraphs.join('\n'),
      iletisim: contact,
    };
  }

  private defaultDetail(deputyId: string, donemId: string, name: string): DeputyDetail {
    return {
      id: deputyId,
      donem_id: donemId,
      ad_soyad: name,
      komisyonlar: [],
    };
  }

  async getDeputyDetails(deputyId: string, donemId: string, name: string): Promise<DeputyDetail> {
    const cachePath = join(this.cacheDir, `${deputyId}.json`);
    if (existsSync(cachePath)) {
      try {
        return JSON.parse(readFileSync(cachePath, 'utf-8')) as DeputyDetail;
      } catch {
      }
    }

    const url = `https://www.tbmm.gov.tr/milletvekili/milletvekilidetay?DonemId=${donemId}&Id=${deputyId}`;
    try {
      const r = await httpFetch(url, { headers: this.headers, timeoutMs: 15000 });
      const text = await r.text();
      if (r.status === 200 && !text.includes('Request Rejected')) {
        const parsed = this.parseBiographyHtml(text);

        const result: DeputyDetail = {
          id: deputyId,
          donem_id: donemId,
          ad_soyad: name,
          komisyonlar: parsed.komisyonlar,
        };

        try {
          writeFileSync(cachePath, JSON.stringify(result, null, 2), 'utf-8');
        } catch {
        }
        return result;
      }
    } catch (e) {
      logger.error(`Error fetching biography for ${name} (${deputyId}): ${(e as Error).message}`);
    }

    return this.defaultDetail(deputyId, donemId, name);
  }
}

