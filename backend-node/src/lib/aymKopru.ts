
export const aymNorm = (s: string | null | undefined): string =>
  String(s ?? '').replace(/[’‘ʼ]/g, "'").replace(/\s+/g, ' ');

const RE_KANUN = /\btarihli\s+ve\s+(\d{3,5})\s+sayılı/gi;

const RE_KANUN_DEGIL = /^\s*(Resm[iî]\s*Gazete|Kanun\s+H[üu]km[üu]nde|Cumhurba[şs]kanl)/i;

const RE_OLUMSUZ = /(öncesinde|mülga|önceki\s+hâli|yürürlükten\s+kaldır)/i;

export interface KanunAtfi {
  no: string;
  idx: number;
  metinTarihi: string | null;
  ana: boolean;
  olumsuz: boolean;
}

export function kanunAtiflari(konu: string | null | undefined): KanunAtfi[] {
  const s = aymNorm(konu);
  const out: KanunAtfi[] = [];
  RE_KANUN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_KANUN.exec(s)) !== null) {
    const son = m.index + m[0].length;
    const kuyruk = s.slice(son, son + 40);
    if (RE_KANUN_DEGIL.test(kuyruk)) continue;
    const sonraki = s.slice(son).search(/\btarihli\s+ve\b/i);
    const cumle = s.slice(son, son + (sonraki > 0 ? sonraki : 200));
    const onc = s.slice(Math.max(0, m.index - 16), m.index);
    const d = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(onc);
    out.push({
      no: m[1]!,
      idx: m.index,
      metinTarihi: d ? `${d[3]}-${d[2]!.padStart(2, '0')}-${d[1]!.padStart(2, '0')}` : null,
      ana: false,
      olumsuz: RE_OLUMSUZ.test(cumle),
    });
  }
  if (out.length) out[0]!.ana = true;
  return out;
}

export function torbaKararMi(konu: string | null | undefined, atifSayisi: number): boolean {
  return aymNorm(konu).length > 5000 || atifSayisi > 15;
}

export const RE_ESAS_KARAR = /E:[\s? ]*(\d+\/\d+)\s*,\s*K:[\s? ]*(\d+\/\d+)/;

export const rgSayiNorm = (s: string | null | undefined): string =>
  String(s ?? '').trim().replace(/\.0+$/, '');

export function esasKararAnahtari(baslik: string | null | undefined): string | null {
  const m = RE_ESAS_KARAR.exec(aymNorm(baslik));
  return m ? `${m[1]}|${m[2]}` : null;
}

export const AYM_SONUC_ETIKET: Record<string, string> = {
  iptal: 'İptal edildi',
  ret: 'İptal edilmedi (esastan incelendi)',
  ilk_ret: 'İncelenmedi (başvuru usulden reddedildi)',
  diger: 'Diğer karar',
};

export const esastanMi = (sonucKod: string | null | undefined): boolean =>
  sonucKod === 'iptal' || sonucKod === 'ret';

export const AYM_BASVURU_ETIKET: Record<string, string> = {
  itiraz: 'Davaya bakan mahkeme taşıdı',
  iptal: 'Doğrudan iptal davası açıldı — davacının kimliği verimizde yok',
};
