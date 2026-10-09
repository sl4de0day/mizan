import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { getLogger } from '../lib/logger.js';
import { httpFetch as _httpFetch, fetchWithBackoff as _fetchWithBackoff, proxyUrlForKaynak, type HttpOptions } from '../lib/http.js';
import { PROJECT_ROOT } from '../lib/config.js';

const logger = getLogger('PoliticalInsight.Parliament.Law');

const KAYNAK = 'tbmm';
function httpFetch(url: string, opts: HttpOptions = {}) { return _httpFetch(url, { proxyUrl: proxyUrlForKaynak(KAYNAK), ...opts }); }
function fetchWithBackoff(url: string, opts: HttpOptions = {}, retries?: number) { return _fetchWithBackoff(url, { proxyUrl: proxyUrlForKaynak(KAYNAK), ...opts }, retries); }

const EMPTY_UUID = '00000000-0000-0000-0000-000000000000';

export interface LawListItem {
  onergeninOzeti?: string;
  donemiVeYasamaYili?: string | null;
  esasNo?: string | null;
  baskanligaGelisTarihi?: string | null;
  sonDurumu?: string | null;
  [k: string]: unknown;
}

export interface LawResult {
  donem_yil: string | null;
  esas_no: string | null;
  id: string;
  tarih: string | null;
  baslik: string;
  vekiller: string;
  parties: string[];
  durum: string;
  detay_url: string;
}

export interface ImzaSahibi {
  ad_soyad: string;
  parti: string;
  il: string;
  ilk_imza: boolean;
}

export interface KomisyonBilgi {
  tip: string;
  adi: string;
  giris: string;
  cikis: string;
  islem: string;
}

export interface LawDetail {
  ana_bilgiler: Record<string, string>;
  komisyon_bilgileri: KomisyonBilgi[];
  imza_sahipleri: ImzaSahibi[];
  metin_pdf: string;
}

export interface FilterOption {
  val: string;
  text: string;
}

export interface LawFilters {
  donemler: FilterOption[];
  durumlar: FilterOption[];
  partiler: FilterOption[];
  komisyonlar: FilterOption[];
  vekiller: FilterOption[];
}

export interface LawSearchParams {
  keyword?: string;
  startDate?: string;
  endDate?: string;
  status?: string | null;
  period?: string | null;
  party?: string | null;
  deputy?: string | null;
  commission?: string | null;
  fileNo?: string | null;
  passedOnly?: string;
  ownerType?: string;
  sortColumn?: string;
  sortDir?: string;
  ping?: string;
  knownIds?: Set<string>;
}

export interface LawStreamStep {
  step: string;
  message: string;
  progress: number;
  data?: LawResult[];
}

interface Deputy {
  ad_soyad?: string;
  parti?: string;
  [k: string]: unknown;
}

interface DomNode {
  type: string;
  data?: string;
  children?: DomNode[];
}

function textNodes(el: DomNode): string[] {
  const out: string[] = [];
  const walk = (node: DomNode): void => {
    for (const c of node.children ?? []) {
      if (c.type === 'text') out.push(c.data ?? '');
      else if (c.type === 'tag') walk(c);
    }
  };
  walk(el);
  return out;
}

function getTextRaw(el: DomNode): string {
  return textNodes(el).join('');
}

function getTextSep(el: DomNode, sep: string): string {
  return textNodes(el).join(sep);
}

function getTextStripTrue(el: DomNode): string {
  return textNodes(el)
    .map((s) => pyStrip(s))
    .filter((s) => s.length > 0)
    .join('');
}

function pyStrip(s: string): string {
  return s.replace(/^\s+/, '').replace(/\s+$/, '');
}

function nodeString(el: DomNode): string | null {
  const kids = el.children ?? [];
  if (kids.length !== 1) return null;
  const c = kids[0];
  if (c.type === 'text') return c.data ?? '';
  if (c.type === 'tag') return nodeString(c);
  return null;
}

function cleanStr(name: string | null | undefined): string {
  if (!name) return '';
  let n = name.trim().toUpperCase();
  n = n
    .replace(/İ/g, 'I')
    .replace(/Ğ/g, 'G')
    .replace(/Ü/g, 'U')
    .replace(/Ş/g, 'S')
    .replace(/Ö/g, 'O')
    .replace(/Ç/g, 'C');
  for (const noise of ['MİLLETVEKİLİ', 'MILLETVEKILI', 'İMZA SAHİBİ', 'IMZA SAHIBI']) {
    n = n.split(noise).join('');
  }
  return n.split(/\s+/).filter((x) => x.length > 0).join(' ');
}

const PARTI_MAP: Record<string, string[]> = {
  akp: ['AK PARTİ', 'AK PARTI', 'ADALET VE KALKINMA PARTİSİ', 'ADALET VE KALKINMA PARTI', 'AKP'],
  chp: ['CHP', 'CUMHURİYET HALK PARTİSİ', 'CUMHURIYET HALK PARTI'],
  mhp: ['MHP', 'MİLLİYETÇİ HAREKET PARTİSİ', 'MILLIYETCI HAREKET PARTI'],
  iyi: ['İYİ PARTİ', 'IYI PARTI', 'İYİ PARTİSİ', 'IYI PARTI'],
  saadet: ['SAADET PARTİSİ', 'SAADET PARTI'],
  gelecek: ['GELECEK PARTİSİ', 'GELECEK PARTI'],
  dem: [
    'DEM PARTİ',
    'DEM PARTI',
    'YEŞİL SOL PARTİ',
    'YESIL SOL PARTI',
    'HALKLARIN DEMOKRATİK PARTİSİ',
    'HALKLARIN DEMOKRATIK PARTI',
    'HDP',
  ],
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class LawEngine {
  private baseUrl = 'https://www.tbmm.gov.tr';
  private formUrl = `${this.baseUrl}/Yasama/Kanun-Teklifleri`;
  private listEndpoint = `${this.baseUrl}/Yasama/Kanun-Teklifleri-Sonuc-Sayfa`;
  private detailCache = new Map<string, LawDetail>();
  deputyList: Deputy[] = [];

  private headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0',
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: `${this.baseUrl}/Yasama/Kanun-Teklifleri-Sonuc`,
    Origin: this.baseUrl,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    Connection: 'keep-alive',
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
  };

  constructor() {
    const deputiesFile = join(PROJECT_ROOT, 'deputy_master_list.json');
    if (existsSync(deputiesFile)) {
      try {
        this.deputyList = JSON.parse(readFileSync(deputiesFile, 'utf-8')) as Deputy[];
        logger.info(
          `deputy_master_list.json basariyla yuklendi. Toplam vekil sayisi: ${this.deputyList.length}`,
        );
      } catch (e) {
        logger.error(`LawEngine deputy list read error: ${(e as Error).message}`);
      }
    }
  }

  parseMetadataFilters(currentHtml: string, pastHtml: string): LawFilters {
    const $c = cheerio.load(currentHtml);
    const $p = cheerio.load(pastHtml);
    const filters: LawFilters = {
      donemler: [],
      durumlar: [],
      partiler: [],
      komisyonlar: [],
      vekiller: [],
    };

    const dnCur = $c('select#DonemYasamaYili').first();
    if (dnCur.length) {
      dnCur.find('option').each((_i, o) => {
        const val = $c(o).attr('value');
        if (val) filters.donemler.push({ val, text: pyStrip(getTextRaw(o as unknown as DomNode)) });
      });
    }

    const dnPast = $p('select#DonemYasamaYili').first();
    if (dnPast.length) {
      dnPast.find('option').each((_i, o) => {
        const val = $p(o).attr('value');
        if (val && val !== EMPTY_UUID)
          filters.donemler.push({ val, text: pyStrip(getTextRaw(o as unknown as DomNode)) });
      });
    }

    const seenDurumlar = new Set<string>();
    for (const $x of [$c, $p]) {
      const drSel = $x('select#SonDurumu').first();
      if (!drSel.length) continue;
      drSel.find('option').each((_i, o) => {
        const val = $x(o).attr('value');
        if (val && !seenDurumlar.has(val)) {
          seenDurumlar.add(val);
          filters.durumlar.push({ val, text: pyStrip(getTextRaw(o as unknown as DomNode)) });
        }
      });
    }

    const seenVekiller = new Set<string>();
    for (const $x of [$c, $p]) {
      const vkSel = $x('select#TeklifSicil').first();
      if (!vkSel.length) continue;
      vkSel.find('option').each((_i, o) => {
        const val = $x(o).attr('value');
        if (val && !seenVekiller.has(val)) {
          seenVekiller.add(val);
          filters.vekiller.push({ val, text: pyStrip(getTextRaw(o as unknown as DomNode)) });
        }
      });
    }

    return filters;
  }

  async getMetadataFilters(): Promise<LawFilters> {
    try {
      const [respCurrent, respPast] = await Promise.all([
        httpFetch(this.formUrl, { headers: this.headers, timeoutMs: 30000 }),
        httpFetch(`${this.baseUrl}/Yasama/Gecmis-Kanun-Teklifleri`, {
          headers: this.headers,
          timeoutMs: 30000,
        }),
      ]);
      const currentHtml = await respCurrent.text();
      const pastHtml = await respPast.text();
      return this.parseMetadataFilters(currentHtml, pastHtml);
    } catch (e) {
      logger.error(`Law Filters Error: ${(e as Error).message}`);
      return { donemler: [], durumlar: [], partiler: [], komisyonlar: [], vekiller: [] };
    }
  }

  extractLawId(item: LawListItem): string {
    const $ = cheerio.load(item.onergeninOzeti ?? '');
    for (const a of $('a').toArray()) {
      const href = $(a).attr('href') ?? '';
      if (href.includes('/Yasama/KanunTeklifi/')) return href.split('/').pop() ?? '';
    }
    return '';
  }

  processItem(item: LawListItem): LawResult {
    const $ = cheerio.load(item.onergeninOzeti ?? '');
    const rootEl = $.root().toArray()[0] as unknown as DomNode;

    const uuid = this.extractLawId(item);

    const fullText = getTextSep(rootEl, '|').split('|');
    const vekillerStr = fullText.length > 0 ? pyStrip(fullText[0]) : 'Bilinmiyor';
    const baslik = fullText.length > 1 ? pyStrip(fullText[1]) : '';

    let durumText = 'Komisyonda';
    const htmlText = getTextRaw(rootEl);
    if (htmlText.includes('Sonuç :')) {
      const parts = htmlText.split('Sonuç :');
      if (parts.length > 1) durumText = pyStrip(parts[1].split('\n')[0]);
    } else if (htmlText.includes('Son Durumu :')) {
      const parts = htmlText.split('Son Durumu :');
      if (parts.length > 1) durumText = pyStrip(parts[1].split('\n')[0]);
    } else if (item.sonDurumu) {
      durumText = item.sonDurumu;
    }

    const parties: string[] = [];
    const vekillerStrClean = cleanStr(vekillerStr);
    for (const dep of this.deputyList) {
      const depNameClean = cleanStr(dep.ad_soyad ?? '');
      if (depNameClean && depNameClean.length > 3 && vekillerStrClean.includes(depNameClean)) {
        const depParty = dep.parti ?? '';
        if (depParty) {
          parties.push(cleanStr(depParty));
          break;
        }
      }
    }

    return {
      donem_yil: item.donemiVeYasamaYili ?? null,
      esas_no: item.esasNo ?? null,
      id: uuid,
      tarih: item.baskanligaGelisTarihi ?? null,
      baslik,
      vekiller: vekillerStr,
      parties,
      durum: durumText,
      detay_url: `${this.baseUrl}/Yasama/KanunTeklifi/${uuid}`,
    };
  }

  transformResults(items: LawListItem[], party?: string | null): LawResult[] {
    const rawResults = items.map((it) => this.processItem(it));
    if (!party) return rawResults;
    const targetParties = PARTI_MAP[party.toLowerCase()] ?? [];
    return rawResults.filter((res) => {
      const resParties = res.parties.map((p) => cleanStr(p));
      return targetParties.some((tp) => {
        const tpClean = cleanStr(tp);
        return resParties.some((rp) => rp.includes(tpClean) || tpClean.includes(rp));
      });
    });
  }

  async *searchLawsStream(p: LawSearchParams = {}): AsyncGenerator<LawStreamStep> {
    const {
      keyword = '',
      startDate = '',
      endDate = '',
      status = null,
      period = null,
      party = null,
      deputy = null,
      fileNo = null,
      passedOnly = 'false',
      ownerType = '',
      sortColumn = '2',
      sortDir = 'desc',
      ping = 'false',
    } = p;

    yield { step: 'starting', message: 'Meclis kanun veri hattı hazırlanıyor...', progress: 10 };

    const sd = startDate ? startDate.split('-').reverse().join('-').replace(/-/g, '.') : '';
    const ed = endDate ? endDate.split('-').reverse().join('-').replace(/-/g, '.') : '';

    let esasSayi = '';
    if (fileNo) {
      const match = fileNo.match(/(\d+)$/);
      if (match) esasSayi = match[1];
    }

    let taksimNo = '0';
    if (ownerType === '1') taksimNo = '2';
    else if (ownerType === '3') taksimNo = '1';

    const isPastPeriod = !!period && period.toLowerCase().startsWith('f72877c2');

    let formUrlToUse: string;
    let postUrlToUse: string;
    let listUrlToUse: string;
    if (isPastPeriod) {
      formUrlToUse = `${this.baseUrl}/Yasama/Gecmis-Kanun-Teklifleri`;
      postUrlToUse = `${this.baseUrl}/Yasama/Gecmis-Kanun-Teklifleri-Sonuc`;
      listUrlToUse = `${this.baseUrl}/Yasama/Gecmis-Kanun-Teklifleri-Sonuc-Sayfa`;
    } else {
      formUrlToUse = this.formUrl;
      postUrlToUse = `${this.baseUrl}/Yasama/Kanun-Teklifleri-Sonuc`;
      listUrlToUse = this.listEndpoint;
    }

    try {
      yield { step: 'starting', message: 'Güvenli bağlantı kuruluyor...', progress: 15 };

      const navHeaders: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        Connection: 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
      };

      const preResp = await httpFetch(formUrlToUse, { headers: navHeaders, timeoutMs: 60000 });
      const preHtml = await preResp.text();
      const $form = cheerio.load(preHtml);

      let tokenVal = '';
      const tokenInput = $form('input[name="X-CSRF-TOKEN-TBMM.WEB.Mvc.Prod"]').first();
      let cookieHeader = '';
      if (tokenInput.length) {
        tokenVal = tokenInput.attr('value') ?? '';
        navHeaders['X-CSRF-TOKEN-TBMM.WEB.Mvc.Prod'] = tokenVal;
        cookieHeader = `X-CSRF-TOKEN-TBMM.WEB.Mvc.Prod=${tokenVal}`;
      }

      await sleep(1800);

      yield { step: 'processing', message: 'Oturum doğrulanıyor...', progress: 35 };

      const heatHeaders: Record<string, string> = {
        ...navHeaders,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://www.tbmm.gov.tr',
        Referer: formUrlToUse,
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
      };
      if (cookieHeader) heatHeaders['Cookie'] = cookieHeader;

      const heatPayload: Record<string, string> = {
        'X-CSRF-TOKEN-TBMM.WEB.Mvc.Prod': tokenVal,
        MetinArama: keyword,
        DonemYasamaYili: period ? period : EMPTY_UUID,
        TaksimNo: taksimNo,
        TeklifSicil: deputy ? deputy : EMPTY_UUID,
        IlkImzaSahibi: 'false',
        SonDurumu: status ? status : EMPTY_UUID,
        EsasNumarasi: esasSayi,
        BaslangicTarihi: sd,
        BitisTarihi: ed,
        Kanunlasanlar: passedOnly,
        IcerikArama: '',
        DonemYasamaYillari: '',
        KanunGruplari: '',
        TeklifSahibiMillletvekilleri: '',
        SonDurumlar: '',
      };

      await httpFetch(postUrlToUse, {
        method: 'POST',
        headers: heatHeaders,
        body: new URLSearchParams(heatPayload),
        timeoutMs: 60000,
      });

      await sleep(2200);

      yield { step: 'processing', message: 'Meclis arşivi taranıyor...', progress: 55 };

      const listHeaders: Record<string, string> = {
        ...heatHeaders,
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: postUrlToUse,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
      };
      delete listHeaders['Content-Type'];

      const params: Record<string, string> = {
        draw: '1',
        'columns[0][data]': 'donemiVeYasamaYili',
        'columns[0][name]': 'donemiVeYasamaYili',
        'columns[0][searchable]': 'true',
        'columns[0][orderable]': 'true',
        'columns[0][search][value]': '',
        'columns[0][search][regex]': 'false',
        'columns[1][data]': 'esasNo',
        'columns[1][name]': 'esasNo',
        'columns[1][searchable]': 'true',
        'columns[1][orderable]': 'true',
        'columns[1][search][value]': '',
        'columns[1][search][regex]': 'false',
        'columns[2][data]': 'baskanligaGelisTarihi',
        'columns[2][name]': 'baskanligaGelisTarihi',
        'columns[2][searchable]': 'true',
        'columns[2][orderable]': 'true',
        'columns[2][search][value]': '',
        'columns[2][search][regex]': 'false',
        'columns[3][data]': 'onergeninOzeti',
        'columns[3][name]': 'onergeninOzeti',
        'columns[3][searchable]': 'true',
        'columns[3][orderable]': 'false',
        'columns[3][search][value]': '',
        'columns[3][search][regex]': 'false',
        start: '0',
        length: ping === 'true' ? '1' : '500',
        'search[value]': '',
        'search[regex]': 'false',
        DonemYasamaYili: period ? period : EMPTY_UUID,
        TaksimNo: taksimNo,
        TeklifSicil: deputy ? deputy : EMPTY_UUID,
        IlkImzaSahibi: 'false',
        SonDurumu: status ? status : EMPTY_UUID,
        EsasNumarasi: esasSayi,
        BaslangicTarihi: sd,
        BitisTarihi: ed,
        MetinArama: keyword,
        IcerikArama: '',
        DonemYasamaYillari: '',
        KanunGruplari: '',
        TeklifSahibiMillletvekilleri: '',
        SonDurumlar: '',
        'DataTableVMProp[draw]': '0',
        'DataTableVMProp[start]': '0',
        'DataTableVMProp[length]': '0',
        'DataTableVMProp[search][value]': '',
        'DataTableVMProp[search][regex]': 'false',
        'order[0][column]': sortColumn,
        'order[0][dir]': sortDir,
        _: String(Date.now()),
      };

      const listUrl = `${listUrlToUse}?${new URLSearchParams(params).toString()}`;
      const response = await fetchWithBackoff(listUrl, { headers: listHeaders, timeoutMs: 60000 });
      const responseText = await response.text();

      if (responseText.includes('Request Rejected') || response.status === 403) {
        throw new Error(
          'Meclis güvenlik duvarı (WAF) isteği geçici olarak kısıtladı. Lütfen 3-5 dakika bekleyip tekrar deneyin.',
        );
      }
      if (response.status !== 200) {
        throw new Error(`Meclis Hatası: ${response.status}`);
      }

      let rawData: { data?: LawListItem[]; recordsTotal?: number };
      try {
        rawData = JSON.parse(responseText) as { data?: LawListItem[]; recordsTotal?: number };
      } catch {
        if (!responseText.trim()) {
          yield { step: 'finished', message: 'Sonuç bulunamadı.', progress: 100, data: [] };
          return;
        }
        throw new Error('Meclis verisi işlenemedi.');
      }

      let items = rawData.data ?? [];
      if (ping === 'true') items = items.slice(0, 1);

      const sunucuToplam = typeof rawData.recordsTotal === 'number' ? rawData.recordsTotal : null;
      const PAGE = 500;
      const pageHasKnown = (arr: LawListItem[]): boolean =>
        !!p.knownIds && arr.some((it) => p.knownIds!.has(this.extractLawId(it)));
      if (ping !== 'true' && items.length >= PAGE && !pageHasKnown(items)) {
        let start = PAGE;
        const maxPages = 200;
        let kesinti: string | null = null;
        for (let pg = 0; pg < maxPages; pg++) {
          params.start = String(start);
          params.draw = String(pg + 2);
          params._ = String(Date.now());
          let pageItems: LawListItem[] = [];
          try {
            const pageResp = await httpFetch(`${listUrlToUse}?${new URLSearchParams(params).toString()}`, {
              headers: listHeaders,
              timeoutMs: 60000,
            });
            if (pageResp.status !== 200) { kesinti = `HTTP ${pageResp.status} (start=${start})`; break; }
            const pageText = await pageResp.text();
            if (pageText.includes('Request Rejected')) { kesinti = `WAF reddi (start=${start})`; break; }
            pageItems = (JSON.parse(pageText) as { data?: LawListItem[] }).data ?? [];
          } catch (e) {
            kesinti = `ağ/ayrıştırma hatası (start=${start}): ${(e as Error).message}`;
            break;
          }
          if (!pageItems.length) break;
          items.push(...pageItems);
          if (pageItems.length < PAGE) break;
          if (pageHasKnown(pageItems)) break;
          start += PAGE;
          await sleep(400);
        }
        if (kesinti) {
          throw new Error(
            `[law] Liste çekimi YARIDA KESİLDİ — ${kesinti}. Elde ${items.length} kayıt var ama bu ` +
            `TAM LİSTE DEĞİL; yazılırsa korpus sessizce eksik kalır (geçmişte 47 kanun böyle kayboldu). ` +
            `Çekim başarısız sayıldı; WAF yatışınca yeniden koşulmalı.`,
          );
        }
        if (sunucuToplam !== null && ping !== 'true' && !p.knownIds && items.length < sunucuToplam) {
          throw new Error(
            `[law] EKSİK LİSTE: sunucu ${sunucuToplam} kayıt olduğunu bildiriyor, ${items.length} kayıt ` +
            `toplanabildi (${sunucuToplam - items.length} eksik). Sayfalama muhtemelen boş sayfa ile ` +
            `kesildi (WAF yük altında böyle davranıyor). Yarım liste YAZILMAZ — yeniden koşulmalı.`,
          );
        }
      }

      yield { step: 'counting', message: `${items.length} kayıt analiz ediliyor...`, progress: 75 };
      yield { step: 'processing', message: 'Parti dağılımları hesaplanıyor...', progress: 85 };

      const rawResults: LawResult[] = [];
      for (let i = 0; i < items.length; i++) {
        const res = this.processItem(items[i]);
        if (res.parties.length === 0 && i < 20) {
          const detail = await this.fetchLawDetail(res.id);
          if (detail && Array.isArray(detail.imza_sahipleri)) {
            const set = new Set<string>();
            for (const imza of detail.imza_sahipleri) {
              if (imza.parti) set.add(cleanStr(imza.parti));
            }
            res.parties = Array.from(set);
          }
        }
        rawResults.push(res);
      }

      let results: LawResult[];
      if (party) {
        const targetParties = PARTI_MAP[party.toLowerCase()] ?? [];
        results = rawResults.filter((res) => {
          const resParties = res.parties.map((pp) => cleanStr(pp));
          return targetParties.some((tp) => {
            const tpClean = cleanStr(tp);
            return resParties.some((rp) => rp.includes(tpClean) || tpClean.includes(rp));
          });
        });
      } else {
        results = rawResults;
      }

      yield {
        step: 'finished',
        message: `Filtrelenmiş ${results.length} kayıt listeleniyor.`,
        progress: 100,
        data: results,
      };
    } catch (e) {
      logger.error(`Law Search Error: ${(e as Error).message}`);
      yield { step: 'error', message: (e as Error).message, progress: 0 };
    }
  }

  parseDetail(html: string): LawDetail {
    const $ = cheerio.load(html);
    const details: LawDetail = {
      ana_bilgiler: {},
      komisyon_bilgileri: [],
      imza_sahipleri: [],
      metin_pdf: '',
    };

    const anchors = $('a').toArray();
    for (const a of anchors) {
      const href = $(a).attr('href');
      if (href === undefined || !/\.pdf/.test(href)) continue;
      const s = nodeString(a as unknown as DomNode);
      if (s !== null && /Teklif Metni|Kanun Metni/.test(s)) {
        details.metin_pdf = href.startsWith('/') ? this.baseUrl + href : href;
        break;
      }
    }

    $('table').each((_ti, t) => {
      const $t = $(t);
      const headers = $t
        .find('th')
        .toArray()
        .map((th) => getTextStripTrue(th as unknown as DomNode).toUpperCase());
      const rows = $t.find('tr').toArray();
      const firstRowCells =
        rows.length > 0 ? $(rows[0]).find('td, th').toArray() : [];

      const cellUpper = (cell: unknown): string =>
        getTextStripTrue(cell as unknown as DomNode).toUpperCase();

      const isImza =
        headers.some((h) => h.includes('ADI VE SOYADI') || h.includes('PARTİSİ')) ||
        (rows.length > 0 &&
          firstRowCells.some((td) => {
            const u = cellUpper(td);
            return u.includes('ADI VE SOYADI') || u.includes('PARTİSİ');
          }));

      if (isImza) {
        for (const row of rows.slice(1)) {
          const cols = $(row).find('td').toArray();
          if (cols.length >= 3) {
            const nameRaw = getTextRaw(cols[0] as unknown as DomNode);
            details.imza_sahipleri.push({
              ad_soyad: pyStrip(nameRaw),
              parti: pyStrip(getTextRaw(cols[1] as unknown as DomNode)),
              il: pyStrip(getTextRaw(cols[2] as unknown as DomNode)),
              ilk_imza: nameRaw.includes('İLK İMZA'),
            });
          }
        }
        return;
      }

      const isKomisyon =
        headers.some(
          (h) =>
            h.includes('KOMISYON') ||
            h.includes('GIRIS') ||
            h.includes('KOMİSYON') ||
            h.includes('GİRİŞ'),
        ) ||
        (rows.length > 0 &&
          firstRowCells.some((td) => {
            const u = cellUpper(td);
            return (
              u.includes('KOMISYON') ||
              u.includes('GIRIS') ||
              u.includes('KOMİSYON') ||
              u.includes('GİRİŞ')
            );
          }));

      if (isKomisyon) {
        for (const row of rows.slice(1)) {
          const cols = $(row).find('td').toArray();
          if (cols.length >= 5) {
            details.komisyon_bilgileri.push({
              tip: pyStrip(getTextRaw(cols[0] as unknown as DomNode)),
              adi: pyStrip(getTextRaw(cols[1] as unknown as DomNode)),
              giris: pyStrip(getTextRaw(cols[2] as unknown as DomNode)),
              cikis: pyStrip(getTextRaw(cols[3] as unknown as DomNode)),
              islem: pyStrip(getTextRaw(cols[4] as unknown as DomNode)),
            });
          }
        }
        return;
      }

      let isAna = true;
      for (const row of rows) {
        if ($(row).find('td').toArray().length !== 2) {
          isAna = false;
          break;
        }
      }
      if (isAna && rows.length > 0) {
        for (const row of rows) {
          const cols = $(row).find('td').toArray();
          const label = getTextStripTrue(cols[0] as unknown as DomNode).split(':').join('');
          details.ana_bilgiler[label] = getTextStripTrue(cols[1] as unknown as DomNode);
        }
      }
    });

    return details;
  }

  async fetchLawDetail(uuid: string): Promise<LawDetail> {
    const cached = this.detailCache.get(uuid);
    if (cached) return cached;

    const url = `${this.baseUrl}/Yasama/KanunTeklifi/${uuid}`;
    try {
      const resp = await httpFetch(url, { headers: this.headers, timeoutMs: 30000 });
      const html = await resp.text();
      const details = this.parseDetail(html);
      this.detailCache.set(uuid, details);
      return details;
    } catch (e) {
      logger.error(`Law Detail Error: ${(e as Error).message}`);
      return { ana_bilgiler: {}, komisyon_bilgileri: [], imza_sahipleri: [], metin_pdf: '' };
    }
  }

  async fetchLawSirasayisi(uuid: string): Promise<{ sirasayisi: string | null; kanunNo: string | null; esasNo: string | null; gelisTarihi: string | null; alanSayisi: number; yenilemeMi: boolean }> {
    const url = `${this.baseUrl}/Yasama/KanunTeklifi/${uuid}`;
    const resp = await httpFetch(url, { headers: this.headers, timeoutMs: 30000 });
    const html = await resp.text();
    const $ = cheerio.load(html);
    const alanlar: Record<string, string> = {};
    $('tr').each((_i, tr) => {
      const td = $(tr).find('td');
      if (td.length === 2) {
        const k = $(td[0]).text().replace(/\s+/g, ' ').trim();
        if (k) alanlar[k] = $(td[1]).text().replace(/\s+/g, ' ').trim();
      }
    });
    const bul = (desen: RegExp) => {
      for (const [k, v] of Object.entries(alanlar)) if (desen.test(k)) return v || null;
      return null;
    };
    const hamSS = bul(/esas\s*komisyon\s*raporu\s*\(?\s*s[ıi]ra\s*say[ıi]s[ıi]/i);
    const rakam = hamSS ? hamSS.replace(/\D/g, '') : '';
    const gunAyYil = (s: string | null): string | null => {
      const m = s && /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim());
      return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
    };
    return {
      sirasayisi: rakam || null,
      kanunNo: bul(/^kanun\s*numaras[ıi]$/i),
      esasNo: (bul(/^esas\s*numaras[ıi]$/i) ?? '').replace(/\s+/g, '') || null,
      gelisTarihi: gunAyYil(bul(/ba[şs]kanl[ıi][ğg]a\s*geli[şs]\s*tarihi/i)),
      alanSayisi: Object.keys(alanlar).length,
      yenilemeMi: Object.keys(alanlar).some((k) => /önceki\s*d[öo]nemden|yeni\s*d[öo]neme\s*intikal/i.test(k)),
    };
  }
}
