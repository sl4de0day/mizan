import { test } from 'node:test';
import assert from 'node:assert/strict';
import { izinliMi, izinliZincir, IZINLI_HOSTLAR } from '../src/lib/kaynakIzin.js';

test('İ1: resmî kaynaklar ve alt alan adları GEÇER', () => {
  for (const u of [
    'https://www.tbmm.gov.tr/Yasama/Kanun/123',
    'https://tbmm.gov.tr/',
    'https://www.resmigazete.gov.tr/fihrist?tarih=2026-07-01',
    'https://normkararlarbilgibankasi.anayasa.gov.tr/karar/1',
    'https://data.tuik.gov.tr/Bulten/Index',
  ]) assert.equal(izinliMi(u).izinli, true, `izinli olmalıydı: ${u}`);
});

test('İ2: SSRF vektörleri REDDEDİLİR (her biri ayrı gerekçeyle)', () => {
  const vaka: [string, RegExp][] = [
    ['http://127.0.0.1:8000/health',        /https/i],
    ['https://127.0.0.1/x',                 /özel|yerel/i],
    ['https://169.254.169.254/latest/meta', /özel|yerel/i],
    ['https://10.0.0.5/',                   /özel|yerel/i],
    ['https://192.168.1.1/',                /özel|yerel/i],
    ['https://172.16.0.1/',                 /özel|yerel/i],
    ['https://[::1]/',                      /özel|yerel|IP/i],
    ['file:///etc/passwd',                  /https/i],
    ['https://user:pass@tbmm.gov.tr/',      /kimlik/i],
    ['https://tbmm.gov.tr:2222/',           /port/i],
    ['tbmm.gov.tr/x',                       /ayrıştırılamadı|https/i],
  ];
  for (const [u, bekle] of vaka) {
    const s = izinliMi(u);
    assert.equal(s.izinli, false, `REDDEDİLMELİYDİ: ${u}`);
    assert.match((s as { sebep: string }).sebep, bekle, `${u} için gerekçe beklenenle uyuşmuyor`);
  }
});

test('İ3: sonek kaçışı KAPALI — nokta sınırında eşleşir', () => {
  for (const u of ['https://kotutbmm.gov.tr/', 'https://tbmm.gov.tr.saldirgan.com/', 'https://xtuik.gov.tr/'])
    assert.equal(izinliMi(u).izinli, false, `sonek kaçışı geçti: ${u}`);
});

test('İ4: haber siteleri BİLEREK dışarıda (tarafsızlık kapısı)', () => {
  for (const u of ['https://www.bbc.com/turkce', 'https://news.google.com/search?q=x', 'https://t24.com.tr/'])
    assert.equal(izinliMi(u).izinli, false, `haber sitesi izinli çıktı: ${u}`);
  assert.ok(IZINLI_HOSTLAR.every((h) => h.endsWith('.gov.tr')), 'izin listesi resmî olmayan host içeriyor');
});

test('İ5: yönlendirme zinciri HER SIÇRAMADA denetlenir', () => {
  assert.equal(izinliZincir(['https://tbmm.gov.tr/a', 'https://www.tbmm.gov.tr/b']).izinli, true);
  const kotu = izinliZincir(['https://tbmm.gov.tr/a', 'https://169.254.169.254/']);
  assert.equal(kotu.izinli, false, 'izinli hosttan metadata servisine yönlendirme geçti');
  assert.match((kotu as { sebep: string }).sebep, /yönlendirme/i);
  assert.equal(izinliZincir(Array(7).fill('https://tbmm.gov.tr/a')).izinli, false, 'uzun zincir geçti');
});
