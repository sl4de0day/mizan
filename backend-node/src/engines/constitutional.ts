import * as cheerio from 'cheerio';
import { getLogger } from '../lib/logger.js';
import { httpFetch as _httpFetch, proxyUrlForKaynak, type HttpOptions } from '../lib/http.js';

const logger = getLogger('PoliticalInsight.Constitutional');

const KAYNAK = 'aym';
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
  if (node.type === 'comment' || node.type === 'script' || node.type === 'style') return;
  const name = (node.name ?? '').toLowerCase();
  if (name === 'script' || name === 'style') return;
  for (const c of node.children ?? []) collectText(c, acc);
}

function getText(node: DomNode | undefined | null, separator = '', strip = false): string {
  if (!node) return '';
  const acc: string[] = [];
  collectText(node, acc);
  if (strip) return acc.map((s) => s.trim()).filter((s) => s.length > 0).join(separator);
  return acc.join(separator);
}

const VOID_TAGS = new Set<string>([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'keygen', 'link',
  'meta', 'param', 'source', 'track', 'wbr', 'menuitem', 'basefont', 'bgsound',
  'command', 'frame', 'image', 'isindex', 'nextid', 'spacer',
]);

function escapeMinimal(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const WS_ONLY_RE = /^[ \t\n\r]+$/;
function collapseWhitespace(data: string): string {
  if (WS_ONLY_RE.test(data)) return /[\n\r]/.test(data) ? '\n' : ' ';
  return data;
}

const PRESERVE_WS_TAGS = new Set<string>(['pre', 'textarea', 'listing', 'xmp']);

function quotedAttributeValue(raw: string): string {
  const v = escapeMinimal(raw);
  if (v.includes('"')) {
    if (v.includes("'")) return `"${v.replace(/"/g, '&quot;')}"`;
    return `'${v}'`;
  }
  return `"${v}"`;
}

const CHARSET_RE = /((^|;)\s*charset=)([^;]*)/gm;

function metaSubstitutedAttribs(attribs: Record<string, string>): Record<string, string> {
  const out = { ...attribs };
  if (out.charset !== undefined) out.charset = 'utf-8';
  const httpEquiv = out['http-equiv'];
  if (out.content !== undefined && httpEquiv !== undefined && httpEquiv.toLowerCase() === 'content-type') {
    out.content = out.content.replace(CHARSET_RE, (_m, g1: string) => g1 + 'utf-8');
  }
  return out;
}

function serializeAttrs(attribs: Record<string, string>): string {
  const names = Object.keys(attribs).sort();
  let out = '';
  for (const name of names) {
    let value = attribs[name] ?? '';
    if (name === 'class') value = value.split(/\s+/).filter(Boolean).join(' ');
    out += ` ${name}=${quotedAttributeValue(value)}`;
  }
  return out;
}

function bs4Serialize(node: DomNode, preserve = false): string {
  switch (node.type) {
    case 'text':
      return escapeMinimal(preserve ? (node.data ?? '') : collapseWhitespace(node.data ?? ''));
    case 'comment':
      return `<!--${node.data ?? ''}-->`;
    case 'directive':
      return `<${node.data ?? ''}>`;
    case 'cdata': {
      let inner = '';
      for (const c of node.children ?? []) inner += bs4Serialize(c, preserve);
      return inner;
    }
    case 'tag':
    case 'script':
    case 'style': {
      const name = (node.name ?? '').toLowerCase();
      const rawAttribs = node.attribs ?? {};
      const attrs = serializeAttrs(name === 'meta' ? metaSubstitutedAttribs(rawAttribs) : rawAttribs);
      if (VOID_TAGS.has(name)) return `<${name}${attrs}/>`;
      const raw = name === 'script' || name === 'style';
      const childPreserve = preserve || PRESERVE_WS_TAGS.has(name);
      let inner = '';
      for (const c of node.children ?? []) {
        inner += raw && c.type === 'text' ? (c.data ?? '') : bs4Serialize(c, childPreserve);
      }
      return `<${name}${attrs}>${inner}</${name}>`;
    }
    default:
      return '';
  }
}

export interface AymSearchItem {
  title: string;
  info: string;
  url: string;
  source: string;
}

export interface AymSearchOk {
  success: true;
  data: AymSearchItem[];
}

export interface AymPartySearchOk {
  success: true;
  data: AymSearchItem[];
  total_found: number;
}

export interface AymError {
  success: false;
  error: string;
}

export interface AymDetailOk {
  success: true;
  html_content: string;
  details: Record<string, string>;
  title: string | null;
}

export interface NormSearchParams {
  keyword?: string;
  esas_no?: string;
  karar_no?: string;
  basvuru_turu?: string;
  karar_turu?: string;
}

export interface PartySearchParams {
  keyword?: string;
  esas_no?: string;
  karar_no?: string;
  karar_turu?: string;
  parti_id?: string;
  karar_tarihi_ilk?: string;
  karar_tarihi_son?: string;
}

interface AymApiItem {
  id?: string;
  esasNo?: string;
  kararNo?: string;
  kararTarihi?: string;
  resmiGazeteTarihi?: string;
  resmiGazeteSayisi?: string | number;
  kararKonusu?: string;
  kararTuruDosyaSonucuLabel?: string;
  basvuruTuru?: string;
}

export interface AymNormItem {
  id: string;
  esasNo: string;
  kararNo: string;
  kararTarihi: string;
  rgTarihi: string;
  rgSayisi: string;
  konu: string;
  sonucLabel: string;
  basvuruTuru: string;
  url: string;
}

const NORM_SOURCE = 'AYM Norm Denetimi';
const PARTY_SOURCE = 'AYM Siyasi Parti İşleri';

export class ConstitutionalEngine {
  private normOrigin = 'https://normkararlarbilgibankasi.anayasa.gov.tr';
  private partyOrigin = 'https://siyasipartikararlar.anayasa.gov.tr';
  private normBaseUrl = `${this.normOrigin}/kbb`;
  private partyBaseUrl = `${this.partyOrigin}/kbb`;
  private headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
    Connection: 'keep-alive',
  };

  parseKararItems(html: string, baseUrl: string, source: string): AymSearchItem[] {
    const $ = cheerio.load(html);
    const results: AymSearchItem[] = [];
    $('div.birkarar').each((_, item) => {
      const link = $(item).find('a').first();
      if (!link.length) return;
      let href = link.attr('href') ?? '';
      if (href && !href.startsWith('http')) href = baseUrl + href;
      const titleDiv = $(item).find('div.bkararbaslik').first();
      const infoDiv = $(item).find('div.kararbilgileri').first();
      const title = titleDiv.length
        ? getText(titleDiv.get(0) as unknown as DomNode, '', true)
        : 'Karar';
      const info = infoDiv.length
        ? getText(infoDiv.get(0) as unknown as DomNode, '', true)
        : '';
      results.push({ title, info, url: href, source });
    });
    return results;
  }

  parseTotalFound(html: string): number {
    const $ = cheerio.load(html);
    let countDiv = $('div.bulunankararsayisi').first();
    if (!countDiv.length) countDiv = $('div.bulunankararsayisiMobil').first();
    if (!countDiv.length) return 0;
    const countText = getText(countDiv.get(0) as unknown as DomNode, '', true);
    const match = countText.replace(/\./g, '').replace(/,/g, '').match(/(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  parseDetail(html: string): AymDetailOk {
    const $ = cheerio.load(html);

    let decisionEl = $('div.KararMetni').first();
    if (!decisionEl.length) decisionEl = $('div#Karar').first();
    const decisionHtml = decisionEl.length
      ? bs4Serialize(decisionEl.get(0) as unknown as DomNode)
      : '';

    const details: Record<string, string> = {};
    const detailsTab = $('div#KararDetaylari').first();
    if (detailsTab.length) {
      const table = detailsTab.find('table').first();
      if (table.length) {
        table.find('tr').each((_, tr) => {
          const cols = $(tr).find('td');
          if (cols.length >= 2) {
            let key = getText(cols.get(0) as unknown as DomNode, '', true);
            const val = getText(cols.get(1) as unknown as DomNode, '', true);
            key = key.replace(/:/g, '').trim();
            details[key] = val;
          }
        });
      }
    }

    const titleEl = $('title').first();
    let title: string | null = 'Anayasa Mahkemesi Kararı';
    if (titleEl.length) title = bs4TitleString(titleEl.get(0) as unknown as DomNode);

    return { success: true, html_content: decisionHtml, details, title };
  }

  private apiHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': this.headers['User-Agent'] ?? 'Mozilla/5.0',
      'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
    };
  }

  private originFor(source: string): string {
    return source === PARTY_SOURCE ? this.partyOrigin : this.normOrigin;
  }

  private jsonDateToTr(d?: string): string {
    if (!d) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : d;
  }

  private async apiSearch(
    origin: string,
    body: Record<string, unknown>,
  ): Promise<{ total: number; data: AymApiItem[] }> {
    const resp = await httpFetch(`${origin}/api/core/public/search`, {
      method: 'POST',
      headers: this.apiHeaders(),
      body: JSON.stringify(body),
      timeoutMs: 30000,
    });
    if (resp.status !== 200) throw new Error(`AYM API HTTP ${resp.status}`);
    const j = (await resp.json()) as { total?: number; data?: AymApiItem[] };
    return { total: j.total ?? 0, data: j.data ?? [] };
  }

  private buildBody(
    p: {
      keyword?: string; esas_no?: string; karar_no?: string; karar_turu?: string;
      basvuru_turu?: string; karar_tarihi_ilk?: string; karar_tarihi_son?: string;
    },
    size: number,
  ): Record<string, unknown> {
    const isUuid = (s?: string): boolean =>
      !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
    const body: Record<string, unknown> = { query: p.keyword ?? '', page: 1, size };
    if (p.esas_no) body.esasNo = p.esas_no;
    if (p.karar_no) body.kararNo = p.karar_no;
    if (p.karar_tarihi_ilk) body.kararTarihiStart = p.karar_tarihi_ilk;
    if (p.karar_tarihi_son) body.kararTarihiEnd = p.karar_tarihi_son;
    if (isUuid(p.karar_turu)) body.kararTuru = p.karar_turu;
    if (isUuid(p.basvuru_turu)) body.basvuruTuru = p.basvuru_turu;
    return body;
  }

  private mapItem(it: AymApiItem, source: string): AymSearchItem {
    const esas = it.esasNo ?? '';
    const karar = it.kararNo ?? '';
    const title = esas || karar ? `Esas ${esas || '?'} - Karar ${karar || '?'}` : 'Anayasa Mahkemesi Kararı';
    const rg = it.resmiGazeteTarihi
      ? `RG: ${this.jsonDateToTr(it.resmiGazeteTarihi)}${it.resmiGazeteSayisi ? ` (${it.resmiGazeteSayisi})` : ''}`
      : '';
    const info = [this.jsonDateToTr(it.kararTarihi), it.kararTuruDosyaSonucuLabel ?? '', rg]
      .filter((s) => s.length > 0)
      .join(' · ');
    const origin = this.originFor(source);
    const bank = source === PARTY_SOURCE ? 'parti' : 'norm';
    const qs = new URLSearchParams({ bank, esas, karar, id: it.id ?? '' });
    return { title, info, url: `${origin}/kbb/karar?${qs.toString()}`, source };
  }

  async searchNorm(p: NormSearchParams = {}): Promise<AymSearchOk | AymError> {
    try {
      logger.info(`AYM Norm | Searching for '${p.keyword ?? ''}'`);
      const { data } = await this.apiSearch(this.normOrigin, this.buildBody(p, 50));
      return { success: true, data: data.map((it) => this.mapItem(it, NORM_SOURCE)) };
    } catch (e) {
      logger.error(`AYM Norm Search Error: ${(e as Error).message}`);
      return { success: false, error: (e as Error).message };
    }
  }

  async searchNormDenetimi(p: { page?: number; size?: number; tarihIlk?: string; tarihSon?: string }): Promise<{ total: number; data: AymNormItem[] }> {
    const body: Record<string, unknown> = { query: '', page: p.page ?? 1, size: p.size ?? 100, kararTipi: 'NormDenetimi' };
    if (p.tarihIlk) body.kararTarihiStart = p.tarihIlk;
    if (p.tarihSon) body.kararTarihiEnd = p.tarihSon;
    const { total, data } = await this.apiSearch(this.normOrigin, body);
    const norm = data.map((it) => {
      const konu = it.kararKonusu ? cheerio.load(it.kararKonusu).text().replace(/\s+/g, ' ').trim() : '';
      const qs = new URLSearchParams({ bank: 'norm', esas: it.esasNo ?? '', karar: it.kararNo ?? '', id: it.id ?? '' });
      return {
        id: it.id ?? '',
        esasNo: it.esasNo ?? '',
        kararNo: it.kararNo ?? '',
        kararTarihi: (it.kararTarihi ?? '').slice(0, 10),
        rgTarihi: (it.resmiGazeteTarihi ?? '').slice(0, 10),
        rgSayisi: it.resmiGazeteSayisi != null ? String(it.resmiGazeteSayisi) : '',
        konu,
        sonucLabel: it.kararTuruDosyaSonucuLabel ?? '',
        basvuruTuru: it.basvuruTuru ?? '',
        url: `${this.normOrigin}/kbb/karar?${qs.toString()}`,
      };
    });
    return { total, data: norm };
  }

  async searchPartiYapisal(p: { page?: number; size?: number; tarihIlk?: string; tarihSon?: string }): Promise<{ total: number; data: AymNormItem[] }> {
    const body: Record<string, unknown> = { query: '', page: p.page ?? 1, size: p.size ?? 100 };
    if (p.tarihIlk) body.kararTarihiStart = p.tarihIlk;
    if (p.tarihSon) body.kararTarihiEnd = p.tarihSon;
    const { total, data } = await this.apiSearch(this.partyOrigin, body);
    const norm = data.map((it) => {
      const konu = it.kararKonusu ? cheerio.load(it.kararKonusu).text().replace(/\s+/g, ' ').trim() : '';
      const qs = new URLSearchParams({ bank: 'parti', esas: it.esasNo ?? '', karar: it.kararNo ?? '', id: it.id ?? '' });
      return {
        id: it.id ?? '',
        esasNo: it.esasNo ?? '',
        kararNo: it.kararNo ?? '',
        kararTarihi: (it.kararTarihi ?? '').slice(0, 10),
        rgTarihi: (it.resmiGazeteTarihi ?? '').slice(0, 10),
        rgSayisi: it.resmiGazeteSayisi != null ? String(it.resmiGazeteSayisi) : '',
        konu,
        sonucLabel: it.kararTuruDosyaSonucuLabel ?? '',
        basvuruTuru: it.basvuruTuru ?? '',
        url: `${this.partyOrigin}/kbb/karar?${qs.toString()}`,
      };
    });
    return { total, data: norm };
  }

  async searchParty(p: PartySearchParams = {}): Promise<AymPartySearchOk | AymError> {
    try {
      logger.info(`AYM Siyasi Parti | Searching for '${p.keyword ?? ''}'`);
      const { total, data } = await this.apiSearch(this.partyOrigin, this.buildBody(p, 100));
      const results = data.map((it) => this.mapItem(it, PARTY_SOURCE));
      logger.info(`AYM Siyasi Parti | API toplam ${total}, dönen ${results.length} karar.`);
      return { success: true, data: results, total_found: total || results.length };
    } catch (e) {
      logger.error(`AYM Siyasi Parti Search Error: ${(e as Error).message}`);
      return { success: false, error: (e as Error).message };
    }
  }

  async fetchDetail(url: string): Promise<AymDetailOk | AymError> {
    try {
      logger.info(`AYM | Fetching detail from ${url}`);
      let origin: string;
      let esas: string, karar: string, id: string, bank: string;
      try {
        const u = new URL(url);
        origin = `${u.protocol}//${u.host}`;
        bank = u.searchParams.get('bank') ?? (u.host.includes('siyasiparti') ? 'parti' : 'norm');
        esas = u.searchParams.get('esas') ?? '';
        karar = u.searchParams.get('karar') ?? '';
        id = u.searchParams.get('id') ?? '';
      } catch {
        return { success: false, error: 'Geçersiz karar adresi.' };
      }

      let item: AymApiItem | undefined;
      if (esas || karar) {
        const { data } = await this.apiSearch(origin, { query: '', esasNo: esas, kararNo: karar, page: 1, size: 5 });
        item = data.find((d) => (d.esasNo ?? '') === esas && (d.kararNo ?? '') === karar) ?? data[0];
      }
      if (!item) return { success: false, error: 'Karar bulunamadı.' };
      const realId = item.id ?? id;

      const details: Record<string, string> = {};
      if (item.esasNo) details['Esas No'] = item.esasNo;
      if (item.kararNo) details['Karar No'] = item.kararNo;
      const kt = this.jsonDateToTr(item.kararTarihi);
      if (kt) details['Karar Tarihi'] = kt;
      if (item.kararTuruDosyaSonucuLabel) details['Karar Türü'] = item.kararTuruDosyaSonucuLabel;
      const rgt = this.jsonDateToTr(item.resmiGazeteTarihi);
      if (rgt) details['Resmî Gazete Tarihi'] = rgt;
      if (item.resmiGazeteSayisi) details['Resmî Gazete Sayısı'] = String(item.resmiGazeteSayisi);

      const pdfUrl = realId ? `${origin}/api/core/public/${realId}/download?type=pdf` : '';
      const pdfLink = pdfUrl
        ? `<p style="margin:12px 0"><a href="${pdfUrl}" target="_blank" rel="noopener noreferrer">📄 Kararın tam metnini (PDF) görüntüle</a></p>`
        : '';
      const konu = (item.kararKonusu ?? '').trim();
      const html_content = (konu || '<p><em>Karar konusu metni bulunamadı.</em></p>') + pdfLink;
      const title = `AYM Kararı — E.${item.esasNo ?? '?'} K.${item.kararNo ?? '?'}`;

      return { success: true, html_content, details, title };
    } catch (e) {
      logger.error(`AYM Detail Error: ${(e as Error).message}`);
      return { success: false, error: (e as Error).message };
    }
  }
}

function bs4TitleString(node: DomNode): string | null {
  const kids = node.children ?? [];
  if (kids.length !== 1) return null;
  const c = kids[0];
  if (c.type === 'text') return c.data ?? '';
  if (c.type === 'tag') return bs4TitleString(c);
  return null;
}
