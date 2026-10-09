import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { araliktaParti, ilAdAyir } from '../src/lib/partyResolve.js';
import { rebuildVekilPartiDonem, vekilPartiTarihte, onergeAtfet } from '../src/lib/db.js';

test('araliktaParti: tarih tek aralıkta → o parti', () => {
  const ar = [{ parti: 'CHP', ilk: '2018-10-11', son: '2020-11-18' }, { parti: 'MEMLEKET', ilk: '2021-10-26', son: '2022-02-16' }];
  assert.equal(araliktaParti(ar, '2019-05-01'), 'CHP');
  assert.equal(araliktaParti(ar, '2021-12-01'), 'MEMLEKET');
});

test('araliktaParti: aralık DIŞI (boşluk/uç) → null (roster\'a düşülür, uydurma yok)', () => {
  const ar = [{ parti: 'CHP', ilk: '2018-10-11', son: '2020-11-18' }, { parti: 'MEMLEKET', ilk: '2021-10-26', son: '2022-02-16' }];
  assert.equal(araliktaParti(ar, '2021-01-01'), null);
  assert.equal(araliktaParti(ar, '2018-01-01'), null);
  assert.equal(araliktaParti(ar, '2025-01-01'), null);
});

test('araliktaParti: ÇAKIŞAN aralık (belirsiz) → null', () => {
  const ar = [{ parti: 'CHP', ilk: '2015-11-19', son: '2018-05-07' }, { parti: 'IYI', ilk: '2018-04-12', son: '2018-04-18' }];
  assert.equal(araliktaParti(ar, '2018-04-15'), null);
  assert.equal(araliktaParti(ar, '2016-01-01'), 'CHP');
});

test('araliktaParti: tarih yok → null', () => {
  assert.equal(araliktaParti([{ parti: 'CHP', ilk: '2018-01-01', son: '2020-01-01' }], null), null);
});

test('araliktaParti: PARTİ EŞDEĞİŞİMİ — etiket takası sonucu takas eder (özel-durum yok)', () => {
  const ar = [{ parti: 'A', ilk: '2018-01-01', son: '2019-01-01' }, { parti: 'B', ilk: '2020-01-01', son: '2021-01-01' }];
  const takas = ar.map((a) => ({ ...a, parti: a.parti === 'A' ? 'B' : 'A' }));
  assert.equal(araliktaParti(ar, '2018-06-01'), 'A');
  assert.equal(araliktaParti(takas, '2018-06-01'), 'B');
});

test('ilAdAyir: "İL Milletvekili AD SOYAD" → {il, ad}', () => {
  assert.deepEqual(ilAdAyir('AYDIN Milletvekili EVRİM KARAKOZ'), { il: 'AYDIN', ad: 'EVRİM KARAKOZ' });
  assert.deepEqual(ilAdAyir('ŞANLIURFA Milletvekili MAHMUT TANAL'), { il: 'ŞANLIURFA', ad: 'MAHMUT TANAL' });
});

test('ilAdAyir: kalıba uymayan → null (çağıran resolveParty\'ye düşer)', () => {
  assert.equal(ilAdAyir('Sadece Bir İsim'), null);
  assert.equal(ilAdAyir(''), null);
  assert.equal(ilAdAyir(null), null);
});

const DB_YOL = join(dirname(fileURLToPath(import.meta.url)), '..', 'storage', 'analytics.db');

test('vekilPartiTarihte: ÇELEBİ d27 — tarihe göre doğru parti (CHP→MEMLEKET→BAĞIMSIZ)', () => {
  rebuildVekilPartiDonem();
  assert.equal(vekilPartiTarihte('MEHMET ALİ ÇELEBİ', 27, '2019-05-01'), 'CHP');
  assert.equal(vekilPartiTarihte('MEHMET ALİ ÇELEBİ', 27, '2021-12-01'), 'MEMLEKET PARTISI');
  assert.equal(vekilPartiTarihte('MEHMET ALİ ÇELEBİ', 27, '2022-05-01'), 'BAGIMSIZ');
});

test('vekilPartiTarihte: switcher OLMAYAN vekil → null (roster\'a düşülür)', () => {
  assert.equal(vekilPartiTarihte('OLMAYAN BIR VEKIL XYZ', 27, '2020-01-01'), null);
});

test('onergeAtfet: ÇELEBİ CHP-dönemi önergesi → CHP (① zaman-çizgisi kazanır, roster AKP değil)', () => {
  rebuildVekilPartiDonem();
  assert.equal(onergeAtfet('İZMİR Milletvekili MEHMET ALİ ÇELEBİ', 27, '2019-05-01', []), 'CHP');
  assert.equal(onergeAtfet('İZMİR Milletvekili MEHMET ALİ ÇELEBİ', 27, '2022-05-01', []), 'BAGIMSIZ');
});

test('onergeAtfet: il-adaş — Kilis MUSTAFA DEMİR AKP DEĞİL (② il, substring adaşını çözer)', () => {
  rebuildVekilPartiDonem();
  const r = onergeAtfet('KİLİS Milletvekili MUSTAFA DEMİR', 28, '2024-01-01', []);
  assert.notEqual(r, 'AKP', 'substring adaşı hâlâ İstanbul/AKP DEMİR\'i seçiyor (il ayrımı çalışmıyor)');
  assert.ok(r && r !== 'Bilinmiyor', 'Kilis DEMİR çözülemedi');
});

test('onergeAtfet: sıradan vekil (switcher/adaş değil) çözülür (regresyon yok)', () => {
  rebuildVekilPartiDonem();
  const r = onergeAtfet('ŞANLIURFA Milletvekili MAHMUT TANAL', 28, '2024-01-01', []);
  assert.ok(r && r !== 'Bilinmiyor', 'sıradan vekil (TANAL) çözülmedi');
});

test('INV-5: imza\'daki her çok-partili vekil timeline\'da var (switcher-kapsama tam)', () => {
  rebuildVekilPartiDonem();
  const db = new DatabaseSync(DB_YOL, { readOnly: true });
  const switcherlar = db.prepare(
    `SELECT i.ad_soyad, f.donem FROM imza i JOIN faaliyet f ON f.id = i.faaliyet_id
      WHERE f.kaynak='kanun' AND i.parti_kaynak='tbmm'
      GROUP BY i.ad_soyad, f.donem HAVING COUNT(DISTINCT i.parti) > 1`,
  ).all() as { ad_soyad: string; donem: number }[];
  const timeline = new Set(
    (db.prepare(`SELECT ad_soyad || '|' || donem AS k FROM vekil_parti_donem`).all() as { k: string }[]).map((r) => r.k),
  );
  db.close();
  const eksik = switcherlar.filter((s) => !timeline.has(s.ad_soyad + '|' + s.donem));
  assert.equal(switcherlar.length > 0, true, 'test önkoşulu: en az bir switcher olmalı');
  assert.deepEqual(eksik, [], `timeline'da eksik switcher(ler): ${JSON.stringify(eksik.slice(0, 5))}`);
});
