import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDetailed, keywordSkorlari } from '../src/lib/taxonomy.js';
import { modelKategorileri } from '../src/lib/nb.js';

test('override — model-dışı sınıfa güçlü keyword NB kararını ezer', () => {
  const uretebilir = modelKategorileri();
  if (uretebilir.size === 0) return;

  for (const [metin, beklenen] of [
    ['Van Büyükşehir Belediyesine kayyum atanmasına ilişkin', 'Yerel Yönetim'],
    ['6 Şubat 2023 Kahramanmaraş depremi enkaz AFAD çalışmaları', 'Afet & Acil Durum'],
    ['Diyanet İşleri Başkanlığı cami cemevi ibadethane', 'Din & İnanç'],
  ] as const) {
    if (uretebilir.has(beklenen)) continue;
    const d = classifyDetailed(metin, { kaynak: 'onerge' });
    assert.equal(d.cat, beklenen, `'${metin}' → ${d.cat} (${d.kaynak}), beklenen ${beklenen}`);
    assert.equal(d.kaynak, 'keyword', 'override çıktısı keyword kaynağı taşımalı (tahmin, altın değil)');
  }
});

test('override — ALTIN etiket (muhatap) HER ZAMAN override\'ı yener', () => {
  const d = classifyDetailed('Büyükşehir belediyeleri tarafından yapılan yol çalışması', {
    kaynak: 'onerge', muhatapId: 'df0a4762-181e-4ea4-86d7-01888f8b8f00', donem: 28,
  });
  assert.notEqual(d.kaynak, undefined);
});

test('override — model üretebilen sınıfa keyword NB\'yi EZMEZ', () => {
  const uretebilir = modelKategorileri();
  if (uretebilir.size === 0) return;
  const ks = keywordSkorlari('vergi düzenlemesi ekonomik istikrar');
  for (const c of Object.keys(ks)) {
    if (!uretebilir.has(c)) continue;
    assert.ok(ks[c]! > 0);
  }
});
