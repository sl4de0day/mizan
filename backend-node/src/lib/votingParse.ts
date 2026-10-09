
const AYLAR = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
export function parseBaslik(metin: string): { tarih: string | null; birlesim: string | null } {
  const bas = metin.slice(0, 2000);
  const t = /(\d{1,2})\s+([A-ZÇĞİÖŞÜ][a-zçğıöşü]+)\s+(\d{4})/.exec(bas);
  let tarih: string | null = null;
  if (t) {
    let ay = AYLAR.indexOf(t[2]!);
    if (ay < 0) {
      const on3 = t[2]!.slice(0, 3).toLocaleLowerCase('tr');
      ay = AYLAR.findIndex((a) => a.slice(0, 3).toLocaleLowerCase('tr') === on3);
    }
    if (ay >= 0) tarih = `${t[3]}-${String(ay + 1).padStart(2, '0')}-${t[1]!.padStart(2, '0')}`;
  }
  const b = /(\d+)['’]\s*(?:ıncı|inci|uncu|üncü)\s+Birleşim/i.exec(bas);
  return { tarih, birlesim: b ? b[1]! : null };
}

export interface OylamaBlok {
  sira_sayisi: string | null;
  konu: string | null;
  kullanilan: number;
  kabul: number;
  ret: number;
  cekimser: number;
  mukerrer: number;
  sonuc: string | null;
  tutarli: boolean;
}
const TOLERANS = 2;

const sayiCek = (pencere: string, etiket: string): number => {
  const re = new RegExp(`(?<!\\p{L})${etiket}\\s*:?\\s*(\\d+)`, 'iu');
  const m = re.exec(pencere);
  return m ? Number(m[1]) : 0;
};

function cipaSatirlari(satir: string[], re: RegExp): number[] {
  const ofsetler: number[] = [];
  let acc = 0;
  const parcalar = satir.map((s) => { ofsetler.push(acc); acc += s.length + 1; return s; });
  const duz = parcalar.join('\n');
  const out: number[] = [];
  for (const m of duz.matchAll(re)) {
    const off = m.index;
    let lo = 0, hi = ofsetler.length - 1, idx = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (ofsetler[mid]! <= off) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    out.push(idx);
  }
  return out;
}

const KULLANILAN_RE = /(?<!\p{L})Kullanılan\s+oy\s+sayısı/giu;
const SIRA_RE = /(\d+)\s*sıra\s*sayılı/gi;

export function parseOylama(metin: string): OylamaBlok[] {
  if (!metin) return [];
  const satir = metin.split('\n');
  const cipalar = cipaSatirlari(satir, KULLANILAN_RE);
  const out: OylamaBlok[] = [];
  for (const i of cipalar) {
    let son = Math.min(satir.length, i + 15);
    for (const k of cipalar) if (k > i && k < son) { son = k; break; }
    const pencere = satir.slice(i, son).join(' ').replace(/\s+/g, ' ');

    const kullanilan = sayiCek(pencere, 'Kullanılan oy sayısı');
    if (!kullanilan) continue;
    const kabul = sayiCek(pencere, 'Kabul');
    const ret = sayiCek(pencere, 'Ret');
    const cekimser = sayiCek(pencere, 'Çekimser');
    const mukerrer = sayiCek(pencere, 'Mükerrer');

    let sira: string | null = null, konu: string | null = null;
    const geriBas = Math.max(0, i - 6);
    const geriPencere = satir.slice(geriBas, i + 1).join(' ').replace(/\s+/g, ' ');
    const eslesmeler = [...geriPencere.matchAll(SIRA_RE)];
    if (eslesmeler.length) {
      sira = eslesmeler[eslesmeler.length - 1]![1]!;
      for (let k = i; k >= geriBas; k--) if (/(\d+)\s*sıra\s*sayılı/i.test(satir[k])) { konu = satir[k].trim(); break; }
    }
    let sonuc: string | null = null;
    for (let k = son; k < Math.min(satir.length, son + 14); k++) {
      if (/kabul edilmiş|reddedilmiş|kanunlaşmış/i.test(satir[k])) { sonuc = satir[k].trim(); break; }
    }
    const tutarli = Math.abs(kullanilan - (kabul + ret + cekimser + mukerrer)) <= TOLERANS;
    out.push({ sira_sayisi: sira, konu, kullanilan, kabul, ret, cekimser, mukerrer, sonuc, tutarli });
  }
  return out;
}
