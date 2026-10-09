import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backendHazir } from './_canli.js';

const B = 'http://localhost:8000/api/ozet';
const canli = await backendHazir();
const jj = async (u: string) => (await fetch(B + u)).json() as Promise<Record<string, any>>;

test('AK1: Türkçe büyük/küçük harf katlama — "öğretmen" ve "Öğretmen" AYNI toplamı döner', { skip: !canli && 'backend kapalı' }, async () => {
  const kucuk = await jj('/onerge-ara?q=öğretmen&donem=hepsi');
  const buyuk = await jj('/onerge-ara?q=Öğretmen&donem=hepsi');
  assert.equal(kucuk.toplam, buyuk.toplam, 'küçük/büyük harf aynı sonucu vermeli');
});

test('AK2: kelime sırası önemsiz — "asgari ücret" ve "ücret asgari" AYNI toplamı döner', { skip: !canli && 'backend kapalı' }, async () => {
  const duz = await jj('/onerge-ara?q=asgari+ücret&donem=hepsi');
  const ters = await jj('/onerge-ara?q=ücret+asgari&donem=hepsi');
  assert.equal(duz.toplam, ters.toplam, 'sıra bağımsız eşleşmeli (eskiden ters sıra 0 dönüyordu)');
  assert.ok(ters.toplam > 0, 'ters sıra artık BOŞ dönmemeli');
});

test('AK3: konusma-ara aynı garanti', { skip: !canli && 'backend kapalı' }, async () => {
  const duz = await jj('/konusma-ara?q=asgari+ücret&donem=hepsi');
  const ters = await jj('/konusma-ara?q=ücret+asgari&donem=hepsi');
  assert.equal(duz.toplam, ters.toplam, 'konusma-ara da sıra bağımsız eşleşmeli');
});

test('AK4: kanun-ara — harf katlama ve kelime sırası', { skip: !canli && 'backend kapalı' }, async () => {
  const kucuk = await jj('/kanun-ara?q=öğretmen&donem=hepsi');
  const buyuk = await jj('/kanun-ara?q=Öğretmen&donem=hepsi');
  assert.equal(kucuk.toplam, buyuk.toplam, 'kanun-ara küçük/büyük harf aynı sonucu vermeli');
  const duz = await jj('/kanun-ara?q=vergi+kanunu&donem=hepsi');
  const ters = await jj('/kanun-ara?q=kanunu+vergi&donem=hepsi');
  assert.equal(duz.toplam, ters.toplam, 'kanun-ara sıra bağımsız eşleşmeli');
  assert.ok(ters.toplam > 0, 'kanun-ara ters sıra BOŞ dönmemeli');
});

test('AK5: aym-ara — harf katlama ve kelime sırası (sorgu-anı tr_lower)', { skip: !canli && 'backend kapalı' }, async () => {
  const kucuk = await jj('/aym-ara?q=öğretmen&donem=hepsi');
  const buyuk = await jj('/aym-ara?q=Öğretmen&donem=hepsi');
  assert.equal(kucuk.toplam, buyuk.toplam, 'aym-ara küçük/büyük harf aynı sonucu vermeli');
  const duz = await jj('/aym-ara?q=vergi+kanunu&donem=hepsi');
  const ters = await jj('/aym-ara?q=kanunu+vergi&donem=hepsi');
  assert.equal(duz.toplam, ters.toplam, 'aym-ara sıra bağımsız eşleşmeli');
  assert.ok(ters.toplam > 0, 'aym-ara ters sıra BOŞ dönmemeli');
});

test('AK6: gazete-ara — harf katlama ve kelime sırası (sorgu-anı tr_lower)', { skip: !canli && 'backend kapalı' }, async () => {
  const kucuk = await jj('/gazete-ara?q=öğretmen&donem=hepsi');
  const buyuk = await jj('/gazete-ara?q=Öğretmen&donem=hepsi');
  assert.equal(kucuk.toplam, buyuk.toplam, 'gazete-ara küçük/büyük harf aynı sonucu vermeli');
  const duz = await jj('/gazete-ara?q=vergi+kanunu&donem=hepsi');
  const ters = await jj('/gazete-ara?q=kanunu+vergi&donem=hepsi');
  assert.equal(duz.toplam, ters.toplam, 'gazete-ara sıra bağımsız eşleşmeli');
  assert.ok(ters.toplam > 0, 'gazete-ara ters sıra BOŞ dönmemeli');
});
