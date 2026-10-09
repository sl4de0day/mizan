import { getDb, partiDagilimiSnapshot, rebuildVekilPartiDonem, vekilPartiTarihte } from '../lib/db.js';
import { ilAdAyir, resolveByNameIl } from '../lib/partyResolve.js';
import { getLogger } from '../lib/logger.js';

const logger = getLogger('PoliticalInsight.MigrateOnergeAtif');

interface Degisim { faaliyet_id: number; eski: string; yeni: string; donem: number; kademe: 'timeline' | 'il' }

function onergeDegisimleri(): Degisim[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT f.id, f.donem, f.tarih, f.ozet, fp.parti AS eski
       FROM faaliyet f JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
      WHERE f.kaynak = 'onerge'`,
  ).all() as { id: number; donem: number; tarih: string | null; ozet: string; eski: string }[];

  const out: Degisim[] = [];
  for (const r of rows) {
    const ia = ilAdAyir(r.ozet);
    if (!ia) continue;
    let yeni: string | null = null;
    let kademe: 'timeline' | 'il' = 'timeline';
    if (r.tarih) { const tp = vekilPartiTarihte(ia.ad, r.donem, r.tarih); if (tp) { yeni = tp; kademe = 'timeline'; } }
    if (!yeni) { const ip = resolveByNameIl(ia.ad, ia.il, r.donem); if (ip && ip !== 'Bilinmiyor') { yeni = ip; kademe = 'il'; } }
    if (yeni && yeni !== r.eski) out.push({ faaliyet_id: r.id, eski: r.eski, yeni, donem: r.donem, kademe });
  }
  return out;
}

function diffRaporu(degisimler: Degisim[]): void {
  const akis = new Map<string, number>();
  const net = new Map<string, number>();
  const kademeSay = { timeline: 0, il: 0 };
  for (const d of degisimler) {
    akis.set(`${d.eski} → ${d.yeni}`, (akis.get(`${d.eski} → ${d.yeni}`) ?? 0) + 1);
    net.set(d.yeni, (net.get(d.yeni) ?? 0) + 1);
    net.set(d.eski, (net.get(d.eski) ?? 0) - 1);
    kademeSay[d.kademe]++;
  }
  logger.info(`Değişecek önerge: ${degisimler.length} (zaman-çizgisi: ${kademeSay.timeline} · il-adaş: ${kademeSay.il})`);
  logger.info('En çok akış (roster yazmış → düzeltilmiş · adet):');
  for (const [k, v] of [...akis.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) logger.info(`  ${k.padEnd(34)} ${v}`);
  logger.info('NET parti payı kayması (+ kazanan · − roster fazlası):');
  for (const [p, v] of [...net.entries()].sort((a, b) => b[1] - a[1])) {
    if (Math.abs(v) >= 2) logger.info(`  ${p.padEnd(20)} ${v > 0 ? '+' : ''}${v}`);
  }
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const db = getDb();

  const swN = rebuildVekilPartiDonem();
  logger.info(`vekil_parti_donem: ${swN} switcher-parti aralığı (KANUN imzasından, parti_kaynak='tbmm').`);

  const degisimler = onergeDegisimleri();
  diffRaporu(degisimler);

  if (!commit) {
    logger.info('DRY-RUN — hiçbir şey yazılmadı. Uygulamak için: npm run migrate:onerge-atif -- --commit');
    return;
  }
  if (!degisimler.length) { logger.info('Değişecek önerge yok — migration gereksiz.'); return; }

  const damga = partiDagilimiSnapshot('onerge-atif migration ÖNCESİ');
  logger.info(`L4 snapshot alındı: ${damga}`);

  db.exec('DROP TABLE IF EXISTS faaliyet_parti_yedek_onerge;');
  db.exec('CREATE TABLE faaliyet_parti_yedek_onerge AS SELECT * FROM faaliyet_parti;');
  const yedekN = (db.prepare('SELECT COUNT(*) c FROM faaliyet_parti_yedek_onerge').get() as { c: number }).c;
  logger.info(`Yedek: faaliyet_parti_yedek_onerge (${yedekN} satır)`);

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
  logger.info(`Uygulandı: ${degisimler.length} önerge güncellendi.`);

  const kalan = onergeDegisimleri().length;
  if (kalan > 0) { logger.error(`🔴 ${kalan} değişim HÂLÂ var — beklenmedik (idempotent değil), incele.`); return; }
  logger.info('✓ Doğrulandı: önerge atfı idempotent (yeniden hesap 0 değişim).');
  logger.info(`L4 diff için: npm run dagilim -- diff ${damga}`);
}

main().catch((e) => { logger.error((e as Error).message); process.exit(1); });
