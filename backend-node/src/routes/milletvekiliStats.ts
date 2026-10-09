import type { FastifyInstance } from 'fastify';
import {
  DEPUTY_IDS_MAPPING,
  DEPUTY_PROFILES_CACHE,
  DEPUTY_TBMM_IDS,
  DEPUTY_MASTER_LIST,
} from '../lib/deputies.js';
import { normalizeParty } from '../lib/parties.js';
import { getCached, setCached } from '../lib/cache.js';
import { LawEngine, type LawResult } from '../engines/law.js';
import { getLogger } from '../lib/logger.js';

const law = new LawEngine();
const logger = getLogger('PoliticalInsight.MilletvekiliStats');

function isCased(ch: string): boolean {
  return ch.toLowerCase() !== ch || ch.toUpperCase() !== ch;
}
function pyTitle(s: string): string {
  let out = '';
  let prevCased = false;
  for (const ch of s) {
    out += prevCased ? ch.toLowerCase() : ch.toUpperCase();
    prevCased = isCased(ch);
  }
  return out;
}

function decompose(x: number): { num: bigint; den: bigint } {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  const bits = dv.getBigUint64(0);
  const sign = (bits >> 63n) & 1n;
  let exp = Number((bits >> 52n) & 0x7ffn);
  let mant = bits & 0xfffffffffffffn;
  if (exp === 0) {
    exp = -1074;
  } else {
    mant = mant | 0x10000000000000n;
    exp = exp - 1075;
  }
  let num = mant;
  let den = 1n;
  if (exp >= 0) num = num << BigInt(exp);
  else den = 1n << BigInt(-exp);
  if (sign === 1n) num = -num;
  return { num, den };
}
function pyRound(x: number, ndigits: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const neg = x < 0;
  const { num, den } = decompose(Math.abs(x));
  const p = 10n ** BigInt(ndigits);
  const scaled = num * p;
  let q = scaled / den;
  const r = scaled % den;
  const twice = r * 2n;
  if (twice > den) q += 1n;
  else if (twice === den && (q & 1n) === 1n) q += 1n;
  const result = Number(q) / Number(p);
  return neg ? -result : result;
}

function pyGet(obj: Record<string, unknown>, key: string, dflt: unknown): unknown {
  return key in obj ? obj[key] : dflt;
}

interface PartyStats {
  party_name: string;
  total: number;
  genders: { KADIN: number; ERKEK: number };
  education: Record<string, number>;
  ages: number[];
  professions: Record<string, number>;
  keywords: Record<string, number>;
}

export function registerMilletvekiliStatsRoutes(app: FastifyInstance): void {
  app.get('/api/milletvekili/list', async (req) => {
    const { il } = (req.query ?? {}) as { il?: string };
    const result: Array<Record<string, unknown>> = [];
    for (const [name, info] of Object.entries(DEPUTY_IDS_MAPPING)) {
      if (il && (info.il ?? '').toUpperCase() !== il.toUpperCase()) continue;
      result.push({
        ad_soyad: pyTitle(name),
        id: info.id ?? null,
        donem_id: info.donem_id ?? null,
        parti: info.parti ?? null,
        il: info.il ?? null,
        photo: info.photo ?? null,
      });
    }
    return { success: true, data: result };
  });

  app.get('/api/milletvekili/performance-index', async () => {
    const cacheKey = 'performance_index';
    const cached = await getCached(cacheKey);
    if (cached) return cached;

    const deputyList = DEPUTY_MASTER_LIST;

    const partyVekilCounts: Record<string, number> = {};
    for (const d of deputyList) {
      if (String(d.donem) === '28') {
        const pRaw = d.parti ?? '';
        const pNorm = normalizeParty(pRaw);
        partyVekilCounts[pNorm] = (partyVekilCounts[pNorm] ?? 0) + 1;
      }
    }

    const partyOnergeCounts: Record<string, number> = {};
    const onergeParties: Record<string, { toplam?: number }> = {};
    for (const [pKey, pVal] of Object.entries(onergeParties)) {
      const pNorm = normalizeParty(pKey);
      partyOnergeCounts[pNorm] = (partyOnergeCounts[pNorm] ?? 0) + (pVal.toplam ?? 0);
    }

    const partyKanunCounts: Record<string, number> = {};
    try {
      let allLaws: LawResult[] = [];
      for await (const step of law.searchLawsStream({ period: '' })) {
        if (step.step === 'finished') {
          allLaws = step.data ?? [];
          break;
        }
      }
      for (const lawItem of allLaws) {
        const lawParties = lawItem.parties ?? [];
        for (const lp of lawParties) {
          const pNorm = normalizeParty(lp);
          partyKanunCounts[pNorm] = (partyKanunCounts[pNorm] ?? 0) + 1;
        }
      }
    } catch (e) {
      logger.error((e as Error).message);
    }

    const allParties = new Set<string>([
      ...Object.keys(partyVekilCounts),
      ...Object.keys(partyOnergeCounts),
      ...Object.keys(partyKanunCounts),
    ]);

    const targetParties = new Set<string>([
      'AK PARTİ',
      'CHP',
      'MHP',
      'İYİ PARTİ',
      'DEM PARTİ',
      'SAADET PARTİSİ',
      'YENİDEN REFAH',
    ]);

    const result: Array<Record<string, unknown>> = [];
    for (const pNorm of allParties) {
      if (!targetParties.has(pNorm)) continue;

      const vekilCount = partyVekilCounts[pNorm] ?? 0;
      const onergeCount = partyOnergeCounts[pNorm] ?? 0;
      const kanunCount = partyKanunCounts[pNorm] ?? 0;
      const toplamAktivite = onergeCount + kanunCount;

      let onergePerVekil = 0.0;
      let kanunPerVekil = 0.0;
      let toplamPerVekil = 0.0;
      if (vekilCount > 0) {
        onergePerVekil = pyRound(onergeCount / vekilCount, 2);
        kanunPerVekil = pyRound(kanunCount / vekilCount, 2);
        toplamPerVekil = pyRound(toplamAktivite / vekilCount, 2);
      }

      result.push({
        parti: pNorm,
        vekil_sayisi: vekilCount,
        toplam_onerge: onergeCount,
        toplam_kanun_teklifi: kanunCount,
        toplam_aktivite: toplamAktivite,
        onerge_per_vekil: onergePerVekil,
        kanun_per_vekil: kanunPerVekil,
        toplam_per_vekil: toplamPerVekil,
      });
    }

    result.sort((a, b) => (b.toplam_per_vekil as number) - (a.toplam_per_vekil as number));

    const responseData = { success: true, data: result };
    await setCached(cacheKey, responseData);
    return responseData;
  });
}
