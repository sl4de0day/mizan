import Fastify from 'fastify';
import cors from '@fastify/cors';
import { getLogger } from './lib/logger.js';
import { getDb, adminCalismaBaslat, adminCalismaBitir } from './lib/db.js';
import { registerStatisticsRoutes } from './routes/statistics.js';
import { registerGazetteRoutes } from './routes/gazette.js';
import { registerParliamentRoutes } from './routes/parliament.js';
import { registerConstitutionalRoutes } from './routes/constitutional.js';
import { registerMilletvekiliRoutes } from './routes/milletvekili.js';
import { registerNewsRoutes } from './routes/news.js';
import { registerMilletvekiliStatsRoutes } from './routes/milletvekiliStats.js';
import { registerOnergeStatsRoutes } from './routes/onergeStats.js';
import { registerKanunStatsRoutes } from './routes/kanunStats.js';
import { registerTutanakAymStatsRoutes } from './routes/tutanakAymStats.js';
import { registerOzetRoutes, kaynakSayimi } from './routes/ozet.js';
import { TAZELIK_ESIK_GUN, tazelikDurumu, gunFarki } from './lib/saglik.js';
import { registerAdminRoutes } from './routes/admin.js';
import { incremental, ingestOylama, ingestOy, ingestAymParti, ingestDuyuru, ingestVekilKomisyon, ingestOnergeCevapOrneklem, ingestYerelYonetim } from './tools/etl.js';
import { cekSirasayisi } from './tools/sirasayisiScraper.js';
import { doldurBasilmisUrl } from './tools/basilmisUrl.js';
import { scrapeImzalar } from './tools/imzaScraper.js';
import { startGundemPoller, tbmmGate } from './lib/poll.js';
import { yedekAl, eskiYedekleriTemizle } from './tools/backup.js';
import { startAdminScheduler } from './routes/adminOps.js';

const logger = getLogger('PoliticalInsight.Core');

export async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] });

  const basladi = new Date().toISOString();

  app.get('/health', async () => {
    let tbmmSatirlari: { kaynak: string; donem: number; son: string | null; durum: string }[] = [];
    let hata: string | null = null;
    try {
      tbmmSatirlari = getDb().prepare(
        `SELECT kaynak, donem, MAX(son_calisma) AS son, durum FROM etl_durum GROUP BY kaynak, donem`,
      ).all() as { kaynak: string; donem: number; son: string | null; durum: string }[];
    } catch (e) {
      hata = (e as Error).message;
    }
    const tbmmAktif = tbmmSatirlari.filter((k) => k.donem === 28).map((k) => {
      const gun = gunFarki(k.son);
      return { kaynak: k.kaynak, son: k.son, gun, esik_gun: TAZELIK_ESIK_GUN[k.kaynak] ?? 3, durum: tazelikDurumu(gun, TAZELIK_ESIK_GUN[k.kaynak] ?? 3), calisma_durumu: k.durum };
    });
    const digerKaynaklar = (['aym', 'gazete', 'tuik', 'ysk', 'parti_program', 'yerel_yonetim'] as const).map((kaynak) => {
      const tabloTarihKolonu: Record<string, [string, string]> = {
        aym: ['aym_karar', 'karar_tarihi'], gazete: ['gazete', 'tarih'], tuik: ['tuik', 'tarih'],
        ysk: ['secim_sonucu', 'tarih'], parti_program: ['parti_program', 'guncelleme'], yerel_yonetim: ['yerel_karar', 'tarih'],
      };
      const [tablo, kolon] = tabloTarihKolonu[kaynak]!;
      const { son } = kaynakSayimi(tablo, kolon);
      const gun = gunFarki(son);
      const esikGun = TAZELIK_ESIK_GUN[kaynak] ?? 5;
      return { kaynak, son, gun, esik_gun: esikGun, durum: tazelikDurumu(gun, esikGun) };
    });
    const hepsi = [...tbmmAktif, ...digerKaynaklar];
    const bayatOlanlar = hepsi.filter((k) => k.durum === 'bayat');
    const bozuk = tbmmAktif.filter((k) => k.calisma_durumu !== 'ok').map((k) => `${k.kaynak}/d28:${k.calisma_durumu}`);
    const enEski = tbmmAktif.length ? Math.max(...tbmmAktif.map((k) => k.gun ?? 9999)) : null;
    return {
      ok: !hata && bayatOlanlar.length === 0 && bozuk.length === 0,
      service: 'political-insight-node',
      basladi,
      veri: {
        en_eski_gun: enEski,
        esik_gun: TAZELIK_ESIK_GUN['kanun'],
        bayat: bayatOlanlar.length > 0,
        bayat_kaynaklar: bayatOlanlar.map((k) => k.kaynak),
        bozuk_kaynaklar: bozuk,
        kaynaklar: tbmmAktif,
        diger_kaynaklar: digerKaynaklar,
        ...(hata ? { hata } : {}),
      },
    };
  });

  registerOzetRoutes(app);
  registerNewsRoutes(app);
  registerAdminRoutes(app);

  return app;
}

async function geceliKZinciri(): Promise<void> {
  const adim = async (ad: string, fn: () => Promise<unknown>, kapili = true): Promise<void> => {
    const dbId = adminCalismaBaslat(ad, 'gecelik-zincir');
    try {
      const sonuc = await (kapili ? tbmmGate(fn) : fn());
      adminCalismaBitir(dbId, 'tamam', sonuc == null ? null : String(sonuc).slice(0, 500), null);
    } catch (e) {
      const mesaj = (e as Error).message;
      adminCalismaBitir(dbId, 'hata', null, mesaj);
      logger.error(`[gecelik] ${ad} hatası: ${mesaj}`);
    }
  };
  await adim('incremental', () => incremental());
  await adim('imza', () => scrapeImzalar());
  await adim('oylama', () => ingestOylama(), false);
  await adim('oy', () => ingestOy());
  await adim('sirasayisi', () => cekSirasayisi({ eksikAlan: false }));
  await adim('basilmis-url', () => doldurBasilmisUrl());
  await adim('aym-parti', () => ingestAymParti(), false);
  await adim('vekil-komisyon', () => ingestVekilKomisyon());
  await adim('onerge-cevap', () => ingestOnergeCevapOrneklem());
  await adim('duyuru', () => Promise.resolve(ingestDuyuru()), false);
  await adim('yerel-yonetim', async () => {
    const son = (getDb().prepare('SELECT MAX(guncelleme) m FROM yerel_karar').get() as { m: string | null }).m;
    const gunFarki = son ? (Date.now() - new Date(son).getTime()) / 86400000 : Infinity;
    if (gunFarki < 7) { logger.info(`[gecelik] yerel-yonetim atlandı (son koşu ${gunFarki.toFixed(1)} gün önce, eşik 7).`); return; }
    await ingestYerelYonetim();
  }, false);
  logger.info('[gecelik] zincir tamamlandı.');
}

function scheduleNightlyEtl(): void {
  const now = new Date();
  const next = new Date(now);
  next.setHours(3, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  const ms = next.getTime() - now.getTime();
  logger.info(`Gecelik ETL zamanlandı: ${next.toLocaleString('tr-TR')}`);
  setTimeout(() => {
    logger.info('Gecelik ETL başlıyor (incremental)...');
    geceliKZinciri()
      .catch((e) => logger.error(`Gecelik ETL hatası: ${(e as Error).message}`))
      .finally(() => scheduleNightlyEtl());
  }, ms);
}

function scheduleNightlyBackup(): void {
  const now = new Date();
  const next = new Date(now);
  next.setHours(4, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  const ms = next.getTime() - now.getTime();
  logger.info(`Gecelik yedekleme zamanlandı: ${next.toLocaleString('tr-TR')}`);
  setTimeout(() => {
    const dbId = adminCalismaBaslat('backup', 'gecelik-yedek');
    try {
      const yol = yedekAl();
      eskiYedekleriTemizle();
      adminCalismaBitir(dbId, 'tamam', yol, null);
    } catch (e) {
      const mesaj = (e as Error).message;
      adminCalismaBitir(dbId, 'hata', null, mesaj);
      logger.error(`Gecelik yedekleme hatası: ${mesaj}`);
    } finally {
      scheduleNightlyBackup();
    }
  }, ms);
}

async function gecikmisIseKostur(): Promise<void> {
  const ESIK_SAAT = 20;
  try {
    const row = getDb().prepare(
      "SELECT MAX(son_calisma) AS son FROM etl_durum WHERE donem = 28",
    ).get() as { son: string | null };
    if (!row?.son) return;
    const saat = (Date.now() - Date.parse(row.son)) / 3_600_000;
    if (saat < ESIK_SAAT) return;
    logger.warn(`[gecelik] son koşma ${saat.toFixed(1)} saat önce (eşik ${ESIK_SAAT}) — kaçırılan gece telafi ediliyor.`);
    await geceliKZinciri();
  } catch (e) {
    logger.error(`[gecelik] telafi kontrolü başarısız: ${(e as Error).message}`);
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (isMain) {
  const app = await buildApp();
  const port = Number(process.env.PORT ?? 8000);
  app
    .listen({ host: '0.0.0.0', port })
    .then(() => {
      logger.info(`PoliticalInsight (Node) dinleniyor: http://0.0.0.0:${port}`);
      if (process.env.ETL_DISABLED !== '1') {
        scheduleNightlyEtl();
        gecikmisIseKostur();
      }
      if (process.env.GUNDEM_DISABLED !== '1') startGundemPoller();
      if (process.env.BACKUP_DISABLED !== '1') scheduleNightlyBackup();
      startAdminScheduler();
    })
    .catch((e) => {
      logger.error(`Sunucu başlatılamadı: ${(e as Error).message}`);
      process.exit(1);
    });
}
