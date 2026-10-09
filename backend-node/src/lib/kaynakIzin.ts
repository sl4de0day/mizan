
export const IZINLI_HOSTLAR: readonly string[] = [
  'tbmm.gov.tr',
  'resmigazete.gov.tr',
  'anayasa.gov.tr',
  'tuik.gov.tr',
];

export type IzinSonuc = { izinli: true } | { izinli: false; sebep: string };

const HOST_KAYNAK: readonly [string, 'tbmm' | 'gazete' | 'aym' | 'tuik'][] = [
  ['tbmm.gov.tr', 'tbmm'],
  ['resmigazete.gov.tr', 'gazete'],
  ['anayasa.gov.tr', 'aym'],
  ['tuik.gov.tr', 'tuik'],
];
export function kaynakForUrl(ham: string): 'tbmm' | 'gazete' | 'aym' | 'tuik' | undefined {
  let host: string;
  try { host = new URL(ham).hostname.toLowerCase().replace(/\.$/, ''); } catch { return undefined; }
  const bulunan = HOST_KAYNAK.find(([h]) => host === h || host.endsWith(`.${h}`));
  return bulunan?.[1];
}

const OZEL_IP = [
  /^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^0\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^::1$/, /^\[?::1\]?$/, /^f[cd][0-9a-f]{2}:/i, /^fe80:/i,
];

const ipLiteraliMi = (host: string): boolean =>
  /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || /^\[.*\]$/.test(host);

export function izinliMi(ham: string): IzinSonuc {
  let u: URL;
  try { u = new URL(ham); } catch { return { izinli: false, sebep: 'URL ayrıştırılamadı' }; }

  if (u.protocol !== 'https:') return { izinli: false, sebep: `yalnız https (verilen: ${u.protocol})` };
  if (u.username || u.password) return { izinli: false, sebep: 'URL kimlik bilgisi taşıyor (user:pass@)' };
  if (u.port && u.port !== '443') return { izinli: false, sebep: `standart dışı port: ${u.port}` };

  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (ipLiteraliMi(host)) {
    if (OZEL_IP.some((r) => r.test(host))) return { izinli: false, sebep: `özel/yerel ağ adresi: ${host}` };
    return { izinli: false, sebep: 'IP literali kabul edilmiyor — kaynak alan adıyla verilmeli' };
  }
  const uyan = IZINLI_HOSTLAR.some((h) => host === h || host.endsWith(`.${h}`));
  if (!uyan) return { izinli: false, sebep: `izinli resmî kaynak listesinde değil: ${host}` };
  return { izinli: true };
}

export function izinliZincir(urller: readonly string[]): IzinSonuc {
  if (urller.length > 5) return { izinli: false, sebep: 'yönlendirme zinciri çok uzun (>5)' };
  for (const u of urller) {
    const s = izinliMi(u);
    if (!s.izinli) return { izinli: false, sebep: `yönlendirme reddedildi (${u}): ${s.sebep}` };
  }
  return { izinli: true };
}
