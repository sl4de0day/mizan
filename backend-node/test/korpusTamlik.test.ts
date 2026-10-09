import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/lib/db.js';

const DONEMLER = [26, 27, 28];

test('korpus — kanun numarası aralığında büyük boşluk yok (sessiz kayıp imzası)', () => {
  const db = getDb();
  const nos = (db.prepare(
    `SELECT CAST(kanun_no AS INTEGER) n FROM teklif_sirasayisi
      WHERE kanun_no IS NOT NULL AND TRIM(kanun_no) <> '' ORDER BY n`,
  ).all() as { n: number }[]).map((r) => r.n).filter((n) => n > 0);
  if (nos.length < 20) return;

  const kapsanan = nos.at(-1)! - nos[0]! + 1;
  const eksik = kapsanan - new Set(nos).size;
  const oran = eksik / kapsanan;
  assert.ok(
    oran <= 0.15,
    `kanun numarası aralığında ${eksik}/${kapsanan} boşluk (%${(100 * oran).toFixed(1)}) — ` +
    `korpus sessizce eksik olabilir. Aralık: ${nos[0]}–${nos.at(-1)}. ` +
    `(Bu ölçü 2026-07-18'de 47 kanunluk kaybı ortaya çıkardı.)`,
  );
});

test('korpus — dönem etiketli kayıt, tarihi tutarsız diye DÜŞÜRÜLMEMİŞ olmalı', () => {
  const db = getDb();
  const r = db.prepare(
    `SELECT COUNT(*) n FROM faaliyet WHERE kaynak='kanun' AND donem=28 AND tarih IS NULL`,
  ).get() as { n: number };
  assert.ok(
    r.n > 0,
    'd28 kanun korpusunda tarihi NULL kayıt yok. Bu, "tarihi değiştirilen eski kanuna ait" ' +
    'kayıtların yeniden ELENDİĞİ anlamına gelebilir (2026-07-18 regresyonu geri döndü).',
  );
});

test('korpus — tarihli kayıtlar dönem penceresinin DIŞINA taşmaz', () => {
  const db = getDb();
  const BAS: Record<number, string> = { 26: '2015-11', 27: '2018-07', 28: '2023-06' };
  for (const d of DONEMLER) {
    const r = db.prepare(
      `SELECT MIN(ay) a, COUNT(*) n FROM faaliyet WHERE kaynak='kanun' AND donem=? AND ay IS NOT NULL`,
    ).get(d) as { a: string | null; n: number };
    if (!r.n || !r.a) continue;
    assert.ok(
      r.a >= BAS[d]!,
      `d${d} kanun korpusunda dönem başlangıcından (${BAS[d]}) önce tarihli kayıt var: ${r.a}. ` +
      `Tutarsız tarih NULL yazılmalıydı.`,
    );
  }
});

test('korpus — her dönemde kanunlaşan teklif sayısı makul bir tabanın üstünde', () => {
  const db = getDb();
  for (const d of DONEMLER) {
    const r = db.prepare(
      `SELECT COUNT(*) n FROM faaliyet WHERE kaynak='kanun' AND donem=? AND durum='KANUNLAŞTI'`,
    ).get(d) as { n: number };
    assert.ok(r.n >= 50, `d${d}: yalnız ${r.n} kanunlaşan teklif — korpus çökmüş olabilir.`);
  }
});
