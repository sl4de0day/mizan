import type { FastifyInstance } from 'fastify';
import { LawEngine } from '../engines/law.js';
import type { LawResult, LawDetail } from '../engines/law.js';
import { DEPUTY_MASTER_LIST } from '../lib/deputies.js';
import { getCached, setCached } from '../lib/cache.js';
import { getLogger } from '../lib/logger.js';
import { CATEGORY_NAMES, classify } from '../lib/taxonomy.js';

const logger = getLogger('PoliticalInsight.KanunStats');
const law = new LawEngine();

function pyStrip(s: string): string {
  return s.replace(/^\s+/, '').replace(/\s+$/, '');
}

function doubleToFraction(x: number): { num: bigint; den: bigint } {
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  dv.setFloat64(0, x);
  const bits = (BigInt(dv.getUint32(0)) << 32n) | BigInt(dv.getUint32(4));
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const mantissa = bits & 0xfffffffffffffn;
  let num: bigint;
  let e: number;
  if (exponent === 0) {
    num = mantissa;
    e = -1074;
  } else {
    num = mantissa | (1n << 52n);
    e = exponent - 1075;
  }
  if (e >= 0) return { num: num << BigInt(e), den: 1n };
  return { num, den: 1n << BigInt(-e) };
}

function pyRound(x: number, ndigits: number): number {
  if (!Number.isFinite(x)) return x;
  if (x === 0) return 0;
  const sign = x < 0 ? -1 : 1;
  const { num, den } = doubleToFraction(Math.abs(x));
  const scale = 10n ** BigInt(ndigits);
  const p = num * scale;
  let q = p / den;
  const r = p % den;
  const twoR = 2n * r;
  if (twoR > den) q = q + 1n;
  else if (twoR === den && q % 2n === 1n) q = q + 1n;
  let digits = q.toString();
  let s: string;
  if (ndigits <= 0) {
    s = digits;
  } else {
    if (digits.length <= ndigits) digits = '0'.repeat(ndigits - digits.length + 1) + digits;
    s = `${digits.slice(0, digits.length - ndigits)}.${digits.slice(digits.length - ndigits)}`;
  }
  return sign * Number(s);
}

const PARTI_MAP: Record<string, string[]> = {
  akp: ['AK Parti', 'AK PARTİ'],
  chp: ['CHP', 'Cumhuriyet Halk Partisi'],
  mhp: ['MHP', 'Milliyetçi Hareket Partisi'],
  iyi: ['İYİ Parti', 'İYİ PARTİ'],
  saadet: ['Saadet Partisi', 'SAADET PARTİSİ'],
  gelecek: ['Gelecek Partisi', 'GELECEK Partisi'],
  dem: ['DEM Parti', 'DEM PARTİ', 'YEŞİL SOL Parti', 'HDP'],
};

const DONEM_MAP: Record<string, string> = {
  '134155F0-C3D6-4D24-893B-F3A2EF695AE7': '28',
  '5fe9e5a3-3938-4c1d-b8c0-01999e72f7b6': '28',
  '17556400-abaa-4bf5-a162-019246ebebe9': '28',
  '9df377e5-6541-4b16-93aa-018aea6d52f5': '28',
  'b0a3e586-c5ce-4900-9d1a-3a8607a05123': '28',
  'f72877c2-f508-037b-e050-007f01005610': '27',
  'f72877c2-f51d-037b-e050-007f01005610': '26',
  'f72877c2-f509-037b-e050-007f01005610': '25',
  'f72877c2-f50a-037b-e050-007f01005610': '24',
  'f72877c2-f50b-037b-e050-007f01005610': '23',
  'f72877c2-f50c-037b-e050-007f01005610': '22',
  'f72877c2-f50d-037b-e050-007f01005610': '21',
  'f72877c2-f50e-037b-e050-007f01005610': '20',
};

async function collectLaws(params: { period: string; ping?: string }): Promise<LawResult[]> {
  let laws: LawResult[] = [];
  for await (const step of law.searchLawsStream(params)) {
    if (step.step === 'finished') {
      laws = step.data ?? [];
      break;
    }
  }
  return laws;
}

function isInvolved(lawPartiesLower: string[], names: string[]): boolean {
  for (const lp of lawPartiesLower) {
    for (const pn of names) {
      if (lp.includes(pn.toLowerCase())) return true;
    }
  }
  return false;
}

function parseDMY(s: string): Date | null {
  const parts = s.split('.');
  if (parts.length !== 3) return null;
  const [dd, mm, yyyy] = parts;
  if (!/^\d+$/.test(dd) || !/^\d+$/.test(mm) || !/^\d+$/.test(yyyy)) return null;
  const d = Number(dd);
  const m = Number(mm);
  const y = Number(yyyy);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

async function fetchAndCalcTime(l: LawResult): Promise<[LawResult, number]> {
  try {
    const gelisRaw = l.tarih ?? '';
    if (!gelisRaw) return [l, 0];
    const gelisStr = gelisRaw.split('/').join('.');
    const gelisDate = parseDMY(gelisStr);
    if (gelisDate === null) return [l, 0];

    const detail = (await law.fetchLawDetail(l.id)) as LawDetail | Record<string, never>;
    if (detail && typeof detail === 'object' && Object.keys(detail).length > 0) {
      let kabulStr = '';
      if ('komisyon_bilgileri' in detail && Array.isArray(detail.komisyon_bilgileri)) {
        for (const kom of detail.komisyon_bilgileri) {
          if (kom.tip === 'Esas Komisyon' && kom.cikis) {
            kabulStr = kom.cikis.split('/').join('.');
            break;
          }
        }
      }
      if (!kabulStr && 'ana_bilgiler' in detail && detail.ana_bilgiler) {
        for (const [k, v] of Object.entries(detail.ana_bilgiler)) {
          if (k.includes('Kabul Tarihi') || k.includes('Kanunlaşma') || k.includes('Kanun Numarası')) {
            const m = /\d{2}\.\d{2}\.\d{4}/.exec(String(v).split('/').join('.'));
            if (m) {
              kabulStr = m[0];
              break;
            }
          }
        }
      }
      if (kabulStr) {
        const kabulDate = parseDMY(kabulStr);
        if (kabulDate === null) return [l, 0];
        let diff = Math.round((kabulDate.getTime() - gelisDate.getTime()) / 86400000);
        if (diff < 0) diff = 0;
        return [l, diff];
      }
    }
  } catch {
  }
  return [l, 0];
}

export function registerKanunStatsRoutes(app: FastifyInstance): void {
  app.get('/api/kanun/sektor-istatistik', async (req) => {
    const { term = '' } = (req.query ?? {}) as { term?: string };
    const cacheKey = `law_sector_stats_${term}`;
    const cached = await getCached<Array<Record<string, unknown>>>(cacheKey);
    if (cached !== null) return { success: true, data: cached };

    let laws: LawResult[] = [];
    try {
      laws = await collectLaws({ period: term });
    } catch (e) {
      logger.error(`Sektor analizi cekerken hata: ${(e as Error).message}`);
    }

    const partiStats = new Map<string, Record<string, number>>();
    const newStats = (): Record<string, number> => {
      const o: Record<string, number> = {};
      for (const cat of CATEGORY_NAMES) o[cat] = 0;
      o['Diğer'] = 0;
      return o;
    };

    for (const lawItem of laws) {
      const bestCat = classify(typeof lawItem.baslik === 'string' ? lawItem.baslik : '', { kaynak: 'kanun' });

      let parties = Array.isArray(lawItem.parties) ? lawItem.parties : [];
      if (parties.length === 0) parties = ['Bilinmiyor'];
      for (const party of parties) {
        const partyClean = pyStrip(party);
        if (!partyClean) continue;
        let stats = partiStats.get(partyClean);
        if (stats === undefined) {
          stats = newStats();
          partiStats.set(partyClean, stats);
        }
        stats[bestCat] += 1;
      }
    }

    const formattedData: Array<Record<string, unknown>> = [];
    for (const [party, stats] of partiStats) {
      if (party === 'Bilinmiyor' || party.length < 2) continue;
      const entry: Record<string, unknown> = { parti: party };
      for (const cat of CATEGORY_NAMES) entry[cat] = stats[cat];
      entry['Diğer'] = stats['Diğer'];
      formattedData.push(entry);
    }

    await setCached(cacheKey, formattedData);
    return { success: true, data: formattedData };
  });

  app.get('/api/kanun/istatistik', async (req) => {
    const q = (req.query ?? {}) as { term?: string; party1?: string; party2?: string; ping?: string };
    const term = q.term ?? '';
    const party1 = q.party1 ?? '';
    const party2 = q.party2 ?? '';
    const ping = q.ping ?? 'false';

    logger.info(`CANLI YASAMA ANALİTİĞİ TALEBİ | Dönem UUID: ${term} | Parti 1: ${party1} | Parti 2: ${party2}`);

    const donemNum = DONEM_MAP[term] ?? '28';
    const p1Names = PARTI_MAP[party1] ?? [party1];
    const p2Names = PARTI_MAP[party2] ?? [party2];

    let p1Count = 0;
    let p2Count = 0;
    for (const d of DEPUTY_MASTER_LIST) {
      const rec = d as unknown as Record<string, unknown>;
      const dDonem = (rec['don'] ?? rec['donem']) as unknown;
      if (String(dDonem) === String(donemNum)) {
        const partiAdi = typeof d.parti === 'string' ? d.parti : '';
        const partiLower = partiAdi.toLowerCase();
        if (p1Names.some((pn) => partiLower.includes(pn.toLowerCase()))) p1Count += 1;
        else if (p2Names.some((pn) => partiLower.includes(pn.toLowerCase()))) p2Count += 1;
      }
    }

    let laws: LawResult[] = [];
    try {
      laws = await collectLaws({ period: term, ping });
    } catch (e) {
      logger.error(`Canlı meclis analitiği çekerken hata oluştu: ${(e as Error).message}`);
    }

    let p1Total = 0;
    let p1Kabul = 0;
    let p1ImzaToplam = 0;
    let p1SureToplam = 0;
    let p2Total = 0;
    let p2Kabul = 0;
    let p2ImzaToplam = 0;
    let p2SureToplam = 0;
    let ortakTeklif = 0;

    const kabulKeywords = ['KANUNLAŞTI', 'KABUL', 'YASALAŞTI'];

    for (const lawItem of laws) {
      const lawPartiesLower = (Array.isArray(lawItem.parties) ? lawItem.parties : []).map((p) =>
        p.toLowerCase(),
      );
      const lawStatus = (typeof lawItem.durum === 'string' ? lawItem.durum : '').toUpperCase();
      const isKabul = kabulKeywords.some((k) => lawStatus.includes(k));

      const isP1 = isInvolved(lawPartiesLower, p1Names);
      const isP2 = isInvolved(lawPartiesLower, p2Names);

      const vekillerStr = typeof lawItem.vekiller === 'string' ? lawItem.vekiller : '';
      let imzaSayisi = 1;
      if (vekillerStr && vekillerStr !== 'Bilinmiyor') imzaSayisi = vekillerStr.split(',').length;

      if (isP1) {
        p1Total += 1;
        p1ImzaToplam += imzaSayisi;
        if (isKabul) p1Kabul += 1;
      }
      if (isP2) {
        p2Total += 1;
        p2ImzaToplam += imzaSayisi;
        if (isKabul) p2Kabul += 1;
      }
      if (isP1 && isP2) ortakTeklif += 1;
    }

    const kabulEdilenKanunlar = laws.filter((l) => {
      const status = (typeof l.durum === 'string' ? l.durum : '').toUpperCase();
      const isKabul = kabulKeywords.some((k) => status.includes(k));
      if (!isKabul) return false;
      const lp = (Array.isArray(l.parties) ? l.parties : []).map((p) => p.toLowerCase());
      return isInvolved(lp, p1Names) || isInvolved(lp, p2Names);
    });

    if (kabulEdilenKanunlar.length > 0) {
      const timeResults = await Promise.all(kabulEdilenKanunlar.map((l) => fetchAndCalcTime(l)));
      for (const [l, diffDays] of timeResults) {
        const lp = (Array.isArray(l.parties) ? l.parties : []).map((p) => p.toLowerCase());
        if (isInvolved(lp, p1Names)) p1SureToplam += diffDays;
        if (isInvolved(lp, p2Names)) p2SureToplam += diffDays;
      }
    }

    const p1Success = p1Total > 0 ? pyRound((p1Kabul / p1Total) * 100, 2) : 0.0;
    const p2Success = p2Total > 0 ? pyRound((p2Kabul / p2Total) * 100, 2) : 0.0;
    const p1OrtImza = p1Total > 0 ? pyRound(p1ImzaToplam / p1Total, 1) : 0.0;
    const p2OrtImza = p2Total > 0 ? pyRound(p2ImzaToplam / p2Total, 1) : 0.0;
    const p1OrtSure = p1Kabul > 0 ? pyRound(p1SureToplam / p1Kabul, 1) : 0.0;
    const p2OrtSure = p2Kabul > 0 ? pyRound(p2SureToplam / p2Kabul, 1) : 0.0;

    const toplamBenzersizTeklif = p1Total + p2Total - ortakTeklif;
    const uzlasiSkoru =
      toplamBenzersizTeklif > 0 ? pyRound((ortakTeklif / toplamBenzersizTeklif) * 100, 2) : 0.0;

    const p1Stats = {
      toplam_teklif: p1Total,
      kabul_edilen: p1Kabul,
      komisyonda: p1Total - p1Kabul,
      reddedilen: 0,
      basari_orani: p1Success,
      ortalama_imza: p1OrtImza,
      ortalama_sure: p1OrtSure,
      konular: [] as unknown[],
    };
    const p2Stats = {
      toplam_teklif: p2Total,
      kabul_edilen: p2Kabul,
      komisyonda: p2Total - p2Kabul,
      reddedilen: 0,
      basari_orani: p2Success,
      ortalama_imza: p2OrtImza,
      ortalama_sure: p2OrtSure,
      konular: [] as unknown[],
    };

    return {
      success: true,
      data: {
        term: donemNum,
        party1: { id: party1, deputy_count: p1Count, stats: p1Stats },
        party2: { id: party2, deputy_count: p2Count, stats: p2Stats },
        uzlasi_skoru: uzlasiSkoru,
      },
    };
  });
}
