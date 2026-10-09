import { getDb } from '../lib/db.js';
import { LawEngine } from '../engines/law.js';
import { getLogger } from '../lib/logger.js';

const logger = getLogger('PoliticalInsight.TarihBackfill');

const BEKLE_MS = 400;
const ARDISIK_HATA_TAVANI = 5;
const PENCERE_TAMPON_GUN = 90;

const uyu = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gunEkle = (iso: string, gun: number): string => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + gun);
  return d.toISOString().slice(0, 10);
};

export async function backfillKanunTarih(
  opts: { donem?: number; limit?: number; dryRun?: boolean } = {},
): Promise<{ denendi: number; bulunan: number; bos: number; reddedildi: number; hata: number }> {
  const db = getDb();
  const donemKosul = opts.donem ? ' AND f.donem = ?' : '';
  const params: (string | number)[] = opts.donem ? [opts.donem] : [];
  const limitSql = opts.limit ? ` LIMIT ${Number(opts.limit)}` : '';

  const pencereler = new Map<number, { lo: string; hi: string }>();
  for (const row of db.prepare(
    `SELECT donem, MIN(tarih) lo, MAX(tarih) hi FROM faaliyet WHERE kaynak='kanun' AND tarih IS NOT NULL GROUP BY donem`,
  ).all() as { donem: number; lo: string; hi: string }[]) pencereler.set(row.donem, { lo: row.lo, hi: row.hi });

  const hedefler = db.prepare(
    `SELECT f.id, f.kaynak_id, f.baslik, f.donem FROM faaliyet f
      WHERE f.kaynak='kanun' AND f.tarih IS NULL${donemKosul}
        AND f.kaynak_id IS NOT NULL AND TRIM(f.kaynak_id) <> ''
      ORDER BY f.id${limitSql}`,
  ).all(...params) as { id: number; kaynak_id: string; baslik: string; donem: number }[];

  logger.info(`[tarih-backfill] tarih NULL olan ${hedefler.length} kanun teklifi bulundu${opts.donem ? ` (d${opts.donem})` : ' (tüm dönemler)'}.`);
  if (!hedefler.length) return { denendi: 0, bulunan: 0, bos: 0, reddedildi: 0, hata: 0 };
  if (opts.dryRun) { logger.info('[tarih-backfill] --dry-run → ağ isteği YOK'); return { denendi: 0, bulunan: 0, bos: 0, reddedildi: 0, hata: 0 }; }

  const engine = new LawEngine();
  const guncelle = db.prepare(`UPDATE faaliyet SET tarih = ?, ay = ?, yil = ?, guncelleme = ? WHERE id = ?`);

  let bulunan = 0, bos = 0, reddedildi = 0, hata = 0, ardisik = 0;
  const simdi = new Date().toISOString();
  for (const [i, h] of hedefler.entries()) {
    try {
      const d = await engine.fetchLawSirasayisi(h.kaynak_id);
      if (!d.alanSayisi) { hata++; ardisik++; }
      else {
        ardisik = 0;
        const p = pencereler.get(h.donem);
        const penceredeMi = !d.gelisTarihi || !p
          || (d.gelisTarihi >= gunEkle(p.lo, -PENCERE_TAMPON_GUN) && d.gelisTarihi <= gunEkle(p.hi, PENCERE_TAMPON_GUN));
        if (d.gelisTarihi && !d.yenilemeMi && penceredeMi) {
          guncelle.run(d.gelisTarihi, d.gelisTarihi.slice(0, 7), Number(d.gelisTarihi.slice(0, 4)), simdi, h.id);
          bulunan++;
        } else if (d.gelisTarihi) {
          reddedildi++;
        } else bos++;
      }
    } catch (e) {
      hata++; ardisik++;
      logger.warn(`[tarih-backfill] ${h.kaynak_id}: ${String(e).slice(0, 90)}`);
    }
    if (ardisik >= ARDISIK_HATA_TAVANI) {
      logger.error(`[tarih-backfill] ÜST ÜSTE ${ardisik} hata → DURDURULDU (WAF olabilir). `
        + `Şimdiye kadar ${bulunan} kayıt dolduruldu; komut yeniden çalıştırılınca kaldığı yerden devam eder.`);
      break;
    }
    if ((i + 1) % 50 === 0) logger.info(`[tarih-backfill] ${i + 1}/${hedefler.length} · bulunan ${bulunan} · boş ${bos} · reddedildi ${reddedildi} · hata ${hata}`);
    await uyu(BEKLE_MS);
  }

  const denendi = bulunan + bos + reddedildi + hata;
  logger.info(`[tarih-backfill] BİTTİ · bulunan ${bulunan} · boş ${bos} · reddedildi(pencere-dışı) ${reddedildi} · hata ${hata}`);
  return { denendi, bulunan, bos, reddedildi, hata };
}

const argv = process.argv.slice(2);
const arg = (ad: string): string | undefined => { const i = argv.indexOf(`--${ad}`); return i >= 0 ? argv[i + 1] : undefined; };
if (process.argv[1]?.includes('tarihBackfill')) {
  backfillKanunTarih({
    donem: arg('donem') ? Number(arg('donem')) : undefined,
    limit: arg('limit') ? Number(arg('limit')) : undefined,
    dryRun: argv.includes('--dry-run'),
  }).then((r) => { logger.info(`[tarih-backfill] ${JSON.stringify(r)}`); process.exit(0); })
    .catch((e) => { logger.error(`[tarih-backfill] ÇÖKTÜ: ${e}`); process.exit(1); });
}
