import { getDb, partiDagilimiSnapshot, partiIlkOtantikTarih, vekilOtantikPartiTarihte } from '../lib/db.js';
import { ilAdAyir } from '../lib/partyResolve.js';
import { getLogger } from '../lib/logger.js';

const logger = getLogger('PoliticalInsight.MigrateAnakronizm');

interface Degisim { faaliyet_id: number; eski: string; yeni: string; kaynak: string; }

function vekilAdiCikar(kaynak: string, ozet: string | null): string | null {
  if (!ozet) return null;
  const ia = ilAdAyir(ozet);
  if (ia) return ia.ad;
  const m = ozet.match(/^(.+?)\s*\(/);
  return m ? m[1].trim() : null;
}

function anakronizmleriBul(): Degisim[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT f.id, f.kaynak, f.tarih, f.ozet, fp.parti AS eski
       FROM faaliyet f JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
      WHERE f.tarih IS NOT NULL`,
  ).all() as { id: number; kaynak: string; tarih: string; ozet: string | null; eski: string }[];

  const out: Degisim[] = [];
  for (const r of rows) {
    const dogus = partiIlkOtantikTarih(r.eski);
    if (!dogus || r.tarih >= dogus) continue;
    const ad = vekilAdiCikar(r.kaynak, r.ozet);
    const yeni = vekilOtantikPartiTarihte(ad, r.tarih);
    if (!yeni || yeni === r.eski || yeni === 'Bilinmiyor') continue;
    out.push({ faaliyet_id: r.id, eski: r.eski, yeni, kaynak: r.kaynak });
  }
  return out;
}

function diffRaporu(degisimler: Degisim[]): void {
  const akis = new Map<string, number>();
  const net = new Map<string, number>();
  const kaynakSay = new Map<string, number>();
  for (const d of degisimler) {
    const k = `${d.eski} → ${d.yeni}`;
    akis.set(k, (akis.get(k) ?? 0) + 1);
    net.set(d.eski, (net.get(d.eski) ?? 0) - 1);
    net.set(d.yeni, (net.get(d.yeni) ?? 0) + 1);
    kaynakSay.set(d.kaynak, (kaynakSay.get(d.kaynak) ?? 0) + 1);
  }
  logger.info(`Değişecek satır: ${degisimler.length}`);
  logger.info('Kaynak kırılımı: ' + [...kaynakSay.entries()].map(([k, v]) => `${k}=${v}`).join(' · '));
  logger.info('En çok akış (anakronik → otantik · adet):');
  for (const [k, v] of [...akis.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) logger.info(`  ${k.padEnd(34)} ${v}`);
  logger.info('NET parti payı kayması (+ kazanan · − anakronik fazlası):');
  for (const [p, v] of [...net.entries()].sort((a, b) => b[1] - a[1])) {
    if (Math.abs(v) >= 2) logger.info(`  ${p.padEnd(20)} ${v > 0 ? '+' : ''}${v}`);
  }
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const db = getDb();

  const degisimler = anakronizmleriBul();
  diffRaporu(degisimler);

  if (!commit) {
    logger.info('DRY-RUN — hiçbir şey yazılmadı. Uygulamak için: npm run migrate:anakronizm -- --commit');
    return;
  }
  if (!degisimler.length) { logger.info('Değişecek satır yok — migration gereksiz.'); return; }

  const damga = partiDagilimiSnapshot('anakronizm migration ÖNCESİ');
  logger.info(`L4 snapshot alındı: ${damga}`);

  db.exec('DROP TABLE IF EXISTS faaliyet_parti_yedek_anakronizm;');
  db.exec('CREATE TABLE faaliyet_parti_yedek_anakronizm AS SELECT * FROM faaliyet_parti;');
  const yedekN = (db.prepare('SELECT COUNT(*) c FROM faaliyet_parti_yedek_anakronizm').get() as { c: number }).c;
  logger.info(`Yedek: faaliyet_parti_yedek_anakronizm (${yedekN} satır)`);

  const sil = db.prepare('DELETE FROM faaliyet_parti WHERE faaliyet_id = ? AND parti = ?');
  const ekle = db.prepare('INSERT OR IGNORE INTO faaliyet_parti (faaliyet_id, parti) VALUES (?, ?)');
  db.exec('BEGIN IMMEDIATE;');
  try {
    for (const d of degisimler) { sil.run(d.faaliyet_id, d.eski); ekle.run(d.faaliyet_id, d.yeni); }
    db.exec('COMMIT;');
  } catch (e) {
    db.exec('ROLLBACK;');
    throw e;
  }
  logger.info(`Uygulandı: ${degisimler.length} satır güncellendi.`);

  const kalan = anakronizmleriBul().length;
  if (kalan > 0) { logger.error(`🔴 ${kalan} anakronizm HÂLÂ var — beklenmedik (idempotent değil), incele.`); return; }
  logger.info('✓ Doğrulandı: anakronizm kapısı idempotent (yeniden hesap 0 değişim).');
  logger.info(`L4 diff için: npm run dagilim -- diff ${damga}`);
}

main().catch((e) => { logger.error((e as Error).message); process.exit(1); });
