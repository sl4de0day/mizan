import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { komisyonNorm, komisyonRol } from '../src/lib/db.js';

const KOK = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(join(KOK, 'storage', 'analytics.db'), { readOnly: true });

const kodSatirlari = (src: string): string =>
  src.replace(/^\s*\/\*[\s\S]*?\*\//gm, ' ').split('\n')
    .filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\/\/.*$/, '')).join('\n');

function semadaVar(tablo: string): boolean {
  return new RegExp(`CREATE TABLE IF NOT EXISTS ${tablo}\\b`).test(readFileSync(join(KOK, 'src', 'lib', 'db.ts'), 'utf8'));
}

test('KR1: ayrıştırılan alanların HEPSİ bir tabloya yazılıyor', () => {
  const eksik: string[] = [];
  for (const [tablo, ne] of [
    ['onerge_cevap', 'motion.cevaplar[] — hangi bakanlık kaç günde cevapladı'],
    ['teklif_komisyon', 'law.komisyon_bilgileri[] — teklif komisyonda kaç gün bekledi'],
    ['aym_parti_karar', 'constitutional.searchParty() — parti kapatma/mali denetim'],
  ] as const) {
    if (!semadaVar(tablo)) eksik.push(`${tablo} (${ne})`);
  }
  assert.deepEqual(eksik, [], `Kurtarılan veri için tablo YOK:\n  ${eksik.join('\n  ')}`);
});

test('KR2: yazıcılar ETL/scraper hattına BAĞLI (tablo var ama dolmuyorsa faydası yok)', () => {
  const etl = kodSatirlari(readFileSync(join(KOK, 'src', 'tools', 'etl.ts'), 'utf8'));
  const imza = kodSatirlari(readFileSync(join(KOK, 'src', 'tools', 'imzaScraper.ts'), 'utf8'));
  assert.match(etl, /replaceOnergeCevap\s*\(/, 'cevap yazıcısı ETL\'de çağrılmıyor');
  assert.match(imza, /replaceTeklifKomisyon\s*\(/, 'komisyon yazıcısı imzaScraper\'da çağrılmıyor');
  assert.match(etl, /ingestAymParti|upsertAymParti/, 'AYM parti kararları ETL\'e bağlanmamış');
});

test('KR3: motor alanları hâlâ ayrıştırılıyor (kaynak tarafı kopmamış)', () => {
  const motion = kodSatirlari(readFileSync(join(KOK, 'src', 'engines', 'motion.ts'), 'utf8'));
  const law = kodSatirlari(readFileSync(join(KOK, 'src', 'engines', 'law.ts'), 'utf8'));
  const gaz = kodSatirlari(readFileSync(join(KOK, 'src', 'engines', 'gazette.ts'), 'utf8'));
  assert.match(motion, /cevaplar/, 'motion.ts cevap tablosunu ayrıştırmıyor');
  assert.match(motion, /cevaplar,/, 'cevaplar MotionResult\'a taşınmıyor — yol yine kopmuş');
  assert.match(law, /komisyon_bilgileri/, 'law.ts komisyon tablosunu ayrıştırmıyor');
  assert.match(gaz, /mukerrer/, 'gazette.ts mükerrer alanını ayrıştırmıyor');
});

test('KR4: KISMİ gelen alanlar BOŞ LİSTEYLE SİLİNMİYOR', () => {
  const dbSrc = readFileSync(join(KOK, 'src', 'lib', 'db.ts'), 'utf8');
  for (const fn of ['replaceOnergeCevap', 'replaceTeklifKomisyon']) {
    const govde = dbSrc.slice(dbSrc.indexOf(`export function ${fn}`), dbSrc.indexOf(`export function ${fn}`) + 1400);
    assert.ok(govde.length > 100, `${fn} bulunamadı`);
    assert.match(govde, /if\s*\(!\w+\.length\)\s*return/,
      `${fn}: boş liste erken dönmüyor — detayı çekilmeyen koşuda mevcut kayıtları SİLER`);
    assert.doesNotMatch(govde, /DELETE\s+FROM/i,
      `${fn}: DELETE kullanıyor — kısmi veride bu, sessiz veri kaybıdır`);
  }
  const gz = dbSrc.slice(dbSrc.indexOf('export function upsertGazete'), dbSrc.indexOf('export function upsertGazete') + 1200);
  assert.match(gz, /mukerrer=COALESCE\(/, 'mukerrer düz atamayla güncelleniyor — kısmi veriyi ezer');
});

test('KR5: kurtarılan tablolar ŞEMADA ama boşsa NEDEN boş olduğu bilinebilir', () => {
  const varMi = (t: string): boolean =>
    !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
  for (const t of ['onerge_cevap', 'teklif_komisyon', 'aym_parti_karar']) {
    if (!varMi(t)) continue;
    const n = (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
    assert.ok(Number.isInteger(n), `${t} sayılamıyor`);
  }
});

test('KR6: iş listesi kapısı, SONRADAN eklenen alanı da sorar', () => {
  const src = kodSatirlari(readFileSync(join(KOK, 'src', 'tools', 'imzaScraper.ts'), 'utf8'));
  assert.match(src, /imzaKokeniBiliniyorMu\(b\.id\)\s*&&\s*detayCekildiMi\(b\.id\)/,
    'atlama kapısı yalnız imzaya bakıyor — komisyonu olmayan belgeler asla çekilmez');
  const govde = src.slice(src.indexOf('const ayristirilabildi'), src.indexOf('if (!sahipler.length)'));
  assert.match(govde, /if\s*\(ayristirilabildi\)/,
    'damga ayrıştırma başarısına bağlı değil — WAF engellenen belgeler "çekildi" sayılıp kalıcı kaybolur');
  assert.match(govde, /detayCekimIsaretle\(/, 'damga hiç basılmıyor — kapı kalıcı olarak açık kalır');
});

test('KR7: komisyon adı normalizasyonu ÇOK KELİMELİ rol ekini atar', () => {
  assert.equal(komisyonNorm('Adalet Komisyonu Katip Üyesi'), 'ADALET KOMİSYONU');
  assert.equal(komisyonNorm('Plan Ve Bütçe Komisyonu Üyesi'), 'PLAN VE BÜTÇE KOMİSYONU');
  assert.equal(komisyonNorm('Anayasa Komisyonu Başkanı'), 'ANAYASA KOMİSYONU');
  assert.equal(komisyonNorm('NATO Parlamenter Asamblesi Başkan Vekili'), 'NATO PARLAMENTER ASAMBLESİ');
  assert.equal(komisyonRol('Adalet Komisyonu Katip Üyesi'), 'Katip Üyesi');
});

test('KR8: Türkçe locale ile büyütülür — ASCII upper komisyonu böler', () => {
  assert.equal(komisyonNorm('İçişleri Komisyonu Üyesi'), 'İÇİŞLERİ KOMİSYONU');
  assert.notEqual('İçişleri Komisyonu'.toUpperCase(), 'İÇİŞLERİ KOMİSYONU');
});

test('KR9: iki tablo GERÇEKTEN eşleşiyor — teklif gören komisyonun üyesi var', () => {
  const db2 = new DatabaseSync(join(KOK, 'storage', 'analytics.db'), { readOnly: true });
  const varMi = (t: string): boolean =>
    !!db2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
  if (!varMi('vekil_komisyon') || !varMi('teklif_komisyon')) return;
  const n = (db2.prepare('SELECT COUNT(*) c FROM vekil_komisyon').get() as { c: number }).c;
  if (!n) return;
  const eslesen = (db2.prepare(
    `SELECT COUNT(DISTINCT tk.ad) c FROM teklif_komisyon tk
      WHERE EXISTS (SELECT 1 FROM vekil_komisyon vk WHERE vk.komisyon_norm = tk.ad)`,
  ).get() as { c: number }).c;
  assert.ok(eslesen >= 5,
    `teklif_komisyon ↔ vekil_komisyon eşleşmesi çökmüş: yalnız ${eslesen} komisyon eşleşiyor (normalizasyon bozulmuş olabilir)`);
});
