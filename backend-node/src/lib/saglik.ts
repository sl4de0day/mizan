export const TAZELIK_ESIK_GUN: Record<string, number> = {
  kanun: 3, onerge: 3, konusma: 3,
  gazete: 5,
  aym: 14,
  tuik: 45,
  yerel_yonetim: 8,
  ysk: 120, parti_program: 120,
  vekil_roster: 21,
};

export type TazelikDurumu = 'taze' | 'yaslanan' | 'bayat';

export function tazelikDurumu(gun: number | null, esikGun: number): TazelikDurumu {
  if (gun === null) return 'bayat';
  if (gun <= esikGun) return 'taze';
  if (gun <= esikGun * 2) return 'yaslanan';
  return 'bayat';
}

export function gunFarki(sonTarih: string | null): number | null {
  if (!sonTarih) return null;
  const t = Date.parse(sonTarih);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}
