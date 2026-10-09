import * as cheerio from 'cheerio';
import { getLogger } from '../lib/logger.js';
import { httpFetch as _httpFetch, proxyUrlForKaynak, type HttpOptions } from '../lib/http.js';

const logger = getLogger('PoliticalInsight.Gazette');

const KAYNAK = 'gazete';
function httpFetch(url: string, opts: HttpOptions = {}) { return _httpFetch(url, { proxyUrl: proxyUrlForKaynak(KAYNAK), ...opts }); }

const BASE = 'https://resmigazete.gov.tr';
const FILTER_URL = `${BASE}/Home/Filter`;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Requested-With': 'XMLHttpRequest',
};

export interface GazetteSearchParams {
  keyword?: string;
  after?: string;
  before?: string;
  category?: string;
  institution?: string;
  mukerrer?: string;
  gazetteNo?: string;
  legislationNo?: string;
  start?: number;
  length?: number;
}

interface FilterItem {
  url?: string;
  konu?: string;
  mevzuatAdi?: string;
  resmiGazeteTarihiFormatted?: string;
  resmiGazeteSayisi?: string;
  mukerrer?: string;
}

export class GazetteEngine {
  transformSearchResults(data: { data?: FilterItem[] }): { success: true; data: unknown[] } {
    const results: unknown[] = [];
    for (const item of data.data ?? []) {
      const raw = item.url ?? '';
      const fullUrl = raw && !raw.startsWith('http') ? BASE + raw : raw;
      results.push({
        title: item.konu ?? '',
        type: item.mevzuatAdi ?? '',
        date: item.resmiGazeteTarihiFormatted ?? '',
        issue_no: item.resmiGazeteSayisi ?? '',
        mukerrer: item.mukerrer ?? '',
        url: fullUrl,
      });
    }
    return { success: true, data: results };
  }

  async searchGazette(p: GazetteSearchParams = {}): Promise<unknown> {
    const payload = {
      draw: 1,
      start: p.start ?? 0,
      length: p.length ?? 50,
      parameters: {
        genelaranacakkelime: p.keyword ?? '',
        genelbaslangictarihi: p.after ?? '',
        genelbitistarihi: p.before ?? '',
        genelkurumkodu: p.institution ?? '',
        genelmevzuatsayisi: p.legislationNo ?? '',
        genelmevzuatturu: p.category ?? '',
        genelmukerrer: p.mukerrer ?? '',
        genelsayi: p.gazetteNo ?? '',
        searchtype: '1',
      },
    };
    try {
      logger.info(`Gazette | Searching for '${p.keyword ?? ''}' via Filter API`);
      const resp = await httpFetch(FILTER_URL, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(payload),
        timeoutMs: 30000,
      });
      if (resp.status !== 200) {
        logger.error(`Gazette API Error: ${resp.status}`);
        return { success: false, error: `Site yanıt vermedi (Hata: ${resp.status})` };
      }
      const data = (await resp.json()) as { data?: FilterItem[] };
      return this.transformSearchResults(data);
    } catch (e) {
      logger.error(`Gazette Search Error: ${(e as Error).message}`);
      return { success: false, error: (e as Error).message };
    }
  }

  parseContent(html: string): unknown {
    const $ = cheerio.load(html);

    let pdfLink = '';
    const pdfBtn = $('a.fihrist-pdfbutton').first();
    if (pdfBtn.length) {
      const href = pdfBtn.attr('href') ?? '';
      pdfLink = href.startsWith('/') ? BASE + href : href;
    } else {
      const cand = $('a[href$=".pdf"]').first();
      if (cand.length) {
        const href = cand.attr('href') ?? '';
        pdfLink = href.startsWith('/') ? BASE + href : href;
      }
    }

    const sections: { name: string; items: { title: string; url: string }[] }[] = [];
    let current: { name: string; items: { title: string; url: string }[] } | null = null;

    const container = $('div#html-content').length
      ? $('div#html-content')
      : $('div#fihrist').length
        ? $('div#fihrist')
        : $('body');

    container.find('div, a, hr').each((_, el) => {
      const $el = $(el);
      const classes = ($el.attr('class') ?? '').split(/\s+/).filter(Boolean);
      const text = $el.text().trim();
      if (!text) return;

      if (classes.some((c) => ['html-title', 'html-subtitle', 'card-title'].includes(c))) {
        if (!current || current.name !== text) {
          current = { name: text, items: [] };
          sections.push(current);
        }
      } else if (classes.includes('fihrist-item') || ($el.is('a') && ($el.attr('href') ?? '').includes('/eskiler/'))) {
        const link = $el.is('a') ? $el : $el.find('a').first();
        if (link.length && current !== null) {
          let href = link.attr('href') ?? '';
          if (href && !href.startsWith('http')) href = BASE + href;
          const itemText = link.text().trim().replace(/^–+/, '').trim();
          if (!current.items.some((it) => it.title === itemText)) {
            current.items.push({ title: itemText, url: href });
          }
        }
      }
    });

    const finalSections: typeof sections = [];
    const seen = new Set<string>();
    for (const s of sections) {
      if (s.items.length && !seen.has(s.name)) {
        finalSections.push(s);
        seen.add(s.name);
      }
    }

    return { success: true, pdf_url: pdfLink, sections: finalSections, date: $('title').text() || '' };
  }

  async fetchContent(url: string): Promise<unknown> {
    try {
      logger.info(`Gazette | Fetching detail from ${url}`);
      const resp = await httpFetch(url, { headers: HEADERS, timeoutMs: 20000 });
      if (resp.status !== 200) return { success: false, error: 'İçerik yüklenemedi.' };
      const buf = Buffer.from(await resp.arrayBuffer());
      let contentStr = buf.toString('utf-8');
      if (contentStr.toLowerCase().includes('iso-8859-9') || contentStr.toLowerCase().includes('windows-1254')) {
        contentStr = buf.toString('latin1');
      }
      return this.parseContent(contentStr);
    } catch (e) {
      logger.error(`Gazette Detail Error: ${(e as Error).message}`);
      return { success: false, error: (e as Error).message };
    }
  }

  async getDailyIndex(dateStr?: string): Promise<unknown> {
    const d = dateStr ?? new Date().toISOString().slice(0, 10);
    return this.searchGazette({ after: d, before: d });
  }
}
