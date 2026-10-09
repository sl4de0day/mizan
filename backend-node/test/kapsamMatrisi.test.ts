import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backendHazir } from './_canli.js';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DB_YOL = join(dirname(fileURLToPath(import.meta.url)), '..', 'storage', 'analytics.db');
const db = new DatabaseSync(DB_YOL, { readOnly: true });
const B = 'http://localhost:8000/api/ozet';
const canli = await backendHazir();

const TUIK_KAPSAM: Array<{ kod: string; enGecBaslangic: string; enAzNokta: number; not: string }> = [
  { kod: 'tasit',    enGecBaslangic: '2005-12', enAzNokta: 240, not: 'databrowser2, tam geçmiş' },
  { kod: 'konut',    enGecBaslangic: '2013-12', enAzNokta: 150, not: 'databrowser2, tam geçmiş' },
  { kod: 'issizlik', enGecBaslangic: '2005-12', enAzNokta: 240, not: 'databrowser2, tam geçmiş' },
  { kod: 'tufe',     enGecBaslangic: '2024-12', enAzNokta: 15,  not: 'yalnız widget (kayan pencere)' },
];

test('KM1: TÜİK serilerinin kapsamı ölçülen alt sınırın altına DÜŞMEDİ', () => {
  const sorun: string[] = [];
  for (const k of TUIK_KAPSAM) {
    const r = db.prepare('SELECT MIN(tarih) lo, MAX(tarih) hi, COUNT(*) n FROM tuik WHERE gosterge=?')
      .get(k.kod) as { lo: string | null; hi: string | null; n: number };
    if (!r.lo) { sorun.push(`${k.kod}: HİÇ VERİ YOK`); continue; }
    if (r.lo > k.enGecBaslangic) sorun.push(`${k.kod}: ${r.lo}'de başlıyor, beklenen ≤${k.enGecBaslangic} (${k.not})`);
    if (r.n < k.enAzNokta) sorun.push(`${k.kod}: ${r.n} nokta, beklenen ≥${k.enAzNokta}`);
  }
  assert.deepEqual(
    sorun, [],
    `TÜİK kapsamı daralmış:\n  ${sorun.join('\n  ')}\n` +
      'Kaynak değişmiş ya da bir gösterge dataflow yerine widget yoluna düşmüş olabilir. ' +
      'Daralma MEŞRUSA bu testteki sınırı ölçerek güncelle — sessizce geçme.',
  );
});

test('KM2: kapsam DIŞINDAKİ dönem, boş dizi değil SEBEP döndürür', { skip: !canli && 'backend kapalı' }, async () => {
  const kat = encodeURIComponent('Ekonomi & Finans');
  const j = await (await fetch(`${B}/gosterge?kategori=${kat}&donem=27`)).json() as
    { success: boolean; gosterge: { kod: string } | null; seri: unknown[]; kapsam?: { ilk: string }; sebep?: string | null };

  assert.equal(j.success, true);
  assert.ok(j.gosterge, 'gösterge eşlemesi kaybolmuş');
  assert.equal(j.seri.length, 0, 'test varsayımı eskimiş: TÜFE artık d27\'yi kapsıyor → sınırları güncelle');
  assert.ok(j.sebep && j.sebep.length > 20, 'kapsam dışı istek SESSİZCE boş dönüyor — sebep yok');
  assert.ok(j.kapsam?.ilk, 'kapsam aralığı bildirilmiyor');
  assert.match(j.sebep, /kapsıyor|dışında/i, 'sebep, kapsam sınırını açıklamıyor');
});

test('KM3: kapsanan dönemde seri GERÇEKTEN dolu (kapı boşuna kapanmıyor)', { skip: !canli && 'backend kapalı' }, async () => {
  const kat = encodeURIComponent('Ekonomi & Finans');
  const j = await (await fetch(`${B}/gosterge?kategori=${kat}&donem=28`)).json() as { seri: unknown[]; sebep?: string | null };
  assert.ok(j.seri.length >= 10, `d28'de TÜFE serisi beklenenden kısa: ${j.seri.length}`);
});

test('KM4: hiçbir göstergenin SON noktası placeholder-0 değil', () => {
  const db = new DatabaseSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'storage', 'analytics.db'), { readOnly: true });
  const gostergeler = (db.prepare('SELECT DISTINCT gosterge g FROM tuik').all() as { g: string }[]).map((r) => r.g);
  for (const g of gostergeler) {
    const son = db.prepare('SELECT tarih, deger FROM tuik WHERE gosterge = ? ORDER BY tarih DESC LIMIT 1').get(g) as { tarih: string; deger: number };
    assert.notEqual(son.deger, 0,
      `${g} serisinin SON noktası (${son.tarih}) = 0 — TÜİK'in henüz-açıklanmamış-ay placeholder'ı sızmış olabilir`);
  }
});
