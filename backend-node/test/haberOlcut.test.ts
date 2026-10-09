import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tanimlayiciCikar, korpustaMi, baslikBozulmamis, type KorpusSorgu } from '../src/lib/haberOlcut.js';

const KOK = join(dirname(fileURLToPath(import.meta.url)), '..');

const KORPUS: KorpusSorgu = {
  kanunVarMi: (no) => (no === '7531' ? { baslik: 'Bazı Kanunlarda Değişiklik Yapılmasına Dair Kanun' } : null),
  siraSayisiVarMi: (ss) => (ss === '280' ? { baslik: 'Yargının Etkin İşlemesi…' } : null),
  esasNoVarMi: (e) => (e === '2/3737' ? { baslik: 'Yargının Etkin İşlemesi…' } : null),
  aymVarMi: (a) => (a === '2025/122|2025/185' ? { baslik: 'AYM kararı' } : null),
};

test('HO1: korpusa ÇIPALANMAYAN duyuru GİREMEZ', () => {
  for (const metin of [
    'Meclis bugün yoğun bir gündemle toplandı ve tartışmalar sürdü.',
    'Ekonomi alanında yeni düzenlemeler gündemde.',
    '', 'Genel Kurul çalışmalarına devam edildi.',
  ]) {
    assert.deepEqual(korpustaMi(tanimlayiciCikar(metin), KORPUS), [],
      `çıpasız metin kabul edildi: "${metin.slice(0, 40)}"`);
  }
});

test('HO2: korpustaki kayda atıf yapan duyuru GİRER ve neye bağlandığı bilinir', () => {
  const e1 = korpustaMi(tanimlayiciCikar('7531 sayılı Kanun kapsamında yapılan düzenleme'), KORPUS);
  assert.equal(e1.length, 1);
  assert.equal(e1[0]!.tur, 'kanun');
  assert.equal(e1[0]!.deger, '7531');

  assert.equal(korpustaMi(tanimlayiciCikar('280 sıra sayılı Kanun Teklifi'), KORPUS).length, 1);
  assert.equal(korpustaMi(tanimlayiciCikar('Esas No: 2/3737'), KORPUS).length, 1);
  assert.equal(korpustaMi(tanimlayiciCikar('E.2025/122, K.2025/185 sayılı karar'), KORPUS).length, 1);
});

test('HO3: korpusta OLMAYAN numaraya atıf yeterli DEĞİL', () => {
  assert.deepEqual(korpustaMi(tanimlayiciCikar('9999 sayılı Kanun ile ilgili açıklama'), KORPUS), []);
  assert.deepEqual(korpustaMi(tanimlayiciCikar('999 sıra sayılı teklif'), KORPUS), []);
});

test('HO4: bağlamsız sayı tanımlayıcı SAYILMAZ (AYM köprüsünde ölçülen tuzak)', () => {
  const t = tanimlayiciCikar("10/1/2019 tarihli ve 30651 sayılı Resmî Gazete'de yayımlanan");
  assert.deepEqual(t.kanunNo, [], 'RG sayısı kanun numarası sanıldı');
  assert.deepEqual(tanimlayiciCikar('703 sayılı Kanun Hükmünde Kararname').kanunNo, [], 'KHK kanun sanıldı');
  const c = tanimlayiciCikar('2024 yılında 1500 kişi katıldı, 12 madde görüşüldü.');
  assert.deepEqual([c.kanunNo, c.siraSayisi, c.esasNo, c.aymEsasKarar].flat(), []);
});

test('HO5: başlık BİREBİR saklanır — özetlenmez, kısaltılmaz', () => {
  const resmi = 'Bazı Kanunlarda Değişiklik Yapılmasına Dair Kanun Teklifinin Komisyonda Görüşülmesine İlişkin Duyuru';
  assert.equal(baslikBozulmamis(resmi, resmi), true);
  assert.equal(baslikBozulmamis(resmi, resmi.slice(0, 40) + '…'), false, 'kısaltma yakalanmadı');
  assert.equal(baslikBozulmamis(resmi, 'Komisyon teklifi görüştü'), false, 'özetleme yakalanmadı');
});

function kodSatirlari(src: string): string {
  return src
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, ' ')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

test('HO6: haber yolunda AI YOK', () => {
  const olcut = kodSatirlari(readFileSync(join(KOK, 'src', 'lib', 'haberOlcut.ts'), 'utf8'));
  assert.doesNotMatch(olcut, /GoogleGenAI|@google\/genai|gemini/i, 'haber ölçütüne model karışmış');
});

test('HO7: haber yolu yalnız RESMÎ kaynaklardan besleniyor', () => {
  const izin = readFileSync(join(KOK, 'src', 'lib', 'kaynakIzin.ts'), 'utf8');
  const hostlar = [...izin.matchAll(/'([a-z0-9.]+\.gov\.tr)'/g)].map((m) => m[1]);
  assert.ok(hostlar.length >= 3, 'resmî kaynak listesi bulunamadı');
  assert.ok(hostlar.every((h) => h!.endsWith('.gov.tr')),
    `izin listesinde resmî olmayan host var: ${hostlar.join(', ')}`);
});

test('HO8: Google News / genel web kazıma yolu kapalı', () => {
  const yol = join(KOK, 'src', 'routes', 'news.ts');
  if (!existsSync(yol)) return;
  const src = kodSatirlari(readFileSync(yol, 'utf8'));
  assert.doesNotMatch(src, /news\.google\.com/, 'Google News yolu geri gelmiş');
  assert.doesNotMatch(src, /app\.post\(\s*['"]\/sorgu/, 'serbest haber arama ucu geri gelmiş');
  assert.doesNotMatch(src, /app\.post\(\s*['"]\/api\/ai\//, 'AI ucu geri gelmiş');
});

test('HO9: "sayılı Kararı/Kararname" kanun no sayılmaz — mahkeme karar-no tuzağı', () => {
  assert.deepEqual(tanimlayiciCikar('Yargıtay 9. Hukuk Dairesinin E: 2024/5139, K: 2024/6725 Sayılı Kararı').kanunNo, []);
  assert.deepEqual(tanimlayiciCikar('Danıştay 13. Dairesinin E: 2023/1, K: 2024/7089 Sayılı Kararı').kanunNo, []);
  assert.deepEqual(tanimlayiciCikar('… 2024/123 Sayılı Kararname').kanunNo, []);
});

test('HO10: GERÇEK kanun atfı hâlâ yakalanıyor (kapı fazla geniş değil)', () => {
  assert.deepEqual(tanimlayiciCikar('6772 Sayılı Kanun Kapsamına Giren Kurumlarda Çalışan İşçilere').kanunNo, ['6772']);
  assert.deepEqual(tanimlayiciCikar('3713 Sayılı Terörle Mücadele Kanununun 1 inci Maddesi').kanunNo, ['3713']);
  assert.deepEqual(
    tanimlayiciCikar('Bazı Alacakların Yeniden Yapılandırılmasına Dair 7440 Sayılı Kanun Genel Tebliği').kanunNo,
    ['7440'],
  );
});

test('HO12: BKK/Cumhurbaşkanı kararı sayısı kanun no sayılmaz — araya kurum adı giren tuzak', () => {
  assert.deepEqual(tanimlayiciCikar('2015/7456 sayılı Bakanlar Kurulu Kararı ile yürürlüğe giren').kanunNo, []);
  assert.deepEqual(tanimlayiciCikar('9432 sayılı Cumhurbaşkanı Kararı Resmî Gazete\'de yayımlandı').kanunNo, []);
  assert.deepEqual(tanimlayiciCikar('7456 sayılı Kanun ile ilgili düzenleme').kanunNo, ['7456']);
});

test('HO11: duyuru korpus çıpası ZORUNLU — atıfsız başlık girmez', () => {
  const t = tanimlayiciCikar('Merkez Bankası Faiz Kararına İlişkin Basın Duyurusu');
  assert.deepEqual(t.kanunNo, [], 'kanun atfı olmayan başlık kanun no üretmemeli');
  const bosSorgu = { kanunVarMi: () => null, siraSayisiVarMi: () => null, esasNoVarMi: () => null, aymVarMi: () => null };
  assert.deepEqual(korpustaMi(t, bosSorgu), []);
});
