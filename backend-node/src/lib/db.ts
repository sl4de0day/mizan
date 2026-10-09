import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { STORAGE_DIR } from './config.js';
import { getLogger } from './logger.js';
import { cleanStr, resolveByNameIl, resolveParty, ilAdAyir, araliktaParti } from './partyResolve.js';
import { trLower } from './taxonomy.js';
import { hashToken } from './authUtil.js';

const logger = getLogger('PoliticalInsight.DB');

export const DB_PATH = join(STORAGE_DIR, 'analytics.db');

let dbHandle: DatabaseSync | null = null;

const FAALIYET_INDEKS = `
  CREATE INDEX IF NOT EXISTS ix_faaliyet_ay      ON faaliyet(ay);
  CREATE INDEX IF NOT EXISTS ix_faaliyet_kat     ON faaliyet(kategori);
  CREATE INDEX IF NOT EXISTS ix_faaliyet_kaynak  ON faaliyet(kaynak);
  CREATE INDEX IF NOT EXISTS ix_faaliyet_donem   ON faaliyet(donem);
  CREATE INDEX IF NOT EXISTS ix_faaliyet_muhatap ON faaliyet(muhatap);
`;

function migrateImzaKaynak(db: DatabaseSync): void {
  const kolonlar = db.prepare("SELECT name FROM pragma_table_info('imza')").all() as { name: string }[];
  if (kolonlar.some((k) => k.name === 'parti_kaynak')) return;
  if (!kolonlar.length) return;
  db.exec("ALTER TABLE imza ADD COLUMN parti_kaynak TEXT NOT NULL DEFAULT 'bilinmiyor';");
}

function migrateAdminKullaniciTokenHash(db: DatabaseSync): void {
  const kolonlar = db.prepare("SELECT name FROM pragma_table_info('admin_kullanici')").all() as { name: string }[];
  if (!kolonlar.length) return;
  const satirlar = db.prepare('SELECT id, token FROM admin_kullanici').all() as { id: number; token: string }[];
  const duzMetin = satirlar.filter((s) => !/^[a-f0-9]{64}$/.test(s.token));
  if (!duzMetin.length) return;
  logger.warn(`[migration] admin_kullanici: ${duzMetin.length} düz-metin token hash'leniyor...`);
  const guncelle = db.prepare('UPDATE admin_kullanici SET token=? WHERE id=?');
  for (const s of duzMetin) guncelle.run(hashToken(s.token), s.id);
}

function migrateFaaliyetKey(db: DatabaseSync): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='faaliyet'").get() as { sql?: string } | undefined;
  const sql = row?.sql ?? '';
  if (!sql || /UNIQUE\s*\(\s*kaynak\s*,\s*kaynak_id\s*,\s*donem\s*\)/i.test(sql)) return;
  if (!/UNIQUE\s*\(\s*kaynak\s*,\s*kaynak_id\s*\)/i.test(sql)) return;

  const once = (db.prepare('SELECT COUNT(*) c FROM faaliyet').get() as { c: number }).c;
  const bosDonem = (db.prepare('SELECT COUNT(*) c FROM faaliyet WHERE donem IS NULL').get() as { c: number }).c;
  if (bosDonem > 0) {
    logger.error(`[migration] ${bosDonem} kayıtta donem NULL — dönemli anahtar kurulamaz (NULL≠NULL mükerrer üretir). Geçiş İPTAL.`);
    return;
  }
  logger.warn(`[migration] faaliyet anahtarı düzeltiliyor: UNIQUE(kaynak,kaynak_id) → (+donem). ${once} kayıt taşınıyor...`);
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(`
      CREATE TABLE faaliyet_yeni (
        id INTEGER PRIMARY KEY, kaynak TEXT NOT NULL, kaynak_id TEXT NOT NULL, tarih TEXT, ay TEXT,
        yil INTEGER, donem INTEGER NOT NULL, baslik TEXT, ozet TEXT, durum TEXT, kategori TEXT,
        detay_url TEXT, guncelleme TEXT, muhatap TEXT, kategori_versiyon INTEGER, kategori_kaynagi TEXT,
        UNIQUE(kaynak, kaynak_id, donem)
      );
      INSERT INTO faaliyet_yeni (id,kaynak,kaynak_id,tarih,ay,yil,donem,baslik,ozet,durum,kategori,
                                 detay_url,guncelleme,muhatap,kategori_versiyon,kategori_kaynagi)
        SELECT id,kaynak,kaynak_id,tarih,ay,yil,donem,baslik,ozet,durum,kategori,
               detay_url,guncelleme,muhatap,kategori_versiyon,kategori_kaynagi FROM faaliyet;
      DROP TABLE faaliyet;
      ALTER TABLE faaliyet_yeni RENAME TO faaliyet;
    `);
    db.exec('COMMIT;');
  } catch (e) {
    db.exec('ROLLBACK;');
    db.exec('PRAGMA foreign_keys = ON;');
    logger.error(`[migration] BAŞARISIZ, geri alındı (veri değişmedi): ${(e as Error).message}`);
    return;
  }
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(FAALIYET_INDEKS);
  const sonra = (db.prepare('SELECT COUNT(*) c FROM faaliyet').get() as { c: number }).c;
  const yetim = (db.prepare('SELECT COUNT(*) c FROM faaliyet_parti WHERE faaliyet_id NOT IN (SELECT id FROM faaliyet)').get() as { c: number }).c;
  logger.warn(`[migration] tamam: ${once} → ${sonra} kayıt · yetim parti bağı: ${yetim}${yetim ? ' ⚠️' : ' ✅'}`);
}

function migrateBaslikNorm(db: DatabaseSync): void {
  const kolonlar = db.prepare("SELECT name FROM pragma_table_info('faaliyet')").all() as { name: string }[];
  if (!kolonlar.some((k) => k.name === 'baslik_norm')) return;
  const eksik = (db.prepare(
    'SELECT COUNT(*) c FROM faaliyet WHERE baslik IS NOT NULL AND baslik_norm IS NULL',
  ).get() as { c: number }).c;
  if (!eksik) return;
  logger.warn(`[migration] baslik_norm dolduruluyor: ${eksik} kayıt...`);
  const rows = db.prepare(
    'SELECT id, baslik FROM faaliyet WHERE baslik IS NOT NULL AND baslik_norm IS NULL',
  ).all() as { id: number; baslik: string }[];
  const upd = db.prepare('UPDATE faaliyet SET baslik_norm = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const r of rows) upd.run(trLower(r.baslik), r.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    logger.error(`[migration] baslik_norm BAŞARISIZ, geri alındı: ${(e as Error).message}`);
    return;
  }
  logger.warn(`[migration] baslik_norm tamam: ${rows.length} kayıt.`);
}

export function getDb(): DatabaseSync {
  if (dbHandle) return dbHandle;
  if (!existsSync(STORAGE_DIR)) mkdirSync(STORAGE_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.function('tr_lower', (s: unknown): string | null => (typeof s === 'string' ? trLower(s) : null));
  db.exec(`
    CREATE TABLE IF NOT EXISTS faaliyet (
      id          INTEGER PRIMARY KEY,
      kaynak      TEXT NOT NULL,          -- 'kanun' | 'onerge' | 'konusma'
      kaynak_id   TEXT NOT NULL,          -- TBMM uuid / esas_no — ⚠️ DÖNEMLER ARASI BENZERSİZ DEĞİL
      tarih       TEXT,                   -- 'YYYY-MM-DD'
      ay          TEXT,                   -- 'YYYY-MM' (bucket)
      yil         INTEGER,
      donem       INTEGER NOT NULL,       -- NOT NULL ŞART: UNIQUE'te NULL≠NULL → mükerrer üretirdi
      baslik      TEXT,
      ozet        TEXT,
      durum       TEXT,
      kategori    TEXT,
      detay_url   TEXT,
      guncelleme  TEXT,
      muhatap     TEXT,                   -- önerge muhatap bakanlık UUID (konu sinyali)
      kategori_versiyon INTEGER,          -- taksonomi versiyonu
      -- 🔴 donem ANAHTARIN PARÇASI OLMAK ZORUNDA. Eskiden UNIQUE(kaynak, kaynak_id) idi ve bu
      -- VERİ KAYBINA yol açtı (2026-07-16, ölçüldü): önerge kaynak_id'si bir ESAS NO'dur ("7/46155")
      -- ve numaralandırma HER DÖNEM SIFIRDAN başlar → d27'nin "7/46155"i d28'inkiyle çakıştı,
      -- ON CONFLICT … donem=excluded.donem tetiklendi ve 46.239 d28 önergesinin 46.186'sı sessizce
      -- d27'ye damgalandı (d28 onerge: 46.239 → 53). Kanun etkilenmedi (id'si global UUID),
      -- konuşma da etkilenmedi (id'si "28-1-10:…" dönem önekli) — yalnız önerge çarpışıyor.
      -- Ders: "TBMM id'si benzersizdir" varsayımı KAYNAK BAZINDA yanlış; anahtar dönemi içermeli.
      UNIQUE(kaynak, kaynak_id, donem)
    );
    CREATE TABLE IF NOT EXISTS faaliyet_parti (
      faaliyet_id INTEGER NOT NULL REFERENCES faaliyet(id) ON DELETE CASCADE,
      parti       TEXT NOT NULL,
      PRIMARY KEY (faaliyet_id, parti)
    );
    CREATE TABLE IF NOT EXISTS imza (
      faaliyet_id INTEGER NOT NULL REFERENCES faaliyet(id) ON DELETE CASCADE,
      ad_soyad    TEXT NOT NULL,          -- imzacı vekil
      parti       TEXT NOT NULL,          -- kanonik etiket (faaliyet_parti ile aynı uzay)
      ilk_imza    INTEGER NOT NULL DEFAULT 0, -- 1 = teklif sahibi (ilk imza)
      -- 🔑 KÖKEN — 'tbmm' | 'roster-fallback'. SÜS DEĞİL, ATIF KURALININ ÖN ŞARTI:
      -- 'tbmm'          = parti TBMM'nin BELGEYE İLİŞTİRDİĞİ sütundan → İMZA ANI gerçeği (otantik)
      -- 'roster-fallback' = TBMM boş bıraktı, isimden roster'la çözüldü → ÇEKİM ANI fotoğrafı
      -- İkisi DB'de ayırt edilemezse "imza roster'ı yener" kuralı roster'ı KENDİNE karşı üstün
      -- tutmaya dönüşür (döngüsel). Ölçüldü 2026-07-17: eski scraper tanımadığı partiyi sessizce
      -- d28 roster'ına düşürüyordu → MEMLEKET Partili vekilin 2021 belgesi AKP'ye yazılmıştı.
      parti_kaynak TEXT NOT NULL DEFAULT 'bilinmiyor',
      PRIMARY KEY (faaliyet_id, ad_soyad)
    );
    CREATE TABLE IF NOT EXISTS etl_durum (
      kaynak       TEXT NOT NULL,
      donem        INTEGER NOT NULL,
      son_calisma  TEXT,
      kayit_sayisi INTEGER,
      durum        TEXT,                  -- 'ok' | 'blocked' | 'error' | 'roster-yetersiz' | 'kismi'
      PRIMARY KEY (kaynak, donem)
    );
    -- L4 — YANLILIK-FARKINDA REGRESYON GUARD'ININ HAFIZASI (append-only snapshot).
    -- Mevcut retrain guard'ı yalnız konu modelinin micro-F1'ine bakıyor → ATIF SAPMASINI GÖREMEZ:
    -- 1.220 belgenin partisi değişirken micro kılını kıpırdatmaz. Bu tablo o kör noktayı kapatır.
    -- KAPI KURALI: |Δpay| büyük ama Δn küçükse → YAPISAL YENİDEN ETİKETLEME → REDDET/alarm.
    -- Salt Δpay eşiği YANLIŞ olurdu: meşru yeni veri de payları oynatır. Ama "0 yeni satır +
    -- 1.220 yeniden etiket" #2'nin (YURUTME sızıntısı) TAM İMZASIDIR — bu guard onu geçirmezdi.
    CREATE TABLE IF NOT EXISTS parti_dagilim_gecmis (
      olcum_zamani TEXT NOT NULL,          -- ISO; aynı koşunun tüm satırları aynı damgayı taşır
      kaynak       TEXT NOT NULL,          -- 'kanun' | 'onerge' | 'konusma'
      donem        INTEGER NOT NULL,
      parti        TEXT NOT NULL,          -- sentinel'ler DAHİL (YÜRÜTME/Bilinmiyor da izlenir)
      n            INTEGER NOT NULL,
      not_metni    TEXT,                   -- snapshot'ın sebebi (ör. 'baseline', 'migration-öncesi')
      PRIMARY KEY (olcum_zamani, kaynak, donem, parti)
    );
    CREATE INDEX IF NOT EXISTS ix_faaliyet_ay      ON faaliyet(ay);
    CREATE INDEX IF NOT EXISTS ix_faaliyet_kat     ON faaliyet(kategori);
    CREATE INDEX IF NOT EXISTS ix_faaliyet_kaynak  ON faaliyet(kaynak);
    CREATE INDEX IF NOT EXISTS ix_faaliyet_donem   ON faaliyet(donem);
    CREATE INDEX IF NOT EXISTS ix_fp_parti         ON faaliyet_parti(parti);
    CREATE INDEX IF NOT EXISTS ix_imza_faaliyet    ON imza(faaliyet_id);
    CREATE INDEX IF NOT EXISTS ix_imza_parti        ON imza(parti);
    -- Gündem akışı + durum tarihçesi (append-only). Tek tablo hem "son 24 saatte ne oldu" (tip='yeni')
    -- hem durum değişimini (tip='durum') besler. UNIQUE + INSERT OR IGNORE → gecelik tam-çekim aynı
    -- olayı tekrar yazmaz (idempotent; guncelleme-kirlenmesi yok).
    CREATE TABLE IF NOT EXISTS olay (
      id          INTEGER PRIMARY KEY,
      faaliyet_id INTEGER NOT NULL REFERENCES faaliyet(id) ON DELETE CASCADE,
      tip         TEXT NOT NULL,          -- 'yeni' | 'durum'
      olay_tarih  TEXT NOT NULL,          -- ISO — ne zaman gördük/durum değişti (SIRALAMA + pencere)
      eski_durum  TEXT,
      yeni_durum  TEXT,
      UNIQUE(faaliyet_id, tip, yeni_durum)
    );
    CREATE INDEX IF NOT EXISTS ix_olay_tarih    ON olay(olay_tarih DESC);
    CREATE INDEX IF NOT EXISTS ix_olay_faaliyet ON olay(faaliyet_id);
    -- Canlı poller gözlemlenebilirlik (tek satır kayıt: son yoklama, ardışık-boş sayısı, devre durumu).
    CREATE TABLE IF NOT EXISTS poll_durum (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      son_poll      TEXT,
      ardisik_bos   INTEGER DEFAULT 0,
      devre_durumu  TEXT,                 -- 'CLOSED' | 'OPEN' | 'HALF_OPEN'
      son_ozet      TEXT
    );
    -- Admin paneli — hafif tarihsel veri (2026-07-30, Faz 2 ÖNCELİK 5). poll_durum YAPISAL OLARAK
    -- TEK satır (id=1) — devre kesicinin ne zaman/kaç kez açıldığını, ne kadar sürdüğünü tutamaz.
    -- OLAY-TETİKLEMELİ (savePollDurum'un ZATEN çağrıldığı noktalara bir INSERT daha) — yeni bir
    -- zamanlayıcı/timer İCAT EDİLMEDİ, mevcut olaya biniliyor.
    CREATE TABLE IF NOT EXISTS poll_durum_gecmis (
      id            INTEGER PRIMARY KEY,
      zaman         TEXT NOT NULL,
      devre_durumu  TEXT,
      ardisik_bos   INTEGER
    );
    CREATE INDEX IF NOT EXISTS ix_poll_durum_gecmis_zaman ON poll_durum_gecmis(zaman DESC);
    -- Bellek/uptime/DB-boyutu için doğal bir "olay" yok (poll_durum'un aksine) — bu yüzden KABA
    -- PERİYODİK örnekleme meşru, ama YENİ bir setInterval AÇILMADI: adminOps.ts'in zaten var olan
    -- 30sn'lik zamanlayıcı tick'ine (zamanlayiciTikAt) her N tikte bir örnekleyerek biniyor.
    CREATE TABLE IF NOT EXISTS admin_saglik_gecmis (
      id             INTEGER PRIMARY KEY,
      zaman          TEXT NOT NULL,
      uptime_saniye  INTEGER,
      bellek_mb      INTEGER,
      db_boyut_mb    REAL
    );
    CREATE INDEX IF NOT EXISTS ix_admin_saglik_gecmis_zaman ON admin_saglik_gecmis(zaman DESC);
    -- Arama analitiği (2026-07-30, Faz 2 ÖNCELİK 5) — 8 arama ucu (kanun-ara/onerge-ara/vs.)
    -- bugüne dek hiçbir terim/sıfır-sonuç kaydetmiyordu. BİLEREK IP/user-agent/oturum kimliği YOK
    -- (kim değil, ne arandı) — yalnız TOPLU kullanım için (en çok aranan terimler, sıfır-sonuç
    -- oranı). ⚠️ Plan dosyasında AÇIK KARAR olarak işaretlendi: ham terimin loglanması bir
    -- şeffaflık sitesi bağlamında hassasiyet sorusu olabilir — varsayılan (plan onaylı) "logla"
    -- yönünde, ama bu satır kullanıcıya AÇIKÇA bildirilmeli, sessizce karar verilmiş SAYILMAMALI.
    CREATE TABLE IF NOT EXISTS arama_log (
      id           INTEGER PRIMARY KEY,
      zaman        TEXT NOT NULL,
      uc           TEXT NOT NULL,
      terim        TEXT NOT NULL,
      donem        TEXT,
      sonuc_sayisi INTEGER,
      sifir_sonuc  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS ix_arama_log_zaman ON arama_log(zaman DESC);
    -- Admin paneli — ELLE tetiklenen (ya da yeniden dirilen zamanlayıcının çalıştırdığı) işlerin
    -- KALICI geçmişi (2026-07-29). Eski Python-portu 'history_logs/*.json' dosya mekanizması bu
    -- Node portunda hiç kullanılmamıştı (bkz. routes/admin.ts başlık notu) — o yerine bu tabloyu
    -- diriltmek yerine, GERÇEKTEN çalışan yeni tetikleme uçlarının (routes/adminOps.ts) geçmişini
    -- tutan taze, basit bir tablo. In-memory registry (adminOps.ts) ANLIK durumu tutar, bu tablo
    -- process yeniden başlasa bile KALICI geçmişi tutar — ikisi ayrı amaçlara hizmet eder.
    CREATE TABLE IF NOT EXISTS admin_calisma (
      id          INTEGER PRIMARY KEY,
      mod         TEXT NOT NULL,           -- MODE_MAP anahtarı (ör. 'ysk', 'parti-program')
      baslangic   TEXT NOT NULL,
      bitis       TEXT,                    -- NULL → hâlâ sürüyor (yalnız süreç bu haldeyken anlamlı)
      durum       TEXT NOT NULL,           -- 'calisiyor' | 'tamam' | 'hata'
      sonuc       TEXT,                    -- ingestX'in dönüş değeri (kayıt sayısı) — varsa
      hata        TEXT,                    -- hata mesajı — varsa
      tetikleyen  TEXT NOT NULL DEFAULT 'zamanlayici'  -- 'admin' | 'zamanlayici'
    );
    CREATE INDEX IF NOT EXISTS ix_admin_calisma_baslangic ON admin_calisma(baslangic DESC);
    -- Admin paneli — eski Python-portu 'scheduler_config.json' dosya mekanizması hiç kullanılmamıştı
    -- (bkz. yukarısı); onu diriltmek yerine, GERÇEK MODE_MAP anahtarlarını doğrudan zamanlayan taze
    -- bir tablo. 'aralik_saat' NULL/0 → yalnız elle tetiklenir (zamanlayıcı bu satırı atlar).
    CREATE TABLE IF NOT EXISTS admin_zamanlayici (
      mod          TEXT PRIMARY KEY,        -- MODE_MAP anahtarı
      aktif        INTEGER NOT NULL DEFAULT 0,
      aralik_saat  INTEGER NOT NULL DEFAULT 24,
      son_calisma  TEXT
    );
    -- Admin paneli — isme bağlı, tek tek iptal edilebilir token'lar (2026-07-30). ADMIN_TOKEN env
    -- değişkeni "ana anahtar" olarak KALIR (kendi başına her zaman geçerli, buradan silinemez —
    -- kilitlenmeyi önleyen kaçış kapısı). Bu tablo yalnız "birden fazla kişi kendi token'ıyla girsin,
    -- biri ayrılınca yalnız onunkini iptal edeyim" ihtiyacı için — parola/oturum/rol YOK (gereksiz
    -- karmaşıklık, güven modeli zaten "token'ı bilen admin'dir", tek fark artık isme bağlı).
    CREATE TABLE IF NOT EXISTS admin_kullanici (
      id            INTEGER PRIMARY KEY,
      isim          TEXT NOT NULL,
      token         TEXT NOT NULL UNIQUE,  -- sha256 hex hash'i, düz metin DEĞİL (bkz. authUtil.ts)
      olusturma     TEXT NOT NULL,
      son_kullanim  TEXT,                  -- son BAŞARILI doğrulama, NULL = hiç kullanılmadı
      sona_erme     TEXT                   -- ISO tarih, NULL = süresiz
    );
    -- Resmî Gazete: "devlet fiilen ne yürürlüğe koydu" (parti YOK — devlet çıktısı). Konuya göre etiketli.
    -- url = GÜNLÜK fihrist (paylaşılan); dedup öğe başına UNIQUE(tarih,baslik) ile.
    CREATE TABLE IF NOT EXISTS gazete (
      id          INTEGER PRIMARY KEY,
      url         TEXT,                   -- günlük RG fihrist linki (öğe başına tekil DEĞİL)
      tarih       TEXT,                   -- 'YYYY-MM-DD'
      ay          TEXT,                   -- 'YYYY-MM'
      tur         TEXT,                   -- mevzuat türü (KANUN | YÖNETMELİK | CB KARARI | AYM...)
      baslik      TEXT,
      kategori    TEXT,                   -- konu sınıflandırması
      sayi        TEXT,                   -- Resmî Gazete sayısı
      guncelleme  TEXT,
      kategori_versiyon INTEGER,
      UNIQUE(tarih, baslik)
    );
    CREATE INDEX IF NOT EXISTS ix_gazete_tarih    ON gazete(tarih DESC);
    CREATE INDEX IF NOT EXISTS ix_gazete_kategori ON gazete(kategori);
    -- AYM norm denetimi: "bu konuda çıkan mevzuat anayasal denetimden geçti mi" (parti YOK — yargı çıktısı).
    -- kararKonusu → konuya sınıflanır; sonuc = İptal/Ret. Dedup UNIQUE(esas_no,karar_no).
    CREATE TABLE IF NOT EXISTS aym_karar (
      id            INTEGER PRIMARY KEY,
      aym_id        TEXT,                   -- API uuid (detay/PDF linki)
      esas_no       TEXT NOT NULL,          -- "2023/126"
      karar_no      TEXT NOT NULL,          -- "2024/67"
      karar_tarihi  TEXT,                   -- 'YYYY-MM-DD' (AYM karar tarihi)
      ay            TEXT,                   -- 'YYYY-MM'
      rg_tarihi     TEXT,                   -- Resmî Gazete tarihi (yayımlanmadıysa boş)
      rg_sayisi     TEXT,
      basvuru_turu  TEXT,                   -- 'itiraz' (mahkeme) | 'iptal' (siyasi aktör)
      sonuc         TEXT,                   -- ham etiket ("Esas - İptal" / "Esas - Ret" ...)
      sonuc_kod     TEXT,                   -- 'iptal' | 'ret' | 'ilk_ret' | 'kismen' | 'diger'
      konu          TEXT,                   -- kararKonusu düz metne indirgenmiş
      kategori      TEXT,                   -- konu sınıflandırması
      kategori_versiyon INTEGER,
      url           TEXT,                   -- AYM karar detay linki
      guncelleme    TEXT,
      UNIQUE(esas_no, karar_no)
    );
    CREATE INDEX IF NOT EXISTS ix_aym_tarih    ON aym_karar(karar_tarihi DESC);
    CREATE INDEX IF NOT EXISTS ix_aym_kategori ON aym_karar(kategori);
    -- TÜİK göstergeleri: "bağlam/gerçeklik katmanı" (parti YOK — resmî istatistik). Konu grafiğinin altında
    -- ayrı şerit. Aylık zaman serisi; her çekişte upsert → TÜİK'in kayan penceresi bizde BİRİKİR (eski aylar kalır).
    CREATE TABLE IF NOT EXISTS tuik (
      id          INTEGER PRIMARY KEY,
      gosterge    TEXT NOT NULL,          -- 'tufe' | 'issizlik' | 'gsyh'
      tarih       TEXT NOT NULL,          -- 'YYYY-MM'
      deger       REAL,
      guncelleme  TEXT,
      UNIQUE(gosterge, tarih)
    );
    CREATE INDEX IF NOT EXISTS ix_tuik ON tuik(gosterge, tarih);
    -- AÇIK OYLAMA sonuçları (Genel Kurul). Kaynak: tutanak metni (agregat) — vekil/parti kırılımı
    -- ekteki Basilmis PDF'te. KAPSAM: kanunların ÇOĞU işaretle oylanır ve KAYDA GEÇMEZ (İçtüzük 143);
    -- burada yalnız açık/elektronik oylananlar var → UI'da bu MUTLAKA söylenir.
    -- Yalnız ÖZ-DOĞRULAMASI geçen bloklar yazılır (kabul+ret+çekimser ≈ kullanılan).
    CREATE TABLE IF NOT EXISTS oylama (
      id           INTEGER PRIMARY KEY,
      birlesim_id  TEXT NOT NULL,        -- tutanak uuid (cache dosya adı)
      -- ⚠️ NOT NULL DEFAULT '' ŞART: SQLite'ta UNIQUE içinde NULL ≠ NULL → S.Sayısı'sız oylamalar
      -- (bütçe/kesin hesap) hiç çakışmaz ve her ETL koşusunda YENİDEN eklenirdi (ölçüldü: 129 → 152).
      sira_sayisi  TEXT NOT NULL DEFAULT '',  -- S. Sayısı (≠ Esas No); '' = tutanakta S.S. verilmemiş
      tarih        TEXT,                 -- 'YYYY-MM-DD' (birleşim tarihi)
      konu         TEXT,                 -- giriş satırı (ham)
      kullanilan   INTEGER,
      kabul        INTEGER,
      ret          INTEGER,
      cekimser     INTEGER,
      mukerrer     INTEGER,
      sonuc        TEXT,
      guncelleme   TEXT,
      UNIQUE(birlesim_id, sira_sayisi, kullanilan)
    );
    CREATE INDEX IF NOT EXISTS ix_oylama_tarih ON oylama(tarih DESC);
    -- VEKİL BAZLI OY — "kim nasıl oy verdi". Kaynak: Basilmis/<uuid>.pdf oy cetveli (lib/votingPdf.ts).
    -- YALNIZ doğrulama kapısını geçen oylamalar yazılır: cetvel sayımı, PDF'in kendi özet kutusunu
    -- (Kabul/Ret/Çekimser) BİREBİR üretmeli. Tutmuyorsa o oylama HİÇ yazılmaz — yanlış partili oy
    -- atfetmek veri eksikliğinden kat kat kötüdür.
    CREATE TABLE IF NOT EXISTS oy (
      birlesim_id TEXT NOT NULL,          -- tutanak uuid
      sira_sayisi TEXT NOT NULL,          -- S. Sayısı (cetvel başlığından: "S. S. 162" → "162")
      il          TEXT NOT NULL,
      soyad       TEXT NOT NULL,
      ad          TEXT NOT NULL,
      parti       TEXT NOT NULL,          -- cetvelin HAM parti adı ("AK PARTİ") — kanonik değil
      oy          TEXT NOT NULL,          -- Kabul | Ret | Çekimser | Katılmadı | Mük.
      tarih       TEXT,
      guncelleme  TEXT,
      -- il+soyad+ad: cetvelde vekil kimliği bu üçlü (TBMM id'si cetvelde YOK). Aynı isim iki ilde
      -- olabilir → il anahtarın parçası. Dönem gerekmez: birlesim_id zaten döneme özgü uuid.
      PRIMARY KEY (birlesim_id, sira_sayisi, il, soyad, ad)
    );
    CREATE INDEX IF NOT EXISTS ix_oy_parti  ON oy(parti);
    CREATE INDEX IF NOT EXISTS ix_oy_sira   ON oy(birlesim_id, sira_sayisi);
    CREATE INDEX IF NOT EXISTS ix_oy_tarih  ON oy(tarih DESC);

    -- ═══ TEKLİF ↔ OYLAMA KÖPRÜSÜ ═══
    -- Sitenin en çok istenen ama "veri bloke" diye kapatılmış sorusu: "BU KANUNU KİM OYLADI?"
    -- Blokenin gerekçesi şuydu: kanun kaydında S.Sayısı YOK (yalnız uuid), oylamada YALNIZ S.Sayısı
    -- var → ortak anahtar yok. 🔴 BU TEŞHİS YANLIŞTI (2026-07-18). Anahtar TBMM'nin teklif detay
    -- sayfasında DURUYOR, yalnız beklenmedik bir etikette: "Esas Komisyon Raporu(Sırasayısı)".
    -- Doğrulandı: teklif 28702068-… → Sırasayısı 280 · Kanun No 7589; 'oylama'da S.Sayısı='280'
    -- kaydı VAR (2026-07-16, kullanılan 285 · kabul 217 · ret 68).
    -- Daha da öğreticisi: 'imzaScraper' ZATEN her teklif sayfasını çekiyor ve 'ana_bilgiler'i
    -- ayrıştırıp ATIYOR — bilgi vardı, yanlış katmandaydı. (Aynı kalıp YENİ YOL bug'ında yaşandı.)
    -- Ayrı tablo, 'faaliyet'e kolon değil: köprü TÜRETİLMİŞ veridir, kaynağı ayrı çekimdir ve
    -- yeniden kurulabilir olmalı; faaliyet'i kirletmek onu geri alınamaz kılar.
    CREATE TABLE IF NOT EXISTS teklif_sirasayisi (
      faaliyet_id  INTEGER PRIMARY KEY,     -- faaliyet(kaynak='kanun').id
      sira_sayisi  TEXT NOT NULL,           -- "Esas Komisyon Raporu(Sırasayısı)" → oylama.sira_sayisi
      kanun_no     TEXT,                    -- "KANUN NUMARASI" (kanunlaşmışsa)
      esas_no      TEXT,                    -- "Esas Numarası" (2/3737) — teşhis için, köprü DEĞİL
      cekim_zamani TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_teklif_ss ON teklif_sirasayisi(sira_sayisi);
    -- 🔴 CEVAP TABLOSU — denetim işlevinin TEK ölçülebilir çıktısı.
    -- faaliyet.durum alanı yalnız "cevaplandı / süresi geçti / hiç cevaplanmadı" der; bu tablo
    -- SÜREYİ ve BELGEYİ verir: hangi birleşimde, hangi tarihte, hangi PDF'le cevaplandı.
    -- Motor bunu 2026-07-19'a kadar ayrıştırıp ATIYORDU.
    -- ⚠️ KAPSAM YAPISAL OLARAK KISMİ: detay sayfası sayfa başına ilk 20 kayıt için çekiliyor.
    -- Bu yüzden AGREGAT ORAN üretilemez (örneklem yanlıdır); alan BELGE GÖSTERİMİ içindir.
    CREATE TABLE IF NOT EXISTS onerge_cevap (
      faaliyet_id     INTEGER NOT NULL REFERENCES faaliyet(id) ON DELETE CASCADE,
      sira            TEXT NOT NULL,      -- tablodaki sıra ('Gecikmiş' olabilir)
      birlesim        TEXT,
      birlesim_tarihi TEXT,
      cevap_tarihi    TEXT,
      pdf_url         TEXT,
      etiket          TEXT,
      PRIMARY KEY (faaliyet_id, sira)
    );
    CREATE INDEX IF NOT EXISTS ix_cevap_faaliyet ON onerge_cevap(faaliyet_id);
    -- 🔴 KOMİSYON SÜRECİ — yasama zincirinin BOŞ HALKASI.
    -- Zincir: Teklif → İmza → [BOŞLUK] → Genel Kurul → Sonuç. Türkiye'de yasama fiilen
    -- komisyonda olur: teklif orada değişir, birleşir ya da hiç gündeme gelmeden düşer.
    -- Site "3.793 teklif komisyonda bekliyor" diyordu ve arkası boştu: hangi komisyonda, kaç aydır?
    -- Motor (law.ts parseDetail) bu tabloyu ZATEN ayrıştırıyordu ve ATIYORDU — üstelik ağ maliyeti
    -- ÖDENMİŞTİ (imzaScraper ~9.700 detay sayfası çekti).
    -- Bununla "teklif komisyonda kaç gün bekledi" ÖLÇÜLEBİLİR hale gelir.
    CREATE TABLE IF NOT EXISTS teklif_komisyon (
      faaliyet_id INTEGER NOT NULL REFERENCES faaliyet(id) ON DELETE CASCADE,
      tip         TEXT NOT NULL,   -- Esas / Tali
      ad          TEXT NOT NULL,
      giris       TEXT,            -- komisyona giriş tarihi
      cikis       TEXT,            -- çıkış tarihi (boşsa HÂLÂ komisyonda)
      islem       TEXT,
      PRIMARY KEY (faaliyet_id, tip, ad)
    );
    CREATE INDEX IF NOT EXISTS ix_komisyon_faaliyet ON teklif_komisyon(faaliyet_id);

    -- 🔴 "DETAYI ÇEKTİK" DAMGASI — iş listesinin yanlış soru sormasını engeller.
    -- imzaScraper'ın atlama kapısı imzaKokeniBiliniyorMu idi: imzası bilinen belge SONSUZA DEK
    -- atlanır. Komisyon tablosu aynı detay sayfasından geliyor ama daha SONRA eklendi → imzası
    -- zaten bilinen 2.858 belgenin komisyonu asla dolmayacaktı. Kapı "bu belgeden ne biliyoruz"u
    -- değil "bu sayfayı KOMİSYONU DA OKUYAN kodla çektik mi"yi sormalı.
    -- komisyon_n = 0 meşrudur (belge komisyona hiç gitmemiş olabilir) — bu yüzden varlık,
    -- teklif_komisyon'da satır aranarak değil AYRI bir damgayla ölçülür: yoksa komisyonsuz
    -- belgeler her turda yeniden çekilirdi.
    CREATE TABLE IF NOT EXISTS detay_cekim (
      faaliyet_id INTEGER PRIMARY KEY REFERENCES faaliyet(id) ON DELETE CASCADE,
      cekildi     TEXT NOT NULL,
      komisyon_n  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS ix_komisyon_ad ON teklif_komisyon(ad);

    -- DUYURU EKİ — "bu kanun çıktıktan sonra hayatta ne oldu" (FAZ 9.2, kullanıcı kararı: kurulsun).
    -- 🔴 BU BİR HABER TABLOSU DEĞİL. Kural (lib/haberOlcut.ts): bir öğe ancak korpusumuzda ZATEN
    -- VAR OLAN bir kanuna atıf yaparsa girer. Kaynak yalnız Resmî Gazete (zaten korpusta) ·
    -- başlık AYNEN saklanır (özet/alıntı/sıfat YOK) · "hangi haber önemli" HİÇ sorulmaz.
    -- Bir kanunu UYGULAYAN sonraki düzenlemeler (Cumhurbaşkanı Kararı, tebliğ, yönetmelik) burada;
    -- kanunun kendisi ve AYM kararı DEĞİL (onlar zaten kanun kartının halkalarında).
    -- kanun_no = çıpalandığı korpus kanunu · gazete_id = kaynağın kendi RG kaydı.
    CREATE TABLE IF NOT EXISTS duyuru (
      gazete_id  INTEGER NOT NULL REFERENCES gazete(id) ON DELETE CASCADE,
      kanun_no   TEXT NOT NULL,
      baslik     TEXT NOT NULL,   -- RG başlığının BİREBİR kendisi
      tur        TEXT,            -- RG tür etiketi (TEBLİĞLER, CUMHURBAŞKANI KARARLARI…)
      tarih      TEXT,
      url        TEXT,
      PRIMARY KEY (gazete_id, kanun_no)
    );
    -- Admin paneli — duyuru inceleme/işaretleme (2026-07-30, Faz 2 ÖNCELİK 4d). haberOlcut.ts'in
    -- mekanik eşleştiricisi geçmişte GERÇEK yanlış-eşleşme sınıfları üretmiş (RG "sayılı Kararı"
    -- sayılarının kanun no sanılması gibi, bkz. haberOlcut.ts). duyuru satırı BİREBİR RG başlığı
    -- taşıdığı için asla elle düzenlenmez — bu tablo yalnız YANINA bir işaret koyar, satırı SİLMEZ:
    -- kanıt (mekanik eşleştiricinin ne ürettiği) denetim izinde kalır, yalnız public sorgu bu
    -- işaretli satırları GÖSTERMEZ (bkz. ozet.ts kanun-hikaye ucu).
    CREATE TABLE IF NOT EXISTS duyuru_inceleme (
      gazete_id   INTEGER NOT NULL,
      kanun_no    TEXT NOT NULL,
      bayrak      TEXT NOT NULL,   -- 'yanlis' | 'belirsiz'
      not_metni   TEXT,
      isaretleyen TEXT NOT NULL,
      tarih       TEXT NOT NULL,
      PRIMARY KEY (gazete_id, kanun_no)
    );
    CREATE INDEX IF NOT EXISTS ix_duyuru_kanun ON duyuru(kanun_no);

    -- VEKİL ↔ KOMİSYON ÜYELİĞİ — yasama sürecinin görünmeyen yarısının ikinci yarısı.
    -- teklif_komisyon "bu teklif hangi komisyonda, ne kadar bekledi" diyor; bu tablo
    -- "o komisyonda KİM var" diyor. İkisi birleşince teklifin kaderini belirleyen yapı görünür:
    -- ölçüldü, Plan ve Bütçe Komisyonu tek başına 1.459 teklife bakmış.
    --
    -- 🔴 KOMİSYON ADI İKİ KAYNAKTA FARKLI YAZILIYOR — normalize edilmeden eşleşmez:
    --   teklif_komisyon → 'PLAN VE BÜTÇE KOMİSYONU'      (TBMM teklif kaydı, BÜYÜK)
    --   vekil profili   → 'Plan Ve Bütçe Komisyonu Üyesi' (TBMM vekil kaydı, Title + rol eki)
    -- komisyon_norm bu yüzden ayrı tutulur: Türkçe locale ile büyütülmüş, rol eki atılmış hâli.
    -- (Türkçe casing tuzağı bu projede daha önce 'Kocaeli' vs 'KOCAELİ' ile yaşandı.)
    CREATE TABLE IF NOT EXISTS vekil_komisyon (
      ad_soyad      TEXT NOT NULL,
      donem         INTEGER NOT NULL,
      komisyon      TEXT NOT NULL,   -- kaynaktaki HAM yazım (rol eki dahil)
      komisyon_norm TEXT NOT NULL,   -- eşleştirme anahtarı (TR-upper, rol eki atılmış)
      rol           TEXT,            -- Üye / Başkan / Başkanvekili … (kaynağın kendi ibaresi)
      parti         TEXT,
      il            TEXT,
      PRIMARY KEY (ad_soyad, donem, komisyon_norm)
    );
    CREATE INDEX IF NOT EXISTS ix_vekil_kom_norm ON vekil_komisyon(komisyon_norm, donem);

    -- Vekil profili ÇEKİLDİ damgası. komisyonlar BOŞ dönmek MEŞRUDUR (vekil hiçbir komisyonda
    -- olmayabilir — ölçüldü: 3 vekilden 1'i boş) → varlık, vekil_komisyon'da satır arayarak
    -- ölçülemez. Damgasız bırakılırsa komisyonsuz vekiller HER TURDA yeniden çekilir.
    -- (Aynı sınıf: detay_cekim. Bu projede iş listesi 4 kez yanlış soru sordu.)
    -- ÖNERGE CEVAP ÇEKİM DAMGASI. Bir önergenin cevabı OLMAYABİLİR (ölçüldü: 720 örnekten 533
    -- cevapsız) ve bu MEŞRUDUR. Damga olmasaydı iş listesi "onerge_cevap'ta satır var mı" diye
    -- sorardı → cevapsız önergeler HER KOŞUMDA yeniden çekilir, 533 istek boşa giderdi.
    -- Bu projede aynı sınıf 5. kez: hasImza · basilmisUrl · imzaKokeni · durum=HEPSI · burası.
    CREATE TABLE IF NOT EXISTS onerge_cevap_cekim (
      faaliyet_id INTEGER PRIMARY KEY REFERENCES faaliyet(id) ON DELETE CASCADE,
      cekildi     TEXT NOT NULL,
      cevap_n     INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS vekil_profil_cekim (
      ad_soyad   TEXT NOT NULL,
      donem      INTEGER NOT NULL,
      cekildi    TEXT NOT NULL,
      komisyon_n INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (ad_soyad, donem)
    );
    -- 🔴 AYM SİYASİ PARTİ KARARLARI — bugüne kadar HİÇ çekilmemiş banka.
    -- Parti kapatma davaları, mali denetim, hazine yardımı kararları. Motor bu bankaya
    -- erişebiliyordu (aynı API, farklı origin) ama ETL hiç çağırmıyordu.
    -- "Siyasi şeffaflık sitesi" için kör nokta olması savunulamazdı.
    -- ⚠️ Norm denetiminden AYRI tablo: farklı bir yargısal işlev, aynı kovaya konamaz.
    CREATE TABLE IF NOT EXISTS aym_parti_karar (
      aym_id       TEXT PRIMARY KEY,
      esas_no      TEXT, karar_no TEXT, karar_tarihi TEXT, ay TEXT,
      rg_tarihi    TEXT, rg_sayisi TEXT,
      basvuru_turu TEXT, sonuc TEXT, konu TEXT, url TEXT,
      guncelleme   TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_aym_parti_tarih ON aym_parti_karar(karar_tarihi);
    -- YSK SEÇİM SONUÇLARI (milletvekili genel seçimi, ÜLKE GENELİ parti oy dökümü).
    -- Kaynak: sonuc.ysk.gov.tr JSON API'si (canlı doğrulandı 2026-07-24, tarayıcı akışıyla).
    -- 🔴 secim_id ASLA getSecimList'in döndürdüğü secim_ID DEĞİL: sayfa, kullanıcı bir seçim
    -- seçtiğinde bu görünen ID'yi İSTEMCİ TARAFINDA farklı bir dahili ID'ye çeviriyor (ör. 2023
    -- için görünen 20230 → gerçek sorgu ID'si 60792) ve bu çeviri hiçbir API çağrısında AÇIK
    -- GÖRÜNMÜYOR — yalnız tarayıcı otomasyonuyla (ng-select akışı) tek tek çözüldü. Bu yüzden
    -- engines/ysk.ts'teki eşleme sabit/elle-doğrulanmış bir tablo, algoritmik türetme DEĞİL.
    -- KAPSAM SINIRI (bilinçli, engines/ysk.ts'te detaylı): oy, yalnız "yurt içi + yurt dışı sandıklar"
    -- toplamı — GÜMRÜK (sınır kapısı) oyları JSON API'de yok, PDF'teki resmî nihai sonuçtan ölçülebilir
    -- küçük farkla (2023 AKP: %0,4 fark) — bu ozet.ts route'unda okura AÇIKÇA söylenir, gizlenmez.
    -- İl/seçim çevresi kırılımı hâlâ YOK (ilId parametresi denendi, ya etkisiz ya tutarsız) →
    -- il-seviyesi için PDF fallback sonraki iş (bkz. proje belleği).
    -- İTTİFAK (5 alliance sütunu) ve bağımsız-aday-bazlı 50 sütun KASITLI OLARAK ALINMADI: ittifak
    -- toplamları zaten üye partilerin toplamı (yeniden yazsak çift-sayım riski), bağımsız-aday
    -- kırılımı isim eşlemesi olmadan anlamsız — yalnız bagimsiz_TOPLAM_OY (tek satır) tutulur.
    -- SANDALYE — AYRI KAYNAK: JSON API'de hiç yok, YSK'nin "SİYASİ PARTİLERİN ÇIKARDIKLARI
    -- MİLLETVEKİLİ İLE BAĞIMSIZLARIN SAYISI" PDF'inden (engines/ysk.ts, dönem başına elle
    -- doğrulanmış URL — dosya adı/klasör şeması yıldan yıla FARKLI, tabloyu BAŞLIK METNİYLE bulur).
    -- Mizan'ın asıl konusu TBMM'de OTURAN vekiller olduğu için sandalye, oy yüzdesinden daha
    -- doğrudan ilgili sayı — ozet.ts'te "belirgin parti" ayrımı bu sütuna dayanır (sandalye>0).
    CREATE TABLE IF NOT EXISTS secim_sonucu (
      id           INTEGER PRIMARY KEY,
      donem        INTEGER NOT NULL,        -- Mizan dönem no (25-28)
      secim_id     INTEGER NOT NULL,        -- YSK'nin GERÇEK sorgu ID'si (60792 gibi, yukarı bkz.)
      tarih        TEXT NOT NULL,           -- 'YYYY-MM-DD' seçim tarihi
      secim_adi    TEXT,                    -- YSK'nin kendi başlığı
      parti        TEXT NOT NULL,           -- normParti() başarılıysa kanonik ad, değilse YSK'nin ham adı
      oy           INTEGER NOT NULL,        -- ülke geneli (yurtiçi+yurtdışı) oy sayısı
      gecerli_oy_toplami  INTEGER,          -- dönem-geneli payda (her satırda aynı) — % hesaplamak için
      gecersiz_oy_toplami INTEGER,
      secmen_sayisi       INTEGER,          -- Kayıtlı Seçmen Sayısı (dönem-geneli)
      katilma_orani       REAL,             -- % (YSK'nin kendi hesabı)
      sandalye     INTEGER,                 -- kazandığı milletvekili sayısı; NULL = PDF'te bu parti hiç yok (0 ile karıştırılmasın)
      guncelleme   TEXT,
      UNIQUE(donem, parti)
    );
    CREATE INDEX IF NOT EXISTS ix_secim_donem ON secim_sonucu(donem);
    -- PARTİ PROGRAMI/SEÇİM BEYANNAMESİ — partinin KENDİ resmi metni, arşivlenip aranabilir kılınır.
    -- 🔴 VAAT↔TBMM KARŞILAŞTIRMASI KASITLI OLARAK YOK: "bu vaat tutuldu mu" hükmü editoryal yargı
    -- gerektirir — RG↔teklif eşleştirmesinin reddedilme gerekçesiyle (yönlü hata) aynı sınıf risk,
    -- muhtemelen daha ağırı (beyannameler RG'den çok daha belirsiz/yorumlanabilir metin). Bunun
    -- yerine metin ARANABİLİR yapılır (aramaKosuluIfade, konusma-ara/kanun-ara ile aynı desen) ve
    -- konu.html'de o konudaki TBMM faaliyetinin YANINA konur — okur kendi kıyasını kurar, biz kurmayız.
    -- ⚠️ BELGELER FARKLI TÜR/TARİH — AYNI ŞEY DEĞİL: AKP/MHP/DEM/YENİDEN REFAH/TİP 2023 seçimi için
    -- (TİP'inki kendi beyanına göre ÖZET); CHP'ninki 2023'e özgü bir beyanname değil, tarihsiz/güncel
    -- (2025 taslağı) genel parti programı — CHP 2023'e Millet İttifakı ortak listesiyle girdiği için
    -- kendi ayrı beyannamesi yok. belge_turu sütunu bu ayrımı taşır, UI'da karıştırılmaz.
    -- İYİ PARTİ YOK: sitede ne 2023 beyannamesi (yayımlanmamış, kişiselleştirilmiş bir web aracıydı,
    -- o alan adı artık ölü) ne de genel parti programı (kaldırılmış, 404) erişilebilir durumda
    -- (canlı doğrulandı 2026-07-25) — bu SESSİZCE atlanmaz, ozet.ts'te 7 partiden 6'sının kapsandığı
    -- açıkça beyan edilir.
    -- metin_norm YOK (bilinçli — aym_karar/gazete ile aynı gerekçe, plan notu): 6 satırlık bir
    -- tabloda sorgu-anı tr_lower() ölçülebilir ucuz, önceden hesaplamak gereksiz karmaşıklık olurdu.
    CREATE TABLE IF NOT EXISTS parti_program (
      id          INTEGER PRIMARY KEY,
      parti       TEXT NOT NULL,        -- normParti() kanonik ad
      belge_adi   TEXT NOT NULL,        -- insan-okur başlık, ör. "2023 Seçim Beyannamesi"
      belge_turu  TEXT NOT NULL,        -- 'secim_beyannamesi' | 'parti_programi' — yalnız AYNI türler kıyaslanabilir
      tarih       TEXT,                 -- yayım tarihi 'YYYY-MM-DD', bilinmiyorsa NULL
      kaynak_url  TEXT NOT NULL,
      metin       TEXT NOT NULL,
      guncelleme  TEXT,
      UNIQUE(parti, belge_turu)
    );
    -- YEREL YÖNETİM — büyükşehir belediyesi meclis kararları (bkz. engines/yerelYonetim.ts başlık notu).
    -- KAPSAM: yalnız 6 büyükşehir (İstanbul/Ankara/İzmir/Bursa/Konya/Diyarbakır, parti çeşitliliği
    -- için seçildi — 6 şehrin 6'sı da canlı doğrulandı 2026-07-25), yalnız 2024 yerel seçimi sonrası
    -- (mevcut meclis dönemi). Bu tek zaman-penceresi kararı üç ayrı sorunu birden çözer: Bursa'nın
    -- 2010'lar-öncesi taranmış-görüntü/OCR sorunu devre dışı kalır, Diyarbakır'ın kayyum-dönemi
    -- (2016-2024, tek atanmış yöneticinin kararlarıydı, çok partili meclis YOKTU) nüansı hiç
    -- gündeme gelmez, ve üye/parti roster'ı ile karar dönemi arası tutarlılık garanti edilir.
    -- 🔴 ÜYE-BAZLI OYLAMA KIRILIMI YOK: 6 şehrin 6'sında da roll-call (kim nasıl oy verdi) ya hiç
    -- yayımlanmıyor ya da güvenilmez (Bursa/Diyarbakır'da yalnız MUHALEFET isimlendiriliyor,
    -- çoğunluk isimsiz kalıyor) — TBMM'nin "FAZ 3 ÖLÇÜMLE ÇÜRÜTÜLDÜ" dersiyle aynı sınıf risk,
    -- üretilmedi. oylama_sonucu sütunu kararın KENDİ beyanından (oybirliği/oyçokluğu ifadesi
    -- metinde açıkça geçiyor), yorum değil — AYM'nin sonuc_kod'u gibi kaynağın kendi kaydı.
    CREATE TABLE IF NOT EXISTS yerel_karar (
      id              INTEGER PRIMARY KEY,
      belediye        TEXT NOT NULL,        -- 'İstanbul' | 'Ankara' | 'İzmir' | 'Bursa' | 'Konya' | 'Diyarbakır'
      karar_no        TEXT NOT NULL DEFAULT '', -- NOT NULL DEFAULT '' ŞART (UNIQUE'te NULL≠NULL) — Konya'da hiç yok
      tarih           TEXT NOT NULL,         -- 'YYYY-MM-DD'
      konu            TEXT,                  -- özet/başlık (kaynak varsa)
      metin           TEXT NOT NULL,
      oylama_sonucu   TEXT,                  -- 'oybirlik' | 'oycoklugu' | NULL (kararda hiç belirtilmemişse — Konya'da hep NULL)
      kaynak_url      TEXT NOT NULL,
      guncelleme      TEXT,
      UNIQUE(belediye, karar_no, tarih)
    );
    CREATE INDEX IF NOT EXISTS ix_yerel_karar_belediye ON yerel_karar(belediye, tarih DESC);
    -- Meclis üye/parti kompozisyonu — STATİK, karar kayıtlarından BAĞIMSIZ (hiçbir kaynak kararı
    -- üyeye/oya bağlamıyor, bkz. yukarı). Diyarbakır: belediyenin kendi sitesinde YOK (4 ilgili
    -- sayfa da boş, canlı doğrulandı) — satır yazılmaz, ozet.ts route'u bunu "5/6" diye açıkça beyan eder.
    CREATE TABLE IF NOT EXISTS yerel_meclis_uye (
      id          INTEGER PRIMARY KEY,
      belediye    TEXT NOT NULL,
      ad_soyad    TEXT NOT NULL,
      parti       TEXT NOT NULL,           -- normParti() dener, çözülmezse ham ad (bkz. ysk.ts bağımsız deseni)
      ilce        TEXT,                    -- varsa (İstanbul API'sinde var)
      guncelleme  TEXT,
      UNIQUE(belediye, ad_soyad)
    );
    CREATE INDEX IF NOT EXISTS ix_yerel_uye_belediye ON yerel_meclis_uye(belediye, parti);
    -- 🔴 TAM METİN ARAMA İÇİN FTS5 — ÖLÇÜLDÜ (2026-07-25, 6 şehir tam yüklendikten sonra): yaygın
    -- terimlerde (ör. "imar") aramaKosuluIfade'nin LIKE '%terim%' taraması 3,4 saniyeye çıktı —
    -- aym_karar/gazete'nin "sorgu-anı tr_lower() ölçüldü, kabul edilen bant" gerekçesi BURADA
    -- GEÇERSİZ: o ölçüm küçük satır SAYISI + kısa metin varsayıyordu, yerel_karar.metin satır
    -- başına onlarca KB'a çıkabiliyor (10.000+ satır × büyük metin = LIKE taraması O(n) pahalı).
    -- FTS5 gerçek ters-indeks kurar. Türkçe harf katlama (İ/I, ı/i) FTS5'in kendi unicode61
    -- tokenizer'ına BIRAKILMAZ (bu projenin "Türkçe harf katlama" işinin kendi çözümüyle
    -- çakışabilir) — bunun yerine trLower() ile ÖNCEDEN katlanmış metin FTS5'e yazılır, sorgu
    -- tarafı da aynı trLower() ile katlanır; FTS5 yalnız zaten-katlanmış ASCII-benzeri metni eşler.
    CREATE VIRTUAL TABLE IF NOT EXISTS yerel_karar_fts USING fts5(metin_norm, tokenize='unicode61');
  `);
  for (const stmt of [
    'ALTER TABLE faaliyet ADD COLUMN muhatap TEXT',
    'ALTER TABLE faaliyet ADD COLUMN kategori_versiyon INTEGER',
    'ALTER TABLE faaliyet ADD COLUMN kategori_kaynagi TEXT',
    'ALTER TABLE teklif_sirasayisi ADD COLUMN gelis_tarihi TEXT',
    'ALTER TABLE faaliyet ADD COLUMN muhatap_text TEXT',
    'ALTER TABLE faaliyet ADD COLUMN baslik_norm TEXT',
    'ALTER TABLE oylama ADD COLUMN basilmis_url TEXT',
    'ALTER TABLE gazete ADD COLUMN mukerrer TEXT',
    'ALTER TABLE secim_sonucu ADD COLUMN sandalye INTEGER',
    'ALTER TABLE admin_kullanici ADD COLUMN son_kullanim TEXT',
    'ALTER TABLE admin_kullanici ADD COLUMN sona_erme TEXT',
  ]) {
    try {
      db.exec(stmt);
    } catch {
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS ix_faaliyet_muhatap ON faaliyet(muhatap);');
  migrateFaaliyetKey(db);
  migrateImzaKaynak(db);
  migrateBaslikNorm(db);
  migrateAdminKullaniciTokenHash(db);
  dbHandle = db;
  logger.info(`SQLite hazır: ${DB_PATH}`);
  return db;
}

export interface FaaliyetKayit {
  kaynak: 'kanun' | 'onerge' | 'konusma';
  kaynak_id: string;
  tarih: string | null;
  ay: string | null;
  yil: number | null;
  donem: number;
  baslik: string;
  ozet: string;
  durum: string;
  kategori: string;
  detay_url: string;
  muhatap?: string | null;
  muhatap_text?: string | null;
  kategori_versiyon?: number | null;
  kategori_kaynagi?: string | null;
}

export function upsertFaaliyet(rec: FaaliyetKayit): number {
  const db = getDb();
  const now = new Date().toISOString();
  const row = db
    .prepare(
      `INSERT INTO faaliyet (kaynak,kaynak_id,tarih,ay,yil,donem,baslik,baslik_norm,ozet,durum,kategori,detay_url,guncelleme,muhatap,muhatap_text,kategori_versiyon,kategori_kaynagi)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       -- Çakışma hedefi anahtarla AYNI olmalı (kaynak,kaynak_id,donem). Dönemsiz hedef, önerge
       -- esas-no'ları dönemler arası tekrarlandığı için d28 kayıtlarının üzerine d27'yi yazıyordu.
       ON CONFLICT(kaynak,kaynak_id,donem) DO UPDATE SET
         tarih=excluded.tarih, ay=excluded.ay, yil=excluded.yil,
         baslik=excluded.baslik, baslik_norm=excluded.baslik_norm, ozet=excluded.ozet, durum=excluded.durum,
         kategori=excluded.kategori, detay_url=excluded.detay_url, guncelleme=excluded.guncelleme,
         muhatap=excluded.muhatap,
         -- COALESCE ŞART: muhatap_text yalnız DETAYI ÇEKİLEN kayıtlarda gelir (sayfa başına ilk
         -- 20). Düz atama, detayı çekilmeyen bir sonraki koşuda mevcut metni NULL'la EZER —
         -- her ETL turu veriyi bir adım geri alırdı. Yeni değer varsa al, yoksa ESKİYİ KORU.
         muhatap_text=COALESCE(excluded.muhatap_text, faaliyet.muhatap_text),
         kategori_versiyon=excluded.kategori_versiyon, kategori_kaynagi=excluded.kategori_kaynagi
       RETURNING id`,
    )
    .get(
      rec.kaynak, rec.kaynak_id, rec.tarih, rec.ay, rec.yil, rec.donem,
      rec.baslik, rec.baslik ? trLower(rec.baslik) : null, rec.ozet, rec.durum, rec.kategori, rec.detay_url, now,
      rec.muhatap ?? null, rec.muhatap_text ?? null, rec.kategori_versiyon ?? null, rec.kategori_kaynagi ?? null,
    ) as { id: number };
  return row.id;
}

export function replaceOnergeCevap(faaliyetId: number, cevaplar: {
  order: string; birlesim: string; birlesim_tarihi: string; date: string; pdf: string; label: string;
}[]): void {
  if (!cevaplar.length) return;
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO onerge_cevap (faaliyet_id, sira, birlesim, birlesim_tarihi, cevap_tarihi, pdf_url, etiket)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(faaliyet_id, sira) DO UPDATE SET
       birlesim=excluded.birlesim, birlesim_tarihi=excluded.birlesim_tarihi,
       cevap_tarihi=excluded.cevap_tarihi, pdf_url=excluded.pdf_url, etiket=excluded.etiket`,
  );
  for (const c of cevaplar) {
    if (!c.order) continue;
    ins.run(faaliyetId, c.order, c.birlesim || null, c.birlesim_tarihi || null,
            c.date || null, c.pdf || null, c.label || null);
  }
}

export function replaceTeklifKomisyon(faaliyetId: number, satirlar: {
  tip: string; adi: string; giris: string; cikis: string; islem: string;
}[]): void {
  if (!satirlar.length) return;
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO teklif_komisyon (faaliyet_id, tip, ad, giris, cikis, islem)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(faaliyet_id, tip, ad) DO UPDATE SET
       giris=excluded.giris, cikis=excluded.cikis, islem=excluded.islem`,
  );
  for (const k of satirlar) {
    if (!k.tip || !k.adi) continue;
    ins.run(faaliyetId, k.tip, k.adi, k.giris || null, k.cikis || null, k.islem || null);
  }
}

const ROL_KALIPLARI = [
  'Eş Başkan Yardımcısı', 'Başkan Yardımcısı', 'Katip Üyesi', 'Kâtip Üyesi', 'Katip Üye', 'Kâtip Üye',
  'Başkan Vekili', 'Başkanvekili', 'İdare Amiri', 'Başkanı', 'Sözcüsü', 'Kâtibi', 'Katibi', 'Üyesi', 'Üye',
];
const ROL_RE = new RegExp(`\\s+(${ROL_KALIPLARI.join('|')})\\s*$`, 'iu');

export function komisyonNorm(ad: string): string {
  return String(ad ?? '')
    .replace(ROL_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleUpperCase('tr');
}

export function komisyonRol(ad: string): string | null {
  const m = String(ad ?? '').match(ROL_RE);
  return m ? m[1]! : null;
}

export function replaceVekilKomisyon(
  adSoyad: string, donem: number, parti: string | null, il: string | null, komisyonlar: string[],
): void {
  if (!komisyonlar.length) return;
  const ins = getDb().prepare(
    `INSERT INTO vekil_komisyon (ad_soyad, donem, komisyon, komisyon_norm, rol, parti, il)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(ad_soyad, donem, komisyon_norm) DO UPDATE SET
       komisyon=excluded.komisyon, rol=excluded.rol, parti=excluded.parti, il=excluded.il`,
  );
  for (const k of komisyonlar) {
    const norm = komisyonNorm(k);
    if (!norm) continue;
    ins.run(adSoyad, donem, k, norm, komisyonRol(k), parti, il);
  }
}

export function onergeCevapCekildiMi(faaliyetId: number): boolean {
  return getDb().prepare('SELECT 1 FROM onerge_cevap_cekim WHERE faaliyet_id = ?').get(faaliyetId) !== undefined;
}

export function onergeCevapIsaretle(faaliyetId: number, n: number, gun: string): void {
  getDb().prepare(
    `INSERT INTO onerge_cevap_cekim (faaliyet_id, cekildi, cevap_n) VALUES (?,?,?)
     ON CONFLICT(faaliyet_id) DO UPDATE SET cekildi=excluded.cekildi, cevap_n=excluded.cevap_n`,
  ).run(faaliyetId, gun, n);
}

export function vekilProfilCekildiMi(adSoyad: string, donem: number): boolean {
  return getDb().prepare('SELECT 1 FROM vekil_profil_cekim WHERE ad_soyad = ? AND donem = ?')
    .get(adSoyad, donem) !== undefined;
}

export function vekilProfilIsaretle(adSoyad: string, donem: number, n: number, gun: string): void {
  getDb().prepare(
    `INSERT INTO vekil_profil_cekim (ad_soyad, donem, cekildi, komisyon_n) VALUES (?,?,?,?)
     ON CONFLICT(ad_soyad, donem) DO UPDATE SET cekildi=excluded.cekildi, komisyon_n=excluded.komisyon_n`,
  ).run(adSoyad, donem, gun, n);
}

export function detayCekildiMi(faaliyetId: number): boolean {
  return getDb().prepare('SELECT 1 FROM detay_cekim WHERE faaliyet_id = ?').get(faaliyetId) !== undefined;
}

export function detayCekimIsaretle(faaliyetId: number, komisyonN: number, gun: string): void {
  getDb()
    .prepare(
      `INSERT INTO detay_cekim (faaliyet_id, cekildi, komisyon_n) VALUES (?,?,?)
       ON CONFLICT(faaliyet_id) DO UPDATE SET cekildi=excluded.cekildi, komisyon_n=excluded.komisyon_n`,
    )
    .run(faaliyetId, gun, komisyonN);
}

export function upsertAymParti(r: {
  aym_id: string; esas_no: string; karar_no: string; karar_tarihi: string;
  rg_tarihi: string; rg_sayisi: string; basvuru_turu: string; sonuc: string; konu: string; url: string;
}): void {
  getDb().prepare(
    `INSERT INTO aym_parti_karar (aym_id, esas_no, karar_no, karar_tarihi, ay, rg_tarihi, rg_sayisi,
                                  basvuru_turu, sonuc, konu, url, guncelleme)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(aym_id) DO UPDATE SET
       esas_no=excluded.esas_no, karar_no=excluded.karar_no, karar_tarihi=excluded.karar_tarihi,
       ay=excluded.ay, rg_tarihi=excluded.rg_tarihi, rg_sayisi=excluded.rg_sayisi,
       basvuru_turu=excluded.basvuru_turu, sonuc=excluded.sonuc, konu=excluded.konu,
       url=excluded.url, guncelleme=excluded.guncelleme`,
  ).run(r.aym_id, r.esas_no, r.karar_no, r.karar_tarihi, (r.karar_tarihi || '').slice(0, 7),
        r.rg_tarihi, r.rg_sayisi, r.basvuru_turu, r.sonuc, r.konu, r.url, new Date().toISOString());
}

export function replaceFaaliyetParties(faaliyetId: number, partiler: string[]): void {
  const db = getDb();
  db.prepare('DELETE FROM faaliyet_parti WHERE faaliyet_id = ?').run(faaliyetId);
  const ins = db.prepare('INSERT OR IGNORE INTO faaliyet_parti (faaliyet_id, parti) VALUES (?, ?)');
  for (const p of new Set(partiler)) ins.run(faaliyetId, p);
}

export function oncekiDurum(kaynak: string, kaynak_id: string, donem: number): string | null {
  const row = getDb().prepare('SELECT durum FROM faaliyet WHERE kaynak=? AND kaynak_id=? AND donem=?').get(kaynak, kaynak_id, donem) as { durum: string | null } | undefined;
  return row ? row.durum ?? '' : null;
}
export function kaydetOlay(faaliyetId: number, once: string | null, yeni: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  if (once === null) {
    db.prepare("INSERT OR IGNORE INTO olay (faaliyet_id,tip,olay_tarih,eski_durum,yeni_durum) VALUES (?,'yeni',?,NULL,?)").run(faaliyetId, now, yeni);
  } else if (once !== yeni) {
    db.prepare("INSERT OR IGNORE INTO olay (faaliyet_id,tip,olay_tarih,eski_durum,yeni_durum) VALUES (?,'durum',?,?,?)").run(faaliyetId, now, once, yeni);
  }
}
export function upsertFaaliyetTracked(rec: FaaliyetKayit): { id: number; tip: 'yeni' | 'durum' | 'ayni' } {
  const once = oncekiDurum(rec.kaynak, rec.kaynak_id, rec.donem);
  const id = upsertFaaliyet(rec);
  const yeni = rec.durum ?? '';
  kaydetOlay(id, once, yeni);
  return { id, tip: once === null ? 'yeni' : once !== yeni ? 'durum' : 'ayni' };
}
export function loadKnownIds(kaynak: string, donem: number): Set<string> {
  const rows = getDb().prepare('SELECT kaynak_id FROM faaliyet WHERE kaynak=? AND donem=?').all(kaynak, donem) as { kaynak_id: string }[];
  return new Set(rows.map((r) => r.kaynak_id));
}
export function loadDurumMap(donem: number): Map<string, string> {
  const rows = getDb().prepare('SELECT kaynak, kaynak_id, durum FROM faaliyet WHERE donem=?').all(donem) as { kaynak: string; kaynak_id: string; durum: string | null }[];
  return new Map(rows.map((r) => [`${r.kaynak}:${r.kaynak_id}`, r.durum ?? '']));
}
export interface PollDurum { son_poll: string | null; ardisik_bos: number; devre_durumu: string | null; son_ozet: string | null; }
export function savePollDurum(d: Partial<PollDurum>): void {
  const db = getDb();
  const cur = (db.prepare('SELECT son_poll,ardisik_bos,devre_durumu,son_ozet FROM poll_durum WHERE id=1').get() as PollDurum | undefined) ?? { son_poll: null, ardisik_bos: 0, devre_durumu: null, son_ozet: null };
  const m = { ...cur, ...d };
  db.prepare('INSERT INTO poll_durum (id,son_poll,ardisik_bos,devre_durumu,son_ozet) VALUES (1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET son_poll=excluded.son_poll, ardisik_bos=excluded.ardisik_bos, devre_durumu=excluded.devre_durumu, son_ozet=excluded.son_ozet').run(m.son_poll, m.ardisik_bos, m.devre_durumu, m.son_ozet);
  db.prepare('INSERT INTO poll_durum_gecmis (zaman, devre_durumu, ardisik_bos) VALUES (?,?,?)').run(new Date().toISOString(), m.devre_durumu, m.ardisik_bos);
  db.prepare(`DELETE FROM poll_durum_gecmis WHERE zaman < ?`).run(new Date(Date.now() - 90 * 86_400_000).toISOString());
}
export function pollDurumGecmisi(limit = 200): { zaman: string; devre_durumu: string | null; ardisik_bos: number | null }[] {
  return getDb().prepare('SELECT zaman, devre_durumu, ardisik_bos FROM poll_durum_gecmis ORDER BY zaman DESC LIMIT ?').all(limit) as unknown as { zaman: string; devre_durumu: string | null; ardisik_bos: number | null }[];
}

export function adminSaglikOrnekYaz(uptimeSaniye: number, bellekMb: number, dbBoyutMb: number | null): void {
  const db = getDb();
  db.prepare('INSERT INTO admin_saglik_gecmis (zaman, uptime_saniye, bellek_mb, db_boyut_mb) VALUES (?,?,?,?)').run(new Date().toISOString(), uptimeSaniye, bellekMb, dbBoyutMb);
  db.prepare(`DELETE FROM admin_saglik_gecmis WHERE zaman < ?`).run(new Date(Date.now() - 90 * 86_400_000).toISOString());
}
export function adminSaglikGecmisi(limit = 300): { zaman: string; uptime_saniye: number; bellek_mb: number; db_boyut_mb: number | null }[] {
  return getDb().prepare('SELECT zaman, uptime_saniye, bellek_mb, db_boyut_mb FROM admin_saglik_gecmis ORDER BY zaman DESC LIMIT ?').all(limit) as unknown as { zaman: string; uptime_saniye: number; bellek_mb: number; db_boyut_mb: number | null }[];
}

export function aramaLogYaz(uc: string, terim: string, donem: string | null, sonucSayisi: number | null): void {
  try {
    getDb().prepare('INSERT INTO arama_log (zaman, uc, terim, donem, sonuc_sayisi, sifir_sonuc) VALUES (?,?,?,?,?,?)')
      .run(new Date().toISOString(), uc, terim, donem, sonucSayisi, sonucSayisi === 0 ? 1 : 0);
  } catch {  }
}
export interface AramaOzet {
  toplamArama: number;
  sifirSonucOrani: number;
  enCokAranan: { terim: string; n: number }[];
  enCokSifirSonuc: { terim: string; n: number }[];
  ucBasinaHacim: { uc: string; n: number }[];
}
export function aramaOzeti(gunSayisi = 30): AramaOzet {
  const db = getDb();
  const esik = new Date(Date.now() - gunSayisi * 86_400_000).toISOString();
  const toplam = (db.prepare(`SELECT COUNT(*) c, SUM(sifir_sonuc) s FROM arama_log WHERE zaman >= ?`).get(esik) as { c: number; s: number | null });
  const enCokAranan = db.prepare(`SELECT terim, COUNT(*) n FROM arama_log WHERE zaman >= ? GROUP BY terim ORDER BY n DESC LIMIT 20`).all(esik) as { terim: string; n: number }[];
  const enCokSifirSonuc = db.prepare(`SELECT terim, COUNT(*) n FROM arama_log WHERE zaman >= ? AND sifir_sonuc=1 GROUP BY terim ORDER BY n DESC LIMIT 20`).all(esik) as { terim: string; n: number }[];
  const ucBasinaHacim = db.prepare(`SELECT uc, COUNT(*) n FROM arama_log WHERE zaman >= ? GROUP BY uc ORDER BY n DESC`).all(esik) as { uc: string; n: number }[];
  return {
    toplamArama: toplam.c ?? 0,
    sifirSonucOrani: toplam.c ? Math.round(((toplam.s ?? 0) / toplam.c) * 1000) / 10 : 0,
    enCokAranan, enCokSifirSonuc, ucBasinaHacim,
  };
}
export function getPollDurum(): PollDurum | null {
  return (getDb().prepare('SELECT son_poll,ardisik_bos,devre_durumu,son_ozet FROM poll_durum WHERE id=1').get() as PollDurum | undefined) ?? null;
}

export interface AdminCalismaRow {
  id: number; mod: string; baslangic: string; bitis: string | null;
  durum: 'calisiyor' | 'tamam' | 'hata'; sonuc: string | null; hata: string | null; tetikleyen: string;
}
export function adminCalismaBaslat(mod: string, tetikleyen: string): number {
  const r = getDb().prepare(
    `INSERT INTO admin_calisma (mod, baslangic, durum, tetikleyen) VALUES (?, ?, 'calisiyor', ?)`,
  ).run(mod, new Date().toISOString(), tetikleyen);
  return Number(r.lastInsertRowid);
}
export function adminCalismaBitir(id: number, durum: 'tamam' | 'hata', sonuc: string | null, hata: string | null): void {
  getDb().prepare(
    `UPDATE admin_calisma SET bitis=?, durum=?, sonuc=?, hata=? WHERE id=?`,
  ).run(new Date().toISOString(), durum, sonuc, hata, id);
}
export interface AdminCalismaFiltre {
  mod?: string; durum?: string; tetikleyen?: string; since?: string; until?: string;
  orderBy?: 'baslangic' | 'bitis' | 'mod'; orderDir?: 'ASC' | 'DESC';
  limit?: number; offset?: number;
}
const GECMIS_SIRALAMA_IZIN = new Set(['baslangic', 'bitis', 'mod']);
export function adminCalismaGecmisiFiltreli(f: AdminCalismaFiltre): { kayitlar: AdminCalismaRow[]; toplam: number } {
  const kosullar: string[] = [];
  const params: (string | number)[] = [];
  if (f.mod) { kosullar.push('mod = ?'); params.push(f.mod); }
  if (f.durum) { kosullar.push('durum = ?'); params.push(f.durum); }
  if (f.tetikleyen) { kosullar.push('tetikleyen = ?'); params.push(f.tetikleyen); }
  if (f.since) { kosullar.push('baslangic >= ?'); params.push(f.since); }
  if (f.until) { kosullar.push('baslangic <= ?'); params.push(f.until); }
  const kosulSql = kosullar.length ? `WHERE ${kosullar.join(' AND ')}` : '';
  const orderBy = f.orderBy && GECMIS_SIRALAMA_IZIN.has(f.orderBy) ? f.orderBy : 'baslangic';
  const orderDir = f.orderDir === 'ASC' ? 'ASC' : 'DESC';
  const limit = Math.min(200, Math.max(1, f.limit ?? 50));
  const offset = Math.max(0, f.offset ?? 0);
  const db = getDb();
  const toplam = (db.prepare(`SELECT COUNT(*) c FROM admin_calisma ${kosulSql}`).get(...params) as { c: number }).c;
  const kayitlar = db.prepare(`SELECT * FROM admin_calisma ${kosulSql} ORDER BY ${orderBy} ${orderDir} LIMIT ? OFFSET ?`).all(...params, limit, offset) as unknown as AdminCalismaRow[];
  return { kayitlar, toplam };
}

export interface AdminZamanlayiciRow { mod: string; aktif: number; aralik_saat: number; son_calisma: string | null }
export function adminZamanlayiciTumu(): AdminZamanlayiciRow[] {
  return getDb().prepare(`SELECT * FROM admin_zamanlayici ORDER BY mod`).all() as unknown as AdminZamanlayiciRow[];
}
export function adminZamanlayiciAyarla(mod: string, aktif: boolean, aralikSaat: number): void {
  getDb().prepare(
    `INSERT INTO admin_zamanlayici (mod, aktif, aralik_saat) VALUES (?, ?, ?)
       ON CONFLICT(mod) DO UPDATE SET aktif=excluded.aktif, aralik_saat=excluded.aralik_saat`,
  ).run(mod, aktif ? 1 : 0, aralikSaat);
}
export function adminZamanlayiciSonCalismaYaz(mod: string): void {
  getDb().prepare(`UPDATE admin_zamanlayici SET son_calisma=? WHERE mod=?`).run(new Date().toISOString(), mod);
}

export interface AdminKullaniciRow { id: number; isim: string; olusturma: string; son_kullanim: string | null; sona_erme: string | null }
export function adminKullaniciEkle(isim: string, token: string, gecerlilikGun?: number): AdminKullaniciRow {
  const olusturma = new Date().toISOString();
  const sonaErme = gecerlilikGun && gecerlilikGun > 0
    ? new Date(Date.now() + gecerlilikGun * 86_400_000).toISOString() : null;
  const r = getDb().prepare(
    `INSERT INTO admin_kullanici (isim, token, olusturma, sona_erme) VALUES (?, ?, ?, ?)`,
  ).run(isim, hashToken(token), olusturma, sonaErme);
  return { id: Number(r.lastInsertRowid), isim, olusturma, son_kullanim: null, sona_erme: sonaErme };
}
export function adminKullaniciListele(): AdminKullaniciRow[] {
  return getDb().prepare(
    `SELECT id, isim, olusturma, son_kullanim, sona_erme FROM admin_kullanici ORDER BY olusturma`,
  ).all() as unknown as AdminKullaniciRow[];
}
export function adminKullaniciSil(id: number): void {
  getDb().prepare(`DELETE FROM admin_kullanici WHERE id=?`).run(id);
}
export function adminKullaniciTokenDogrula(token: string): { id: number; isim: string } | null {
  const db = getDb();
  const r = db.prepare(
    `SELECT id, isim, sona_erme FROM admin_kullanici WHERE token=?`,
  ).get(hashToken(token)) as { id: number; isim: string; sona_erme: string | null } | undefined;
  if (!r) return null;
  if (r.sona_erme && Date.parse(r.sona_erme) <= Date.now()) return null;
  db.prepare(`UPDATE admin_kullanici SET son_kullanim=? WHERE id=?`).run(new Date().toISOString(), r.id);
  return { id: r.id, isim: r.isim };
}

export interface DuyuruIncelemeRow { gazete_id: number; kanun_no: string; bayrak: string; not_metni: string | null; isaretleyen: string; tarih: string }
export function duyuruBayrakla(gazeteId: number, kanunNo: string, bayrak: string, notMetni: string | null, isaretleyen: string): void {
  getDb().prepare(
    `INSERT INTO duyuru_inceleme (gazete_id, kanun_no, bayrak, not_metni, isaretleyen, tarih) VALUES (?,?,?,?,?,?)
       ON CONFLICT(gazete_id, kanun_no) DO UPDATE SET bayrak=excluded.bayrak, not_metni=excluded.not_metni, isaretleyen=excluded.isaretleyen, tarih=excluded.tarih`,
  ).run(gazeteId, kanunNo, bayrak, notMetni, isaretleyen, new Date().toISOString());
}
export function duyuruBayrakKaldir(gazeteId: number, kanunNo: string): void {
  getDb().prepare(`DELETE FROM duyuru_inceleme WHERE gazete_id=? AND kanun_no=?`).run(gazeteId, kanunNo);
}
export function duyuruSonNKayit(limit: number): (DuyuruIncelemeRow & { baslik: string; tur: string | null; tarih_rg: string | null; url: string | null })[] {
  return getDb().prepare(
    `SELECT d.gazete_id, d.kanun_no, d.baslik, d.tur, d.tarih AS tarih_rg, d.url,
            di.bayrak, di.not_metni, di.isaretleyen, di.tarih
       FROM duyuru d LEFT JOIN duyuru_inceleme di ON di.gazete_id=d.gazete_id AND di.kanun_no=d.kanun_no
      ORDER BY d.gazete_id DESC LIMIT ?`,
  ).all(limit) as unknown as (DuyuruIncelemeRow & { baslik: string; tur: string | null; tarih_rg: string | null; url: string | null })[];
}

export interface GazeteKayit {
  url: string;
  tarih: string | null;
  ay: string | null;
  tur: string;
  baslik: string;
  kategori: string;
  sayi: string;
  kategori_versiyon?: number | null;
  mukerrer?: string;
}
export function upsertGazete(rec: GazeteKayit): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO gazete (url,tarih,ay,tur,baslik,kategori,sayi,mukerrer,guncelleme,kategori_versiyon)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(tarih, baslik) DO UPDATE SET
       url=excluded.url, ay=excluded.ay, tur=excluded.tur,
       kategori=excluded.kategori, sayi=excluded.sayi,
       -- Mükerrer işareti kısmi gelebilir → COALESCE ile korunur (INV-11 deseni).
       mukerrer=COALESCE(excluded.mukerrer, gazete.mukerrer),
       guncelleme=excluded.guncelleme, kategori_versiyon=excluded.kategori_versiyon`,
  ).run(rec.url, rec.tarih, rec.ay, rec.tur, rec.baslik, rec.kategori, rec.sayi,
        rec.mukerrer || null, now, rec.kategori_versiyon ?? null);
}

export interface AymKayit {
  aym_id: string;
  esas_no: string;
  karar_no: string;
  karar_tarihi: string | null;
  ay: string | null;
  rg_tarihi: string | null;
  rg_sayisi: string;
  basvuru_turu: string;
  sonuc: string;
  sonuc_kod: string;
  konu: string;
  kategori: string;
  url: string;
  kategori_versiyon?: number | null;
}
export function upsertAym(rec: AymKayit): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO aym_karar (aym_id,esas_no,karar_no,karar_tarihi,ay,rg_tarihi,rg_sayisi,basvuru_turu,sonuc,sonuc_kod,konu,kategori,url,guncelleme,kategori_versiyon)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(esas_no, karar_no) DO UPDATE SET
       aym_id=excluded.aym_id, karar_tarihi=excluded.karar_tarihi, ay=excluded.ay,
       rg_tarihi=excluded.rg_tarihi, rg_sayisi=excluded.rg_sayisi, basvuru_turu=excluded.basvuru_turu,
       sonuc=excluded.sonuc, sonuc_kod=excluded.sonuc_kod, konu=excluded.konu,
       kategori=excluded.kategori, url=excluded.url, guncelleme=excluded.guncelleme, kategori_versiyon=excluded.kategori_versiyon`,
  ).run(rec.aym_id, rec.esas_no, rec.karar_no, rec.karar_tarihi, rec.ay, rec.rg_tarihi, rec.rg_sayisi, rec.basvuru_turu, rec.sonuc, rec.sonuc_kod, rec.konu, rec.kategori, rec.url, now, rec.kategori_versiyon ?? null);
}

export interface TuikKayit { gosterge: string; tarih: string; deger: number; }
export function upsertTuik(rec: TuikKayit): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO tuik (gosterge,tarih,deger,guncelleme) VALUES (?,?,?,?)
     ON CONFLICT(gosterge,tarih) DO UPDATE SET deger=excluded.deger, guncelleme=excluded.guncelleme`,
  ).run(rec.gosterge, rec.tarih, rec.deger, new Date().toISOString());
}

export interface SecimSonucuKayit {
  donem: number; secim_id: number; tarih: string; secim_adi: string | null; parti: string; oy: number;
  gecerli_oy_toplami: number | null; gecersiz_oy_toplami: number | null;
  secmen_sayisi: number | null; katilma_orani: number | null;
}
export function upsertSecimSonucu(rec: SecimSonucuKayit): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO secim_sonucu
       (donem,secim_id,tarih,secim_adi,parti,oy,gecerli_oy_toplami,gecersiz_oy_toplami,secmen_sayisi,katilma_orani,guncelleme)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(donem, parti) DO UPDATE SET
       secim_id=excluded.secim_id, tarih=excluded.tarih, secim_adi=excluded.secim_adi, oy=excluded.oy,
       gecerli_oy_toplami=excluded.gecerli_oy_toplami, gecersiz_oy_toplami=excluded.gecersiz_oy_toplami,
       secmen_sayisi=excluded.secmen_sayisi, katilma_orani=excluded.katilma_orani, guncelleme=excluded.guncelleme`,
  ).run(rec.donem, rec.secim_id, rec.tarih, rec.secim_adi, rec.parti, rec.oy, rec.gecerli_oy_toplami,
        rec.gecersiz_oy_toplami, rec.secmen_sayisi, rec.katilma_orani, new Date().toISOString());
}

export function updateSecimSandalye(donem: number, parti: string, sandalye: number): boolean {
  const db = getDb();
  const r = db.prepare(
    'UPDATE secim_sonucu SET sandalye = ?, guncelleme = ? WHERE donem = ? AND parti = ?',
  ).run(sandalye, new Date().toISOString(), donem, parti);
  return r.changes > 0;
}

export interface PartiProgramKayit {
  parti: string; belge_adi: string; belge_turu: 'secim_beyannamesi' | 'parti_programi';
  tarih: string | null; kaynak_url: string; metin: string;
}
export function upsertPartiProgram(rec: PartiProgramKayit): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO parti_program (parti,belge_adi,belge_turu,tarih,kaynak_url,metin,guncelleme)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(parti, belge_turu) DO UPDATE SET
       belge_adi=excluded.belge_adi, tarih=excluded.tarih, kaynak_url=excluded.kaynak_url,
       metin=excluded.metin, guncelleme=excluded.guncelleme`,
  ).run(rec.parti, rec.belge_adi, rec.belge_turu, rec.tarih, rec.kaynak_url, rec.metin, new Date().toISOString());
}

export interface YerelKararKayit {
  belediye: string; karar_no: string | null; tarih: string; konu: string | null;
  metin: string; oylama_sonucu: 'oybirlik' | 'oycoklugu' | null; kaynak_url: string;
}
export function upsertYerelKarar(rec: YerelKararKayit): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO yerel_karar (belediye,karar_no,tarih,konu,metin,oylama_sonucu,kaynak_url,guncelleme)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(belediye, karar_no, tarih) DO UPDATE SET
       konu=excluded.konu, metin=excluded.metin, oylama_sonucu=excluded.oylama_sonucu,
       kaynak_url=excluded.kaynak_url, guncelleme=excluded.guncelleme`,
  ).run(rec.belediye, rec.karar_no ?? '', rec.tarih, rec.konu, rec.metin, rec.oylama_sonucu, rec.kaynak_url, new Date().toISOString());
  const { id } = db.prepare('SELECT id FROM yerel_karar WHERE belediye=? AND karar_no=? AND tarih=?')
    .get(rec.belediye, rec.karar_no ?? '', rec.tarih) as { id: number };
  db.prepare('DELETE FROM yerel_karar_fts WHERE rowid = ?').run(id);
  db.prepare('INSERT INTO yerel_karar_fts (rowid, metin_norm) VALUES (?, ?)').run(id, trLower(rec.metin));
}

export interface YerelMeclisUyeKayit {
  belediye: string; ad_soyad: string; parti: string; ilce: string | null;
}
export function upsertYerelMeclisUye(rec: YerelMeclisUyeKayit): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO yerel_meclis_uye (belediye,ad_soyad,parti,ilce,guncelleme)
     VALUES (?,?,?,?,?)
     ON CONFLICT(belediye, ad_soyad) DO UPDATE SET
       parti=excluded.parti, ilce=excluded.ilce, guncelleme=excluded.guncelleme`,
  ).run(rec.belediye, rec.ad_soyad, rec.parti, rec.ilce, new Date().toISOString());
}

export interface OylamaKayit {
  birlesim_id: string; sira_sayisi: string | null; tarih: string | null; konu: string | null;
  kullanilan: number; kabul: number; ret: number; cekimser: number; mukerrer: number; sonuc: string | null;
}
export function upsertOylama(rec: OylamaKayit): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO oylama (birlesim_id,sira_sayisi,tarih,konu,kullanilan,kabul,ret,cekimser,mukerrer,sonuc,guncelleme)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(birlesim_id, sira_sayisi, kullanilan) DO UPDATE SET
       tarih=excluded.tarih, konu=excluded.konu, kabul=excluded.kabul, ret=excluded.ret,
       cekimser=excluded.cekimser, mukerrer=excluded.mukerrer, sonuc=excluded.sonuc, guncelleme=excluded.guncelleme`,
  ).run(rec.birlesim_id, rec.sira_sayisi ?? '', rec.tarih, rec.konu, rec.kullanilan, rec.kabul, rec.ret,
        rec.cekimser, rec.mukerrer, rec.sonuc, new Date().toISOString());
}

export interface OyKayit {
  birlesim_id: string; sira_sayisi: string; il: string; soyad: string; ad: string;
  parti: string; oy: string; tarih: string | null;
}
export function upsertOyToplu(kayitlar: OyKayit[]): number {
  if (!kayitlar.length) return 0;
  const db = getDb();
  const st = db.prepare(
    `INSERT INTO oy (birlesim_id,sira_sayisi,il,soyad,ad,parti,oy,tarih,guncelleme)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(birlesim_id,sira_sayisi,il,soyad,ad) DO UPDATE SET
       parti=excluded.parti, oy=excluded.oy, tarih=excluded.tarih, guncelleme=excluded.guncelleme`,
  );
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    for (const k of kayitlar) st.run(k.birlesim_id, k.sira_sayisi, k.il, k.soyad, k.ad, k.parti, k.oy, k.tarih, now);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return kayitlar.length;
}

export interface ImzaRow { ad_soyad: string; parti: string; ilk_imza: number; parti_kaynak: string; }

export function hasImza(faaliyetId: number): boolean {
  return getDb().prepare('SELECT 1 FROM imza WHERE faaliyet_id = ? LIMIT 1').get(faaliyetId) !== undefined;
}

export function imzaKokeniBiliniyorMu(faaliyetId: number): boolean {
  return getDb()
    .prepare("SELECT 1 FROM imza WHERE faaliyet_id = ? AND parti_kaynak <> 'bilinmiyor' LIMIT 1")
    .get(faaliyetId) !== undefined;
}

export function replaceImzalar(faaliyetId: number, rows: ImzaRow[]): void {
  const db = getDb();
  db.prepare('DELETE FROM imza WHERE faaliyet_id = ?').run(faaliyetId);
  const ins = db.prepare(
    'INSERT OR IGNORE INTO imza (faaliyet_id, ad_soyad, parti, ilk_imza, parti_kaynak) VALUES (?,?,?,?,?)',
  );
  for (const r of rows) ins.run(faaliyetId, r.ad_soyad, r.parti, r.ilk_imza, r.parti_kaynak);
}

export function markEtl(kaynak: string, donem: number, kayitSayisi: number, durum: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO etl_durum (kaynak,donem,son_calisma,kayit_sayisi,durum)
     VALUES (?,?,?,?,?)
     ON CONFLICT(kaynak,donem) DO UPDATE SET
       son_calisma=excluded.son_calisma, kayit_sayisi=excluded.kayit_sayisi, durum=excluded.durum`,
  ).run(kaynak, donem, new Date().toISOString(), kayitSayisi, durum);
}

export interface EtlDurumRow {
  kaynak: string;
  donem: number;
  son_calisma: string | null;
  kayit_sayisi: number | null;
  durum: string | null;
}

export function getEtlDurum(): EtlDurumRow[] {
  return getDb().prepare('SELECT * FROM etl_durum ORDER BY kaynak, donem').all() as unknown as EtlDurumRow[];
}

export function isDonemDone(kaynak: string, donem: number): boolean {
  const row = getDb()
    .prepare("SELECT durum FROM etl_durum WHERE kaynak=? AND donem=? AND durum='ok'")
    .get(kaynak, donem) as { durum: string } | undefined;
  return row !== undefined;
}

export function imzaIlkParti(faaliyetId: number): string | null {
  const r = getDb()
    .prepare("SELECT parti FROM imza WHERE faaliyet_id = ? AND ilk_imza = 1 LIMIT 1")
    .get(faaliyetId) as { parti: string } | undefined;
  return r?.parti ?? null;
}

function ensureVekilPartiDonem(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS vekil_parti_donem (
    ad_soyad TEXT NOT NULL,
    donem INTEGER NOT NULL,
    parti TEXT NOT NULL,
    ilk_gorulme TEXT NOT NULL,
    son_gorulme TEXT NOT NULL,
    kanit_n INTEGER NOT NULL,
    PRIMARY KEY (ad_soyad, donem, parti)
  );`);
}

export function rebuildVekilPartiDonem(): number {
  const db = getDb();
  ensureVekilPartiDonem(db);
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec('DELETE FROM vekil_parti_donem;');
    db.exec(`INSERT INTO vekil_parti_donem (ad_soyad, donem, parti, ilk_gorulme, son_gorulme, kanit_n)
      SELECT i.ad_soyad, f.donem, i.parti, MIN(f.tarih), MAX(f.tarih), COUNT(*)
        FROM imza i
        JOIN faaliyet f ON f.id = i.faaliyet_id
        JOIN (
          SELECT i2.ad_soyad AS ad, f2.donem AS dn
            FROM imza i2 JOIN faaliyet f2 ON f2.id = i2.faaliyet_id
           WHERE f2.kaynak='kanun' AND i2.parti_kaynak='tbmm'
           GROUP BY i2.ad_soyad, f2.donem
          HAVING COUNT(DISTINCT i2.parti) > 1
        ) sw ON sw.ad = i.ad_soyad AND sw.dn = f.donem
       WHERE f.kaynak='kanun' AND f.tarih IS NOT NULL AND i.parti_kaynak='tbmm'
       GROUP BY i.ad_soyad, f.donem, i.parti;`);
    db.exec('COMMIT;');
  } catch (e) {
    db.exec('ROLLBACK;');
    throw e;
  }
  timelineCache = null;
  const n = (db.prepare('SELECT COUNT(*) c FROM vekil_parti_donem').get() as { c: number }).c;
  return n;
}

let timelineCache: Map<string, { parti: string; ilk: string; son: string }[]> | null = null;
function timelineYukle(): Map<string, { parti: string; ilk: string; son: string }[]> {
  if (timelineCache) return timelineCache;
  const m = new Map<string, { parti: string; ilk: string; son: string }[]>();
  const db = getDb();
  ensureVekilPartiDonem(db);
  const rows = db.prepare('SELECT ad_soyad, donem, parti, ilk_gorulme, son_gorulme FROM vekil_parti_donem')
    .all() as { ad_soyad: string; donem: number; parti: string; ilk_gorulme: string; son_gorulme: string }[];
  for (const r of rows) {
    const key = cleanStr(r.ad_soyad) + '|' + String(r.donem);
    if (!m.has(key)) m.set(key, []);
    m.get(key)!.push({ parti: r.parti, ilk: r.ilk_gorulme, son: r.son_gorulme });
  }
  timelineCache = m;
  return m;
}

export function vekilPartiTarihte(adSoyad: string, donem: number | string, tarih: string | null): string | null {
  const araliklar = timelineYukle().get(cleanStr(adSoyad) + '|' + String(donem));
  if (!araliklar) return null;
  return araliktaParti(araliklar, tarih);
}

let partiIlkCache: Map<string, string | null> | null = null;
export function partiIlkOtantikTarih(parti: string): string | null {
  if (!partiIlkCache) {
    const db = getDb();
    const ham = new Map<string, string>();
    const koy = (p: string, t: string | null): void => {
      if (!p || !t) return;
      const v = ham.get(p);
      if (!v || t < v) ham.set(p, t);
    };
    for (const r of db.prepare(
      `SELECT i.parti p, MIN(f.tarih) t FROM imza i JOIN faaliyet f ON f.id = i.faaliyet_id
        WHERE i.parti_kaynak='tbmm' AND f.tarih IS NOT NULL GROUP BY 1`,
    ).all() as { p: string; t: string }[]) koy(r.p, r.t);
    for (const r of db.prepare(
      'SELECT parti p, MIN(tarih) t FROM oy WHERE tarih IS NOT NULL GROUP BY 1',
    ).all() as { p: string; t: string }[]) koy(r.p, r.t);

    const pencereBaslangici = [...ham.values()].sort()[0] ?? null;
    const m = new Map<string, string | null>();
    if (pencereBaslangici) {
      const oncedenVarMi = db.prepare(
        'SELECT COUNT(*) c FROM faaliyet_parti fp JOIN faaliyet f ON f.id = fp.faaliyet_id WHERE fp.parti = ? AND f.tarih < ?',
      );
      for (const [p, t] of ham) {
        const varOlmus = (oncedenVarMi.get(p, pencereBaslangici) as { c: number }).c > 0;
        m.set(p, varOlmus ? null : t);
      }
    }
    partiIlkCache = m;
  }
  return partiIlkCache.get(parti) ?? null;
}

let otantikGozlemCache: Map<string, { t: string; p: string }[]> | null = null;
function otantikGozlemler(): Map<string, { t: string; p: string }[]> {
  if (otantikGozlemCache) return otantikGozlemCache;
  const db = getDb();
  const m = new Map<string, { t: string; p: string }[]>();
  const ekle = (ad: string, t: string | null, p: string | null): void => {
    if (!ad || !t || !p) return;
    const k = cleanStr(ad);
    if (!k) return;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push({ t, p });
  };
  for (const r of db.prepare('SELECT ad, soyad, tarih, parti FROM oy WHERE tarih IS NOT NULL')
    .all() as { ad: string; soyad: string; tarih: string; parti: string }[]) ekle(`${r.ad} ${r.soyad}`, r.tarih, r.parti);
  for (const r of db.prepare(
    `SELECT i.ad_soyad ad, f.tarih t, i.parti p FROM imza i JOIN faaliyet f ON f.id = i.faaliyet_id
      WHERE i.parti_kaynak='tbmm' AND f.tarih IS NOT NULL`,
  ).all() as { ad: string; t: string; p: string }[]) ekle(r.ad, r.t, r.p);
  for (const v of m.values()) v.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  otantikGozlemCache = m;
  return m;
}

export function vekilOtantikPartiTarihte(adSoyad: string | undefined | null, tarih: string | null): string | null {
  if (!adSoyad || !tarih) return null;
  const v = otantikGozlemler().get(cleanStr(adSoyad));
  if (!v?.length) return null;
  let son: string | null = null;
  for (const g of v) {
    if (g.t <= tarih) son = g.p;
    else break;
  }
  return son ?? v[0].p;
}

export function anakronizmSuz(parti: string, adSoyad: string | undefined | null, tarih: string | null): string {
  if (!parti || !tarih) return parti;
  const dogus = partiIlkOtantikTarih(parti);
  if (!dogus || tarih >= dogus) return parti;
  const alt = vekilOtantikPartiTarihte(adSoyad, tarih);
  if (!alt || alt === parti || alt === 'Bilinmiyor') return parti;
  return alt;
}

export function anakronizmOnbellegiDusur(): void {
  partiIlkCache = null;
  otantikGozlemCache = null;
}

export function onergeAtfet(
  vekilOzet: string | undefined | null,
  donem: number | string,
  tarih: string | null,
  fallbackParties?: string[],
): string {
  const ia = ilAdAyir(vekilOzet);
  const ad = ia?.ad ?? vekilOzet ?? null;
  if (ia && tarih) {
    const tp = vekilPartiTarihte(ia.ad, donem, tarih);
    if (tp) return tp;
  }
  if (ia) {
    const ip = resolveByNameIl(ia.ad, ia.il, donem);
    if (ip && ip !== 'Bilinmiyor') return anakronizmSuz(ip, ad, tarih);
  }
  return anakronizmSuz(resolveParty(vekilOzet, donem, fallbackParties), ad, tarih);
}

export interface PartiDagilimSatir {
  kaynak: string;
  donem: number;
  parti: string;
  n: number;
}

export function partiDagilimiOku(): PartiDagilimSatir[] {
  return getDb()
    .prepare(
      `SELECT f.kaynak, f.donem, fp.parti, COUNT(*) AS n
         FROM faaliyet_parti fp JOIN faaliyet f ON f.id = fp.faaliyet_id
        GROUP BY f.kaynak, f.donem, fp.parti
        ORDER BY f.kaynak, f.donem, n DESC`,
    )
    .all() as unknown as PartiDagilimSatir[];
}

export function partiDagilimiSnapshot(notMetni: string): string {
  const db = getDb();
  const damga = new Date().toISOString();
  const ekle = db.prepare(
    'INSERT OR REPLACE INTO parti_dagilim_gecmis (olcum_zamani,kaynak,donem,parti,n,not_metni) VALUES (?,?,?,?,?,?)',
  );
  db.exec('BEGIN IMMEDIATE;');
  try {
    for (const r of partiDagilimiOku()) ekle.run(damga, r.kaynak, r.donem, r.parti, r.n, notMetni);
    db.exec('COMMIT;');
  } catch (e) {
    db.exec('ROLLBACK;');
    throw e;
  }
  return damga;
}

export interface DagilimDiff {
  kaynak: string;
  donem: number;
  parti: string;
  onceki: number;
  simdiki: number;
  deltaN: number;
  oncekiPay: number;
  simdikiPay: number;
  deltaPay: number;
}

export function dagilimDiff(oncekiDamga: string, simdikiDamga: string): DagilimDiff[] {
  const db = getDb();
  const oku = (d: string): PartiDagilimSatir[] =>
    db
      .prepare('SELECT kaynak,donem,parti,n FROM parti_dagilim_gecmis WHERE olcum_zamani=?')
      .all(d) as unknown as PartiDagilimSatir[];

  const anahtar = (r: { kaynak: string; donem: number; parti: string }): string =>
    `${r.kaynak}|${r.donem}|${r.parti}`;
  const toplamla = (rows: PartiDagilimSatir[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(`${r.kaynak}|${r.donem}`, (m.get(`${r.kaynak}|${r.donem}`) ?? 0) + r.n);
    return m;
  };

  const a = oku(oncekiDamga), b = oku(simdikiDamga);
  const aMap = new Map(a.map((r) => [anahtar(r), r]));
  const bMap = new Map(b.map((r) => [anahtar(r), r]));
  const aTop = toplamla(a), bTop = toplamla(b);

  const out: DagilimDiff[] = [];
  for (const k of new Set([...aMap.keys(), ...bMap.keys()])) {
    const ar = aMap.get(k), br = bMap.get(k);
    const ref = (ar ?? br)!;
    const grup = `${ref.kaynak}|${ref.donem}`;
    const onceki = ar?.n ?? 0, simdiki = br?.n ?? 0;
    const oncekiPay = (aTop.get(grup) ?? 0) > 0 ? (100 * onceki) / aTop.get(grup)! : 0;
    const simdikiPay = (bTop.get(grup) ?? 0) > 0 ? (100 * simdiki) / bTop.get(grup)! : 0;
    if (onceki === simdiki) continue;
    out.push({
      kaynak: ref.kaynak, donem: ref.donem, parti: ref.parti,
      onceki, simdiki, deltaN: simdiki - onceki,
      oncekiPay, simdikiPay, deltaPay: simdikiPay - oncekiPay,
    });
  }
  return out.sort((x, y) => Math.abs(y.deltaPay) - Math.abs(x.deltaPay));
}
