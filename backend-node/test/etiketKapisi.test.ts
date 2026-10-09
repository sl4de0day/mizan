import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { etiketKapisi } from '../src/routes/ozet.js';
import { lopoArtiklar } from '../src/lib/nb.js';
import { PARTI_DISI } from '../src/lib/partyResolve.js';

const DB_YOL = join(dirname(fileURLToPath(import.meta.url)), '..', 'storage', 'analytics.db');

test('etiketKapisi: d28 AÇIK (altın etiket var → yayımlanabilir)', () => {
  const k = etiketKapisi({ donem: '28' });
  assert.equal(k.yayimlanabilir, true, 'd28 altın etiketli, kapı açık olmalı');
  assert.ok(k.altin > 0, `d28 altın sayısı >0 olmalı, ölçülen: ${k.altin}`);
});

for (const d of ['27', '26']) {
  test(`etiketKapisi: d${d} KAPALI (0 altın, veri var → yayımlanamaz)`, () => {
    const k = etiketKapisi({ donem: d });
    assert.equal(k.yayimlanabilir, false, `d${d} altınsız, kapı kapalı olmalı`);
    assert.equal(k.altin, 0, `d${d} altın 0 olmalı`);
    assert.ok(k.toplam > 0, `d${d} veri VAR olmalı (toplam>0); yoksa test "veri yok"u kapıyla karıştırır`);
    assert.ok(k.sebep && k.sebep.length > 0, 'kapalı kapı gerekçe cümlesi taşımalı');
  });
}

test('etiketKapisi: hepsi BYPASS KAPALI (per-dönem kontrol; d26/d27 havuzu kirletir)', () => {
  const k = etiketKapisi({ donem: 'hepsi' });
  assert.equal(k.yayimlanabilir, false, 'hepsi: bir dönem bile 0 altınsa (d26/d27) havuz yayımlanamaz — bypass kapalı olmalı');
  assert.match(k.sebep ?? '', /26|27/, 'gerekçe hangi dönem(ler)in altını olmadığını söylemeli');
});

test('DB değişmezi: d26/d27 kanun+önerge altını = 0, d28 > 0 (kapının ön koşulu)', () => {
  const db = new DatabaseSync(DB_YOL, { readOnly: true });
  const disiSql = `(${[...PARTI_DISI].map((v) => `'${v.replace(/'/g, "''")}'`).join(',')})`;
  const rows = db.prepare(
    `SELECT f.donem, COUNT(*) AS toplam,
            SUM(CASE WHEN f.kategori_kaynagi='muhatap' THEN 1 ELSE 0 END) AS altin
       FROM faaliyet f JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
      WHERE fp.parti NOT IN ${disiSql} AND f.kaynak IN ('kanun','onerge')
      GROUP BY f.donem`,
  ).all() as { donem: number; toplam: number; altin: number }[];
  db.close();
  const byD = new Map(rows.map((r) => [r.donem, r]));
  const d28 = byD.get(28), d27 = byD.get(27), d26 = byD.get(26);
  assert.ok(d28 && d28.altin > 0, `d28 altın >0 olmalı: ${JSON.stringify(d28)}`);
  for (const [n, r] of [['27', d27], ['26', d26]] as const) {
    if (r && r.toplam > 0) {
      assert.equal(r.altin, 0, `d${n} veri var (${r.toplam}) ama altın 0 olmalı — bu kapının ön koşulu`);
    }
  }
});

const mk = (parti: string, truth: string, pOk: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ truth, parti, ok: i < Math.floor(n * pOk) }));

test('lopoArtiklar: özdeş konu-karışımı + özdeş doğruluk → artık ≈ 0', () => {
  const preds = [...mk('ALFA', 'X', 0.8, 300), ...mk('BETA', 'X', 0.8, 300)];
  const { perParti, yanlilikMaxPP } = lopoArtiklar(preds);
  assert.equal(perParti['ALFA']!.artik, 0, 'ALFA artığı 0 olmalı');
  assert.equal(perParti['BETA']!.artik, 0, 'BETA artığı 0 olmalı');
  assert.equal(yanlilikMaxPP, 0, 'yanlılık sinyali yok → yanlilikMaxPP 0');
});

test('lopoArtiklar: leave-one-party-out (kendi belgesini beklenene KATMAZ)', () => {
  const preds = [...mk('A', 'X', 1.0, 250), ...mk('B', 'X', 0.0, 250)];
  const { perParti, yanlilikMaxPP } = lopoArtiklar(preds);
  assert.equal(perParti['A']!.artik, 100, 'A: beklenen=B doğruluğu(0) → artık +100 (naif olsa +50 olurdu)');
  assert.equal(perParti['B']!.artik, -100, 'B: beklenen=A doğruluğu(100) → artık −100');
  assert.equal(yanlilikMaxPP, 100, 'yanlilikMaxPP = max|artık| = 100');
});

test('lopoArtiklar: n<200 parti raporlanmaz (küçük örneklem susar)', () => {
  const preds = [...mk('BUYUK', 'X', 0.9, 300), ...mk('KUCUK', 'X', 0.1, 150)];
  const { perParti } = lopoArtiklar(preds);
  assert.ok(perParti['BUYUK'], 'n=300 raporlanmalı');
  assert.equal(perParti['KUCUK'], undefined, 'n=150 < 200 → raporlanmamalı');
});

test('lopoArtiklar: parti etiketi takası artıkları TAKAS eder (özel-durum yok)', () => {
  const taban = [
    ...mk('ALFA', 'X', 0.9, 250), ...mk('BETA', 'X', 0.4, 250),
    ...mk('ALFA', 'Y', 0.3, 250), ...mk('BETA', 'Y', 0.7, 250),
  ];
  const r1 = lopoArtiklar(taban);
  const takas = taban.map((p) => ({ ...p, parti: p.parti === 'ALFA' ? 'BETA' : 'ALFA' }));
  const r2 = lopoArtiklar(takas);
  assert.equal(r2.perParti['ALFA']!.artik, r1.perParti['BETA']!.artik, 'takas sonrası ALFA = eski BETA');
  assert.equal(r2.perParti['BETA']!.artik, r1.perParti['ALFA']!.artik, 'takas sonrası BETA = eski ALFA');
  assert.equal(r2.yanlilikMaxPP, r1.yanlilikMaxPP, 'yanlilikMaxPP takasla değişmemeli');
});
