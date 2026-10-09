
export interface Tanimlayicilar {
  kanunNo: string[];
  siraSayisi: string[];
  esasNo: string[];
  aymEsasKarar: string[];
}

const bos = (): Tanimlayicilar => ({ kanunNo: [], siraSayisi: [], esasNo: [], aymEsasKarar: [] });
const tekil = (a: string[]): string[] => [...new Set(a)];

export function tanimlayiciCikar(metin: string | null | undefined): Tanimlayicilar {
  const s = String(metin ?? '').replace(/[’‘ʼ]/g, "'").replace(/\s+/g, ' ');
  if (!s) return bos();
  const out = bos();

  for (const m of s.matchAll(/\b(\d{4,5})\s+sayılı\s+([^.;]{0,60})/gi)) {
    const pencere = m[2] ?? '';
    const kanunIdx = pencere.search(/Kanun(?!\s+H[üu]km[üu]nde)/i);
    if (kanunIdx === -1) continue;
    const digerIdx = pencere.search(/Resm[iî]|Cumhurba[şs]kanl|Karar|Y[öo]netmeli|Tebli[ğg]|Genelge/i);
    if (digerIdx === -1 || kanunIdx < digerIdx) out.kanunNo.push(m[1]!);
  }
  for (const m of s.matchAll(/\b(\d{1,4})\s+sıra\s+sayılı/gi)) out.siraSayisi.push(m[1]!);
  for (const m of s.matchAll(/\b(?:esas\s*(?:no|numaralı)?\s*:?\s*)(\d\s*\/\s*\d{1,5})\b/gi)) {
    out.esasNo.push(m[1]!.replace(/\s+/g, ''));
  }
  for (const m of s.matchAll(/E[.:]\s*(\d{4}\/\d{1,4})\s*[,;]?\s*K[.:]\s*(\d{4}\/\d{1,4})/gi)) {
    out.aymEsasKarar.push(`${m[1]}|${m[2]}`);
  }

  return {
    kanunNo: tekil(out.kanunNo),
    siraSayisi: tekil(out.siraSayisi),
    esasNo: tekil(out.esasNo),
    aymEsasKarar: tekil(out.aymEsasKarar),
  };
}

export interface KorpusRef {
  tur: 'kanun' | 'teklif' | 'aym';
  deger: string;
  baslik?: string | null;
}

export interface KorpusSorgu {
  kanunVarMi(no: string): { baslik: string | null } | null;
  siraSayisiVarMi(ss: string): { baslik: string | null } | null;
  esasNoVarMi(esas: string): { baslik: string | null } | null;
  aymVarMi(anahtar: string): { baslik: string | null } | null;
}

export function korpustaMi(t: Tanimlayicilar, k: KorpusSorgu): KorpusRef[] {
  const es: KorpusRef[] = [];
  for (const no of t.kanunNo) { const r = k.kanunVarMi(no); if (r) es.push({ tur: 'kanun', deger: no, baslik: r.baslik }); }
  for (const ss of t.siraSayisi) { const r = k.siraSayisiVarMi(ss); if (r) es.push({ tur: 'teklif', deger: ss, baslik: r.baslik }); }
  for (const e of t.esasNo) { const r = k.esasNoVarMi(e); if (r) es.push({ tur: 'teklif', deger: e, baslik: r.baslik }); }
  for (const a of t.aymEsasKarar) { const r = k.aymVarMi(a); if (r) es.push({ tur: 'aym', deger: a, baslik: r.baslik }); }
  return es;
}

export interface HaberOgesi {
  baslik: string;
  url: string;
  tarih: string | null;
  kaynak: string;
  capalar: KorpusRef[];
}

export const baslikBozulmamis = (kaynakBaslik: string, saklanan: string): boolean =>
  kaynakBaslik === saklanan;
