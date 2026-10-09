import { DEPUTY_MASTER_LIST, type DeputyMasterEntry } from './deputies.js';

export function cleanStr(name: string | undefined | null): string {
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

export const PARTI_MAP: Record<string, string[]> = {
  akp: ['AK PARTİ', 'AK PARTI', 'ADALET VE KALKINMA PARTİSİ', 'ADALET VE KALKINMA PARTI', 'AKP'],
  chp: ['CHP', 'CUMHURİYET HALK PARTİSİ', 'CUMHURIYET HALK PARTI'],
  mhp: ['MHP', 'MİLLİYETÇİ HAREKET PARTİSİ', 'MILLIYETCI HAREKET PARTI'],
  iyi: ['İYİ PARTİ', 'IYI PARTI', 'İYİ PARTİSİ', 'IYI PARTI'],
  saadet: ['SAADET PARTİSİ', 'SAADET PARTI', 'SAADET P'],
  gelecek: ['GELECEK PARTİSİ', 'GELECEK PARTI'],
  dem: [
    'DEM PART',
    'DEM PARTİ', 'DEM PARTI', 'YEŞİL SOL PARTİ', 'YESIL SOL PARTI',
    'YEŞİL SOL', 'YESIL SOL',
    'YEŞİLLER VE SOL GELECEK PARTİSİ', 'YESILLER VE SOL GELECEK PARTISI',
    'HALKLARIN DEMOKRATİK PARTİSİ', 'HALKLARIN DEMOKRATIK PARTI', 'HDP',
    'HEDEP', 'HALKLARIN ESITLIK VE DEMOKRASI',
  ],
  tip: ['TÜRKİYE İŞÇİ PARTİSİ', 'TURKIYE ISCI PARTISI', 'TİP'],
  'yeniden refah': ['YENİDEN REFAH PARTİSİ', 'YENIDEN REFAH PARTISI', 'YENİDEN REFAH'],
  'huda par': ['HÜR DAVA PARTİSİ', 'HUR DAVA PARTISI', 'HÜDA PAR', 'HUDA PAR'],
  emep: ['EMEK PARTİSİ', 'EMEK PARTISI', 'EMEP'],
  dsp: ['DEMOKRATİK SOL PARTİ', 'DEMOKRATIK SOL PARTI', 'DSP'],
  dbp: ['DEMOKRATİK BÖLGELER PARTİSİ', 'DEMOKRATIK BOLGELER PARTISI', 'DBP'],
  deva: ['DEMOKRASİ VE ATILIM PARTİSİ', 'DEMOKRASI VE ATILIM PARTISI', 'DEVA'],
  bbp: ['BÜYÜK BİRLİK PARTİSİ', 'BUYUK BIRLIK PARTISI', 'BBP'],
  'yeni yol': ['YENİ YOL PARTİSİ', 'YENI YOL PARTISI', 'YENİ YOL', 'YENI YOL'],
  dp: ['DEMOKRAT PARTİ', 'DEMOKRAT PARTI'],
};

export const CETVEL_KESIK: Record<string, string> = {
  'YENIDEN RE': 'YENIDEN REFAH',
  'YENIDEN': 'YENIDEN REFAH',
  'YESIL': 'DEM',
};

export const ALLOWED_PARTIES = ['AKP', 'CHP', 'MHP', 'IYI', 'SAADET', 'GELECEK', 'DEM'];

export const PARTI_DISI: ReadonlySet<string> = new Set(['Bilinmiyor', 'YÜRÜTME']);

const PARTI_MAP_CLEAN: { alias: string; std: string }[] = Object.entries(PARTI_MAP)
  .flatMap(([std, aliases]) => [...new Set(aliases.map((a) => cleanStr(a)))].map((alias) => ({ alias, std: std.toUpperCase() })))
  .filter((x) => x.alias.length > 0)
  .sort((a, b) => b.alias.length - a.alias.length);

export function toStandardKey(partyClean: string): string | null {
  for (const { alias, std } of PARTI_MAP_CLEAN) {
    if (partyClean.includes(alias)) return std;
  }
  return null;
}

export function normParti(raw: string | undefined | null): string {
  const ham = (raw ?? '').trim();
  if (PARTI_DISI.has(ham)) return ham;
  const clean = cleanStr(ham);
  if (!clean) return 'Bilinmiyor';
  const std = toStandardKey(clean);
  if (std) return std;
  if (ROSTER_PARTILERI.has(clean)) return clean;
  if (SENTINEL_KATLANMIS.has(clean)) return clean;
  return 'Bilinmiyor';
}

const ROSTER_PARTILERI: ReadonlySet<string> = new Set(
  DEPUTY_MASTER_LIST.map((d) => cleanStr(d.parti)).filter(Boolean),
);

const SENTINEL_KATLANMIS: ReadonlySet<string> = new Set([...PARTI_DISI].map((s) => cleanStr(s)));

export function resolveByNameIl(
  ad: string | undefined | null,
  il: string | undefined | null,
  donem: number | string,
): string {
  const nameClean = cleanStr(ad ?? '');
  const ilClean = cleanStr(il ?? '');
  if (nameClean.length < 4) return 'Bilinmiyor';
  const termStr = String(donem);
  const nameCands: DeputyMasterEntry[] = [];
  let ilMatch: DeputyMasterEntry | null = null;
  for (const dep of DEPUTY_MASTER_LIST) {
    if (String(dep.donem) !== termStr) continue;
    const dn = cleanStr(dep.ad_soyad ?? '');
    if (dn.length > 3 && nameClean.includes(dn)) {
      nameCands.push(dep);
      if (ilClean && cleanStr(dep.il ?? '') === ilClean) {
        ilMatch = dep;
        break;
      }
    }
  }
  const pick = ilMatch ?? (nameCands.length === 1 ? nameCands[0]! : null);
  if (pick) return normParti(pick.parti);

  if (nameCands.length === 0 && ilClean) {
    const soyadAdaylar: DeputyMasterEntry[] = [];
    for (const dep of DEPUTY_MASTER_LIST) {
      if (String(dep.donem) !== termStr) continue;
      if (cleanStr(dep.il ?? '') !== ilClean) continue;
      const dn = cleanStr(dep.ad_soyad ?? '');
      if (dn === nameClean || dn.endsWith(' ' + nameClean)) soyadAdaylar.push(dep);
    }
    if (soyadAdaylar.length === 1) return normParti(soyadAdaylar[0]!.parti);
  }
  return 'Bilinmiyor';
}

const YURUTME_BELGE = /kanun\w*\s*tasar[ıi]s|kanun\w*\s*h[üu]km[üu]nde\s*kararname|(b[üu]t[çc]e|kesin\s*hesap)\s*kanun/i;
const TASARI_BAS = /^\s*tasar[ıi](?!\p{L})/iu;
export function yurutmeBelgesiMi(metin: string | undefined | null): boolean {
  return !!metin && (YURUTME_BELGE.test(metin) || TASARI_BAS.test(metin));
}

export function resolveParty(
  vekilAdi: string | undefined | null,
  donem: number | string,
  fallbackParties?: string[],
): string {
  const termStr = String(donem);
  const vekilClean = cleanStr(vekilAdi ?? '');
  let matched = 'DİĞER';

  if (vekilClean) {
    for (const dep of DEPUTY_MASTER_LIST) {
      if (String(dep.donem) !== termStr) continue;
      const depNameClean = cleanStr(dep.ad_soyad ?? '');
      if (depNameClean && depNameClean.length > 3 && vekilClean.includes(depNameClean)) {
        const depParty = dep.parti ?? '';
        if (depParty) {
          const depPartyClean = cleanStr(depParty);
          matched = toStandardKey(depPartyClean) ?? depPartyClean;
        }
        break;
      }
    }
  }

  if (matched === 'DİĞER' && fallbackParties && fallbackParties.length) {
    matched = toStandardKey(cleanStr(fallbackParties[0])) ?? 'DİĞER';
  }

  return matched === 'DİĞER' ? 'Bilinmiyor' : matched;
}

const IL_AD_RE = /^\s*(\S+)\s+Milletvekili\s+(.+?)\s*$/u;
export function ilAdAyir(ozet: string | undefined | null): { il: string; ad: string } | null {
  const m = IL_AD_RE.exec(ozet ?? '');
  return m ? { il: m[1]!, ad: m[2]! } : null;
}

export function araliktaParti(
  araliklar: { parti: string; ilk: string; son: string }[],
  tarih: string | undefined | null,
): string | null {
  if (!tarih) return null;
  const kapsayan = araliklar.filter((a) => a.ilk <= tarih && tarih <= a.son);
  const partiler = new Set(kapsayan.map((a) => a.parti));
  return partiler.size === 1 ? [...partiler][0]! : null;
}
