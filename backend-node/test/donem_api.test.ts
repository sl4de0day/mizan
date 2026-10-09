import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backendHazir } from './_canli.js';

const B = 'http://localhost:8000/api/ozet';
const canli = await backendHazir();
const jj = async (u: string): Promise<{ st: number; j: any }> => {
  const r = await fetch(B + u);
  return { st: r.status, j: await r.json() };
};

const FAALIYET_EP: [string, string][] = [
  ['yasama', ''], ['parti-ay-konu', ''], ['konu-zaman', '&parti=CHP'], ['karsilastir', '&partiler=CHP,AKP'],
  ['parti-konu', ''], ['siralama', ''], ['trend', '&parti=CHP'], ['cesaret', '&parti=CHP'],
  ['cesaret-konu', `&kategori=${encodeURIComponent('Ekonomi & Finans')}`], ['aylik', ''],
  ['ortak-imza', ''], ['ortak-imza-zaman', '&parti=CHP'],
];

test('dönem filtresi ETKİLİ — d28 ile d27 FARKLI sonuç verir', { skip: !canli && 'backend kapalı' }, async () => {
  for (const [ep, ek] of FAALIYET_EP) {
    const a = await jj(`/${ep}?donem=28${ek}`);
    const b = await jj(`/${ep}?donem=27${ek}`);
    assert.equal(a.j.success, true, `${ep}?donem=28 başarısız`);
    assert.equal(b.j.success, true, `${ep}?donem=27 başarısız`);
    assert.notDeepEqual(a.j, b.j, `${ep}: d28 ve d27 AYNI sonucu döndürdü — dönem filtresi çalışmıyor`);
  }
});

test('dönemsiz istek AKTİF döneme (28) düşer — üç dönemi TOPLAMAZ', { skip: !canli && 'backend kapalı' }, async () => {
  const bos = await jj('/yasama');
  const d28 = await jj('/yasama?donem=28');
  assert.deepEqual(bos.j.partiler, d28.j.partiler, 'dönemsiz istek d28 ile aynı olmalı');
  const hepsi = await jj('/yasama?donem=hepsi');
  assert.equal(bos.j.toplam_kanunlasti, d28.j.toplam_kanunlasti, 'dönemsiz = d28 olmalı');
  assert.ok(
    bos.j.toplam_kanunlasti < hepsi.j.toplam_kanunlasti,
    `dönemsiz istek üç dönemi TOPLAMIŞ: ${bos.j.toplam_kanunlasti} = hepsi (${hepsi.j.toplam_kanunlasti})`,
  );
});

test('?donem=hepsi BİLİNÇLİ çok-dönem — d28\'den farklı ve daha büyük', { skip: !canli && 'backend kapalı' }, async () => {
  const hepsi = await jj('/yasama?donem=hepsi');
  const d28 = await jj('/yasama?donem=28');
  assert.equal(hepsi.j.success, true);
  assert.ok(hepsi.j.toplam_kanunlasti > d28.j.toplam_kanunlasti, 'hepsi, d28\'den büyük olmalı');
});

test('geçersiz dönem 400 döner — success:true + boş DEĞİL', { skip: !canli && 'backend kapalı' }, async () => {
  for (const kotu of ['99', 'abc', '-1', '0']) {
    const { st, j } = await jj(`/yasama?donem=${kotu}`);
    assert.equal(st, 400, `donem=${kotu} 400 dönmeli, döndü: ${st}`);
    assert.equal(j.success, false, `donem=${kotu} success:false dönmeli`);
    assert.match(j.error, /Bilinmeyen dönem/, `donem=${kotu} açıklayıcı hata vermeli`);
  }
});

test('bağlam kaynakları dönem PENCERESİNE saygı gösterir', { skip: !canli && 'backend kapalı' }, async () => {
  const A = encodeURIComponent('Adalet & Hukuk'), KS = encodeURIComponent('Konut & Şehircilik');
  const y26 = await jj(`/yargi?kategori=${A}&donem=26`);
  const y27 = await jj(`/yargi?kategori=${A}&donem=27`);
  const y28 = await jj(`/yargi?kategori=${A}&donem=28`);
  assert.ok((y28.j.ozet?.esas ?? 0) > 0, 'AYM d28\'de veri olmalı');
  assert.ok((y27.j.ozet?.esas ?? 0) > 0, 'AYM d27\'de veri olmalı (korpus 2015\'e açıldı)');
  assert.ok((y26.j.ozet?.esas ?? 0) > 0, 'AYM d26\'da veri olmalı (korpus 2015\'e açıldı)');
  const g27 = await jj(`/gosterge?kategori=${KS}&donem=27`);
  const seri = g27.j.seri ?? [];
  assert.ok(seri.length > 20, `TÜİK/konut d27'de veri olmalı, geldi: ${seri.length}`);
  assert.match(seri[0].tarih, /^2018-/, `d27 penceresi 2018'de başlamalı (2012 aykırısı sızmış): ${seri[0].tarih}`);
  assert.match(seri[seri.length - 1].tarih, /^2023-/, 'd27 penceresi 2023\'te bitmeli');
});

test('DERINLIK-1: /meta.donemler tam yayımlanan dönem kümesini döndürür', { skip: !canli && 'backend kapalı' }, async () => {
  const m = await (await fetch('http://localhost:8000/api/ozet/meta')).json() as { donemler?: number[] };
  assert.ok(Array.isArray(m.donemler), 'meta.donemler dizi değil');
  const set = new Set(m.donemler);
  for (const d of [28, 27, 26, 25, 24, 23, 22, 21, 20]) {
    assert.ok(set.has(d), `meta.donemler d${d} içermiyor — yasama verisi yazıldıysa görünmeli`);
  }
  assert.equal(Math.max(...m.donemler), 28, 'en yeni dönem 28 değil');
  assert.ok(Math.min(...m.donemler) <= 20, `en eski dönem 20'ye inmemiş: ${Math.min(...m.donemler)}`);
});

test('DERINLIK-2: eski dönemler (d22) dönem-körlük olmadan sorgulanır', { skip: !canli && 'backend kapalı' }, async () => {
  const a = await jj('/yasama?donem=22');
  const b = await jj('/yasama?donem=28');
  assert.equal(a.j.success, true, 'd22 yasama başarısız');
  assert.notDeepEqual(a.j.partiler, b.j.partiler, 'd22 ve d28 aynı sonuç — dönem filtresi kör');
  const lider = (a.j.partiler ?? []).slice().sort((x: any, y: any) => y.kanunlasti - x.kanunlasti)[0];
  assert.ok(lider && lider.kanunlasti > 0, 'd22 kanunlaşma verisi yok — roster/atıf bozuk olabilir');
});

test('DERINLIK-3: kismi konuşma dönemi BEYAN taşır, temiz dönem taşımaz', { skip: !canli && 'backend kapalı' }, async () => {
  const kismi = await jj('/arac-profili?donem=21');
  const temiz = await jj('/arac-profili?donem=22');
  assert.ok(kismi.j.konusma_kalite_notu, 'd21 (kismi konuşma) kalite beyanı taşımıyor');
  assert.equal(temiz.j.konusma_kalite_notu ?? null, null, 'd22 (temiz konuşma) gereksiz beyan taşıyor');
});
