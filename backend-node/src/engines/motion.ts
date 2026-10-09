import * as cheerio from 'cheerio';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getLogger } from '../lib/logger.js';
import { httpFetch as _httpFetch, fetchWithBackoff as _fetchWithBackoff, proxyUrlForKaynak, type HttpOptions } from '../lib/http.js';
import { PROJECT_ROOT } from '../lib/config.js';

const logger = getLogger('PoliticalInsight.Parliament.Motion');

const KAYNAK = 'tbmm';
function httpFetch(url: string, opts: HttpOptions = {}) { return _httpFetch(url, { proxyUrl: proxyUrlForKaynak(KAYNAK), ...opts }); }
function fetchWithBackoff(url: string, opts: HttpOptions = {}, retries?: number) { return _fetchWithBackoff(url, { proxyUrl: proxyUrlForKaynak(KAYNAK), ...opts }, retries); }

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

function descendantsByTag(node: DomNode, tag: string): DomNode[] {
  const out: DomNode[] = [];
  const walk = (n: DomNode): void => {
    for (const c of n.children ?? []) {
      if (c.type === 'tag' && c.name === tag) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

function firstDescendantByTag(node: DomNode, tag: string): DomNode | null {
  return descendantsByTag(node, tag)[0] ?? null;
}

function getAttr(node: DomNode, name: string): string | undefined {
  return node.attribs?.[name];
}

function flatten(node: DomNode, out: DomNode[]): void {
  out.push(node);
  for (const c of node.children ?? []) flatten(c, out);
}

function singleString(node: DomNode): string | null {
  const kids = node.children ?? [];
  if (kids.length !== 1) return null;
  const c = kids[0];
  if (c.type === 'text') return c.data ?? '';
  if (c.type === 'tag') return singleString(c);
  return null;
}

export interface MotionRawItem {
  onergeninSahibiveOzeti?: string;
  donemveYasamaYili?: string | null;
  taksimveEsasNo?: string | null;
  baskanligaGelisTarihi?: string | null;
  onergeMuhatabiId?: string;
  onergeDurumu?: string;
  [k: string]: unknown;
}

export interface MotionCevap {
  order: string;
  birlesim: string;
  birlesim_tarihi: string;
  date: string;
  pdf: string;
  label: string;
}

export interface MotionDetail {
  ana_bilgiler: Record<string, string>;
  cevaplar: MotionCevap[];
  pdf_ler: { label: string; url: string }[];
  onerge_pdf_url: string | null;
}

export interface MotionResult {
  donem_yil: string | null;
  id: string | null;
  tarih: string | null;
  vekil: string;
  ozet: string;
  parties: string[];
  muhatap_id: string;
  cevaplar: MotionCevap[];
  muhatap_text: string;
  durum: string;
  detay_url: string;
}

export interface MotionStreamEvent {
  step: string;
  message: string;
  progress: number;
  data?: MotionResult[];
  total?: number;
}

export interface MotionSearchParams {
  keyword?: string;
  after?: string;
  before?: string;
  status?: string;
  term?: string;
  year?: string;
  deputy?: string;
  addressed_to?: string;
  file_no?: string;
  last_term_only?: string;
  party?: string;
  first_signer_only?: string;
  sort_column?: string;
  sort_dir?: string;
  ping?: string;
  knownIds?: Set<string>;
}

export interface FilterOption {
  id: string | undefined;
  label: string;
}

export interface MotionFilters {
  terms: { id: string; label: string }[];
  years: FilterOption[];
  deputies: FilterOption[];
  parties: FilterOption[];
  addressed_to: { id: string; label: string }[];
  statuses: FilterOption[];
}

interface DeputyRecord {
  ad_soyad?: string;
  parti?: string;
  [k: string]: unknown;
}

const TERMS: { id: string; label: string }[] = [
  { id: '00000000-0000-0000-0000-000000000000', label: '28. Dönem' },
  { id: '259b36bd-897d-41a3-b457-0182c6cf153f', label: '27. Dönem' },
  { id: 'e39d73fc-dc0f-48e1-a8ed-019c4d4f68fc', label: '26. Dönem' },
  { id: '93b2a2aa-ec4a-4e3f-a631-019c4d4f68fc', label: '25. Dönem' },
  { id: '673f8205-bcf7-4dc1-ba66-019c4d4f68fc', label: '24. Dönem' },
  { id: '84d5df65-8b9a-4c28-be99-019c4d4f68fc', label: '23. Dönem' },
  { id: '59cb36bb-897d-41a3-b457-0182c6cf153f', label: '22. Dönem' },
  { id: 'a9cb36bb-897d-41a3-b457-0182c6cf153f', label: '21. Dönem' },
  { id: 'b9cb36bb-897d-41a3-b457-0182c6cf153f', label: '20. Dönem' },
];

const CABINET_28: { id: string; label: string }[] = [
  { id: 'e3ce1232-4307-435c-b361-4ae5c53ee75a', label: 'TBMM Başkanı Numan KURTULMUŞ' },
  { id: 'BD9FADF2-93BA-4A18-9979-01888F881D3A', label: 'Cumhurbaşkanı Yardımcısı Cevdet YILMAZ' },
  { id: '23CAA63B-EFC8-4E3A-8E8D-019C4D4F68FC', label: 'Adalet Bakanı Akın GÜRLEK' },
  { id: '050B9AA4-255A-4D83-8F36-01888F8AC96B', label: 'Aile Ve Sosyal Hizmetler Bakanı Mahinur ÖZDEMİR GÖKTAŞ' },
  { id: '30113760-2D92-4B49-B6B2-01888F8B7200', label: 'Çalışma Ve Sosyal Güvenlik Bakanı Vedat IŞIKHAN' },
  { id: 'F7C04932-84FF-48C2-A884-01907254761A', label: 'Çevre, Şehircilik Ve İklim Değişikliği Bakanı Murat KURUM' },
  { id: 'B268BD1D-0376-45DA-A9BA-01888F8D2BC0', label: 'Dışişleri Bakanı Hakan FİDAN' },
  { id: '33900F98-4F2F-49CD-8251-01888F8FA87B', label: 'Enerji Ve Tabii Kaynaklar Bakanı Alparslan BAYRAKTAR' },
  { id: '49F139E8-81CF-40FE-8BC6-01888F904AE4', label: 'Gençlik Ve Spor Bakanı Osman Aşkın BAK' },
  { id: '29669C6C-01A1-45D1-A3C5-01888F9110E4', label: 'Hazine Ve Maliye Bakanı Mehmet ŞİMŞEK' },
  { id: 'C37A0947-B190-4037-9D4C-019C4C9236E8', label: 'İçişleri Bakanı Mustafa ÇİFTÇİ' },
  { id: '82C6A9E5-0676-4C44-83E2-01888F92441E', label: 'Kültür Ve Turizm Bakanı Mehmet Nuri ERSOY' },
  { id: '193C5BCE-438F-4771-949A-01888F936251', label: 'Milli Eğitim Bakanı Yusuf TEKİN' },
  { id: '07041329-D38C-49C1-8E84-01888F93CF19', label: 'Milli Savunma Bakanı Yaşar GÜLER' },
  { id: '007A6836-79C8-4ECB-8152-01907343309E', label: 'Sağlık Bakanı Kemal MEMİŞOĞLU' },
  { id: 'E5FDEB55-8CD1-44AD-A06C-01888F952BB1', label: 'Sanayi Ve Teknoloji Bakanı Mehmet Fatih KACIR' },
  { id: 'E0C4FC5E-E037-4B3C-8D5A-01888F971079', label: 'Tarım Ve Orman Bakanı İbrahim YUMAKLI' },
  { id: 'D0AB6F77-A66F-45E2-A0BC-01888F97A58B', label: 'Ticaret Bakanı Ömer BOLAT' },
  { id: 'DF0A4762-181E-4EA4-86D7-01888F9889E4', label: 'Ulaştırma Ve Altyapı Bakanı Abdulkadir URALOĞLU' },
];

const CABINET_27: { id: string; label: string }[] = [
  { id: 'e3ce1232-4307-435c-b361-4ae5c53ee75a', label: 'TBMM Başkanı Mustafa ŞENTOP' },
  { id: 'BD9FADF2-93BA-4A18-9979-01888F881D3A', label: 'Cumhurbaşkanı Yardımcısı Fuat OKTAY' },
  { id: '23CAA63B-EFC8-4E3A-8E8D-019C4D4F68FC', label: 'Adalet Bakanı Bekir BOZDAĞ' },
  { id: '050B9AA4-255A-4D83-8F36-01888F8AC96B', label: 'Aile, Çalışma ve Sosyal Hizmetler Bakanı Zehra Zümrüt SELÇUK' },
  { id: '30113760-2D92-4B49-B6B2-01888F8B7200', label: 'Çevre ve Şehircilik Bakanı Murat KURUM' },
  { id: 'B268BD1D-0376-45DA-A9BA-01888F8D2BC0', label: 'Dışişleri Bakanı Mevlüt ÇAVUŞOĞLU' },
  { id: '33900F98-4F2F-49CD-8251-01888F8FA87B', label: 'Enerji ve Tabii Kaynaklar Bakanı Fatih DÖNMEZ' },
  { id: '49F139E8-81CF-40FE-8BC6-01888F904AE4', label: 'Gençlik ve Spor Bakanı Mehmet Muharrem KASAPOĞLU' },
  { id: '29669C6C-01A1-45D1-A3C5-01888F9110E4', label: 'Hazine ve Maliye Bakanı Lütfi ELVAN' },
  { id: 'C37A0947-B190-4037-9D4C-019C4C9236E8', label: 'İçişleri Bakanı Süleyman SOYLU' },
  { id: '82C6A9E5-0676-4C44-83E2-01888F92441E', label: 'Kültür ve Turizm Bakanı Mehmet Nuri ERSOY' },
  { id: '193C5BCE-438F-4771-949A-01888F936251', label: 'Milli Eğitim Bakanı Mahmut ÖZER' },
  { id: '07041329-D38C-49C1-8E84-01888F93CF19', label: 'Milli Savunma Bakanı Hulusi AKAR' },
  { id: '007A6836-79C8-4ECB-8152-01907343309E', label: 'Sağlık Bakanı Fahrettin KOCA' },
  { id: 'E5FDEB55-8CD1-44AD-A06C-01888F952BB1', label: 'Sanayi ve Teknoloji Bakanı Mustafa VARANK' },
  { id: 'E0C4FC5E-E037-4B3C-8D5A-01888F971079', label: 'Tarım ve Orman Bakanı Bekir PAKDEMİRLİ' },
  { id: 'D0AB6F77-A66F-45E2-A0BC-01888F97A58B', label: 'Ticaret Bakanı Ruhsar PEKCAN' },
  { id: 'DF0A4762-181E-4EA4-86D7-01888F9889E4', label: 'Ulaştırma ve Altyapı Bakanı Adil KARAİSMAİLOĞLU' },
];

const CABINET_26: { id: string; label: string }[] = [
  { id: 'e3ce1232-4307-435c-b361-4ae5c53ee75a', label: 'TBMM Başkanı İsmail KAHRAMAN' },
  { id: 'BD9FADF2-93BA-4A18-9979-01888F881D3A', label: 'Başbakan Binali YILDIRIM' },
  { id: '23CAA63B-EFC8-4E3A-8E8D-019C4D4F68FC', label: 'Adalet Bakanı Abdulhamit GÜL' },
  { id: '050B9AA4-255A-4D83-8F36-01888F8AC96B', label: 'Aile ve Sosyal Politikalar Bakanı Fatma Betül Sayan KAYA' },
  { id: '30113760-2D92-4B49-B6B2-01888F8B7200', label: 'Çalışma ve Sosyal Güvenlik Bakanı Jülide SARIEROĞLU' },
  { id: 'B268BD1D-0376-45DA-A9BA-01888F8D2BC0', label: 'Dışişleri Bakanı Mevlüt ÇAVUŞOĞLU' },
  { id: '33900F98-4F2F-49CD-8251-01888F8FA87B', label: 'Enerji ve Tabii Kaynaklar Bakanı Berat ALBAYRAK' },
  { id: '49F139E8-81CF-40FE-8BC6-01888F904AE4', label: 'Gençlik ve Spor Bakanı Osman Aşkın BAK' },
  { id: '29669C6C-01A1-45D1-A3C5-01888F9110E4', label: 'Maliye Bakanı Naci AĞBAL' },
  { id: 'C37A0947-B190-4037-9D4C-019C4C9236E8', label: 'İçişleri Bakanı Süleyman SOYLU' },
  { id: '82C6A9E5-0676-4C44-83E2-01888F92441E', label: 'Kültür ve Turizm Bakanı Numan KURTULMUŞ' },
  { id: '193C5BCE-438F-4771-949A-01888F936251', label: 'Milli Eğitim Bakanı İsmet YILMAZ' },
  { id: '07041329-D38C-49C1-8E84-01888F93CF19', label: 'Milli Savunma Bakanı Nurettin CANİKLİ' },
  { id: '007A6836-79C8-4ECB-8152-01907343309E', label: 'Sağlık Bakanı Ahmet DEMİRCAN' },
  { id: 'E5FDEB55-8CD1-44AD-A06C-01888F952BB1', label: 'Bilim, Sanayi ve Teknoloji Bakanı Faruk ÖZLÜ' },
  { id: 'E0C4FC5E-E037-4B3C-8D5A-01888F971079', label: 'Gıda, Tarım ve Hayvancılık Bakanı Ahmet Eşref FAKIBABA' },
  { id: 'D0AB6F77-A66F-45E2-A0BC-01888F97A58B', label: 'Gümrük ve Ticaret Bakanı Bülent TÜFENKCİ' },
  { id: 'DF0A4762-181E-4EA4-86D7-01888F9889E4', label: 'Ulaştırma, Denizcilik ve Haberleşme Bakanı Ahmet ARSLAN' },
];

const CABINET_FALLBACK: { id: string; label: string }[] = [
  { id: 'e3ce1232-4307-435c-b361-4ae5c53ee75a', label: 'TBMM Başkanlığı' },
  { id: 'BD9FADF2-93BA-4A18-9979-01888F881D3A', label: 'Başbakanlık / Cumhurbaşkanlığı' },
  { id: '23CAA63B-EFC8-4E3A-8E8D-019C4D4F68FC', label: 'Adalet Bakanlığı' },
  { id: '050B9AA4-255A-4D83-8F36-01888F8AC96B', label: 'Aile ve Sosyal Politikalar Bakanlığı' },
  { id: '30113760-2D92-4B49-B6B2-01888F8B7200', label: 'Çalışma ve Sosyal Güvenlik Bakanlığı' },
  { id: 'B268BD1D-0376-45DA-A9BA-01888F8D2BC0', label: 'Dışişleri Bakanlığı' },
  { id: '33900F98-4F2F-49CD-8251-01888F8FA87B', label: 'Enerji ve Tabii Kaynaklar Bakanlığı' },
  { id: '49F139E8-81CF-40FE-8BC6-01888F904AE4', label: 'Gençlik ve Spor Bakanlığı' },
  { id: '29669C6C-01A1-45D1-A3C5-01888F9110E4', label: 'Maliye / Hazine Bakanlığı' },
  { id: 'C37A0947-B190-4037-9D4C-019C4C9236E8', label: 'İçişleri Bakanlığı' },
  { id: '82C6A9E5-0676-4C44-83E2-01888F92441E', label: 'Kültür ve Turizm Bakanlığı' },
  { id: '193C5BCE-438F-4771-949A-01888F936251', label: 'Milli Eğitim Bakanlığı' },
  { id: '07041329-D38C-49C1-8E84-01888F93CF19', label: 'Milli Savunma Bakanlığı' },
  { id: '007A6836-79C8-4ECB-8152-01907343309E', label: 'Sağlık Bakanlığı' },
  { id: 'E5FDEB55-8CD1-44AD-A06C-01888F952BB1', label: 'Sanayi ve Teknoloji Bakanlığı' },
  { id: 'E0C4FC5E-E037-4B3C-8D5A-01888F971079', label: 'Tarım ve Orman Bakanlığı' },
  { id: 'D0AB6F77-A66F-45E2-A0BC-01888F97A58B', label: 'Ticaret Bakanlığı' },
  { id: 'DF0A4762-181E-4EA4-86D7-01888F9889E4', label: 'Ulaştırma Bakanlığı' },
];

const PARTY_MAP: Record<string, string[]> = {
  akp: ['AK PARTİ', 'AK PARTI', 'ADALET VE KALKINMA PARTİSİ', 'ADALET VE KALKINMA PARTI', 'AKP'],
  chp: ['CHP', 'CUMHURİYET HALK PARTİSİ', 'CUMHURIYET HALK PARTI'],
  mhp: ['MHP', 'MİLLİYETÇİ HAREKET PARTİSİ', 'MILLIYETCI HAREKET PARTI'],
  iyi: ['İYİ PARTİ', 'IYI PARTI', 'İYİ PARTİSİ', 'IYI PARTI'],
  saadet: ['SAADET PARTİSİ', 'SAADET PARTI'],
  gelecek: ['GELECEK PARTİSİ', 'GELECEK PARTI'],
  dem: [
    'DEM PARTİ', 'DEM PARTI', 'YEŞİL SOL PARTİ', 'YESIL SOL PARTI',
    'HALKLARIN DEMOKRATİK PARTİSİ', 'HALKLARIN DEMOKRATIK PARTI', 'HDP',
  ],
};

const SAYFA_ARASI_BEKLEME = 400;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class MotionEngine {
  private baseUrl = 'https://www.tbmm.gov.tr';
  private formUrl = `${this.baseUrl}/denetim/yazili-soru-onergeleri`;
  private queryUrl = `${this.baseUrl}/Denetim/Yazili-Soru-Onergeleri-Sonuc`;
  private listUrl = `${this.baseUrl}/Denetim/YaziliSoruOnergesiTable`;
  private detailCache = new Map<string, MotionDetail>();
  private deputyList: DeputyRecord[] | null = null;
  private headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0',
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: this.baseUrl,
    Referer: `${this.baseUrl}/Denetim/Yazili-Soru-Onergeleri-Sonuc`,
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  };

  parseOzeti(html: string): { uuid: string; vekil: string; ozet: string } {
    const $ = cheerio.load(html);
    const root = $.root().get(0) as unknown as DomNode;

    let uuid = '';
    const detailEl = $('a')
      .filter((_, e) => /Detay\//.test($(e).attr('href') ?? ''))
      .first();
    if (detailEl.length) {
      const href = detailEl.attr('href') ?? '';
      const parts = href.split('/');
      uuid = parts[parts.length - 1] ?? '';
    }

    const fullText = getText(root, '|', false).split('|');
    const vekil = (fullText[0] ?? '').trim();
    const ozet = fullText.length > 1 ? (fullText[1] ?? '').trim() : '';
    return { uuid, vekil, ozet };
  }

  extractPartyInfo(detail: Partial<MotionDetail> | Record<string, never>): {
    parties: string[];
    muhatapText: string;
  } {
    let muhatapText = '';
    let parties: string[] = [];
    const d = detail as Partial<MotionDetail>;
    if (d && Object.keys(d).length > 0 && d.ana_bilgiler) {
      muhatapText = d.ana_bilgiler['Önergenin Muhatabı'] ?? '';
      const sahibi = d.ana_bilgiler['Önerge Sahibi'] ?? '';
      if (sahibi.includes('(') && sahibi.includes(')')) {
        const m = sahibi.match(/\((.*?)\)/);
        if (m) parties = [m[1].trim()];
      }
    }
    return { parties, muhatapText };
  }

  buildMotionResult(
    item: MotionRawItem,
    ozeti: { uuid: string; vekil: string; ozet: string },
    partyInfo: { parties: string[]; muhatapText: string },
    cevaplar: MotionCevap[] = [],
  ): MotionResult {
    return {
      donem_yil: (item.donemveYasamaYili ?? null) as string | null,
      id: (item.taksimveEsasNo ?? null) as string | null,
      tarih: (item.baskanligaGelisTarihi ?? null) as string | null,
      vekil: ozeti.vekil,
      ozet: ozeti.ozet,
      parties: partyInfo.parties,
      muhatap_id: (item.onergeMuhatabiId ?? '') as string,
      muhatap_text: partyInfo.muhatapText,
      cevaplar,
      durum: (item.onergeDurumu ?? 'Bilinmiyor') as string,
      detay_url: `${this.baseUrl}/Denetim/Yazili-Soru-Onergesi-Detay/${ozeti.uuid}`,
    };
  }

  private async processItem(item: MotionRawItem, fetchParties: boolean): Promise<MotionResult> {
    const ozeti = this.parseOzeti(String(item.onergeninSahibiveOzeti ?? ''));
    let partyInfo = { parties: [] as string[], muhatapText: '' };
    let cevaplar: MotionCevap[] = [];
    if (fetchParties) {
      const detail = await this.fetchMotionDetail(ozeti.uuid);
      partyInfo = this.extractPartyInfo(detail);
      cevaplar = (detail as Partial<MotionDetail>)?.cevaplar ?? [];
    }
    return this.buildMotionResult(item, ozeti, partyInfo, cevaplar);
  }

  async transformListPage(items: MotionRawItem[]): Promise<MotionResult[]> {
    const tasks = items.map((item, i) => this.processItem(item, i < 20));
    return Promise.all(tasks);
  }

  parseMotionDetail(html: string): MotionDetail {
    const $ = cheerio.load(html);
    const root = $.root().get(0) as unknown as DomNode;

    const details: MotionDetail = {
      ana_bilgiler: {},
      cevaplar: [],
      pdf_ler: [],
      onerge_pdf_url: null,
    };

    const mainTable = $('div.blog-content.tbmm-div-list').first();
    if (mainTable.length) {
      mainTable.find('tr').each((_, tr) => {
        const tds = $(tr).find('td');
        if (tds.length === 2) {
          const key = getText(tds.get(0) as unknown as DomNode, '', true).replace(/:/g, '');
          const val = getText(tds.get(1) as unknown as DomNode, '', true);
          if (key) details.ana_bilgiler[key] = val;
        }
      });
    }

    $('a').each((_, a) => {
      const href = $(a).attr('href');
      if (href && /\.pdf/.test(href)) {
        const label = getText(a as unknown as DomNode, '', true);
        const fullUrl = href.startsWith('/') ? this.baseUrl + href : href;
        details.pdf_ler.push({ label, url: fullUrl });
        if (!details.onerge_pdf_url && (label.includes('Önerge Metni') || label.includes('Önergesinin Metni'))) {
          details.onerge_pdf_url = fullUrl;
        }
      }
    });

    const allNodes: DomNode[] = [];
    flatten(root, allNodes);
    let resIdx = -1;
    for (let i = 0; i < allNodes.length; i++) {
      const n = allNodes[i];
      if (n.type === 'text' && (n.data ?? '').includes('CEVAP BİLGİLERİ')) {
        resIdx = i;
        break;
      }
    }
    if (resIdx >= 0) {
      let resTable: DomNode | null = null;
      for (let i = resIdx + 1; i < allNodes.length; i++) {
        if (allNodes[i].type === 'tag' && allNodes[i].name === 'table') {
          resTable = allNodes[i];
          break;
        }
      }
      if (resTable) {
        const rows = descendantsByTag(resTable, 'tr');
        if (rows.length > 1) {
          for (let r = 1; r < rows.length; r++) {
            const cols = descendantsByTag(rows[r], 'td');
            if (cols.length >= 5) {
              const pdfA = firstDescendantByTag(cols[4], 'a');
              let pdf = '';
              if (pdfA) {
                const h = getAttr(pdfA, 'href') ?? '';
                pdf = h.startsWith('/') ? this.baseUrl + h : h;
              }
              details.cevaplar.push({
                order: getText(cols[0], '', true),
                birlesim: getText(cols[1], '', true),
                birlesim_tarihi: getText(cols[2], '', true),
                date: getText(cols[3], '', true),
                pdf,
                label: getText(cols[4], '', true),
              });
            }
          }
        }
      }
    }

    let lateAnswer: DomNode | null = null;
    for (const n of allNodes) {
      if (n.type === 'tag' && n.name === 'a') {
        const s = singleString(n);
        if (s !== null && /Süresi Geçtikten Sonra Gelen Cevap/.test(s)) {
          lateAnswer = n;
          break;
        }
      }
    }
    if (lateAnswer) {
      const foundInTable = details.cevaplar.some((c) => String(c.pdf ?? '').includes('Süresi Geçtikten Sonra'));
      if (!foundInTable) {
        const h = getAttr(lateAnswer, 'href') ?? '';
        details.cevaplar.push({
          order: 'Gecikmiş',
          birlesim: '-',
          birlesim_tarihi: '-',
          date: details.ana_bilgiler['Cevap Bildiriliş Tarihi'] ?? '-',
          pdf: h.startsWith('/') ? this.baseUrl + h : h,
          label: 'Gecikmiş Cevap',
        });
      }
    }

    return details;
  }

  async fetchMotionDetail(uuid: string): Promise<MotionDetail | Record<string, never>> {
    const cached = this.detailCache.get(uuid);
    if (cached) return cached;

    const url = `${this.baseUrl}/Denetim/Yazili-Soru-Onergesi-Detay/${uuid}`;
    try {
      const resp = await httpFetch(url, { headers: this.headers, timeoutMs: 30000 });
      const html = await resp.text();
      const details = this.parseMotionDetail(html);
      this.detailCache.set(uuid, details);
      return details;
    } catch (e) {
      logger.error(`Detay çekme hatası: ${(e as Error).message}`);
      return {};
    }
  }

  private absorbCookies(jar: Map<string, string>, resp: Response): void {
    const anyHeaders = resp.headers as unknown as { getSetCookie?: () => string[] };
    const cookies = anyHeaders.getSetCookie?.() ?? [];
    for (const c of cookies) {
      const pair = c.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  private cookieHeader(jar: Map<string, string>): string {
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async *searchMotionsStream(params: MotionSearchParams = {}): AsyncGenerator<MotionStreamEvent> {
    const {
      keyword = '', after = '', before = '', status = '', term = '', year = '',
      deputy = '', addressed_to = '', file_no = '', last_term_only = 'true', party = '',
      first_signer_only = 'false', ping = 'false',
    } = params;

    yield { step: 'starting', message: 'Meclis veri hattı hazırlanıyor...', progress: 10 };

    const sd = after ? after.split('-').reverse().join('-').replace(/-/g, '.') : '';
    const ed = before ? before.split('-').reverse().join('-').replace(/-/g, '.') : '';

    try {
      const jar = new Map<string, string>();

      const formResp = await httpFetch(this.formUrl, { headers: this.headers, timeoutMs: 60000 });
      this.absorbCookies(jar, formResp);
      const formHtml = await formResp.text();
      const $f = cheerio.load(formHtml);
      let csrfToken = $f('input[name="X-CSRF-TOKEN-TBMM.WEB.Mvc.Prod"]').attr('value') ?? '';
      if (!csrfToken) csrfToken = jar.get('X-CSRF-TOKEN-TBMM.WEB.Mvc.Prod') ?? '';

      const reqHeaders: Record<string, string> = { ...this.headers };
      if (csrfToken) reqHeaders['X-CSRF-TOKEN-TBMM.WEB.Mvc.Prod'] = csrfToken;

      yield { step: 'processing', message: 'Oturum doğrulandı.', progress: 30 };

      const heat = new URLSearchParams();
      heat.set('X-CSRF-TOKEN-TBMM.WEB.Mvc.Prod', csrfToken);
      heat.set('AranacakKelime', keyword);
      heat.set('DurumId', status || '');
      heat.set('BaslangicTarihi', sd);
      heat.set('BitisTarihi', ed);
      heat.set('SonDonemMi', term ? 'false' : last_term_only);
      heat.set('IlkImzaSahibi', first_signer_only);
      if (year) heat.set('YasamaYiliId', year);
      if (deputy) heat.set('OnergeSahibiId', deputy);
      if (addressed_to) heat.set('OnergeMuhatabiId', addressed_to);
      if (file_no) heat.set('EsasNo', file_no);
      if (term) heat.set('GecmisDonemId', term);

      const heatResp = await httpFetch(this.queryUrl, {
        method: 'POST',
        headers: { ...reqHeaders, Cookie: this.cookieHeader(jar) },
        body: heat,
        timeoutMs: 60000,
      });
      this.absorbCookies(jar, heatResp);

      const finalPayload = new URLSearchParams();
      finalPayload.set('draw', '1');
      finalPayload.set('start', '0');
      finalPayload.set('length', ping === 'true' ? '1' : '500');
      finalPayload.set('order[0][column]', params.sort_column ?? '2');
      finalPayload.set('order[0][dir]', params.sort_dir ?? 'asc');
      finalPayload.set('search[value]', '');
      finalPayload.set('search[regex]', 'false');
      finalPayload.set('AranacakKelime', keyword);
      finalPayload.set('SonDonemMi', term ? 'false' : last_term_only);
      finalPayload.set('IlkImzaSahibi', first_signer_only);
      finalPayload.set('DurumId', status || '');
      finalPayload.set('BaslangicTarihi', sd);
      finalPayload.set('BitisTarihi', ed);
      finalPayload.set('GecmisDonemId', term || '');
      finalPayload.set('OnergeMuhatabiBilgi', '');
      finalPayload.set('OnergeTipKodu', '');
      if (year) finalPayload.set('YasamaYiliId', year);
      if (deputy) finalPayload.set('OnergeSahibiId', deputy);
      if (addressed_to) finalPayload.set('OnergeMuhatabiId', addressed_to);
      if (file_no) finalPayload.set('EsasNo', file_no);

      const cols = ['TaksimveEsasNo', 'YasamaYili', 'EsasNo', 'BaskanligaGelisTarihiDt', 'OnergeninSahibiveOzeti'];
      cols.forEach((colName, i) => {
        finalPayload.set(
          `columns[${i}][data]`,
          i !== 4 ? colName[0].toLowerCase() + colName.slice(1) : 'onergeninSahibiveOzeti',
        );
        finalPayload.set(`columns[${i}][name]`, colName);
        finalPayload.set(`columns[${i}][searchable]`, 'true');
        finalPayload.set(`columns[${i}][orderable]`, i !== 0 ? 'true' : 'false');
        finalPayload.set(`columns[${i}][search][value]`, '');
        finalPayload.set(`columns[${i}][search][regex]`, 'false');
      });

      const response = await fetchWithBackoff(this.listUrl, {
        method: 'POST',
        headers: { ...reqHeaders, Cookie: this.cookieHeader(jar) },
        body: finalPayload,
        timeoutMs: 60000,
      });

      if (response.status !== 200) {
        const preview = (await response.text()).slice(0, 100);
        logger.error(`Meclis Hatası: ${response.status} | ${preview}`);
        throw new Error(`Meclis Sunucusu Erişilemez (Hata: ${response.status})`);
      }

      let rawData: { data?: MotionRawItem[]; recordsTotal?: number };
      try {
        rawData = (await response.json()) as { data?: MotionRawItem[]; recordsTotal?: number };
      } catch {
        throw new Error('Meclis veri formatı değişti veya oturum geçersiz. Lütfen tekrar deneyin.');
      }

      let items: MotionRawItem[] = rawData.data ?? [];
      const totalRecords = rawData.recordsTotal ?? 0;
      const pageHasKnown = (arr: MotionRawItem[]): boolean =>
        !!params.knownIds && arr.some((it) => params.knownIds!.has(String(it.taksimveEsasNo ?? '')));

      if (ping === 'true') {
        items = items.slice(0, 1);
      } else if (!pageHasKnown(items)) {
        let start = 500;
        let draw = 1;
        let kesinti: string | null = null;
        while (start < totalRecords) {
          await sleep(SAYFA_ARASI_BEKLEME);
          finalPayload.set('start', String(start));
          draw += 1;
          finalPayload.set('draw', String(draw));
          try {
            const pageResp = await httpFetch(this.listUrl, {
              method: 'POST',
              headers: { ...reqHeaders, Cookie: this.cookieHeader(jar) },
              body: finalPayload,
              timeoutMs: 60000,
            });
            if (pageResp.status === 200) {
              const pageData = (await pageResp.json()) as { data?: MotionRawItem[] };
              const pd = pageData.data ?? [];
              items.push(...pd);
              if (pageHasKnown(pd)) break;
            } else {
              kesinti = `HTTP ${pageResp.status} (start=${start})`;
              break;
            }
          } catch (e) {
            kesinti = `ağ/ayrıştırma hatası (start=${start}): ${(e as Error).message}`;
            break;
          }
          start += 500;
          if (start % 2000 === 0) {
            yield {
              step: 'counting',
              message: `${items.length} / ${totalRecords} kayıt indirildi...`,
              progress: 40 + Math.trunc((start / totalRecords) * 30),
            };
          }
        }
        if (kesinti) {
          throw new Error(
            `[motion] Liste çekimi YARIDA KESİLDİ — ${kesinti}. Elde ${items.length}/${totalRecords} kayıt var; ` +
            `yarım liste YAZILMAZ (law.ts'te aynı sınıf sessiz kesilme 47 kanunu kaybetmişti).`,
          );
        }
        if (ping !== 'true' && !params.knownIds && totalRecords > 0 && items.length < totalRecords) {
          throw new Error(
            `[motion] EKSİK LİSTE: sunucu ${totalRecords} kayıt bildiriyor, ${items.length} toplanabildi ` +
            `(${totalRecords - items.length} eksik). Yarım liste YAZILMAZ — yeniden koşulmalı.`,
          );
        }
      }

      yield { step: 'counting', message: `Toplam ${items.length} kayıt işleniyor...`, progress: 70 };
      yield { step: 'processing', message: 'Parti dağılımları hesaplanıyor...', progress: 85 };

      let results = await this.transformListPage(items);

      if (party) {
        results = this.filterByParty(results, party);
      }

      yield { step: 'finished', message: 'Tamamlandı.', progress: 100, data: results, total: totalRecords };
    } catch (e) {
      logger.error(`Error: ${(e as Error).message}`);
      yield { step: 'error', message: (e as Error).message, progress: 0 };
    }
  }

  private cleanStr(name: string): string {
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
    return n.split(/\s+/).filter(Boolean).join(' ');
  }

  private loadDeputyList(): DeputyRecord[] {
    if (this.deputyList) return this.deputyList;
    const file = join(PROJECT_ROOT, 'deputy_master_list.json');
    if (existsSync(file)) {
      try {
        this.deputyList = JSON.parse(readFileSync(file, 'utf-8')) as DeputyRecord[];
        return this.deputyList;
      } catch {
      }
    }
    return [];
  }

  private filterByParty(results: MotionResult[], party: string): MotionResult[] {
    const deputyList = this.loadDeputyList();
    const filtered: MotionResult[] = [];
    for (const motion of results) {
      const vekilClean = this.cleanStr(motion.vekil ?? '');
      let matchedParty = 'DİĞER';
      for (const dep of deputyList) {
        const depNameClean = this.cleanStr(dep.ad_soyad ?? '');
        if (depNameClean && depNameClean.length > 3 && vekilClean.includes(depNameClean)) {
          const depParty = dep.parti ?? '';
          if (depParty) {
            const depPartyClean = this.cleanStr(depParty);
            let foundStandard = false;
            for (const [stdKey, aliases] of Object.entries(PARTY_MAP)) {
              if (aliases.some((alias) => depPartyClean.includes(alias))) {
                matchedParty = stdKey.toUpperCase();
                foundStandard = true;
                break;
              }
            }
            if (!foundStandard) matchedParty = depPartyClean;
          }
          break;
        }
      }

      if (matchedParty === 'DİĞER' && motion.parties && motion.parties.length) {
        const pRaw = this.cleanStr(motion.parties[0]);
        for (const [stdKey, aliases] of Object.entries(PARTY_MAP)) {
          if (aliases.some((alias) => pRaw.includes(alias))) {
            matchedParty = stdKey.toUpperCase();
            break;
          }
        }
      }

      if (matchedParty.toUpperCase() === party.toUpperCase()) filtered.push(motion);
    }
    return filtered;
  }

  parseFilters(html: string, term = '00000000-0000-0000-0000-000000000000'): MotionFilters {
    let addressedTo: { id: string; label: string }[];
    if (term === '259b36bd-897d-41a3-b457-0182c6cf153f') addressedTo = CABINET_27;
    else if (term === 'e39d73fc-dc0f-48e1-a8ed-019c4d4f68fc') addressedTo = CABINET_26;
    else if (term === '00000000-0000-0000-0000-000000000000') addressedTo = CABINET_28;
    else addressedTo = CABINET_FALLBACK;

    const $ = cheerio.load(html);
    const filters: MotionFilters = {
      terms: TERMS,
      years: [],
      deputies: [],
      parties: [],
      addressed_to: addressedTo,
      statuses: [],
    };

    const readSelect = (id: string): FilterOption[] => {
      const sel = $(`select#${id}`).first();
      if (!sel.length) return [];
      const out: FilterOption[] = [];
      sel.find('option').each((_, o) => {
        const node = o as unknown as DomNode;
        const value = getAttr(node, 'value');
        if (value) out.push({ id: value, label: getText(node, '', false).trim() });
      });
      return out;
    };

    filters.years = readSelect('YasamaYiliId');
    filters.deputies = readSelect('OnergeSahibiId');
    filters.parties = readSelect('SiyasiPartiId');
    filters.statuses = readSelect('DurumId');
    return filters;
  }

  async getMetadataFilters(term = '00000000-0000-0000-0000-000000000000'): Promise<MotionFilters> {
    let addressedTo: { id: string; label: string }[];
    if (term === '259b36bd-897d-41a3-b457-0182c6cf153f') addressedTo = CABINET_27;
    else if (term === 'e39d73fc-dc0f-48e1-a8ed-019c4d4f68fc') addressedTo = CABINET_26;
    else if (term === '00000000-0000-0000-0000-000000000000') addressedTo = CABINET_28;
    else addressedTo = CABINET_FALLBACK;

    try {
      const resp = await httpFetch(this.formUrl, { headers: this.headers, timeoutMs: 10000 });
      const html = await resp.text();
      return this.parseFilters(html, term);
    } catch (e) {
      logger.error(`Filtre çekiminde hata: ${(e as Error).message}`);
      return {
        terms: TERMS,
        years: [],
        deputies: [],
        parties: [],
        addressed_to: addressedTo,
        statuses: [],
      };
    }
  }
}
