import { getDb } from '../lib/db.js';
import { MinuteEngine } from '../engines/minute.js';
import { getLogger } from '../lib/logger.js';

const logger = getLogger('PoliticalInsight.BasilmisUrl');
const BEKLE_MS = 600;
const ARDISIK_HATA_TAVANI = 5;
const uyu = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function doldurBasilmisUrl(opts: { dryRun?: boolean } = {}) {
  const db = getDb();
  const hedefler = db.prepare(
    `SELECT DISTINCT birlesim_id AS b FROM oylama
      WHERE birlesim_id IS NOT NULL AND birlesim_id <> ''
        AND (basilmis_url IS NULL OR basilmis_url = '')`,
  ).all() as { b: string }[];

  logger.info(`[basilmis] doldurulacak birleşim: ${hedefler.length}`);
  if (!hedefler.length) return { cekilen: 0, bulunan: 0, hata: 0 };
  if (opts.dryRun) { logger.info('[basilmis] --dry-run → ağ isteği YOK'); return { cekilen: 0, bulunan: 0, hata: 0 }; }

  const engine = new MinuteEngine();
  const upd = db.prepare('UPDATE oylama SET basilmis_url = ? WHERE birlesim_id = ?');
  let bulunan = 0, hata = 0, ardisik = 0;

  for (const [i, h] of hedefler.entries()) {
    try {
      const url = (await engine.fetchDetailMeta(h.b)).basilmis_url;
      if (url) { upd.run(url, h.b); bulunan++; ardisik = 0; }
      else {
        ardisik++;
        logger.warn(`[basilmis] ${h.b}: basilmis_url yok`);
      }
    } catch (e) {
      hata++; ardisik++;
      logger.warn(`[basilmis] ${h.b}: ${String(e).slice(0, 90)}`);
    }
    if (ardisik >= ARDISIK_HATA_TAVANI) {
      logger.error(`[basilmis] ÜST ÜSTE ${ardisik} boş/hata → DURDURULDU (WAF olabilir). `
        + `${bulunan} kayıt yazıldı; komut yeniden çalıştırılınca kaldığı yerden devam eder.`);
      break;
    }
    if ((i + 1) % 10 === 0) logger.info(`[basilmis] ${i + 1}/${hedefler.length} · bulunan ${bulunan}`);
    await uyu(BEKLE_MS);
  }
  logger.info(`[basilmis] BİTTİ · bulunan ${bulunan} · hata ${hata}`);
  return { cekilen: hedefler.length, bulunan, hata };
}

if (process.argv[1]?.includes('basilmisUrl')) {
  doldurBasilmisUrl({ dryRun: process.argv.includes('--dry-run') })
    .then((r) => { logger.info(`[basilmis] ${JSON.stringify(r)}`); process.exit(0); })
    .catch((e) => { logger.error(`[basilmis] ÇÖKTÜ: ${e}`); process.exit(1); });
}
