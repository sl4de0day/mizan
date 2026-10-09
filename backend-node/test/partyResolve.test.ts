import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normParti, cleanStr, toStandardKey, resolveByNameIl, PARTI_DISI, PARTI_MAP } from '../src/lib/partyResolve.js';
import { DEPUTY_MASTER_LIST } from '../src/lib/deputies.js';

test('normParti sentinel etiketleri BOZMAZ (TR harf katlaması sızıntısı)', () => {
  for (const s of PARTI_DISI) {
    assert.equal(normParti(s), s, `sentinel '${s}' normParti'den geçince değişti — PARTI_DISI_SQL'i deler`);
  }
});

test('sentinel etiketleri cleanStr ile ÇAKIŞMIYOR (gelecekteki bölünme)', () => {
  for (const s of PARTI_DISI) {
    const katlanmis = cleanStr(s);
    if (katlanmis === s) continue;
    assert.equal(
      normParti(katlanmis), katlanmis,
      `'${katlanmis}' ('${s}'nin katlanmışı) normParti'de sessizce '${s}'ye dönüşmemeli — ` +
      `ama sentinel'in KENDİSİ de asla '${katlanmis}' üretmemeli (üstteki test)`,
    );
  }
});

test('normParti bilinen partileri kanonik anahtara indirir', () => {
  assert.equal(normParti('AK PARTİ'), 'AKP');
  assert.equal(normParti('ADALET VE KALKINMA PARTİSİ'), 'AKP');
  assert.equal(normParti('CUMHURİYET HALK PARTİSİ'), 'CHP');
  assert.equal(normParti('İYİ PARTİ'), 'IYI');
  assert.equal(normParti('YEŞİL SOL PARTİ'), 'DEM');
  assert.equal(normParti('HDP'), 'DEM');
});

test('normParti tanınmayan partiyi ham adıyla döndürür — ASLA null/boş', () => {
  for (const ham of ['MEMLEKET PARTİSİ', 'ZAFER PARTİSİ', 'DEVA', 'BBP', 'YENİLİK PARTİSİ']) {
    const r = normParti(ham);
    assert.ok(r && r.length > 0, `'${ham}' → boş/null döndü; fallback zincirini tetikler`);
    assert.notEqual(r, 'AKP', `'${ham}' → AKP: tanınmayan parti iktidar partisine çözülemez`);
  }
});

test('normParti boş girdide Bilinmiyor döner (parti UYDURMAZ)', () => {
  for (const bos of ['', '   ', null, undefined]) {
    assert.equal(normParti(bos), 'Bilinmiyor');
  }
});

test('toStandardKey tanımadığına null döner (normParti passthrough yapabilsin)', () => {
  assert.equal(toStandardKey(cleanStr('MEMLEKET PARTİSİ')), null);
  assert.equal(toStandardKey(cleanStr('AK PARTİ')), 'AKP');
});

test('PARTI_MAP — hiçbir alias yanlış partiye çözülmüyor (substring çakışması)', () => {
  for (const [std, aliaslar] of Object.entries(PARTI_MAP)) {
    for (const a of aliaslar) {
      const bulunan = toStandardKey(cleanStr(a));
      assert.equal(
        bulunan, std.toUpperCase(),
        `'${a}' → '${bulunan}' olmalıydı '${std.toUpperCase()}'. toStandardKey ilk eşleşmede dönüyor ` +
        `→ tablo sırası yanlış ya da bir alias başka partinin alias'ını içeriyor.`,
      );
    }
  }
});

test('register eşlemesi — roster kısa yazımı ile TBMM uzun yazımı aynı partiye iner', () => {
  const olculmus: [string, string][] = [
    ['AK Parti',             'ADALET VE KALKINMA PARTİSİ'],
    ['CHP',                  'CUMHURİYET HALK PARTİSİ'],
    ['MHP',                  'MİLLİYETÇİ HAREKET PARTİSİ'],
    ['İYİ Parti',            'İYİ PARTİ'],
    ['HDP',                  'HALKLARIN DEMOKRATİK PARTİSİ'],
    ['TİP',                  'TÜRKİYE İŞÇİ PARTİSİ'],
    ['YENİDEN REFAH',        'YENİDEN REFAH PARTİSİ'],
    ['HÜDA PAR',             'HÜR DAVA PARTİSİ'],
    ['EMEP',                 'EMEK PARTİSİ'],
    ['DSP',                  'DEMOKRATİK SOL PARTİ'],
    ['DBP',                  'DEMOKRATİK BÖLGELER PARTİSİ'],
    ['DP',                   'DEMOKRAT PARTİ'],
    ['DEVA',                 'DEMOKRASİ VE ATILIM PARTİSİ'],
    ['BBP',                  'BÜYÜK BİRLİK PARTİSİ'],
    ['MEMLEKET Partisi',     'MEMLEKET PARTİSİ'],
    ['ZAFER Partisi',        'ZAFER PARTİSİ'],
    ['DEM PARTİ',            'YEŞİLLER VE SOL GELECEK PARTİSİ'],
  ];
  for (const [roster, tbmm] of olculmus) {
    assert.equal(
      normParti(tbmm), normParti(roster),
      `BÖLÜNME: roster '${roster}' → '${normParti(roster)}' ama TBMM '${tbmm}' → '${normParti(tbmm)}'. ` +
      `Aynı parti iki ayrı etiket olur ve payı bölünür.`,
    );
  }
});

test('tablo/ortak.js sentinel aynası backend PARTI_DISI ile tutarlı', async () => {
  const { readFile } = await import('node:fs/promises');
  const yol = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tablo', 'ortak.js');
  const kaynak = await readFile(yol, 'utf8');
  const m = /const PARTI_DISI = new Set\(\[([^\]]*)\]\)/.exec(kaynak);
  assert.ok(m, "ortak.js'te PARTI_DISI Set'i bulunamadı — ayna kayboldu ya da adı değişti");
  const frontendSet = new Set([...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!));
  for (const s of PARTI_DISI) {
    assert.ok(
      frontendSet.has(s),
      `Backend sentinel '${s}' ortak.js aynasında YOK → frontend o etiketi parti gibi gösterir`,
    );
  }
});

test('resolveByNameIl belirsiz/eksik girdide parti UYDURMAZ', () => {
  assert.equal(resolveByNameIl('', 'Ankara', 28), 'Bilinmiyor', 'boş ad');
  assert.equal(resolveByNameIl('AB', 'Ankara', 28), 'Bilinmiyor', '<4 harf guard');
  assert.equal(resolveByNameIl('BÖYLE BİR VEKİL YOK', 'Ankara', 28), 'Bilinmiyor', 'eşleşme yok');
  assert.equal(resolveByNameIl('Mehmet Ali ÇELEBİ', 'İzmir', 999), 'Bilinmiyor', 'dönem yok');
});

test('YSP tam adı DEM\'e iner — GELECEK\'e DEĞİL (uzunluk > sıra)', () => {
  assert.equal(normParti('YEŞİLLER VE SOL GELECEK PARTİSİ'), 'DEM');
  assert.equal(normParti('YESILLER VE SOL GELECEK PARTISI'), 'DEM');
  assert.equal(normParti('GELECEK PARTİSİ'), 'GELECEK');
});

test('alias eşlemesi tablo SIRASINA bağlı değil (uzunluk kuralı)', () => {
  const tumAlias = Object.entries(PARTI_MAP).flatMap(([std, a]) => a.map((x) => ({ std: std.toUpperCase(), c: cleanStr(x) })));
  for (const uzun of tumAlias) {
    for (const kisa of tumAlias) {
      if (uzun.std === kisa.std || uzun.c === kisa.c) continue;
      if (!uzun.c.includes(kisa.c)) continue;
      assert.equal(
        toStandardKey(uzun.c), uzun.std,
        `'${uzun.c}' → '${toStandardKey(uzun.c)}' ama '${uzun.std}' olmalı. ` +
        `'${kisa.c}' (${kisa.std}) onu içeriden kaçırıyor — uzunluk kuralı bozulmuş.`,
      );
    }
  }
});

test('resolveByNameIl — soyad-only + il, TEKİL eşleşme çözülür (arşiv sarması kurtarma)', () => {
  const dep = DEPUTY_MASTER_LIST.find((d) => String(d.donem) === '28' && d.ad_soyad.includes(' ') && d.il);
  assert.ok(dep, 'test için d28 vekili yok');
  const soyad = dep!.ad_soyad.split(' ').pop();
  const r = resolveByNameIl(soyad, dep!.il, 28);
  const adas = DEPUTY_MASTER_LIST.filter((d) => String(d.donem) === '28' && cleanStr(d.il ?? '') === cleanStr(dep!.il) && (cleanStr(d.ad_soyad).endsWith(' ' + cleanStr(soyad)) || cleanStr(d.ad_soyad) === cleanStr(soyad)));
  if (adas.length === 1) assert.notEqual(r, 'Bilinmiyor', `tekil soyad+il çözülmeliydi: ${soyad}/${dep!.il}`);
});

test('resolveByNameIl — soyad-only İL YOK → parti UYDURMAZ', () => {
  const dep = DEPUTY_MASTER_LIST.find((d) => String(d.donem) === '28' && d.ad_soyad.includes(' '));
  const soyad = dep!.ad_soyad.split(' ').pop();
  assert.equal(resolveByNameIl(soyad, '', 28), 'Bilinmiyor', 'il olmadan soyad-only çözülmemeli');
});

test('resolveByNameIl — TAM ad hâlâ çözülüyor (ters-kapsama mevcut davranışı bozmadı)', () => {
  const dep = DEPUTY_MASTER_LIST.find((d) => String(d.donem) === '28' && d.il);
  assert.notEqual(resolveByNameIl(dep!.ad_soyad, dep!.il, 28), 'Bilinmiyor');
});
