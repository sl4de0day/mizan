import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imzaSatiri, stripImzaMark } from '../src/tools/imzaScraper.js';
import { DEPUTY_MASTER_LIST } from '../src/lib/deputies.js';

const TBMM_YAZIMLARI: [string, string][] = [
  ['MEMLEKET PARTİSİ', 'MEMLEKET PARTISI'],
  ['ZAFER PARTİSİ', 'ZAFER PARTISI'],
  ['DEMOKRASİ VE ATILIM PARTİSİ', 'DEVA'],
  ['BÜYÜK BİRLİK PARTİSİ', 'BBP'],
  ['TÜRKİYE İŞÇİ PARTİSİ', 'TIP'],
  ['HÜR DAVA PARTİSİ', 'HUDA PAR'],
  ['YENİDEN REFAH PARTİSİ', 'YENIDEN REFAH'],
  ['EMEK PARTİSİ', 'EMEP'],
  ['DEMOKRATİK SOL PARTİ', 'DSP'],
  ['DEMOKRATİK BÖLGELER PARTİSİ', 'DBP'],
  ['DEMOKRAT PARTİ', 'DP'],
  ['ADALET VE KALKINMA PARTİSİ', 'AKP'],
  ['CUMHURİYET HALK PARTİSİ', 'CHP'],
];

test('imzaSatiri — TBMM sütunu doluysa O kazanır ve kökeni tbmm olur', () => {
  for (const [ham, beklenen] of TBMM_YAZIMLARI) {
    const r = imzaSatiri(ham, 'Herhangi Bir VEKİL', 27);
    assert.equal(r.parti, beklenen, `TBMM '${ham}' → '${r.parti}', beklenen '${beklenen}'`);
    assert.equal(r.parti_kaynak, 'tbmm', `'${ham}' fallback'e düştü — allowlist tuzağı geri geldi`);
  }
});

test('imzaSatiri — TBMM sütunu doluyken roster ASLA devreye girmez', () => {
  const dep = DEPUTY_MASTER_LIST.find((d) => String(d.donem) === '28');
  assert.ok(dep, 'd28 roster boş — test anlamsız');
  const r = imzaSatiri('MEMLEKET PARTİSİ', dep!.ad_soyad, 28);
  assert.equal(r.parti_kaynak, 'tbmm');
  assert.equal(r.parti, 'MEMLEKET PARTISI',
    `roster '${dep!.parti}' TBMM'nin sözünü ezdi → anakronizm (MEMLEKET → ${r.parti})`);
});

test('imzaSatiri — TBMM boşsa roster fallback DÖNEMİYLE çalışır (sabit 28 tuzağı)', () => {
  const d28Adlar = new Set(DEPUTY_MASTER_LIST.filter((d) => String(d.donem) === '28').map((d) => d.ad_soyad));
  const yalnizD27 = DEPUTY_MASTER_LIST.find((d) => String(d.donem) === '27' && !d28Adlar.has(d.ad_soyad));
  assert.ok(yalnizD27, 'd27-only vekil bulunamadı — test anlamsız');

  const dogru = imzaSatiri('', yalnizD27!.ad_soyad, 27);
  assert.equal(dogru.parti_kaynak, 'roster-fallback');
  assert.notEqual(dogru.parti, 'Bilinmiyor',
    `d27 vekili '${yalnizD27!.ad_soyad}' kendi döneminde çözülemedi`);

  const yanlis = imzaSatiri('', yalnizD27!.ad_soyad, 28);
  assert.equal(yanlis.parti, 'Bilinmiyor',
    `d27-only vekil d28 roster'ında çözüldü ('${yanlis.parti}') → adaş/substring eşleşmesi var, ` +
    `sabit-dönem tuzağı sessiz kalırdı`);
});

test('imzaSatiri — TBMM boş VE roster çözemiyorsa parti UYDURULMAZ', () => {
  const r = imzaSatiri('', 'BÖYLE BİR VEKİL YOKTUR', 28);
  assert.equal(r.parti, 'Bilinmiyor');
  assert.equal(r.parti_kaynak, 'roster-fallback');
});

test('imzaSatiri — köken alanı her zaman doldurulur (bilinmiyor kalamaz)', () => {
  for (const [ham] of [...TBMM_YAZIMLARI, ['']] as [string][]) {
    const r = imzaSatiri(ham, 'Bir VEKİL', 28);
    assert.notEqual(r.parti_kaynak, 'bilinmiyor');
    assert.ok(['tbmm', 'roster-fallback'].includes(r.parti_kaynak));
  }
});

test('stripImzaMark — "İLK İMZA SAHİBİ" işaretini ayıklar, adı bozmaz', () => {
  assert.equal(stripImzaMark('Mehmet Ali ÇELEBİ İLK İMZA SAHİBİ'), 'Mehmet Ali ÇELEBİ');
  assert.equal(stripImzaMark('Ayhan BARUT'), 'Ayhan BARUT');
});
