import { join } from 'node:path';
import { getLogger } from '../lib/logger.js';
import { getJson as _getJson, proxyUrlForKaynak, type HttpOptions } from '../lib/http.js';
import { FileCache } from '../lib/cache.js';
import { STORAGE_DIR } from '../lib/config.js';
import type { Indicator } from '../lib/types.js';

const logger = getLogger('PoliticalInsight.Statistics.TUIK');

const KAYNAK = 'tuik';
function getJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> { return _getJson<T>(url, { proxyUrl: proxyUrlForKaynak(KAYNAK), ...opts }); }

interface RawItem {
  key?: string;
  deger?: unknown;
  yil?: number | string;
  ay?: number | string;
  donem?: number | string;
  linkTR?: string;
  birimKey?: string;
  displayNameTR?: string;
  xDeger?: string;
  baslikTR?: string;
}

export interface JsonStat {
  id: string[];
  size: number[];
  value: Record<string, string | number | null>;
  dimension: Record<string, { category: { index: string[] | Record<string, number>; label?: Record<string, string> } }>;
}

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  Accept: 'application/json',
};

const TARGET_KEYS: Record<string, { id: string; title: string }> = {
  __TUKETICI_FIYAT_ENDEKSI__: { id: 'tufe', title: 'Tüketici Fiyat Endeksi-Yıllık (%)' },
  __ISSIZLIK_ORANI_ARINDIRILMIS__: { id: 'issizlik', title: 'İşsizlik Oranı (%)' },
  __GSYH_BUYUME_HIZI__: { id: 'gsyh', title: 'GSYH Büyüme Hızı-Yıllık (%)' },
  __SANAYI_URETIM_ENDEKSI__: { id: 'sanayi', title: 'Sanayi Üretim Endeksi-Yıllık (%)' },
  __TUKETICI_GUVEN_ENDEKSI__: { id: 'guven', title: 'Tüketici Güven Endeksi' },
  __TURKIYE_NUFUSU__: { id: 'nufus', title: 'Türkiye Nüfusu' },
};

const ENDPOINT_MAP: Record<string, string> = {
  tufe: '/Home/GetTuketiciFiyatEndeksiGrafik',
  issizlik: '/Home/GetIssizlikOraniGrafik',
  gsyh: '/Home/GetGSYHBuyumeHiziGrafik',
  sanayi: '/Home/GetSanayiUretimEndeksiGrafik',
  guven: '/Home/GetTuketiciGuvenEndeksiGrafik',
  nufus: '/Home/GetTurkiyeNufusuGrafik',
};

export class StatisticsEngine {
  private baseUrl = 'https://www.tuik.gov.tr';
  private cache = new FileCache(join(STORAGE_DIR, 'tuik'));

  transformMainIndicators(rawData: RawItem[]): Indicator[] {
    const formatted: (Indicator & { rawKey: string })[] = [];
    for (const item of rawData) {
      const key = item.key;
      if (key && key in TARGET_KEYS) {
        let value: string;
        if (key === '__TURKIYE_NUFUSU__') {
          value = Number(item.deger).toLocaleString('en-US').replace(/,/g, '.');
        } else {
          value = String(item.deger).replace(/\./g, ',');
        }

        const year = item.yil;
        const month = item.ay ?? 0;
        const period = item.donem ?? 0;

        let subArea = `${year}`;
        if (month && Number(month) > 0) subArea = `${year}/${month}`;
        else if (period && Number(period) > 0) subArea = `${year}/${period}. Çeyrek`;

        formatted.push({
          id: TARGET_KEYS[key].id,
          title: TARGET_KEYS[key].title,
          value,
          subArea,
          rawKey: key,
          link: item.linkTR ?? null,
        });
      }
    }
    const sequence = Object.keys(TARGET_KEYS);
    formatted.sort((a, b) => sequence.indexOf(a.rawKey) - sequence.indexOf(b.rawKey));
    return formatted;
  }

  async getMainIndicators(): Promise<Indicator[]> {
    const cached = this.cache.get<Indicator[]>('main_indicators');
    if (cached) return cached;

    const url = `${this.baseUrl}/Home/GetGostergeler`;
    try {
      logger.info(`FETCH      | Retrieving main indicators from: ${url}`);
      const rawData = await getJson<RawItem[]>(url, { headers: HEADERS, timeoutMs: 20000 });
      const formatted = this.transformMainIndicators(rawData);
      if (formatted.length) this.cache.set('main_indicators', formatted);
      return formatted;
    } catch (e) {
      logger.error(`FAIL       | Indicator fetch failed: ${(e as Error).message}`);
      return [];
    }
  }

  transformIndicatorDetails(indicatorId: string, rawData: RawItem[]): unknown {
    if (indicatorId === 'tufe') {
      const trend: { date: string; value: unknown }[] = [];
      const categories: { name: string; value: unknown }[] = [];
      for (const item of rawData) {
        if (item.birimKey === '__GRAFIK_2__') {
          categories.push({ name: item.displayNameTR || item.xDeger || '', value: item.deger });
        } else {
          const x = item.xDeger;
          if (x && x.includes('/')) trend.push({ date: x, value: item.deger });
          else if (!x && item.yil) trend.push({ date: String(item.yil), value: item.deger });
        }
      }
      trend.reverse();
      return { success: true, type: 'tufe', trend, categories };
    }

    if (indicatorId === 'issizlik') {
      const chart1: Record<string, Record<string, unknown>> = {};
      const chart2: Record<string, Record<string, unknown>> = {};
      for (const item of rawData) {
        const date = item.xDeger;
        if (!date || !date.includes('/')) continue;
        const baslik = item.baslikTR ?? '';
        const deger = item.deger;
        if (baslik.includes('İşsizlik Oranı')) {
          if (!chart1[date]) chart1[date] = { date };
          if (baslik.includes('arındırılmamış')) chart1[date].arindirilmamis = deger;
          else chart1[date].arindirilmis = deger;
        } else if (baslik.includes('İstihdam Oranı')) {
          if (!chart2[date]) chart2[date] = { date };
          if (baslik.includes('arındırılmamış')) chart2[date].arindirilmamis = deger;
          else chart2[date].arindirilmis = deger;
        }
      }
      const parseDate = (d: string) => {
        const parts = d.split('/');
        return Number(parts[0]) * 100 + Number(parts[1]);
      };
      const c1 = Object.values(chart1).sort((a, b) => parseDate(a.date as string) - parseDate(b.date as string));
      const c2 = Object.values(chart2).sort((a, b) => parseDate(a.date as string) - parseDate(b.date as string));
      return { success: true, type: 'issizlik', chart1: c1, chart2: c2 };
    }

    if (indicatorId === 'gsyh') {
      const trend: { date: string; value: unknown }[] = [];
      const categories: { name: string; value: unknown }[] = [];
      for (const item of rawData) {
        if (item.birimKey === '__GRAFIK_7__') {
          categories.push({ name: item.displayNameTR || item.xDeger || '', value: item.deger });
        } else {
          const x = item.xDeger;
          if (x) trend.push({ date: x, value: item.deger });
        }
      }
      trend.reverse();
      return { success: true, type: 'gsyh', trend, categories };
    }

    if (indicatorId === 'sanayi' || indicatorId === 'guven') {
      const trend: { date: string; value: unknown }[] = [];
      const categories: { name: string; value: unknown }[] = [];
      const graphKey = indicatorId === 'sanayi' ? '__GRAFIK_9__' : '__GRAFIK_11__';
      for (const item of rawData) {
        if (item.birimKey === graphKey) {
          categories.push({ name: item.displayNameTR || item.xDeger || '', value: item.deger });
        } else {
          const x = item.xDeger;
          if (x) trend.push({ date: x, value: item.deger });
        }
      }
      trend.reverse();
      return { success: true, type: indicatorId, trend, categories };
    }

    if (indicatorId === 'nufus') {
      const trend: { date: string; value: unknown }[] = [];
      const pyramid: Record<string, { age: string; male: unknown; female: unknown }> = {};
      for (const item of rawData) {
        if (item.birimKey === '__GRAFIK_12__') {
          const x = item.xDeger;
          if (x) trend.push({ date: x, value: item.deger });
        } else {
          const key = item.key ?? '';
          const gender = key.includes('ERKEK') ? 'male' : 'female';
          const parts = key.split('__').filter((p) => p);
          if (parts.length >= 2) {
            const ageGroup = parts[1].replace(/_/g, '-');
            if (!pyramid[ageGroup]) pyramid[ageGroup] = { age: ageGroup, male: 0, female: 0 };
            pyramid[ageGroup][gender] = item.deger;
          }
        }
      }
      const ageSortKey = (age: string) => {
        const n = parseInt(age.split('-')[0], 10);
        return Number.isNaN(n) ? 999 : n;
      };
      const pyramidList = Object.values(pyramid).sort((a, b) => ageSortKey(a.age) - ageSortKey(b.age));
      trend.reverse();
      return { success: true, type: 'nufus', trend, pyramid: pyramidList };
    }

    return { error: 'Indicator details not found.' };
  }

  async getIndicatorDetails(indicatorId: string): Promise<unknown> {
    const cached = this.cache.get(`details_${indicatorId}`);
    if (cached) return cached;

    if (!(indicatorId in ENDPOINT_MAP)) return { error: 'Indicator details not found.' };

    const url = `${this.baseUrl}${ENDPOINT_MAP[indicatorId]}`;
    try {
      logger.info(`FETCH      | Retrieving detail trend for: ${indicatorId}`);
      const rawData = await getJson<RawItem[]>(url, { headers: HEADERS, timeoutMs: 20000 });
      const result = this.transformIndicatorDetails(indicatorId, rawData);
      if (!(result as { error?: string }).error) this.cache.set(`details_${indicatorId}`, result);
      return result;
    } catch (e) {
      logger.error(`FAIL       | Detail fetch failed (${indicatorId}): ${(e as Error).message}`);
      return { error: (e as Error).message };
    }
  }

  private db2Base = 'https://databrowser2.tuik.gov.tr/api/core/nodes/1/datasets';
  async getDataflowSeries(dataflowId: string, filtre: Record<string, string>, timeDim = 'TIME_PERIOD'): Promise<{ tarih: string; deger: number }[]> {
    const cacheKey = `df_${dataflowId}_${JSON.stringify(filtre)}`;
    const cached = this.cache.get<{ tarih: string; deger: number }[]>(cacheKey);
    if (cached) return cached;
    const url = `${this.db2Base}/${encodeURIComponent(dataflowId)}/data`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': HEADERS['User-Agent'], Referer: 'https://databrowser2.tuik.gov.tr/', 'Accept-Language': 'tr' },
      body: '[]',
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) throw new Error(`databrowser2 HTTP ${resp.status}`);
    const js = (await resp.json()) as JsonStat;
    const seri = StatisticsEngine.decodeJsonStat(js, filtre, timeDim);
    if (seri.length) this.cache.set(cacheKey, seri);
    return seri;
  }

  static decodeJsonStat(js: JsonStat, filtre: Record<string, string>, timeDim = 'TIME_PERIOD'): { tarih: string; deger: number }[] {
    const { id, size, dimension, value } = js;
    const stride = new Array<number>(id.length);
    stride[id.length - 1] = 1;
    for (let k = id.length - 2; k >= 0; k--) stride[k] = stride[k + 1] * size[k + 1];
    const tk = id.indexOf(timeDim);
    if (tk < 0) return [];
    const codesOf = (name: string): string[] => {
      const idx = dimension[name]?.category?.index;
      return Array.isArray(idx) ? idx : Object.keys(idx ?? {});
    };
    const dinamik: number[] = [];
    let base = 0;
    for (let k = 0; k < id.length; k++) {
      if (k === tk) continue;
      const want = filtre[id[k]];
      if (want === '@ay') { dinamik.push(k); continue; }
      const p = want != null ? codesOf(id[k]).indexOf(want) : 0;
      if (p < 0) return [];
      base += p * stride[k];
    }
    const tCodes = codesOf(timeDim);
    const seri: { tarih: string; deger: number }[] = [];
    for (let t = 0; t < size[tk]; t++) {
      let fi = base + t * stride[tk];
      let ok = true;
      for (const k of dinamik) {
        const ay = 'M' + (tCodes[t].split('-')[1] ?? '');
        const p = codesOf(id[k]).indexOf(ay);
        if (p < 0) { ok = false; break; }
        fi += p * stride[k];
      }
      if (!ok) continue;
      const v = value[String(fi)];
      if (v != null && v !== '' && Number.isFinite(+v)) seri.push({ tarih: tCodes[t], deger: +v });
    }
    return seri;
  }
}
