import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT, BACKEND_NODE_ROOT } from './config.js';
import { getLogger } from './logger.js';

const logger = getLogger('PoliticalInsight.Deputies');

const masterPath = join(PROJECT_ROOT, 'deputy_master_list.json');
const cacheDir = join(BACKEND_NODE_ROOT, 'data', 'milletvekili_cache');
const idsPath = join(BACKEND_NODE_ROOT, 'data', 'deputy_tbmm_ids.json');

export interface DeputyMasterEntry {
  ad_soyad: string;
  parti: string;
  il: string;
  donem: string;
}

export interface DeputyIdInfo {
  id?: string;
  donem_id?: string;
  parti?: string;
  il?: string;
  photo?: string;
}

export const DEPUTY_MASTER_LIST: DeputyMasterEntry[] = (() => {
  if (!existsSync(masterPath)) return [];
  try {
    return JSON.parse(readFileSync(masterPath, 'utf-8'));
  } catch (e) {
    logger.error((e as Error).message);
    return [];
  }
})();

export interface RosterSaglik {
  donem: number;
  toplam: number;
  elliKesik: string[];
  saglikli: boolean;
}

export function rosterSagligi(donem: number | string): RosterSaglik {
  const d = String(donem);
  const sayim = new Map<string, number>();
  for (const dep of DEPUTY_MASTER_LIST) {
    if (String(dep.donem) !== d) continue;
    sayim.set(dep.parti, (sayim.get(dep.parti) ?? 0) + 1);
  }
  const toplam = [...sayim.values()].reduce((a, b) => a + b, 0);
  const elliKesik = [...sayim.entries()].filter(([, n]) => n === 50).map(([p]) => p);
  return {
    donem: Number(donem),
    toplam,
    elliKesik,
    saglikli: elliKesik.length === 0 && toplam >= 100,
  };
}

export const DEPUTY_IDS_MAPPING: Record<string, DeputyIdInfo> = (() => {
  if (!existsSync(idsPath)) return {};
  try {
    return JSON.parse(readFileSync(idsPath, 'utf-8'));
  } catch (e) {
    logger.error((e as Error).message);
    return {};
  }
})();

export const DEPUTY_TBMM_IDS: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const info of Object.values(DEPUTY_IDS_MAPPING)) {
    if (info.id) out[info.id] = info.parti ?? '';
  }
  return out;
})();

export const DEPUTY_PROFILES_CACHE: Record<string, Record<string, unknown>> = (() => {
  const out: Record<string, Record<string, unknown>> = {};
  if (!existsSync(cacheDir)) return out;
  try {
    for (const fname of readdirSync(cacheDir)) {
      if (fname.endsWith('.json')) {
        const depId = fname.replace(/\.json$/, '');
        try {
          out[depId] = JSON.parse(readFileSync(join(cacheDir, fname), 'utf-8'));
        } catch {
        }
      }
    }
  } catch (e) {
    logger.error((e as Error).message);
  }
  return out;
})();
