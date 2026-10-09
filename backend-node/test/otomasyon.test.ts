import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const KOK = join(dirname(fileURLToPath(import.meta.url)), '..');

function kodSatirlari(src: string): string {
  return src
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, ' ')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

const indexKodu = kodSatirlari(readFileSync(join(KOK, 'src', 'index.ts'), 'utf8'));

const ZORUNLU_ADIMLAR: { ad: string; desen: RegExp; neden: string }[] = [
  { ad: 'incremental', desen: /\bincremental\s*\(/, neden: 'kanun/önerge/konuşma korpusu' },
  { ad: 'scrapeImzalar', desen: /\bscrapeImzalar\s*\(/, neden: 'imzacı listesi' },
  { ad: 'ingestOylama', desen: /\bingestOylama\s*\(/, neden: 'oylama agregatı — SIFIR ağ isteği, bedava' },
  { ad: 'ingestOy', desen: /\bingestOy\s*\(/, neden: 'vekil bazlı oy dökümü' },
  { ad: 'cekSirasayisi', desen: /\bcekSirasayisi\s*\(/, neden: 'S.Sayısı köprüsü — AYM halkasının anahtarı' },
  { ad: 'doldurBasilmisUrl', desen: /\bdoldurBasilmisUrl\s*\(/, neden: 'kanıt PDF linki' },
  { ad: 'ingestAymParti', desen: /\bingestAymParti\s*\(/, neden: 'AYM siyasi parti kararları — banka HİÇ çekilmiyordu' },
  { ad: 'ingestDuyuru', desen: /\bingestDuyuru\s*\(/, neden: 'duyuru eki — kanunun RG izi, SIFIR ağ isteği' },
  { ad: 'ingestVekilKomisyon', desen: /\bingestVekilKomisyon\s*\(/, neden: 'komisyon halkasının içi — üye kompozisyonu' },
  { ad: 'ingestOnergeCevapOrneklem', desen: /\bingestOnergeCevapOrneklem\s*\(/, neden: 'cevap süresi — denetimin tek nicel ölçüsü' },
];

test('OT1: gecelik zincir, siteyi besleyen TÜM adımları içeriyor', () => {
  const eksik = ZORUNLU_ADIMLAR.filter((a) => !a.desen.test(indexKodu));
  assert.deepEqual(
    eksik.map((a) => `${a.ad} (${a.neden})`), [],
    'Gecelik zincirden adım DÜŞMÜŞ. Bu sessiz bir bozulmadır: site çalışmaya devam eder, yalnız ' +
      'ilgili kart zamanla bayatlar ve kimse fark etmez.',
  );
});

test('OT2: kaçırılan gece telafisi kurulu', () => {
  assert.match(indexKodu, /gecikmisIseKostur\s*\(/, 'açılışta gecikme kontrolü çağrılmıyor');
  assert.match(indexKodu, /etl_durum/, 'gecikme kontrolü son koşma damgasını okumuyor');
});

test('OT3: zincirdeki her adımın hatası İZOLE (bir halka koparsa diğerleri koşar)', () => {
  assert.match(indexKodu, /async function geceliKZinciri/, 'zincir ayrı fonksiyona alınmamış');
  const zincir = indexKodu.slice(indexKodu.indexOf('async function geceliKZinciri'));
  assert.match(zincir, /catch/, 'zincirde adım bazlı hata yakalama yok');
});

test('OT4: TBMM\'ye giden adımlar eşzamanlılık kapısından geçiyor', () => {
  const zincir = indexKodu.slice(indexKodu.indexOf('async function geceliKZinciri'));
  assert.match(zincir, /tbmmGate/, 'gecelik zincir TBMM kapısını kullanmıyor — WAF riski');
});
