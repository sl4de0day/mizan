import { poll, pollKonusma, pollGazette, pollAym, pollTuik } from '../tools/etl.js';
import { savePollDurum } from './db.js';
import { getLogger } from './logger.js';

const logger = getLogger('PoliticalInsight.Poller');
const DK = 60_000;
const SA = 3_600_000;

let gate: Promise<unknown> = Promise.resolve();
export function tbmmGate<T>(fn: () => Promise<T>): Promise<T> {
  const run = gate.then(() => fn());
  gate = run.catch(() => undefined);
  return run;
}

const isWaf = (e: unknown) => /Request Rejected|WAF|blocked|403|güvenlik duvar/i.test((e as Error)?.message ?? '');
class Breaker {
  private fails = 0;
  private openUntil = 0;
  private cooldown = 30 * DK;
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  canTry(): boolean {
    if (this.state !== 'OPEN') return true;
    if (Date.now() >= this.openUntil) { this.state = 'HALF_OPEN'; return true; }
    return false;
  }
  onSuccess(): void { this.fails = 0; this.cooldown = 30 * DK; this.state = 'CLOSED'; }
  onBlocked(): void {
    this.fails++;
    if (this.fails >= 3 || this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.openUntil = Date.now() + this.cooldown;
      this.cooldown = Math.min(this.cooldown * 2, 4 * SA);
    }
  }
}
const breaker = new Breaker();

function istNow(): { gun: number; saat: number; ay: number; tarih: number } {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Istanbul' }));
  return { gun: d.getDay(), saat: d.getHours(), ay: d.getMonth() + 1, tarih: d.getDate() };
}
function isTatil(t = istNow()): boolean {
  return (t.ay === 7 && t.tarih >= 15) || t.ay === 8 || t.ay === 9 || (t.ay === 10 && t.tarih === 1);
}
function tabanAralik(): number {
  const mode = process.env.POLL_MODE;
  if (mode === 'hot') return 8 * DK;
  if (mode === 'recess') return 6 * SA;
  const t = istNow();
  if (isTatil(t)) return 6 * SA;
  if (t.gun === 0 || t.gun === 6) return 4 * SA;
  const oturum = t.gun >= 2 && t.gun <= 4;
  if (oturum && t.saat >= 11 && t.saat < 24) return 20 * DK;
  if (t.saat >= 9 && t.saat < 19) return 90 * DK;
  return 3 * SA;
}
const FLOOR = 8 * DK;
function sonrakiAralik(yeni: number, bos: number): number {
  const taban = tabanAralik();
  const cap = isTatil() ? 12 * SA : 3 * SA;
  if (yeni > 0) return Math.max(FLOOR, Math.round(taban * 0.5)) + 2000;
  return Math.max(FLOOR, Math.min(taban * Math.min(Math.max(bos, 1), 4), cap));
}

let ardisikBos = 0;

async function lawMotionTick(): Promise<void> {
  let next: number;
  if (breaker.canTry()) {
    try {
      const s = await tbmmGate(() => poll());
      breaker.onSuccess();
      const yeni = s.yeniKanun + s.yeniOnerge;
      ardisikBos = yeni > 0 ? 0 : ardisikBos + 1;
      savePollDurum({ son_poll: new Date().toISOString(), ardisik_bos: ardisikBos, devre_durumu: breaker.state, son_ozet: JSON.stringify(s) });
      next = sonrakiAralik(yeni, ardisikBos);
    } catch (e) {
      if (isWaf(e)) { breaker.onBlocked(); logger.error(`[poller] WAF blok → devre ${breaker.state}`); }
      else logger.error(`[poller] hata: ${(e as Error).message}`);
      savePollDurum({ devre_durumu: breaker.state });
      next = breaker.state === 'OPEN' ? 30 * DK : Math.max(FLOOR, tabanAralik());
    }
  } else {
    next = 30 * DK;
  }
  setTimeout(() => void lawMotionTick(), next);
}

async function minuteTick(): Promise<void> {
  if (breaker.canTry()) {
    try {
      await tbmmGate(() => pollKonusma());
      await tbmmGate(() => pollGazette());
      breaker.onSuccess();
    } catch (e) { if (isWaf(e)) breaker.onBlocked(); logger.error(`[poller-günlük] ${(e as Error).message}`); }
  }
  try { await pollAym(); } catch (e) { logger.error(`[poller-aym] ${(e as Error).message}`); }
  try { await pollTuik(); } catch (e) { logger.error(`[poller-tuik] ${(e as Error).message}`); }
  setTimeout(() => void minuteTick(), 24 * SA);
}

export function startGundemPoller(): void {
  logger.info('Canlı gündem poller başlatıldı (oturum-farkında kadans + WAF devre-kesici + eşzamanlılık-1).');
  setTimeout(() => void lawMotionTick(), 5000 + Math.floor(Math.random() * 5000));
  setTimeout(() => void minuteTick(), 60 * DK);
}
