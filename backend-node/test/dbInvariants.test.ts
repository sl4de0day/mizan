import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cleanStr, normParti, PARTI_DISI, PARTI_MAP } from '../src/lib/partyResolve.js';
import { rosterSagligi, DEPUTY_MASTER_LIST } from '../src/lib/deputies.js';

const DB_YOL = join(dirname(fileURLToPath(import.meta.url)), '..', 'storage', 'analytics.db');
const db = new DatabaseSync(DB_YOL, { readOnly: true });

const partiEtiketleri = (): string[] =>
  (db.prepare('SELECT DISTINCT parti FROM faaliyet_parti').all() as { parti: string }[]).map((r) => r.parti);

test('INV-1: hiçbir parti etiketi bir sentinel etiketine katlanmıyor', () => {
  const sentinelKatlanmis = new Map<string, string>();
  for (const s of PARTI_DISI) sentinelKatlanmis.set(cleanStr(s), s);

  const kacaklar = partiEtiketleri().filter(
    (p) => !PARTI_DISI.has(p) && sentinelKatlanmis.has(cleanStr(p)),
  );
  assert.deepEqual(
    kacaklar, [],
    `Sentinel'e katlanan etiket(ler) PARTI_DISI_SQL'i deliyor: ${kacaklar.map((k) => `'${k}' → '${sentinelKatlanmis.get(cleanStr(k))}'`).join(', ')}`,
  );
});

test('INV-2: hiçbir iki parti etiketi yalnız TR harf katlamasıyla ayrışmıyor', () => {
  const gruplar = new Map<string, string[]>();
  for (const p of partiEtiketleri()) {
    const k = cleanStr(p);
    gruplar.set(k, [...(gruplar.get(k) ?? []), p]);
  }
  const cakisan = [...gruplar.entries()].filter(([, v]) => v.length > 1);
  assert.deepEqual(
    cakisan, [],
    `Aynı şeye katlanan etiketler (payları böler): ${cakisan.map(([k, v]) => `${k}: ${v.join(' / ')}`).join(' | ')}`,
  );
});

test('INV-4: yayımlanan (durum=ok) her dönemin roster kapsaması sağlıklı', () => {
  const okDonemler = (db.prepare(
    "SELECT DISTINCT donem FROM etl_durum WHERE durum='ok'",
  ).all() as { donem: number }[]).map((r) => r.donem);

  const bozuk = okDonemler
    .map((d) => rosterSagligi(d))
    .filter((r) => !r.saglikli)
    .map((r) => `d${r.donem} (${r.toplam} vekil${r.elliKesik.length ? `, tam-50 kesik: ${r.elliKesik.join('/')}` : ''})`);

  assert.deepEqual(
    bozuk, [],
    `Bu dönemler 'ok' işaretli ama roster'ları kesik — parti istatistikleri YÖNLÜ olarak yanlış: ${bozuk.join(' · ')}`,
  );
});

test('INV-6: imza-kapsamlı dönemlerde her parti imza tablosunda görünüyor', () => {
  const imzaliDonemler = (db.prepare(
    "SELECT DISTINCT f.donem d FROM imza i JOIN faaliyet f ON f.id = i.faaliyet_id",
  ).all() as { d: number }[]).map((r) => r.d);
  assert.ok(imzaliDonemler.length > 0, 'imza tablosu boş — test anlamsız');

  const yerTutucu = imzaliDonemler.map(() => '?').join(',');
  const eksik = (db.prepare(
    `SELECT DISTINCT fp.parti FROM faaliyet_parti fp
       JOIN faaliyet f ON f.id = fp.faaliyet_id
      WHERE f.kaynak = 'kanun' AND f.donem IN (${yerTutucu})
        AND fp.parti NOT IN (SELECT DISTINCT parti FROM imza)`,
  ).all(...imzaliDonemler) as { parti: string }[])
    .map((r) => r.parti)
    .filter((p) => !PARTI_DISI.has(p));

  assert.deepEqual(
    eksik, [],
    `Bu partiler kanun belgesine sahip ama imza'da HİÇ satırı yok — imkânsız, ` +
    `imzaScraper allowlist'inden düştüklerini ve satırlarının imzacının BUGÜNKÜ partisine ` +
    `yazıldığını gösterir: ${eksik.join(' · ')}`,
  );
});

test('INV-7: hiçbir roster partisi imza\'da SİSTEMATİK olarak başka etikete düşmüyor (register bölünmesi)', () => {
  const imzalar = db.prepare(
    `SELECT i.ad_soyad, i.parti, f.donem FROM imza i JOIN faaliyet f ON f.id = i.faaliyet_id`,
  ).all() as { ad_soyad: string; parti: string; donem: number }[];
  assert.ok(imzalar.length > 0, 'imza tablosu boş — test anlamsız');

  const rosterIdx = new Map<string, string>();
  for (const d of DEPUTY_MASTER_LIST) rosterIdx.set(`${cleanStr(d.ad_soyad)}|${d.donem}`, normParti(d.parti));

  const tumEtiketEvreni = new Set(imzalar.map((i) => i.parti));

  const partiVekilEtiket = new Map<string, Map<string, Set<string>>>();
  for (const i of imzalar) {
    if (PARTI_DISI.has(i.parti)) continue;
    const rp = rosterIdx.get(`${cleanStr(i.ad_soyad)}|${i.donem}`);
    if (!rp) continue;
    const vekiller = partiVekilEtiket.get(rp) ?? new Map<string, Set<string>>();
    const et = vekiller.get(i.ad_soyad) ?? new Set<string>();
    et.add(i.parti);
    vekiller.set(i.ad_soyad, et);
    partiVekilEtiket.set(rp, vekiller);
  }

  const bolunme: string[] = [];
  for (const [rp, vekiller] of partiVekilEtiket) {
    if (vekiller.size < 2) continue;
    if (!tumEtiketEvreni.has(rp)) continue;
    const kendiniGosteren = [...vekiller.values()].filter((s) => s.has(rp)).length;
    if (kendiniGosteren > 0) continue;
    const yabanci = [...new Set([...vekiller.values()].flatMap((s) => [...s]))];
    bolunme.push(`${rp}: ${vekiller.size} vekilin HEPSİ '${yabanci.join("'/'")}'  gösteriyor`);
  }

  assert.deepEqual(
    bolunme, [],
    `REGİSTER BÖLÜNMESİ — bir partinin TÜM imzacıları başka etikete düşüyor (yazım eşlemesi eksik, ` +
    `PARTI_MAP'e ölçülmüş alias eklenmeli):\n  ${bolunme.join('\n  ')}`,
  );
});

test("INV-8: parti_kaynak yalnız bilinen değerler alır", () => {
  const gecerli = new Set(['tbmm', 'roster-fallback', 'bilinmiyor']);
  const bozuk = (db.prepare('SELECT DISTINCT parti_kaynak k FROM imza').all() as { k: string }[])
    .map((r) => r.k)
    .filter((k) => !gecerli.has(k));
  assert.deepEqual(bozuk, [], `tanınmayan parti_kaynak değeri: ${bozuk.join(' · ')}`);
});

test('INV-3: kanun ilk-imza belgesinde faaliyet_parti imza ile hizalı', () => {
  const celiski = db.prepare(
    `SELECT COUNT(*) c FROM faaliyet f
       JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
       JOIN imza i ON i.faaliyet_id = f.id AND i.ilk_imza = 1
      WHERE f.kaynak = 'kanun' AND fp.parti <> i.parti`,
  ).get() as { c: number };
  assert.equal(
    celiski.c, 0,
    `${celiski.c} kanun belgesinde faaliyet_parti(roster) ≠ imza(TBMM) → parti değiştiren vekilin ` +
    `belgesi yanlış partiye yazılmış (yanlılık #1). migrate:imza-attrib yeniden koşulmalı.`,
  );
});

test('INV-9: parti etiketleri meşru parti evreninin dışına çıkmıyor (kırpma artefaktı yok)', () => {
  const mesru = new Set<string>([
    ...DEPUTY_MASTER_LIST.map((d) => normParti(d.parti)),
    ...Object.keys(PARTI_MAP).map((k) => k.toLocaleUpperCase('tr')),
    ...PARTI_DISI,
  ]);

  const kacak: string[] = [];
  for (const [tablo, kolon] of [['faaliyet_parti', 'parti'], ['imza', 'parti'], ['oy', 'parti']] as const) {
    const rows = db.prepare(`SELECT ${kolon} AS p, COUNT(*) AS n FROM ${tablo} GROUP BY 1`).all() as { p: string; n: number }[];
    for (const r of rows) if (r.p && !mesru.has(r.p)) kacak.push(`${tablo}.'${r.p}' (${r.n} kayıt)`);
  }
  assert.deepEqual(
    kacak, [],
    `Meşru parti evreni dışında etiket(ler): ${kacak.join(' · ')}\n` +
      'Bunlar ya gerçek bir partidir (→ PARTI_MAP\'e alias ekle, ÖLÇEREK) ya da ayıklama ' +
      'artefaktıdır (→ üreten kodu düzelt + mevcut satırları temizle). Sessizce bırakılamaz: ' +
      'sahte parti etiketi bir belgeyi/oyu YANLIŞ partiye yazar ve M3 eşdeğişimini bozar.',
  );
});

test('INV-10: soyad-only konuşmacı varyantları ölçülebilir düzeyde (birleştirme kuralı gerekli)', () => {
  const rows = db.prepare(
    `SELECT ozet, COUNT(*) n FROM faaliyet WHERE kaynak='konusma' AND ozet IS NOT NULL GROUP BY 1`,
  ).all() as { ozet: string; n: number }[];
  assert.ok(rows.length > 100, 'konuşma korpusu beklenmedik biçimde küçük');

  let tekKelime = 0, toplam = 0;
  for (const r of rows) {
    toplam += r.n;
    const ad = r.ozet.replace(/\s*\(Devamla\)\s*/gi, ' ').replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (ad && ad.split(/\s+/).length === 1) tekKelime += r.n;
  }
  assert.ok(
    tekKelime > 1000,
    `Tek kelimelik konuşmacı adı ${tekKelime}'e düşmüş (önceki ölçüm 6.819). Kaynak temizlenmiş ` +
      'olabilir — vekil-konusma\'daki alt-küme birleştirme kuralı hâlâ gerekli mi, gözden geçir.',
  );
  assert.ok(tekKelime / toplam < 0.25, `varyant oranı beklenenden yüksek: %${(100 * tekKelime / toplam).toFixed(1)}`);
});

test('INV-11: kısmi gelen alanlar upsert\'te COALESCE ile korunuyor', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'db.ts'), 'utf8');
  const upsert = src.slice(src.indexOf('export function upsertFaaliyet'), src.indexOf('export function replaceFaaliyetParties'));
  assert.ok(upsert.length > 100, 'upsertFaaliyet gövdesi bulunamadı');
  assert.match(
    upsert, /muhatap_text\s*=\s*COALESCE\(\s*excluded\.muhatap_text\s*,\s*faaliyet\.muhatap_text\s*\)/,
    'muhatap_text düz atamayla güncelleniyor — detayı çekilmeyen kayıtlarda mevcut değeri NULL\'la EZER. ' +
      'Kısmi gelen her alan COALESCE ile korunmalı.',
  );
});
