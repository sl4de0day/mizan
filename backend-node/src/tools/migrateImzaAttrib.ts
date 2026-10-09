import { getDb, partiDagilimiSnapshot } from '../lib/db.js';
import { getLogger } from '../lib/logger.js';

const logger = getLogger('PoliticalInsight.MigrateImzaAttrib');

interface Degisim { faaliyet_id: number; eski: string; yeni: string; donem: number }

function celiskileriBul(): Degisim[] {
  return getDb().prepare(
    `SELECT f.id AS faaliyet_id, f.donem, fp.parti AS eski, i.parti AS yeni
       FROM faaliyet f
       JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
       JOIN imza i ON i.faaliyet_id = f.id AND i.ilk_imza = 1
      WHERE f.kaynak = 'kanun' AND fp.parti <> i.parti`,
  ).all() as unknown as Degisim[];
}

function diffRaporu(degisimler: Degisim[]): void {
  const akis = new Map<string, number>();
  const net = new Map<string, number>();
  for (const d of degisimler) {
    akis.set(`${d.eski} → ${d.yeni}`, (akis.get(`${d.eski} → ${d.yeni}`) ?? 0) + 1);
    net.set(d.yeni, (net.get(d.yeni) ?? 0) + 1);
    net.set(d.eski, (net.get(d.eski) ?? 0) - 1);
  }
  logger.info(`Değişecek kayıt: ${degisimler.length} (kanun ilk-imza; faaliyet_parti ≠ imza)`);
  logger.info('En çok değişim (roster yazmış → imza diyor · adet):');
  for (const [k, v] of [...akis.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) logger.info(`  ${k.padEnd(32)} ${v}`);
  logger.info('NET parti payı kayması (+ imza\'ya göre kazanan · − roster fazlası):');
  for (const [p, v] of [...net.entries()].sort((a, b) => b[1] - a[1])) {
    if (Math.abs(v) >= 3) logger.info(`  ${p.padEnd(20)} ${v > 0 ? '+' : ''}${v}`);
  }
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const db = getDb();
  const degisimler = celiskileriBul();

  diffRaporu(degisimler);

  if (!commit) {
    logger.info('DRY-RUN — hiçbir şey yazılmadı. Uygulamak için: npm run migrate:imza-attrib -- --commit');
    return;
  }
  if (!degisimler.length) { logger.info('Değişecek kayıt yok — migration gereksiz.'); return; }

  const damga = partiDagilimiSnapshot('imza-attrib migration ÖNCESİ');
  logger.info(`L4 snapshot alındı: ${damga}`);

  db.exec('DROP TABLE IF EXISTS faaliyet_parti_yedek_imza;');
  db.exec('CREATE TABLE faaliyet_parti_yedek_imza AS SELECT * FROM faaliyet_parti;');
  const yedekN = (db.prepare('SELECT COUNT(*) c FROM faaliyet_parti_yedek_imza').get() as { c: number }).c;
  logger.info(`Yedek: faaliyet_parti_yedek_imza (${yedekN} satır)`);

  const sil = db.prepare('DELETE FROM faaliyet_parti WHERE faaliyet_id = ?');
  const ekle = db.prepare('INSERT OR IGNORE INTO faaliyet_parti (faaliyet_id, parti) VALUES (?, ?)');
  db.exec('BEGIN IMMEDIATE;');
  try {
    for (const d of degisimler) { sil.run(d.faaliyet_id); ekle.run(d.faaliyet_id, d.yeni); }
    db.exec('COMMIT;');
  } catch (e) {
    db.exec('ROLLBACK;');
    throw e;
  }
  logger.info(`Uygulandı: ${degisimler.length} kayıt güncellendi.`);

  const kalan = celiskileriBul().length;
  if (kalan > 0) { logger.error(`🔴 ${kalan} çelişki HÂLÂ var — beklenmedik, incele.`); return; }
  logger.info('✓ Doğrulandı: kanun ilk-imza belgelerinde faaliyet_parti = imza (0 çelişki).');
  logger.info(`L4 diff için: npm run dagilim -- diff ${damga}`);
}

main().catch((e) => { logger.error((e as Error).message); process.exit(1); });
