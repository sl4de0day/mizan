import { getDb } from '../lib/db.js';
import { LawEngine } from '../engines/law.js';
import { getLogger } from '../lib/logger.js';

const logger = getLogger('PoliticalInsight.Sirasayisi');

const BEKLE_MS = 400;
const ARDISIK_HATA_TAVANI = 5;

const uyu = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function cekSirasayisi(opts: { donem?: number; durum?: string; limit?: number; dryRun?: boolean; eksikAlan?: boolean } = {}) {
  const donem = opts.donem ?? 28;
  const durum = opts.durum ?? 'KANUNLAŞTI';
  const db = getDb();

  const kosul = durum === 'HEPSI' ? '' : ' AND f.durum = ?';
  const params: (string | number)[] = [donem];
  if (kosul) params.push(durum);
  const limitSql = opts.limit ? ` LIMIT ${Number(opts.limit)}` : '';

  const eksikAlan = !!opts.eksikAlan;
  const secim = eksikAlan
    ? `EXISTS (SELECT 1 FROM teklif_sirasayisi t WHERE t.faaliyet_id = f.id
                AND (t.esas_no IS NULL OR t.gelis_tarihi IS NULL))`
    : `NOT EXISTS (SELECT 1 FROM teklif_sirasayisi t WHERE t.faaliyet_id = f.id)`;
  const hedefler = db.prepare(
    `SELECT f.id, f.kaynak_id, f.baslik FROM faaliyet f
      WHERE f.kaynak='kanun' AND f.donem = ?${kosul}
        AND f.kaynak_id IS NOT NULL AND TRIM(f.kaynak_id) <> ''
        AND ${secim}
      ORDER BY f.tarih DESC${limitSql}`,
  ).all(...params) as { id: number; kaynak_id: string; baslik: string }[];

  const zaten = (db.prepare(`SELECT COUNT(*) n FROM teklif_sirasayisi`).get() as { n: number }).n;
  logger.info(`[sirasayisi] d${donem} · durum=${durum} · çekilecek ${hedefler.length} (zaten kayıtlı ${zaten})`);
  if (!hedefler.length) return { cekilen: 0, bulunan: 0, bos: 0, hata: 0 };
  if (opts.dryRun) { logger.info('[sirasayisi] --dry-run → ağ isteği YOK'); return { cekilen: 0, bulunan: 0, bos: 0, hata: 0 }; }

  const engine = new LawEngine();
  const ekle = db.prepare(
    `INSERT OR REPLACE INTO teklif_sirasayisi
       (faaliyet_id, sira_sayisi, kanun_no, esas_no, gelis_tarihi, cekim_zamani)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  let bulunan = 0, bos = 0, hata = 0, ardisik = 0;
  const simdi = new Date().toISOString();
  for (const [i, h] of hedefler.entries()) {
    try {
      const d = await engine.fetchLawSirasayisi(h.kaynak_id);
      if (!d.alanSayisi) { hata++; ardisik++; }
      else {
        ardisik = 0;
        if (d.sirasayisi) { ekle.run(h.id, d.sirasayisi, d.kanunNo, d.esasNo, d.gelisTarihi, simdi); bulunan++; }
        else bos++;
      }
    } catch (e) {
      hata++; ardisik++;
      logger.warn(`[sirasayisi] ${h.kaynak_id}: ${String(e).slice(0, 90)}`);
    }
    if (ardisik >= ARDISIK_HATA_TAVANI) {
      logger.error(`[sirasayisi] ÜST ÜSTE ${ardisik} hata → DURDURULDU (WAF olabilir). `
        + `Şimdiye kadar ${bulunan} kayıt yazıldı; komut yeniden çalıştırılınca kaldığı yerden devam eder.`);
      break;
    }
    if ((i + 1) % 20 === 0) logger.info(`[sirasayisi] ${i + 1}/${hedefler.length} · bulunan ${bulunan} · boş ${bos} · hata ${hata}`);
    await uyu(BEKLE_MS);
  }

  const denendi = bulunan + bos + hata;
  if (denendi > 10 && bulunan / denendi < 0.3) {
    logger.error(`[sirasayisi] ⚠️ BULMA ORANI DÜŞÜK (%${((100 * bulunan) / denendi).toFixed(1)}) — `
      + `alan etiketi değişmiş ya da istekler engellenmiş olabilir. Sonucu KULLANMADAN ÖNCE doğrula.`);
  }
  logger.info(`[sirasayisi] BİTTİ · bulunan ${bulunan} · boş ${bos} · hata ${hata}`);
  return { cekilen: denendi, bulunan, bos, hata };
}

const argv = process.argv.slice(2);
const arg = (ad: string) => { const i = argv.indexOf(`--${ad}`); return i >= 0 ? argv[i + 1] : undefined; };
if (process.argv[1]?.includes('sirasayisiScraper')) {
  cekSirasayisi({
    donem: arg('donem') ? Number(arg('donem')) : undefined,
    durum: arg('durum'),
    limit: arg('limit') ? Number(arg('limit')) : undefined,
    dryRun: argv.includes('--dry-run'),
    eksikAlan: argv.includes('--eksik-alan'),
  }).then((r) => { logger.info(`[sirasayisi] ${JSON.stringify(r)}`); process.exit(0); })
    .catch((e) => { logger.error(`[sirasayisi] ÇÖKTÜ: ${e}`); process.exit(1); });
}
