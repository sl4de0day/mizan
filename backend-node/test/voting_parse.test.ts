import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOylama } from '../src/lib/votingParse.js';

test('düz (d28) biçim — tek blok, doğru sayılar', () => {
  const m = '58 sıra sayılı Kanun Teklifi açık oylama sonucunu açıklıyorum:\nKullanılan oy sayısı : 300 / Kabul : 291 / Ret : 9';
  const b = parseOylama(m);
  assert.equal(b.length, 1);
  assert.equal(b[0].sira_sayisi, '58');
  assert.equal(b[0].kullanilan, 300);
  assert.equal(b[0].kabul, 291);
  assert.equal(b[0].ret, 9);
});

test('🔴 SARMALI (d26/d27 arşiv) biçim — eski kod 0 blok verirdi, yeni okur', () => {
  const m = '561\nsıra sayılı Kanun Teklifi açık oylama sonucu:\nKullanılan oy\nsayısı\n:\n234\nKabul\n:\n225\nRet\n:\n7\nÇekimser\n:\n2\nkabul edilmiştir.';
  const b = parseOylama(m);
  assert.equal(b.length, 1, 'sarmalı metin okunmadı — çıpa hâlâ satır-bazlı');
  assert.equal(b[0].kullanilan, 234);
  assert.equal(b[0].kabul, 225);
  assert.equal(b[0].ret, 7);
  assert.equal(b[0].cekimser, 2, 'Çekimser sarması kaçtı');
  assert.equal(b[0].sira_sayisi, '561', 'S.Sayısı sarması (561\\nsıra) kaçtı');
  assert.ok(b[0].tutarli, '225+7+2=234 tutarlı olmalı');
});

test('iki bitişik blok karışmıyor (pencere sonraki çıpada durur)', () => {
  const m = 'Kullanılan oy sayısı : 100 Kabul : 100\nKullanılan oy sayısı : 200 Kabul : 150 Ret : 50';
  const b = parseOylama(m);
  assert.equal(b.length, 2);
  assert.equal(b[0].kullanilan, 100);
  assert.equal(b[1].kullanilan, 200);
  assert.equal(b[1].ret, 50, 'ikinci bloğun reti ilkine sızmamalı');
});

test('işaret oyu (sayısız) blok DEĞİL', () => {
  const m = 'Kabul edenler... etmeyenler... Kabul edilmiştir.';
  assert.equal(parseOylama(m).length, 0);
});
