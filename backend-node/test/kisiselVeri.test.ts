import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const KOK = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJE = join(KOK, '..');

function kodSatirlari(src: string): string {
  return src
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, ' ')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

const CIKARSAMA_ALANLARI = ['cinsiyet', 'dogum_yili', 'ogrenim_durumu', 'meslek', 'anahtar_kelimeler'];
const SAKLANMAZ = ['iletisim', 'biyografi_paragraflar'];

test('KV1: milletvekili motoru LLM ile kişisel veri ÇIKARSAMIYOR', () => {
  const src = kodSatirlari(readFileSync(join(KOK, 'src', 'engines', 'milletvekili.ts'), 'utf8'));
  assert.doesNotMatch(src, /GoogleGenAI|@google\/genai/,
    'milletvekili motoru yeniden bir LLM istemcisi import ediyor — kişisel veri çıkarsama riski geri geldi');
  assert.doesNotMatch(src, /runAiAnalysis|runFallbackAnalysis/,
    'çıkarsama fonksiyonları geri gelmiş');
  assert.doesNotMatch(src, /annendir|annesidir/,
    'özgeçmiş metninden cinsiyet çıkaran kural geri gelmiş (yöntem farklı, sorun aynı)');
});

test('KV2: saklanan profil YALNIZCA kütüksel alanları içerir', () => {
  const dizin = join(KOK, 'storage', 'milletvekili_cache');
  if (!existsSync(dizin)) return;
  const sorun: string[] = [];
  for (const f of readdirSync(dizin).filter((x) => x.endsWith('.json'))) {
    let j: Record<string, unknown>;
    try { j = JSON.parse(readFileSync(join(dizin, f), 'utf8')); } catch { continue; }
    for (const k of [...CIKARSAMA_ALANLARI, ...SAKLANMAZ]) if (k in j) sorun.push(`${f}: ${k}`);
  }
  assert.deepEqual(sorun, [],
    `Profil cache'inde saklanmaması gereken alan(lar):\n  ${sorun.join('\n  ')}\n` +
      'Çıkarsanmış alanlar kişiye yanlış iddia atfeder; iletişim/biyografi alanları ise ' +
      'hiçbir yerde kullanılmıyor (amaçla sınırlılık). Kamuya açık olmak SAKLAMAYI gerektirmez.');
});

test('KV3: vekil kütüğünde çıkarsanmış alan yok, kütüksel alanlar TAM', () => {
  const yol = join(PROJE, 'deputy_master_list.json');
  if (!existsSync(yol)) return;
  const arr = JSON.parse(readFileSync(yol, 'utf8')) as Record<string, unknown>[];
  assert.ok(arr.length > 3000, `kütük beklenmedik biçimde küçük: ${arr.length}`);

  const kacak = CIKARSAMA_ALANLARI.filter((k) => arr.some((d) => k in d));
  assert.deepEqual(kacak, [],
    `Kütükte çıkarsanmış alan(lar): ${kacak.join(', ')} — bunlar TBMM kaydından değil, ` +
      'özgeçmişin bir LLM tarafından yorumlanmasından gelir.');

  for (const k of ['ad_soyad', 'parti', 'il', 'donem']) {
    const dolu = arr.filter((d) => d[k] !== undefined && d[k] !== null && d[k] !== '').length;
    assert.equal(dolu, arr.length, `kütüksel alan '${k}' eksik: ${dolu}/${arr.length}`);
  }
  assert.ok(arr.filter((d) => d.photo).length > 500, 'fotoğraf alanı kaybolmuş — o çıkarsama değildi');
});

test('KV4: uydurma girdiye dayalı demografi ucu yayımlanmıyor', () => {
  const src = kodSatirlari(readFileSync(join(KOK, 'src', 'routes', 'milletvekiliStats.ts'), 'utf8'));
  assert.doesNotMatch(src, /app\.get\(\s*['"]\/api\/milletvekili\/comparative-stats/,
    'parti demografisi ucu geri gelmiş — girdisi LLM çıkarsamasıydı ve bilinmeyeni ERKEK sayıyordu');
  assert.doesNotMatch(src, /genders\.ERKEK\s*\+=/,
    'bilinmeyen cinsiyeti ERKEK sayan desen geri gelmiş (yanlılık yönü sabit, gürültü değil)');
});
