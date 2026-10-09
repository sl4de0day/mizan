
export interface Indicator {
  id: string;
  title: string;
  value: string;
  subArea: string;
  rawKey: string;
  link: string | null;
}

export interface TrendPoint {
  date: string;
  value: unknown;
}

export interface CategoryPoint {
  name: string;
  value: unknown;
}

export type IndicatorDetail =
  | { success: true; type: string; trend?: TrendPoint[]; categories?: CategoryPoint[] }
  | { success: true; type: 'issizlik'; chart1: unknown[]; chart2: unknown[] }
  | { success: true; type: 'nufus'; trend: TrendPoint[]; pyramid: unknown[] }
  | { error: string };
