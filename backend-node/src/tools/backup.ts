import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, DB_PATH } from '../lib/db.js';
import { STORAGE_DIR } from '../lib/config.js';
import { getLogger } from '../lib/logger.js';

const logger = getLogger('PoliticalInsight.Backup');
const YEDEK_DIR = join(STORAGE_DIR, 'backups');

function zamanDamgasi(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function yedekAl(): string {
  if (!existsSync(YEDEK_DIR)) mkdirSync(YEDEK_DIR, { recursive: true });
  const hedef = join(YEDEK_DIR, `analytics-${zamanDamgasi()}.db`);
  if (existsSync(hedef)) throw new Error(`yedek dosyası zaten var: ${hedef}`);
  getDb().prepare('VACUUM INTO ?').run(hedef);
  const boyutMb = (statSync(hedef).size / (1024 * 1024)).toFixed(1);
  logger.info(`[yedek] alındı: ${hedef} (${boyutMb} MB)`);
  return hedef;
}

export function eskiYedekleriTemizle(tutulacak = 14): number {
  if (!existsSync(YEDEK_DIR)) return 0;
  const dosyalar = readdirSync(YEDEK_DIR)
    .filter((f) => f.startsWith('analytics-') && f.endsWith('.db'))
    .map((f) => ({ ad: f, yol: join(YEDEK_DIR, f), mtime: statSync(join(YEDEK_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const silinecekler = dosyalar.slice(tutulacak);
  for (const d of silinecekler) {
    try { unlinkSync(d.yol); } catch (e) { logger.warn(`[yedek] silinemedi: ${d.ad} (${String(e).slice(0, 80)})`); }
  }
  if (silinecekler.length) logger.info(`[yedek] ${silinecekler.length} eski yedek temizlendi (${tutulacak} tutuluyor).`);
  return silinecekler.length;
}

if (process.argv[1]?.includes('backup')) {
  try {
    yedekAl();
    eskiYedekleriTemizle();
    process.exit(0);
  } catch (e) {
    logger.error(`[yedek] ÇÖKTÜ: ${e}`);
    process.exit(1);
  }
}
