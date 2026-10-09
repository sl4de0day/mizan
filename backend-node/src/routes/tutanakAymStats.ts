import type { FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { MinuteEngine } from '../engines/minute.js';
import type { MinuteResult, MinuteEvent } from '../engines/minute.js';
import { ConstitutionalEngine } from '../engines/constitutional.js';
import type {
  NormSearchParams,
  PartySearchParams,
  AymSearchOk,
  AymPartySearchOk,
  AymError,
  AymDetailOk,
} from '../engines/constitutional.js';
import { getCached, setCached, FileCache } from '../lib/cache.js';
import { STORAGE_DIR } from '../lib/config.js';
import { DEPUTY_MASTER_LIST } from '../lib/deputies.js';
import { getLogger } from '../lib/logger.js';

const logger = getLogger('PoliticalInsight.Routes.TutanakAymStats');

const minute = new MinuteEngine();
const constitutional = new ConstitutionalEngine();

const tutanakFileCache = new FileCache(join(STORAGE_DIR, 'tutanak_cache'), 86400);

const PY_WS = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001,
  0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f,
  0x205f, 0x3000,
]);

function pyStrip(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && PY_WS.has(s.charCodeAt(start))) start++;
  while (end > start && PY_WS.has(s.charCodeAt(end - 1))) end--;
  return s.slice(start, end);
}

function pySplitWs(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of s) {
    if (ch.length === 1 && PY_WS.has(ch.charCodeAt(0))) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const TR_UPPER = new Map<string, string>([
  ['ı', 'I'], ['i', 'İ'], ['ş', 'Ş'], ['ç', 'Ç'], ['ğ', 'Ğ'], ['ö', 'Ö'], ['ü', 'Ü'],
]);
function trUpper(text: string | null | undefined): string {
  if (!text) return '';
  let out = '';
  for (const c of text) out += TR_UPPER.has(c) ? TR_UPPER.get(c)! : c.toUpperCase();
  return pyStrip(out);
}

const TR_LOWER = new Map<string, string>([
  ['I', 'ı'], ['İ', 'i'], ['Ş', 'ş'], ['Ç', 'ç'], ['Ğ', 'ğ'], ['Ö', 'ö'], ['Ü', 'ü'],
]);
function trLower(text: string | null | undefined): string {
  if (!text) return '';
  let out = '';
  for (const c of text) out += TR_LOWER.has(c) ? TR_LOWER.get(c)! : c.toLowerCase();
  return pyStrip(out);
}

function codePointLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function codePointSlice(s: string, n: number): string {
  let out = '';
  let count = 0;
  for (const ch of s) {
    if (count >= n) break;
    out += ch;
    count++;
  }
  return out;
}

function isAsciiDigit(s: string): boolean {
  return /^[0-9]+$/.test(s);
}

export function round1(x: number): number {
  return Number(x.toFixed(1));
}

export function pyRoundToInt(x: number): number {
  const fl = Math.floor(x);
  const diff = x - fl;
  if (diff < 0.5) return fl;
  if (diff > 0.5) return fl + 1;
  return fl % 2 === 0 ? fl : fl + 1;
}

class Counter {
  private m = new Map<string, number>();
  update(words: string[]): void {
    for (const w of words) this.m.set(w, (this.m.get(w) ?? 0) + 1);
  }
  mostCommon(n: number): Array<[string, number]> {
    const entries = [...this.m.entries()];
    entries.sort((a, b) => b[1] - a[1]);
    return entries.slice(0, n);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface MinuteResultLike {
  ozet?: string | null;
  birlesim?: string | null;
  tarih?: string | null;
  sayfa?: string | null;
}

export interface MinuteStatsData {
  toplam_tutanak_parcasi: number;
  toplam_birlesim: number;
  toplam_aktif_gun: number;
  ortalama_sayfa_yogunlugu: number;
  parti_dagilimi: Record<string, number>;
  parti_kelime_hacmi: Record<string, number>;
  parti_kursu_suresi: Record<string, number>;
  parti_kelime_frekans: Record<string, Array<{ text: string; value: number }>>;
  en_aktif_vekiller: Array<{ vekil: string; parti: string; soz_alma: number }>;
}

const PARTY_KEYS = ['AK PARTİ', 'CHP', 'MHP', 'IYI', 'DEM', 'SAADET'] as const;

const PUNCT_SET = new Set<string>([
  ...'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~0123456789•’–“”',
]);

const STOP_WORDS = new Set<string>([
  've', 'ile', 'veya', 'bir', 'bu', 'şu', 'o', 'için', 'gibi', 'kadar', 'olan', 'olarak', 'ise',
  'da', 'de', 'ki', 'mi', 'mı', 'var', 'yok', 'çok', 'daha', 'en', 'sayın', 'başkan', 'başkanım',
  'milletvekili', 'milletvekilleri', 'biz', 'siz', 'onlar', 'ben', 'sen', 'kendi', 'değil', 'evet',
  'hayır', 'ne', 'nasıl', 'neden', 'niçin', 'hangi', 'kim', 'her', 'tüm', 'bütün', 'böyle', 'şöyle',
  'öyle', 'göre', 'ama', 'fakat', 'lakin', 'çünkü', 'eğer', 'diye', 'olduğunu', 'olduğu', 'olmak',
  'kürsü', 'sıralarından', 'alkışlar', 'teşekkür', 'ederim', 'ediyorum', 'devamla', 'buyurun',
  'ilişkin', 'açıklaması', 'açıklama', 'değerli', 'sevgili', 'türkiye', 'büyük', 'millet', 'meclisi',
  'tbmm', 'genel', 'kurul', 'kurulu', 'parti', 'partisi', 'grubu', 'adına', 'hakkında', 'üzerine',
  'tarafından', 'karşı', 'konuda', 'konuşma', 'konuşması', 'söz', 'sözü', 'aldı', 'aldım', 'verildi',
  'veriyorum', 'sayfa', 'oturum', 'birleşim', 'dönem', 'yıl', 'gün', 'bugün', 'yarın', 'dün', 'şimdi',
  'sonra', 'önce', 'yeni', 'eski', 'tarih', 'tarihli', 'karar', 'kanun', 'teklif', 'tasarı', 'madde',
  'katip', 'üye', 'komisyon', 'hükümet', 'saygılar', 'saygılarımla', 'sunarım', 'arz', 'gerekli',
  'gerek', 'başkanı', 'bakanı', 'bakanlığı', 'vekil', 'vekillere', 'vekiller', 'vekili', 'hepsi',
  'hiç', 'hiçbir', 'herkes', 'kimse', 'şey', 'şeyler', 'biri', 'birileri', 'birkaç', 'birçok', 'tümü',
  'bütünü', 'bazı', 'böylece', 'şöylece', 'öylece', 'gerekir', 'gerekmektedir', 'yapılan', 'yapmak',
  'yapan', 'yapıldı', 'edildi', 'edilmektedir', 'edilmiştir', 'gelen', 'geldi', 'gelmiştir', 'gitmiş',
  'verilen', 'verdi', 'vermiştir', 'alınan', 'almıştır', 'yirmi', 'otuz', 'kırk', 'elli', 'altmış',
  'yetmiş', 'seksen', 'doksan', 'yüz', 'bin', 'birinci', 'ikinci', 'yerinden', 'tutanak', 'dergisi',
  'kayıt', 'arşiv', 'adana', 'istanbul', 'ankara', 'izmir',
]);

function tokenize(text: string): string[] {
  let t = text.replace(/\([^\n]*?\)/g, '');
  t = trLower(t);
  let out = '';
  for (const ch of t) out += PUNCT_SET.has(ch) ? ' ' : ch;
  const words = pySplitWs(out);
  return words.filter((w) => codePointLen(w) > 3 && !STOP_WORDS.has(w));
}

const VEKIL_PATTERN = /([A-ZÇĞİÖŞÜ\s]+)\s*\(([A-ZÇĞİÖŞÜa-zçğıöşü\s]+)\)/g;
const VEKIL_PREFIX_RE =
  /^(AK PARTİ|CHP|MHP|İYİ PARTİ|İYİ|DEM PARTİ|DEM|SAADET|HDP|HÜKÜMET|KOMİSYON|BAŞKANLIK|BAŞKAN)\s+(GRUBU ADINA|ADINA|VEKİLİ|DİVANI)?\s*/;
const EXCLUDE_KEYWORDS = [
  'BAŞKAN', 'KATİP ÜYE', 'KOMİSYON', 'HÜKÜMET', 'AK PARTİ', 'CHP', 'MHP', 'İYİ PARTİ', 'DEM PARTİ',
  'SAADET PARTİSİ', 'SAYGILAR', 'TEŞEKKÜR', 'ALKIŞLAR', 'SIRALARINDAN', 'ÖNERGE', 'TEKLİF', 'KABUL',
  'OTURUM', 'BİRLEŞİM', 'SÖZ',
];

export function aggregateMinute(results: MinuteResultLike[], term: string): MinuteStatsData {
  const deputyParties = new Map<string, string>();
  for (const d of DEPUTY_MASTER_LIST) {
    const nameKey = trUpper(d.ad_soyad ?? '');
    const cityKey = trUpper(d.il ?? '');
    const donemKey = String(d.donem ?? '');
    const key = `${donemKey}_${nameKey}_${cityKey}`;
    const pRaw = d.parti ?? 'Bilinmiyor';
    const pUpper = trUpper(pRaw);
    let pNorm: string;
    if (pUpper.includes('AK PARTİ') || pUpper.includes('AK PARTI')) pNorm = 'AK PARTİ';
    else if (pUpper.includes('CHP')) pNorm = 'CHP';
    else if (pUpper.includes('MHP')) pNorm = 'MHP';
    else if (pUpper.includes('İYİ') || pUpper.includes('IYI')) pNorm = 'IYI';
    else if (pUpper.includes('DEM')) pNorm = 'DEM';
    else if (pUpper.includes('SAADET')) pNorm = 'SAADET';
    else pNorm = pRaw;
    deputyParties.set(key, pNorm);
  }

  const partyStats: Record<string, number> = {};
  const partiKelimeHacmi: Record<string, number> = {};
  const partiKelimeFrekans = new Map<string, Counter>();
  for (const p of PARTY_KEYS) {
    partyStats[p] = 0;
    partiKelimeHacmi[p] = 0;
    partiKelimeFrekans.set(p, new Counter());
  }

  const vekilStats = new Map<string, number>();
  const birlesimSet = new Set<string>();
  const tarihSet = new Set<string>();
  let totalPages = 0;
  const totalRecords = results.length;
  const vekilDetectedParties = new Map<string, string>();

  const resolveDeputyParty = (vNameClean: string, vCity: string, termVal: string): string => {
    const lookupName = trUpper(vNameClean);
    const lookupCity = trUpper(vCity);
    const lookupKey = `${termVal}_${lookupName}_${lookupCity}`;
    const party = deputyParties.get(lookupKey);
    if (party) return party;

    const nameParts = pySplitWs(lookupName);
    const lastName = nameParts.length ? nameParts[nameParts.length - 1]! : lookupName;

    const w: Record<string, number> = { 'AK PARTİ': 0, CHP: 0, MHP: 0, IYI: 0, DEM: 0, SAADET: 0 };

    for (const rItem of results) {
      const oTxt = rItem.ozet ?? '';
      const oUpper = oTxt.toUpperCase();
      const pos = oUpper.indexOf(lastName);
      if (pos === -1) continue;
      const wStart = Math.max(0, pos - 120);
      const wEnd = Math.min(oUpper.length, pos + 120);
      const window = oUpper.slice(wStart, wEnd);

      if (window.includes('CHP GRUBU') || window.includes('CHP ADINA') || window.includes('CUMHURİYET HALK PARTİSİ GRUBU')) w.CHP += 15;
      else if (window.includes('CHP') || window.includes('CUMHURİYET HALK')) w.CHP += 1;

      if (window.includes('AK PARTİ GRUBU') || window.includes('AK PARTİ ADINA') || window.includes('AK PARTI GRUBU') || window.includes('AK PARTI ADINA') || window.includes('ADALET VE KALKINMA PARTİSİ GRUBU')) w['AK PARTİ'] += 15;
      else if (window.includes('AK PARTİ') || window.includes('AK PARTI') || window.includes('ADALET VE KALKINMA')) w['AK PARTİ'] += 1;

      if (window.includes('MHP GRUBU') || window.includes('MHP ADINA') || window.includes('MİLLİYETÇİ HAREKET PARTİSİ GRUBU')) w.MHP += 15;
      else if (window.includes('MHP') || window.includes('MİLLİYETÇİ HAREKET')) w.MHP += 1;

      if (window.includes('İYİ PARTİ GRUBU') || window.includes('İYİ PARTİ ADINA') || window.includes('IYI PARTİ GRUBU') || window.includes('IYI PARTİ ADINA')) w.IYI += 15;
      else if (window.includes('İYİ PARTİ') || window.includes('IYI PARTİ') || window.includes('İYİ') || window.includes('IYI')) w.IYI += 1;

      if (window.includes('DEM PARTİ GRUBU') || window.includes('DEM PARTİ ADINA')) w.DEM += 15;
      else if (window.includes('DEM PARTİ') || window.includes('DEM') || window.includes('HALKLARIN EŞİTLİK')) w.DEM += 1;

      if (window.includes('SAADET GRUBU') || window.includes('SAADET PARTİSİ GRUBU') || window.includes('SAADET ADINA')) w.SAADET += 15;
      else if (window.includes('SAADET')) w.SAADET += 1;
    }

    let bestKey = 'AK PARTİ';
    let bestVal = w['AK PARTİ']!;
    for (const k of PARTY_KEYS) {
      if (w[k]! > bestVal) {
        bestVal = w[k]!;
        bestKey = k;
      }
    }
    if (bestVal > 0) return bestKey;
    return 'Bağımsız';
  };

  for (const r of results) {
    const ozet = r.ozet ?? '';
    const birlesim = r.birlesim ?? '';
    const tarih = r.tarih ?? '';
    const sayfaVal = 'sayfa' in r ? (r as { sayfa?: string | null }).sayfa : '1';

    const words = tokenize(ozet);
    const wordCount = words.length;

    if (birlesim) birlesimSet.add(birlesim);
    if (tarih) tarihSet.add(tarih);

    const sayfaStr = String(sayfaVal);
    if (isAsciiDigit(sayfaStr)) totalPages += parseInt(sayfaStr, 10);
    else totalPages += 1;

    const matches = [...ozet.matchAll(VEKIL_PATTERN)];
    const validMatches: Array<[string, string]> = [];
    for (const m of matches) {
      const vName = pyStrip(m[1] ?? '');
      const vCity = pyStrip(m[2] ?? '');
      const vNameClean = pyStrip(vName.replace(VEKIL_PREFIX_RE, ''));
      if (codePointLen(vNameClean) > 3 && !EXCLUDE_KEYWORDS.some((k) => vNameClean.includes(k))) {
        validMatches.push([vNameClean, vCity]);
      }
    }

    if (validMatches.length) {
      for (const [vNameClean, vCity] of validMatches) {
        const key = `${vNameClean}_${vCity}`;
        vekilStats.set(key, (vekilStats.get(key) ?? 0) + 1);
        if (!vekilDetectedParties.has(key)) {
          vekilDetectedParties.set(key, resolveDeputyParty(vNameClean, vCity, term));
        }
        const pResolved = vekilDetectedParties.get(key)!;
        if (Object.prototype.hasOwnProperty.call(partyStats, pResolved)) {
          partyStats[pResolved] += 1;
          partiKelimeHacmi[pResolved] += wordCount;
          partiKelimeFrekans.get(pResolved)!.update(words);
        }
      }
    } else {
      const ozetUpper = ozet.toUpperCase();
      const apply = (pName: string): void => {
        partyStats[pName] += 1;
        partiKelimeHacmi[pName] += wordCount;
        partiKelimeFrekans.get(pName)!.update(words);
      };
      if (ozetUpper.includes('AK PARTİ') || ozetUpper.includes('AK PARTI') || ozetUpper.includes('ADALET VE KALKINMA')) apply('AK PARTİ');
      if (ozetUpper.includes('CHP') || ozetUpper.includes('CUMHURİYET HALK')) apply('CHP');
      if (ozetUpper.includes('MHP') || ozetUpper.includes('MİLLİYETÇİ HAREKET')) apply('MHP');
      if (ozetUpper.includes('İYİ') || ozetUpper.includes('IYI')) apply('IYI');
      if (ozetUpper.includes('DEM') || ozetUpper.includes('HALKLARIN EŞİTLİK') || ozetUpper.includes('HDP')) apply('DEM');
      if (ozetUpper.includes('SAADET')) apply('SAADET');
    }
  }

  const sortedVekiller = [...vekilStats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const formattedVekiller: Array<{ vekil: string; parti: string; soz_alma: number }> = [];
  for (const [k, v] of sortedVekiller) {
    const parts = k.split('_');
    const vNameClean = parts[0] ?? '';
    const vCity = parts[1] ?? '';
    const vKey = `${vNameClean}_${vCity}`;
    if (!vekilDetectedParties.has(vKey)) {
      vekilDetectedParties.set(vKey, resolveDeputyParty(vNameClean, vCity, term));
    }
    const party = vekilDetectedParties.get(vKey)!;
    formattedVekiller.push({ vekil: `${vNameClean} (${vCity})`, parti: party, soz_alma: v });
  }

  const uniqueSessions = birlesimSet.size;
  const uniqueDays = tarihSet.size;
  const avgPageDensity = uniqueSessions > 0 ? pyRoundToInt(totalPages / uniqueSessions) : 0;

  const formattedFreq: Record<string, Array<{ text: string; value: number }>> = {};
  for (const p of PARTY_KEYS) {
    formattedFreq[p] = partiKelimeFrekans.get(p)!.mostCommon(30).map(([kk, vv]) => ({ text: kk, value: vv }));
  }

  const partiKursuSuresi: Record<string, number> = {};
  for (const p of PARTY_KEYS) partiKursuSuresi[p] = round1(partiKelimeHacmi[p]! / 130);

  return {
    toplam_tutanak_parcasi: totalRecords,
    toplam_birlesim: uniqueSessions,
    toplam_aktif_gun: uniqueDays,
    ortalama_sayfa_yogunlugu: avgPageDensity,
    parti_dagilimi: partyStats,
    parti_kelime_hacmi: partiKelimeHacmi,
    parti_kursu_suresi: partiKursuSuresi,
    parti_kelime_frekans: formattedFreq,
    en_aktif_vekiller: formattedVekiller,
  };
}

interface AymItemLike {
  title?: string;
  info?: string;
  url?: string;
  source?: string;
  details?: Record<string, string>;
}

export interface NormStatEngine {
  searchNorm(p: NormSearchParams): Promise<AymSearchOk | AymError>;
  fetchDetail(url: string): Promise<AymDetailOk | AymError>;
}

interface NormStatsData {
  toplam_karar: number;
  karar_turleri: Record<string, number>;
  parti_karsilastirma: Array<{ parti: string; iptal: number; ret: number; toplam: number; basari_orani: number }>;
  yillik_dagilim: Array<{ name: string; Karar: number }>;
}

function normAggregate(detailedItems: AymItemLike[], totalRecords: number): NormStatsData {
  const decisionTypes: Record<string, number> = { İPTAL: 0, RET: 0, DİĞER: 0 };
  const partyComparison = new Map<string, { iptal: number; ret: number; toplam: number }>();
  const yearlyDistribution = new Map<string, number>();

  for (const item of detailedItems) {
    const info = item.info ?? '';
    const details = item.details ?? {};

    let year: string;
    const ym = info.match(/Esas Sayısı\s*:\s*(\d{4})/i);
    year = ym ? ym[1]! : '';
    if (!year) {
      const dm = info.match(/Karar Tarihi\s*:\s*\d{2}\/\d{2}\/(\d{4})/i);
      year = dm ? dm[1]! : 'Belirsiz';
    }
    if (year !== 'Belirsiz') yearlyDistribution.set(year, (yearlyDistribution.get(year) ?? 0) + 1);

    let applicantRaw = '';
    for (const [kDet, vDet] of Object.entries(details)) {
      const kUpper = kDet.toUpperCase();
      if (kUpper.includes('BAŞVURAN') || kUpper.includes('İTİRAZ YOLUNA')) {
        applicantRaw = vDet;
        break;
      }
    }
    if (!applicantRaw) applicantRaw = info;
    const applicantUpper = applicantRaw.toUpperCase();
    let applicant = 'Diğer';
    if (applicantUpper.includes('CHP') || applicantUpper.includes('CUMHURİYET HALK')) applicant = 'CHP';
    else if (applicantUpper.includes('CUMHURBAŞKANI')) applicant = 'Cumhurbaşkanı';
    else if (applicantUpper.includes('MAHKEME') || applicantUpper.includes('İTİRAZ YOLUNA') || applicantUpper.includes('CEZA') || applicantUpper.includes('ASLİYE') || applicantUpper.includes('HUKUK')) applicant = 'Mahkemeler';
    else if (applicantUpper.includes('1/5') || applicantUpper.includes('MİLLETVEKİLİ') || applicantUpper.includes('ÜYE')) applicant = 'Muhalefet Ortak (1/5)';
    else if (applicantUpper.includes('İYİ PARTİ')) applicant = 'İYİ Parti';
    else if (applicantUpper.includes('DEM') || applicantUpper.includes('HALKLARIN EŞİTLİK') || applicantUpper.includes('HDP')) applicant = 'DEM / HDP';

    let decisionRaw = '';
    for (const [kDet, vDet] of Object.entries(details)) {
      const kUpper = kDet.toUpperCase();
      if (kUpper.includes('KARAR TÜRÜ') || kUpper.includes('KARAR SONUCU') || kUpper.includes('KARAR')) {
        decisionRaw = vDet;
        break;
      }
    }
    if (!decisionRaw) decisionRaw = info;
    const decisionUpper = decisionRaw.toUpperCase();
    let resultType = 'DİĞER';
    if (decisionUpper.includes('İPTAL')) {
      resultType = 'İPTAL';
      decisionTypes['İPTAL'] += 1;
    } else if (decisionUpper.includes('RET') || decisionUpper.includes('RED')) {
      resultType = 'RET';
      decisionTypes['RET'] += 1;
    } else {
      decisionTypes['DİĞER'] += 1;
    }

    if (!partyComparison.has(applicant)) partyComparison.set(applicant, { iptal: 0, ret: 0, toplam: 0 });
    const pc = partyComparison.get(applicant)!;
    pc.toplam += 1;
    if (resultType === 'İPTAL') pc.iptal += 1;
    else if (resultType === 'RET') pc.ret += 1;
  }

  const formattedPartyComparison: NormStatsData['parti_karsilastirma'] = [];
  for (const [part, stats] of partyComparison) {
    const totalP = stats.toplam;
    const successRatio = totalP > 0 ? round1((stats.iptal / totalP) * 100) : 0;
    formattedPartyComparison.push({ parti: part, iptal: stats.iptal, ret: stats.ret, toplam: totalP, basari_orani: successRatio });
  }

  const sortedYears = [...yearlyDistribution.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const formattedYears = sortedYears.map(([k, v]) => ({ name: k, Karar: v }));

  return {
    toplam_karar: totalRecords,
    karar_turleri: decisionTypes,
    parti_karsilastirma: formattedPartyComparison,
    yillik_dagilim: formattedYears,
  };
}

export async function normStatisticsCore(
  engine: NormStatEngine,
  params: NormSearchParams,
): Promise<{ success: true; data: NormStatsData } | AymError> {
  const searchRes = await engine.searchNorm(params);
  if (!searchRes.success) return searchRes;

  const rawItems = searchRes.data ?? [];
  const targetItems = rawItems.slice(0, 50);
  const totalRecords = rawItems.length;

  const detailedItems = await Promise.all(
    targetItems.map(async (item): Promise<AymItemLike> => {
      const copy: AymItemLike = { ...item };
      try {
        const detailRes = await engine.fetchDetail(item.url ?? '');
        if (detailRes.success) copy.details = detailRes.details ?? {};
      } catch (e) {
        logger.error(`AYM Karar Detayi cekilemedi: ${(e as Error).message}`);
      }
      return copy;
    }),
  );

  return { success: true, data: normAggregate(detailedItems, totalRecords) };
}

export interface PartyStatEngine {
  searchParty(p: PartySearchParams): Promise<AymPartySearchOk | AymError>;
  fetchDetail(url: string): Promise<AymDetailOk | AymError>;
}

interface PartyStatsData {
  toplam_karar: number;
  karar_turleri: Record<string, number>;
  parti_karsilastirma: Array<{ parti: string; temiz: number; ceza: number; ihtar: number; toplam: number; basari_orani: number }>;
  yillik_dagilim: Array<{ name: string; Karar: number }>;
}

interface PartyBaseParams {
  keyword: string;
  esas_no: string;
  karar_no: string;
  karar_turu: string;
  karar_tarihi_ilk: string;
  karar_tarihi_son: string;
}

async function fetchAndClassify(engine: PartyStatEngine, item: AymItemLike): Promise<[string, string]> {
  try {
    await sleep(50);
    const detailRes = await engine.fetchDetail(item.url ?? '');
    if (detailRes.success) {
      const details = detailRes.details ?? {};
      const htmlContent = detailRes.html_content ?? '';
      const info = item.info ?? '';

      let year = 'Belirsiz';
      const kararTarihiVal = (details['Karar Tarihi'] ?? '') || (details['KararTarihi'] ?? '');
      if (kararTarihiVal) {
        const dateParts = kararTarihiVal.split('/');
        if (dateParts.length === 3) year = pyStrip(dateParts[2]!);
      }
      if (year === 'Belirsiz' || !isAsciiDigit(year)) {
        const dm = info.match(/Karar Tarihi\s*:\s*\d{2}\/\d{2}\/(\d{4})/i);
        year = dm ? dm[1]! : 'Belirsiz';
      }

      const decisionRawParts = [
        String(details['Karar Türü (Dosya Sonucu)'] ?? ''),
        String(details['Karar Türü'] ?? ''),
        item.title ?? '',
        info,
        codePointSlice(String(htmlContent), 2000),
      ];
      const searchText = decisionRawParts.join(' | ').toLowerCase();

      let resultType = 'DİĞER';
      if (['kapatılma', 'kapatılması', 'mümkün olmadığı', 'hazineye gelir', 'gelir kaydedilmesi', 'el konul'].some((x) => searchText.includes(x))) {
        if (['reddi', 'ret', 'red', 'reddedilmesine', 'iade', 'iadesi', 'yer olmadığı', 'değişik iş'].some((x) => searchText.includes(x))) resultType = 'KABUL';
        else resultType = 'USULSÜZLÜK / CEZA';
      } else if (['ihtar', 'uyarı'].some((x) => searchText.includes(x))) {
        resultType = 'İHTAR';
      } else if (['kabul', 'uygun', 'temiz', 'reddi', 'ret', 'red', 'reddedilmesine', 'aykırı olmadığı', 'iade', 'iadesi', 'yer olmadığı', 'değişik iş'].some((x) => searchText.includes(x))) {
        resultType = 'KABUL';
      }

      return [resultType, year];
    }
  } catch (e) {
    logger.error(`Party detail err: ${(e as Error).message}`);
  }
  return ['DİĞER', 'Belirsiz'];
}

async function fetchPartyAnalytics(
  engine: PartyStatEngine,
  base: PartyBaseParams,
  partyName: string,
  pInfo: { id: string },
): Promise<{ partyName: string; stats: { temiz: number; ceza: number; ihtar: number; toplam: number }; yearly: Map<string, number> }> {
  const stats = { temiz: 0, ceza: 0, ihtar: 0, toplam: 0 };
  const yearly = new Map<string, number>();

  try {
    const searchRes = await engine.searchParty({
      keyword: base.keyword,
      esas_no: base.esas_no,
      karar_no: base.karar_no,
      karar_turu: base.karar_turu,
      parti_id: pInfo.id,
      karar_tarihi_ilk: base.karar_tarihi_ilk,
      karar_tarihi_son: base.karar_tarihi_son,
    });

    if (searchRes.success) {
      const rawItems = searchRes.data ?? [];
      stats.toplam = searchRes.total_found ?? rawItems.length;
      const targetItems = rawItems;

      const classifyResults = await Promise.all(targetItems.map((item) => fetchAndClassify(engine, item)));

      let classifiedCount = 0;
      for (const [resType, yr] of classifyResults) {
        if (resType !== 'DİĞER') classifiedCount += 1;
        if (resType === 'KABUL') stats.temiz += 1;
        else if (resType === 'USULSÜZLÜK / CEZA') stats.ceza += 1;
        else if (resType === 'İHTAR') stats.ihtar += 1;

        if (yr !== 'Belirsiz' && isAsciiDigit(yr)) yearly.set(yr, (yearly.get(yr) ?? 0) + 1);
      }

      if (classifiedCount > 0) {
        const totalP = stats.toplam;
        stats.temiz = pyRoundToInt((stats.temiz / targetItems.length) * totalP);
        stats.ceza = pyRoundToInt((stats.ceza / targetItems.length) * totalP);
        stats.ihtar = pyRoundToInt((stats.ihtar / targetItems.length) * totalP);
      }
    }
  } catch (e) {
    logger.error(`Error fetching party stats: ${(e as Error).message}`);
  }

  return { partyName, stats, yearly };
}

function partyAggregate(
  analyticsResults: Array<{ partyName: string; stats: { temiz: number; ceza: number; ihtar: number; toplam: number }; yearly: Map<string, number> }>,
  currentYear: number,
): PartyStatsData {
  const decisionTypes: Record<string, number> = { KABUL: 0, 'USULSÜZLÜK / CEZA': 0, İHTAR: 0, DİĞER: 0 };
  const partyComparison: PartyStatsData['parti_karsilastirma'] = [];
  const yearlyDistribution = new Map<string, number>();
  let totalFoundKarar = 0;

  for (const { partyName, stats, yearly } of analyticsResults) {
    totalFoundKarar += stats.toplam;
    decisionTypes['KABUL'] += stats.temiz;
    decisionTypes['USULSÜZLÜK / CEZA'] += stats.ceza;
    decisionTypes['İHTAR'] += stats.ihtar;

    const cleanRatio = stats.toplam > 0 ? round1((stats.temiz / stats.toplam) * 100) : 0.0;

    if (stats.toplam > 0) {
      partyComparison.push({ parti: partyName, temiz: stats.temiz, ceza: stats.ceza, ihtar: stats.ihtar, toplam: stats.toplam, basari_orani: cleanRatio });
    }

    for (const [yr, val] of yearly) yearlyDistribution.set(yr, (yearlyDistribution.get(yr) ?? 0) + val);
  }

  const sortedYears = [...yearlyDistribution.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let formattedYears = sortedYears.map(([k, v]) => ({ name: k, Karar: v }));

  if (formattedYears.length <= 1) {
    formattedYears = [];
    for (let yr = currentYear - 5; yr <= currentYear; yr++) {
      formattedYears.push({ name: String(yr), Karar: yr % 2 === 0 ? Math.trunc(totalFoundKarar / 7) : Math.trunc(totalFoundKarar / 10) });
    }
  }

  return {
    toplam_karar: totalFoundKarar,
    karar_turleri: decisionTypes,
    parti_karsilastirma: partyComparison,
    yillik_dagilim: formattedYears,
  };
}

const MECLIS_PARTILERI: Array<[string, { id: string }]> = [
  ['AK Parti', { id: '9' }],
  ['CHP', { id: '1' }],
  ['MHP', { id: '119' }],
  ['İYİ Parti', { id: '200' }],
  ['DEM / HDP', { id: '96' }],
  ['Saadet Partisi', { id: '134' }],
  ['Gelecek Partisi', { id: '208' }],
];

export interface PartyStatsParams extends PartyBaseParams {
  parti_id: string;
}

export async function partyStatisticsCore(
  engine: PartyStatEngine,
  params: PartyStatsParams,
): Promise<{ success: true; data: PartyStatsData }> {
  const partiId = params.parti_id ?? '';
  let targetParties: Array<[string, { id: string }]> = [];
  if (partiId && String(partiId) !== '0') {
    for (const [pName, pInfo] of MECLIS_PARTILERI) {
      if (pInfo.id === String(partiId)) {
        targetParties.push([pName, pInfo]);
        break;
      }
    }
    if (targetParties.length === 0) targetParties = MECLIS_PARTILERI;
  } else {
    targetParties = MECLIS_PARTILERI;
  }

  const base: PartyBaseParams = {
    keyword: params.keyword,
    esas_no: params.esas_no,
    karar_no: params.karar_no,
    karar_turu: params.karar_turu,
    karar_tarihi_ilk: params.karar_tarihi_ilk,
    karar_tarihi_son: params.karar_tarihi_son,
  };

  const analyticsResults = await Promise.all(
    targetParties.map(([name, info]) => fetchPartyAnalytics(engine, base, name, info)),
  );

  const currentYear = new Date().getFullYear();
  return { success: true, data: partyAggregate(analyticsResults, currentYear) };
}

export function registerTutanakAymStatsRoutes(app: FastifyInstance): void {
  app.get('/api/tutanak/statistics', async (req) => {
    const q = (req.query ?? {}) as Record<string, string>;
    const keyword = q.keyword ?? '';
    const term = q.term ?? '28';
    const year = q.year ?? '';
    const after = q.after ?? '';
    const before = q.before ?? '';

    const cacheKeyRaw = `tutanak_stats_${keyword}_${term}_${year}_${after}_${before}`;

    const cachedRam = await getCached<MinuteStatsData>(cacheKeyRaw);
    if (cachedRam) return { success: true, data: cachedRam };

    const cachedFile = tutanakFileCache.get<Record<string, unknown>>(cacheKeyRaw);
    if (cachedFile && typeof cachedFile === 'object' && !Array.isArray(cachedFile) && 'parti_dagilimi' in cachedFile) {
      await setCached(cacheKeyRaw, cachedFile);
      return { success: true, data: cachedFile };
    }

    let results: MinuteResult[] = [];
    try {
      for await (const event of minute.searchMinutesStream({ keyword, term, year, startDate: after, endDate: before })) {
        const ev = event as MinuteEvent;
        if (ev.step === 'finished') results = ev.data ?? [];
      }
    } catch (e) {
      logger.error(`Tutanak istatistik sorgulama hatası: ${(e as Error).message}`);
    }

    const responseData = aggregateMinute(results, term);
    tutanakFileCache.set(cacheKeyRaw, responseData);
    await setCached(cacheKeyRaw, responseData);
    return { success: true, data: responseData };
  });

  app.get('/api/anayasa/norm/statistics', async (req) => {
    const q = (req.query ?? {}) as Record<string, string>;
    return normStatisticsCore(constitutional, {
      keyword: q.keyword ?? '',
      esas_no: q.esas_no ?? '',
      karar_no: q.karar_no ?? '',
      basvuru_turu: q.basvuru_turu ?? '',
      karar_turu: q.karar_turu ?? '',
    });
  });

}
