import type { FastifyInstance, FastifyRequest } from 'fastify';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, unlinkSync, createReadStream } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  getDb, getEtlDurum, getPollDurum,
  adminCalismaBaslat, adminCalismaBitir, adminCalismaGecmisiFiltreli,
  adminZamanlayiciTumu, adminZamanlayiciAyarla, adminZamanlayiciSonCalismaYaz,
  adminKullaniciEkle, adminKullaniciListele, adminKullaniciSil,
} from '../lib/db.js';
import { STORAGE_DIR, PROJECT_ROOT } from '../lib/config.js';
import { getLogger, sonLoglar } from '../lib/logger.js';
import { tbmmGate } from '../lib/poll.js';
import { applyProxyConfig, setKaynakProxyUrlleri, type Kaynak } from '../lib/http.js';
import { TAZELIK_ESIK_GUN, tazelikDurumu, gunFarki } from '../lib/saglik.js';
import { kaynakSayimi } from './ozet.js';
import { yedekAl, eskiYedekleriTemizle } from '../tools/backup.js';
import {
  incremental, ingestGazette, ingestAym, ingestTuik, ingestYsk, ingestPartiProgram,
  ingestOylama, ingestOy, ingestVekilKomisyon, ingestOnergeCevapOrneklem, ingestDuyuru,
  ingestAymParti, ingestYerelYonetim, poll,
  reclassify, reclassifyGazete, reclassifyAym, reconcileKonusma,
  cleanup, trainTopic, backfill,
} from '../tools/etl.js';
import { scrapeImzalar } from '../tools/imzaScraper.js';
import { cekSirasayisi } from '../tools/sirasayisiScraper.js';
import { doldurBasilmisUrl } from '../tools/basilmisUrl.js';
import { googleHaberAra, adminIcinIcerikCek, cokluIcerikCek } from '../engines/newsSearch.js';
import { aiSorguAyristir, aiKonuAnalizEt } from '../engines/newsAi.js';
import { loadModelFile, modelKategorileri } from '../lib/nb.js';
import { TAXONOMY_VERSION, CATEGORY_NAMES } from '../lib/taxonomy.js';
import { partiDagilimiOku, dagilimDiff, partiDagilimiSnapshot, duyuruSonNKayit, duyuruBayrakla, duyuruBayrakKaldir } from '../lib/db.js';
import { BILINEN_SINIRLAR } from '../lib/bilinenSinirlar.js';
import { pollDurumGecmisi, adminSaglikOrnekYaz, adminSaglikGecmisi, aramaOzeti } from '../lib/db.js';

const logger = getLogger('PoliticalInsight.AdminOps');

type ModeFn = () => Promise<unknown>;
export interface ModeTanim { fn: ModeFn; katman: 1 | 2 | 3; etiket: string; not?: string }

const KATMAN1: Record<string, ModeTanim> = {
  ysk: { fn: () => ingestYsk(), katman: 1, etiket: 'YSK seçim sonuçları', not: 'Hiçbir zamanlayıcıya bağlı değil — yalnız elle.' },
  'parti-program': { fn: () => ingestPartiProgram(), katman: 1, etiket: 'Parti programları', not: 'Hiçbir zamanlayıcıya bağlı değil — yalnız elle.' },
  tuik: { fn: () => ingestTuik(), katman: 1, etiket: 'TÜİK göstergeleri' },
  aym: { fn: () => ingestAym(), katman: 1, etiket: 'AYM norm denetimi kararları' },
  gazete: { fn: () => tbmmGate(() => ingestGazette()), katman: 1, etiket: 'Resmî Gazete' },
  incremental: { fn: () => tbmmGate(() => incremental()), katman: 1, etiket: 'TBMM güncel dönem (kanun+önerge+konuşma)' },
  backup: { fn: async () => { const yol = yedekAl(); eskiYedekleriTemizle(); return yol; }, katman: 1, etiket: 'Veritabanı yedeği al' },
  imza: { fn: () => tbmmGate(() => scrapeImzalar()), katman: 1, etiket: 'Ortak imzalar' },
  sirasayisi: { fn: () => tbmmGate(() => cekSirasayisi({ eksikAlan: false })), katman: 1, etiket: 'Teklif↔oylama köprüsü (S.Sayısı)' },
  'basilmis-url': { fn: () => tbmmGate(() => doldurBasilmisUrl()), katman: 1, etiket: 'Oy kanıt PDF linki' },
};

const KATMAN2: Record<string, ModeTanim> = {
  oy: { fn: () => tbmmGate(() => ingestOy()), katman: 2, etiket: 'Vekil bazlı oy (Basılmış PDF)' },
  oylama: { fn: () => ingestOylama(), katman: 2, etiket: 'Açık oylama agregatı (ağsız, cache)' },
  'vekil-komisyon': { fn: () => tbmmGate(() => ingestVekilKomisyon()), katman: 2, etiket: 'Vekil↔komisyon üyeliği' },
  'onerge-cevap': { fn: () => tbmmGate(() => ingestOnergeCevapOrneklem()), katman: 2, etiket: 'Önerge cevap süresi örneklemi' },
  duyuru: { fn: () => Promise.resolve(ingestDuyuru()), katman: 2, etiket: 'RG↔kanun duyuru çıpası (ağsız)' },
  'aym-parti': { fn: () => ingestAymParti(), katman: 2, etiket: 'AYM siyasi parti kararları' },
  'yerel-yonetim': { fn: () => ingestYerelYonetim(), katman: 2, etiket: 'belediye meclis kararı', not: '30+ dakika sürebilir (her belediye sitesi ayrı taranır, sayı gruplar hâlinde artıyor).' },
  poll: { fn: () => tbmmGate(() => poll()), katman: 2, etiket: 'Hafif kanun/önerge yoklaması' },
  reclassify: { fn: () => reclassify(), katman: 2, etiket: 'Kategorileri yeniden sınıflandır (TBMM, ağsız)' },
  'gazete-reclassify': { fn: async () => { getDb(); reclassifyGazete(); }, katman: 2, etiket: 'RG kategorilerini yeniden sınıflandır (ağsız)' },
  'aym-reclassify': { fn: async () => { getDb(); reclassifyAym(); }, katman: 2, etiket: 'AYM kategorilerini yeniden sınıflandır (ağsız)' },
  'reconcile-konusma': { fn: async () => { getDb(); return reconcileKonusma(); }, katman: 2, etiket: 'Grup sözcüsü kurtarma (ağsız)' },
};

const KATMAN3: Record<string, ModeTanim> = {
  cleanup: { fn: () => cleanup(), katman: 3, etiket: 'Yanlış-dönem kayıtlarını SİL', not: 'DELETE çalıştırır — geri alınamaz.' },
  'train-topic': { fn: () => trainTopic(), katman: 3, etiket: 'Konu sınıflandırma modelini yeniden eğit', not: 'Uzun sürer, sınıflandırmayı ileriye dönük değiştirir.' },
  backfill: { fn: () => backfill(), katman: 3, etiket: 'TAM tarihsel tarama (tüm dönemler)', not: 'Saatler sürebilir, TBMM üzerinde ağır yük.' },
};

export const MODE_MAP: Record<string, ModeTanim> = { ...KATMAN1, ...KATMAN2, ...KATMAN3 };

export const CLI_ONLY_ARACLAR = [
  { komut: 'npm run migrate:imza-attrib', aciklama: 'Tek seferlik imza-atıf migrasyonu (dry-run varsayılan)' },
  { komut: 'npm run migrate:onerge-atif', aciklama: 'Tek seferlik önerge-atıf migrasyonu (dry-run varsayılan)' },
  { komut: 'npm run dagilim', aciklama: 'Parti dağılımı snapshot/diff (insan onaylı, migrasyon öncesi/sonrası)' },
  { komut: 'npm run build:deputies -- <mod>', aciklama: 'Milletvekili referans dosyalarını (deputy_tbmm_ids.json, deputy_master_list.json) üretir — modlu/parametreli, tek düğmeye uymuyor' },
  { komut: 'npm run tarih-backfill', aciklama: 'Kanun teklifi tarih boşluğu doldurma — belgeli no-op (ölçüldü: uygun aday kalmadı), gelecek için tutuluyor' },
];

const SMOKE_CHECKS: { kaynak: string; yol: string }[] = [
  { kaynak: 'aym', yol: '/api/ozet/aym-ara?q=iptal' },
  { kaynak: 'gazete', yol: '/api/ozet/gazete-ara?q=kanun' },
  { kaynak: 'tuik', yol: `/api/ozet/gosterge?kategori=${encodeURIComponent('Çalışma & Sosyal Güvenlik')}` },
  { kaynak: 'ysk', yol: '/api/ozet/secim-sonucu' },
  { kaynak: 'parti_program', yol: '/api/ozet/parti-program-ara?q=ekonomi' },
  { kaynak: 'yerel_yonetim', yol: '/api/ozet/yerel-meclis' },
];

interface IcerikTabloConfig {
  tarihKolon?: string;
  aramaKolonlari?: string[];
  filtreKolonlari?: string[];
  siralama: string;
}
const ICERIK_TABLOLARI: Record<string, IcerikTabloConfig> = {
  faaliyet: { tarihKolon: 'tarih', aramaKolonlari: ['baslik'], filtreKolonlari: ['kaynak', 'donem', 'kategori', 'kategori_kaynagi'], siralama: 'tarih DESC' },
  gazete: { tarihKolon: 'tarih', aramaKolonlari: ['baslik'], filtreKolonlari: ['kategori', 'tur'], siralama: 'tarih DESC' },
  aym_karar: { tarihKolon: 'karar_tarihi', aramaKolonlari: ['konu'], filtreKolonlari: ['kategori', 'sonuc_kod', 'basvuru_turu'], siralama: 'karar_tarihi DESC' },
  aym_parti_karar: { tarihKolon: 'karar_tarihi', aramaKolonlari: ['konu'], filtreKolonlari: ['basvuru_turu'], siralama: 'karar_tarihi DESC' },
  oylama: { tarihKolon: 'tarih', aramaKolonlari: ['konu'], siralama: 'tarih DESC' },
  oy: { tarihKolon: 'tarih', filtreKolonlari: ['parti', 'oy', 'il'], siralama: 'rowid DESC' },
  secim_sonucu: { tarihKolon: 'tarih', filtreKolonlari: ['parti', 'donem'], siralama: 'donem DESC, oy DESC' },
  parti_program: { tarihKolon: 'tarih', aramaKolonlari: ['belge_adi'], filtreKolonlari: ['parti', 'belge_turu'], siralama: 'tarih DESC' },
  yerel_karar: { tarihKolon: 'tarih', aramaKolonlari: ['konu'], filtreKolonlari: ['belediye'], siralama: 'tarih DESC' },
  yerel_meclis_uye: { aramaKolonlari: ['ad_soyad'], filtreKolonlari: ['belediye', 'parti'], siralama: 'belediye, ad_soyad' },
  duyuru: { tarihKolon: 'tarih', aramaKolonlari: ['baslik', 'kanun_no'], filtreKolonlari: ['tur'], siralama: 'rowid DESC' },
  imza: { aramaKolonlari: ['ad_soyad'], filtreKolonlari: ['parti', 'parti_kaynak'], siralama: 'rowid DESC' },
  teklif_komisyon: { aramaKolonlari: ['ad'], filtreKolonlari: ['tip'], siralama: 'rowid DESC' },
  vekil_komisyon: { aramaKolonlari: ['ad_soyad', 'komisyon'], filtreKolonlari: ['donem', 'parti', 'rol'], siralama: 'donem DESC' },
  onerge_cevap: { tarihKolon: 'cevap_tarihi', filtreKolonlari: ['etiket'], siralama: 'rowid DESC' },
};

interface CalismaKaydi { durum: 'calisiyor' | 'tamam' | 'hata'; baslangic: string; bitis?: string; sonuc?: string; hata?: string; dbId: number }
const calismalar = new Map<string, CalismaKaydi>();

interface IndirmeBileti { dosya: string; son: number }
const indirmeBiletleri = new Map<string, IndirmeBileti>();
const BILET_OMRU_MS = 30_000;

export function biletTuket(bilet: string, dosya: string): boolean {
  const kayit = indirmeBiletleri.get(bilet);
  if (!kayit) return false;
  indirmeBiletleri.delete(bilet);
  return kayit.dosya === dosya && Date.now() <= kayit.son;
}

function calistir(mod: string, tetikleyen: string): { basladi: true } | { basladi: false; sebep: string } {
  const tanim = MODE_MAP[mod];
  if (!tanim) return { basladi: false, sebep: 'bilinmeyen mod' };
  const mevcut = calismalar.get(mod);
  if (mevcut?.durum === 'calisiyor') return { basladi: false, sebep: 'zaten çalışıyor' };
  if (tanim.katman === 3) {
    try { partiDagilimiSnapshot(`otomatik: ${mod} öncesi`); }
    catch (e) { logger.error(`[${mod}] otomatik dağılım anlık görüntüsü başarısız: ${(e as Error).message}`); }
  }
  const dbId = adminCalismaBaslat(mod, tetikleyen);
  calismalar.set(mod, { durum: 'calisiyor', baslangic: new Date().toISOString(), dbId });
  tanim.fn()
    .then((sonuc) => {
      const s = sonuc == null ? null : String(sonuc).slice(0, 500);
      calismalar.set(mod, { durum: 'tamam', baslangic: calismalar.get(mod)!.baslangic, bitis: new Date().toISOString(), sonuc: s ?? undefined, dbId });
      adminCalismaBitir(dbId, 'tamam', s, null);
      logger.info(`[${mod}] tamamlandı${s ? ` (${s})` : ''}.`);
    })
    .catch((e) => {
      const mesaj = (e as Error)?.message ?? String(e);
      calismalar.set(mod, { durum: 'hata', baslangic: calismalar.get(mod)!.baslangic, bitis: new Date().toISOString(), hata: mesaj, dbId });
      adminCalismaBitir(dbId, 'hata', null, mesaj);
      logger.error(`[${mod}] hata: ${mesaj}`);
    });
  return { basladi: true };
}

function denetimYaz(mod: string, tetikleyen: string, sonuc: string | null): void {
  const dbId = adminCalismaBaslat(mod, tetikleyen);
  adminCalismaBitir(dbId, 'tamam', sonuc, null);
}
function isimAl(req: FastifyRequest): string {
  return (req as unknown as { adminIsim?: string }).adminIsim ?? 'admin';
}

const PROXY_CONFIG_PATH = join(STORAGE_DIR, 'admin_proxy.json');
const KAYNAKLAR: Kaynak[] = ['tbmm', 'gazete', 'aym', 'tuik', 'ysk', 'parti_program', 'yerel_yonetim'];
interface ProxyTanimi { ad: string; ip: string; port: string; username: string; password: string }
interface ProxyHavuzu { proxyler: ProxyTanimi[]; atamalar: Partial<Record<Kaynak, string | null>> }
interface EskiProxyAyari { enabled: boolean; ip: string; port: string; username: string; password: string }

function proxyHavuzuOku(): ProxyHavuzu {
  let ham: unknown;
  try { ham = existsSync(PROXY_CONFIG_PATH) ? JSON.parse(readFileSync(PROXY_CONFIG_PATH, 'utf-8')) : null; }
  catch { ham = null; }
  if (!ham) return { proxyler: [], atamalar: {} };
  if (Array.isArray((ham as ProxyHavuzu).proxyler)) return ham as ProxyHavuzu;
  const eski = ham as EskiProxyAyari;
  if (eski.enabled && eski.ip && eski.port) {
    const havuz: ProxyHavuzu = {
      proxyler: [{ ad: 'varsayılan', ip: eski.ip, port: eski.port, username: eski.username ?? '', password: eski.password ?? '' }],
      atamalar: Object.fromEntries(KAYNAKLAR.map((k) => [k, 'varsayılan'])),
    };
    writeFileSync(PROXY_CONFIG_PATH, JSON.stringify(havuz, null, 2), 'utf-8');
    return havuz;
  }
  return { proxyler: [], atamalar: {} };
}

function proxyUrlOlustur(p: ProxyTanimi): string {
  return p.username && p.password ? `http://${p.username}:${p.password}@${p.ip}:${p.port}` : `http://${p.ip}:${p.port}`;
}

function proxyHavuzuUygula(havuz: ProxyHavuzu): void {
  const proxyMap = new Map(havuz.proxyler.map((p) => [p.ad, p]));
  const kaynakUrlleri: Partial<Record<Kaynak, string>> = {};
  for (const [kaynak, ad] of Object.entries(havuz.atamalar)) {
    const p = ad ? proxyMap.get(ad) : undefined;
    if (p) kaynakUrlleri[kaynak as Kaynak] = proxyUrlOlustur(p);
  }
  setKaynakProxyUrlleri(kaynakUrlleri);
}

proxyHavuzuUygula(proxyHavuzuOku());
if (process.env.PROXY_URL) applyProxyConfig(process.env.PROXY_URL);

let zamanlayiciKuruldu = false;
let saglikOrnekSayaci = 0;
const SAGLIK_ORNEK_HER_N_TIK = 20;
function zamanlayiciTikAt(): void {
  saglikOrnekSayaci += 1;
  if (saglikOrnekSayaci >= SAGLIK_ORNEK_HER_N_TIK) {
    saglikOrnekSayaci = 0;
    const dbYol = join(STORAGE_DIR, 'analytics.db');
    const dbBoyutMb = existsSync(dbYol) ? Math.round((statSync(dbYol).size / (1024 * 1024)) * 10) / 10 : null;
    adminSaglikOrnekYaz(Math.round(process.uptime()), Math.round(process.memoryUsage().rss / (1024 * 1024)), dbBoyutMb);
  }
  const simdi = Date.now();
  for (const row of adminZamanlayiciTumu()) {
    if (!row.aktif) continue;
    const sonMs = row.son_calisma ? Date.parse(row.son_calisma) : 0;
    const gecenSaat = (simdi - sonMs) / 3_600_000;
    if (gecenSaat < row.aralik_saat) continue;
    if (calismalar.get(row.mod)?.durum === 'calisiyor') continue;
    logger.info(`[zamanlayici] tetikleniyor: ${row.mod} (aralık ${row.aralik_saat}sa doldu)`);
    adminZamanlayiciSonCalismaYaz(row.mod);
    calistir(row.mod, 'zamanlayici');
  }
}
export function startAdminScheduler(): void {
  if (zamanlayiciKuruldu) return;
  zamanlayiciKuruldu = true;
  setInterval(zamanlayiciTikAt, 30_000);
}

function dizinBoyutu(dizin: string): { dosya: string; boyutMb: number; tarih: string }[] {
  if (!existsSync(dizin)) return [];
  return readdirSync(dizin)
    .map((ad) => {
      const yol = join(dizin, ad);
      const st = statSync(yol);
      return st.isFile() ? { dosya: ad, boyutMb: Math.round((st.size / (1024 * 1024)) * 10) / 10, tarih: st.mtime.toISOString() } : null;
    })
    .filter((x): x is { dosya: string; boyutMb: number; tarih: string } => x !== null)
    .sort((a, b) => b.tarih.localeCompare(a.tarih));
}

function vekilRosterSayimi(): { kayit: number; son: string | null } {
  const yol = join(PROJECT_ROOT, 'deputy_master_list.json');
  if (!existsSync(yol)) return { kayit: 0, son: null };
  try {
    const liste = JSON.parse(readFileSync(yol, 'utf-8'));
    return { kayit: Array.isArray(liste) ? liste.length : 0, son: statSync(yol).mtime.toISOString() };
  } catch { return { kayit: 0, son: null }; }
}

function veritabaniOzeti(): { tablo: string; satir: number }[] {
  const db = getDb();
  const tablolar = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).all() as { name: string }[];
  return tablolar.map((t) => {
    try {
      const r = db.prepare(`SELECT COUNT(*) c FROM "${t.name}"`).get() as { c: number };
      return { tablo: t.name, satir: r.c };
    } catch { return { tablo: t.name, satir: -1 }; }
  });
}

const ENV_GORUNUR = ['PORT', 'STORAGE_DIR', 'ETL_DISABLED', 'GUNDEM_DISABLED', 'BACKUP_DISABLED', 'POLL_MODE', 'REDIS_DISABLED', 'REDIS_HOST', 'REDIS_PORT', 'ESKI_KATMAN'];
const ENV_SIR = ['ADMIN_TOKEN', 'PROXY_URL', 'GEMINI_API_KEY'];

export function registerAdminOpsRoutes(app: FastifyInstance): void {
  app.get('/api/admin/durum', async () => {
    const etlDurum = getEtlDurum();
    const pollDurum = getPollDurum();
    const kaynaklar = {
      aym: kaynakSayimi('aym_karar', 'karar_tarihi'),
      gazete: kaynakSayimi('gazete', 'tarih'),
      tuik: kaynakSayimi('tuik', 'tarih'),
      ysk: kaynakSayimi('secim_sonucu', 'tarih'),
      parti_program: kaynakSayimi('parti_program', 'guncelleme'),
      yerel_yonetim: kaynakSayimi('yerel_karar', 'tarih'),
      vekil_roster: vekilRosterSayimi(),
    };
    const konusmaKismiDonemler = [...new Set(etlDurum.filter((e) => e.kaynak === 'konusma' && e.durum === 'kismi').map((e) => e.donem))].sort((a, b) => b - a);
    const tbmmDonem28 = etlDurum.filter((e) => e.donem === 28);
    const tbmmTazelik = tbmmDonem28.map((e) => {
      const gun = gunFarki(e.son_calisma);
      const esikGun = TAZELIK_ESIK_GUN[e.kaynak] ?? 3;
      return { kaynak: e.kaynak, son: e.son_calisma, gun, esik_gun: esikGun, durum: tazelikDurumu(gun, esikGun) };
    });
    const digerTazelik = Object.entries(kaynaklar).map(([kaynak, k]) => {
      const gun = gunFarki(k.son);
      const esikGun = TAZELIK_ESIK_GUN[kaynak] ?? 5;
      return { kaynak, son: k.son, gun, esik_gun: esikGun, durum: tazelikDurumu(gun, esikGun) };
    });
    const veriTazelik = [...tbmmTazelik, ...digerTazelik];
    const dbBoyutMb = existsSync(join(STORAGE_DIR, 'analytics.db'))
      ? Math.round((statSync(join(STORAGE_DIR, 'analytics.db')).size / (1024 * 1024)) * 10) / 10 : null;
    const yedekler = dizinBoyutu(join(STORAGE_DIR, 'backups'));
    const eskiArtiklar = [
      ...dizinBoyutu(STORAGE_DIR).filter((f) => f.dosya.includes('.yedek-')),
    ];
    const env: Record<string, string | null> = {};
    for (const k of ENV_GORUNUR) env[k] = process.env[k] ?? null;
    for (const k of ENV_SIR) env[k] = process.env[k] ? 'tanımlı' : 'tanımsız';
    const calismaListesi = Object.fromEntries(calismalar.entries());
    const uyarilar: string[] = [];
    const bayatKaynaklar = veriTazelik.filter((k) => k.durum === 'bayat').map((k) => k.kaynak);
    if (bayatKaynaklar.length) uyarilar.push(`Bayat veri: ${bayatKaynaklar.join(', ')} — eşiği aştı, taze değil.`);
    if (pollDurum?.devre_durumu === 'OPEN') uyarilar.push('Canlı yoklama devre kesicisi AÇIK (WAF engeli algılandı) — TBMM verisi şu an güncellenmiyor.');
    const sonYedek = getDb().prepare(`SELECT MAX(bitis) m FROM admin_calisma WHERE mod='backup' AND durum='tamam'`).get() as { m: string | null };
    const yedekSaatFarki = sonYedek?.m ? (Date.now() - Date.parse(sonYedek.m)) / 3_600_000 : null;
    if (yedekSaatFarki === null || yedekSaatFarki > 36) uyarilar.push(`Son 36 saatte başarılı yedek yok (${yedekSaatFarki === null ? 'hiç alınmamış' : Math.round(yedekSaatFarki) + ' saat önce'}).`);
    return {
      success: true,
      surec: { uptime_saniye: Math.round(process.uptime()), bellek_mb: Math.round(process.memoryUsage().rss / (1024 * 1024)) },
      etl_durum: etlDurum,
      kaynaklar,
      veri_tazelik: veriTazelik,
      konusma_kismi_donemler: konusmaKismiDonemler,
      uyarilar,
      poll_durum: pollDurum,
      db: { boyut_mb: dbBoyutMb, tablolar: veritabaniOzeti() },
      yedekler: { liste: yedekler, toplam_mb: Math.round(yedekler.reduce((s, y) => s + y.boyutMb, 0)) },
      eski_artiklar: eskiArtiklar,
      env,
      calismalar: calismaListesi,
      cli_only_araclar: CLI_ONLY_ARACLAR,
    };
  });

  app.post('/api/admin/calistir/:mod', async (req, reply) => {
    const { mod } = req.params as { mod: string };
    const tanim = MODE_MAP[mod];
    if (!tanim) return reply.code(404).send({ detail: 'bilinmeyen mod', bilinen_modlar: Object.keys(MODE_MAP) });
    if (tanim.katman === 3) {
      const body = (req.body ?? {}) as { onay?: string };
      if (body.onay !== mod) {
        return reply.code(400).send({ detail: `bu tehlikeli bir işlem — onaylamak için gövdede {"onay":"${mod}"} gönderin` });
      }
    }
    const sonuc = calistir(mod, isimAl(req));
    if (!sonuc.basladi) return reply.code(409).send({ detail: sonuc.sebep });
    return reply.code(202).send({ success: true, mod, durum: 'calisiyor' });
  });

  app.get('/api/admin/gecmis', async (req) => {
    const q = (req.query ?? {}) as { limit?: string; offset?: string; mod?: string; durum?: string; tetikleyen?: string; since?: string; until?: string; orderBy?: string; orderDir?: string };
    const { kayitlar, toplam } = adminCalismaGecmisiFiltreli({
      limit: Number(q.limit) || 50, offset: Number(q.offset) || 0,
      mod: q.mod, durum: q.durum, tetikleyen: q.tetikleyen, since: q.since, until: q.until,
      orderBy: q.orderBy as 'baslangic' | 'bitis' | 'mod' | undefined, orderDir: q.orderDir as 'ASC' | 'DESC' | undefined,
    });
    return { success: true, kayitlar, toplam };
  });

  app.get('/api/admin/yedekler', async () => ({ success: true, liste: dizinBoyutu(join(STORAGE_DIR, 'backups')) }));
  app.post('/api/admin/yedekler/:dosya/bilet', async (req, reply) => {
    const { dosya } = req.params as { dosya: string };
    const ad = basename(dosya);
    const yol = join(STORAGE_DIR, 'backups', ad);
    if (!ad.endsWith('.db') || !existsSync(yol) || !statSync(yol).isFile()) return reply.code(404).send({ detail: 'dosya bulunamadı' });
    const bilet = randomUUID();
    indirmeBiletleri.set(bilet, { dosya: ad, son: Date.now() + BILET_OMRU_MS });
    return { success: true, bilet, omur_sn: BILET_OMRU_MS / 1000 };
  });
  app.get('/api/admin/yedekler/:dosya', async (req, reply) => {
    const { dosya } = req.params as { dosya: string };
    const ad = basename(dosya);
    const yol = join(STORAGE_DIR, 'backups', ad);
    if (!ad.endsWith('.db') || !existsSync(yol) || !statSync(yol).isFile()) return reply.code(404).send({ detail: 'dosya bulunamadı' });
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${ad}"`);
    reply.header('Content-Length', statSync(yol).size);
    return reply.send(createReadStream(yol));
  });
  app.delete('/api/admin/yedekler/:dosya', async (req, reply) => {
    const { dosya } = req.params as { dosya: string };
    const ad = basename(dosya);
    const yol = join(STORAGE_DIR, 'backups', ad);
    if (!ad.endsWith('.db') || !existsSync(yol)) return reply.code(404).send({ detail: 'dosya bulunamadı' });
    const body = (req.body ?? {}) as { onay?: string };
    if (body.onay !== ad) return reply.code(400).send({ detail: `onaylamak için gövdede {"onay":"${ad}"} gönderin` });
    unlinkSync(yol);
    denetimYaz(`yedek-sil:${ad}`, isimAl(req), ad);
    return { success: true };
  });

  app.get('/api/admin/zamanlayici', async () => ({
    success: true,
    gorevler: adminZamanlayiciTumu(),
    modlar: Object.entries(MODE_MAP).map(([anahtar, t]) => ({ anahtar, etiket: t.etiket, katman: t.katman })),
  }));
  app.post('/api/admin/zamanlayici', async (req, reply) => {
    const body = (req.body ?? {}) as { mod?: string; aktif?: boolean; aralik_saat?: number };
    if (!body.mod || !MODE_MAP[body.mod]) return reply.code(404).send({ detail: 'bilinmeyen mod' });
    if (MODE_MAP[body.mod].katman === 3) return reply.code(400).send({ detail: 'Katman 3 (tehlikeli) modlar zamanlanamaz — yalnız elle.' });
    const aralik = Math.max(1, Number(body.aralik_saat) || 24);
    adminZamanlayiciAyarla(body.mod, !!body.aktif, aralik);
    denetimYaz(`zamanlayici-degistir:${body.mod}`, isimAl(req), `aktif=${!!body.aktif}, aralik=${aralik}sa`);
    return { success: true };
  });

  app.get('/api/admin/kullanicilar', async () => ({ success: true, liste: adminKullaniciListele() }));
  app.post('/api/admin/kullanicilar', async (req, reply) => {
    const { isim, gecerlilik_gun } = (req.body ?? {}) as { isim?: string; gecerlilik_gun?: number };
    if (!isim || !isim.trim()) return reply.code(400).send({ detail: 'isim gerekli' });
    const token = randomUUID();
    const kayit = adminKullaniciEkle(isim.trim(), token, gecerlilik_gun && gecerlilik_gun > 0 ? Number(gecerlilik_gun) : undefined);
    return { success: true, kullanici: kayit, token };
  });
  app.delete('/api/admin/kullanicilar/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const mevcut = adminKullaniciListele().find((k) => k.id === Number(id));
    if (!mevcut) return reply.code(404).send({ detail: 'kullanıcı bulunamadı' });
    const body = (req.body ?? {}) as { onay?: string };
    if (body.onay !== mevcut.isim) return reply.code(400).send({ detail: `onaylamak için gövdede {"onay":"${mevcut.isim}"} gönderin` });
    adminKullaniciSil(Number(id));
    denetimYaz(`kullanici-sil:${mevcut.isim}`, isimAl(req), mevcut.isim);
    return { success: true };
  });

  app.get('/api/admin/proxy', async () => {
    const h = proxyHavuzuOku();
    return {
      success: true,
      kaynaklar: KAYNAKLAR,
      proxyler: h.proxyler.map((p) => ({ ad: p.ad, ip: p.ip, port: p.port, username: p.username, sifre_tanimli: !!p.password })),
      atamalar: h.atamalar,
    };
  });
  app.post('/api/admin/proxy', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<ProxyHavuzu>;
    const eskiSifreler = new Map(proxyHavuzuOku().proxyler.map((p) => [p.ad, p.password]));
    const proxyler = Array.isArray(body.proxyler)
      ? body.proxyler.map((p) => {
          const ad = String(p.ad ?? '').trim();
          const gelenSifre = String(p.password ?? '');
          return { ad, ip: String(p.ip ?? ''), port: String(p.port ?? ''), username: String(p.username ?? ''), password: gelenSifre || eskiSifreler.get(ad) || '' };
        })
      : [];
    if (proxyler.some((p) => !p.ad || !p.ip || !p.port)) return reply.code(400).send({ detail: 'her proxy için ad/ip/port zorunlu' });
    const adlar = new Set(proxyler.map((p) => p.ad));
    if (adlar.size !== proxyler.length) return reply.code(400).send({ detail: 'proxy adları birbirinden farklı olmalı' });
    const atamalarHam = (body.atamalar ?? {}) as Record<string, unknown>;
    const atamalar: Partial<Record<Kaynak, string | null>> = {};
    for (const kaynak of KAYNAKLAR) {
      const deger = atamalarHam[kaynak];
      if (deger != null && !adlar.has(String(deger))) return reply.code(400).send({ detail: `atamalar.${kaynak} tanımsız bir proxy adı gösteriyor` });
      atamalar[kaynak] = deger == null ? null : String(deger);
    }
    const havuz: ProxyHavuzu = { proxyler, atamalar };
    mkdirSync(STORAGE_DIR, { recursive: true });
    writeFileSync(PROXY_CONFIG_PATH, JSON.stringify(havuz, null, 2), 'utf-8');
    proxyHavuzuUygula(havuz);
    const ozet = KAYNAKLAR.filter((k) => atamalar[k]).map((k) => `${k}→${atamalar[k]}`).join(', ') || 'yok';
    denetimYaz('proxy-guncelle', isimAl(req), `${proxyler.length} proxy, atamalar: ${ozet}`);
    return { success: true };
  });

  app.get('/api/admin/loglar', async (req) => {
    const { limit } = (req.query ?? {}) as { limit?: string };
    return { success: true, satirlar: sonLoglar(Math.min(500, Math.max(1, Number(limit) || 200))) };
  });

  app.get('/api/admin/icerik/:tablo', async (req, reply) => {
    const { tablo } = req.params as { tablo: string };
    const cfg = ICERIK_TABLOLARI[tablo];
    if (!cfg) return reply.code(404).send({ detail: 'bilinmeyen tablo', bilinen_tablolar: Object.keys(ICERIK_TABLOLARI) });
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const offset = Math.max(0, Number(q.offset) || 0);
    const kosullar: string[] = [];
    const params: (string | number)[] = [];
    if (cfg.tarihKolon && q.tarih_baslangic) { kosullar.push(`${cfg.tarihKolon} >= ?`); params.push(q.tarih_baslangic); }
    if (cfg.tarihKolon && q.tarih_bitis) { kosullar.push(`${cfg.tarihKolon} <= ?`); params.push(q.tarih_bitis); }
    const terim = (q.q ?? '').trim();
    if (terim.length >= 2 && cfg.aramaKolonlari?.length) {
      kosullar.push('(' + cfg.aramaKolonlari.map((k) => `${k} LIKE ?`).join(' OR ') + ')');
      for (const _ of cfg.aramaKolonlari) params.push(`%${terim}%`);
    }
    for (const kolon of cfg.filtreKolonlari ?? []) {
      const deger = q[kolon];
      if (deger != null && deger !== '') { kosullar.push(`${kolon} = ?`); params.push(deger); }
    }
    const kosulSql = kosullar.length ? `WHERE ${kosullar.join(' AND ')}` : '';
    const db = getDb();
    const toplam = (db.prepare(`SELECT COUNT(*) c FROM "${tablo}" ${kosulSql}`).get(...params) as { c: number }).c;
    const satirlar = db.prepare(`SELECT rowid AS _satir_id, * FROM "${tablo}" ${kosulSql} ORDER BY ${cfg.siralama} LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { success: true, satirlar, toplam, limit, offset, alanlar: { tarih: cfg.tarihKolon ?? null, arama: cfg.aramaKolonlari ?? [], filtre: cfg.filtreKolonlari ?? [] } };
  });
  app.get('/api/admin/icerik/:tablo/:id', async (req, reply) => {
    const { tablo, id } = req.params as { tablo: string; id: string };
    if (!ICERIK_TABLOLARI[tablo]) return reply.code(404).send({ detail: 'bilinmeyen tablo' });
    if (!/^\d+$/.test(id)) return reply.code(400).send({ detail: 'geçersiz id' });
    const satir = getDb().prepare(`SELECT rowid AS _satir_id, * FROM "${tablo}" WHERE rowid = ?`).get(Number(id));
    if (!satir) return reply.code(404).send({ detail: 'satır bulunamadı' });
    return { success: true, satir };
  });

  app.get('/api/admin/siniflandirma-ozet', async () => {
    const satirlar = getDb().prepare(
      `SELECT kaynak, kategori, kategori_kaynagi, kategori_versiyon, COUNT(*) n
         FROM faaliyet WHERE kategori IS NOT NULL
        GROUP BY kaynak, kategori, kategori_kaynagi, kategori_versiyon
        ORDER BY kaynak, n DESC`,
    ).all();
    const eskiVersiyon = (getDb().prepare(`SELECT COUNT(*) c FROM faaliyet WHERE kategori_versiyon IS NOT NULL AND kategori_versiyon != ?`).get(TAXONOMY_VERSION) as { c: number }).c;
    const modelUretebilir = modelKategorileri();
    const modelUretemez = CATEGORY_NAMES.filter((k) => !modelUretebilir.has(k));
    return { success: true, ozet: satirlar, taxonomy_versiyon: TAXONOMY_VERSION, eski_versiyon_satir: eskiVersiyon, model_uretemez_kategoriler: modelUretemez };
  });
  app.get('/api/admin/siniflandirma-model', async () => {
    const m = loadModelFile();
    if (!m) return { success: true, model: null };
    return {
      success: true,
      model: {
        trainedAt: m.trainedAt, trainDocs: m.trainDocs, taxonomyVersion: m.taxonomyVersion, modelVersion: m.modelVersion,
        heldoutMicro: m.heldoutMicro ?? null, heldoutMacro: m.heldoutMacro ?? null, yanlilikMaxPP: m.yanlilikMaxPP ?? null,
        heldoutFrom: m.heldoutFrom ?? null,
      },
    };
  });

  app.get('/api/admin/dagilim', async () => ({ success: true, satirlar: partiDagilimiOku() }));
  app.get('/api/admin/dagilim/liste', async () => {
    const satirlar = getDb().prepare(
      `SELECT olcum_zamani, not_metni, COUNT(*) satir, SUM(n) toplam
         FROM parti_dagilim_gecmis GROUP BY olcum_zamani ORDER BY olcum_zamani DESC`,
    ).all();
    return { success: true, satirlar };
  });
  app.get('/api/admin/dagilim/diff', async (req, reply) => {
    const { once, sonra } = (req.query ?? {}) as { once?: string; sonra?: string };
    if (!once || !sonra) return reply.code(400).send({ detail: 'once ve sonra (iki damga) gerekli' });
    return { success: true, satirlar: dagilimDiff(once, sonra) };
  });

  app.get('/api/admin/duyuru/son', async (req) => {
    const { limit } = (req.query ?? {}) as { limit?: string };
    return { success: true, kayitlar: duyuruSonNKayit(Math.min(200, Math.max(1, Number(limit) || 50))) };
  });
  app.post('/api/admin/duyuru/:gazeteId/:kanunNo/bayrakla', async (req, reply) => {
    const { gazeteId, kanunNo } = req.params as { gazeteId: string; kanunNo: string };
    const body = (req.body ?? {}) as { bayrak?: string; not?: string };
    if (body.bayrak !== 'yanlis' && body.bayrak !== 'belirsiz') return reply.code(400).send({ detail: 'bayrak "yanlis" ya da "belirsiz" olmalı' });
    duyuruBayrakla(Number(gazeteId), kanunNo, body.bayrak, body.not ?? null, isimAl(req));
    return { success: true };
  });
  app.delete('/api/admin/duyuru/:gazeteId/:kanunNo/bayrakla', async (req) => {
    const { gazeteId, kanunNo } = req.params as { gazeteId: string; kanunNo: string };
    duyuruBayrakKaldir(Number(gazeteId), kanunNo);
    return { success: true };
  });

  app.get('/api/admin/bilinen-sinirlar', async () => ({ success: true, liste: BILINEN_SINIRLAR }));

  app.get('/api/admin/parti-atif-kalite', async () => {
    const db = getDb();
    const imzaKaynak = db.prepare(`SELECT parti_kaynak, COUNT(*) n FROM imza GROUP BY parti_kaynak ORDER BY n DESC`).all();
    const oyParti = db.prepare(`SELECT parti, COUNT(*) n FROM oy GROUP BY parti ORDER BY n DESC`).all();
    return { success: true, imza_kaynak: imzaKaynak, oy_parti_ham: oyParti };
  });

  app.get('/api/admin/saglik-gecmisi', async (req) => {
    const { limit } = (req.query ?? {}) as { limit?: string };
    const n = Math.min(1000, Math.max(1, Number(limit) || 300));
    return { success: true, poll: pollDurumGecmisi(n), saglik: adminSaglikGecmisi(n) };
  });

  app.get('/api/admin/arama-ozeti', async (req) => {
    const { gun } = (req.query ?? {}) as { gun?: string };
    return { success: true, ozet: aramaOzeti(Math.min(365, Math.max(1, Number(gun) || 30))) };
  });

  app.post('/api/admin/haber-ara', async (req, reply) => {
    const body = (req.body ?? {}) as { keyword?: string; after?: string; before?: string; exclude?: string; site?: string; limit?: number };
    if (!body.keyword?.trim()) return reply.code(400).send({ detail: 'keyword gerekli' });
    try {
      const articles = await googleHaberAra({ keyword: body.keyword, after: body.after, before: body.before, exclude: body.exclude, site: body.site, limit: body.limit });
      denetimYaz('haber-ara', isimAl(req), `"${body.keyword}" → ${articles.length} sonuç`);
      return { success: true, articles };
    } catch (e) {
      return reply.code(500).send({ success: false, error: (e as Error).message });
    }
  });
  app.post('/api/admin/haber-icerik', async (req, reply) => {
    const body = (req.body ?? {}) as { url?: string };
    if (!body.url?.trim()) return reply.code(400).send({ detail: 'url gerekli' });
    return adminIcinIcerikCek(body.url);
  });
  app.post('/api/admin/haber-ai-sorgu', async (req, reply) => {
    const body = (req.body ?? {}) as { query?: string };
    if (!body.query?.trim()) return reply.code(400).send({ detail: 'query gerekli' });
    try {
      const p = await aiSorguAyristir(body.query);
      const arananKelime = p.keywords.join(' ');
      if (!arananKelime) return { success: true, articles: [], ai_params: { display_keyword: 'Sonuç Bulunamadı', display_time: '' } };
      const articles = await googleHaberAra({ keyword: arananKelime, after: p.after, before: p.before, exclude: p.exclude, site: p.site });
      denetimYaz('haber-ai-sorgu', isimAl(req), `"${body.query}" → ${p.keywords.join(',')} → ${articles.length} sonuç`);
      let displayKeyword = p.keywords.join(' + ').toUpperCase();
      if (p.exclude) displayKeyword += ` [HARİÇ: ${p.exclude.toUpperCase()}]`;
      if (p.site) displayKeyword += ` [SİTE: ${p.site.toUpperCase()}]`;
      return { success: true, articles, ai_params: { display_keyword: displayKeyword, display_time: p.after || p.before ? `${p.after} / ${p.before}` : 'Tüm Zamanlar' } };
    } catch (e) {
      return reply.code(500).send({ success: false, error: (e as Error).message });
    }
  });
  app.post('/api/admin/haber-ai-analiz', async (req, reply) => {
    const body = (req.body ?? {}) as { keyword?: string; urls?: string[] };
    if (!body.keyword?.trim() || !body.urls?.length) return reply.code(400).send({ detail: 'keyword ve urls gerekli' });
    try {
      const icerikler = await cokluIcerikCek(body.urls.slice(0, 20));
      const makaleler = icerikler
        .filter((i): i is { success: true; data: { title?: string; text?: string } } => i.success)
        .map((i) => ({ title: i.data.title ?? '', text: i.data.text ?? '' }));
      const sonuc = await aiKonuAnalizEt(body.keyword, makaleler);
      denetimYaz('haber-ai-analiz', isimAl(req), `"${body.keyword}" → ${makaleler.length} makale analiz edildi`);
      return { success: true, data: sonuc, article_count: makaleler.length };
    } catch (e) {
      return reply.code(500).send({ success: false, error: (e as Error).message });
    }
  });

  app.get('/api/admin/smoke-test', async () => {
    const sonuclar = await Promise.all(SMOKE_CHECKS.map(async (c) => {
      try {
        const r = await app.inject({ method: 'GET', url: c.yol });
        if (r.statusCode !== 200) return { ...c, durum: 'kirmizi', detay: `HTTP ${r.statusCode}` };
        const j = r.json() as { success?: boolean; error?: string };
        if (j.success === false) return { ...c, durum: 'kirmizi', detay: j.error ?? 'success:false' };
        return { ...c, durum: 'yesil', detay: null };
      } catch (e) {
        return { ...c, durum: 'kirmizi', detay: (e as Error)?.message ?? String(e) };
      }
    }));
    const kirmizi = sonuclar.filter((s) => s.durum === 'kirmizi').length;
    return { success: true, durum: kirmizi === 0 ? 'yesil' : 'kirmizi', kontroller: sonuclar };
  });
}
