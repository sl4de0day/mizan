export const BOSLUK_GUN = 365;

export const gunFark = (a: string, b: string): number =>
  Math.round((new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86400000);

export const aykiriAyikla = (tarihler: string[]): string | null => {
  if (!tarihler.length) return null;
  let i = 0;
  while (i < tarihler.length - 1 && gunFark(tarihler[i]!, tarihler[i + 1]!) > BOSLUK_GUN) i++;
  return tarihler[i]!;
};
