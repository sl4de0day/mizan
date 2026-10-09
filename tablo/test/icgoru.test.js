import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  icgoruYasama, notYasama, icgoruCesaret, icgoruCesaretKonu, icgoruRankKonu, icgoruRankParti, icgoruAyrisma, icgoruOylama, icgoruOy, icgoruDonemler, secVeSirala, nf, pf, kirpmaNot, farkAyirtEdilebilir, etiketKokeniNot,
  cesaretAyrim, CESARET_ESIK, olcekNot, boslukNot, USUL, usulNot,
} from '../ortak.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORTAK = join(HERE, '..', 'ortak.js');

const YASAMA = {
  success: true,
  toplam_kanunlasti: 87,
  partiler: [
    { parti: 'CHP', toplam: 1185, kanunlasti: 0, komisyonda: 1183, gundemde: 0 },
    { parti: 'DEM', toplam: 425, kanunlasti: 0, komisyonda: 424, gundemde: 0 },
    { parti: 'AKP', toplam: 186, kanunlasti: 80, komisyonda: 52, gundemde: 51 },
    { parti: 'MHP', toplam: 83, kanunlasti: 0, komisyonda: 83, gundemde: 0 },
  ],
};

const CESARET = {
  success: true, parti: 'CHP', yeterli: true, konusmaN: 8232, belgeN: 20938, ortusme: 74.8,
  kategoriler: [
    { kategori: 'Ekonomi & Finans', soylem: 26.2, eylem: 14.7, fark: -11.5, konusma: 2156, belge: 3084 },
    { kategori: 'Çevre & Tarım', soylem: 14.8, eylem: 15.6, fark: 0.8, konusma: 1220, belge: 3271 },
    { kategori: 'Adalet & Hukuk', soylem: 12.8, eylem: 6.8, fark: -6, konusma: 1055, belge: 1422 },
    { kategori: 'Din & İnanç', soylem: 40, eylem: 1, fark: -39, konusma: 24, belge: 11 },
  ],
};
const CESARET_KONU = {
  success: true, kategori: 'Ekonomi & Finans',
  data: [
    { parti: 'DP', soylem: 44.7, eylem: 18.8, fark: -25.9, konusmaN: 47, belgeN: 112, konusmaK: 21, belgeK: 21 },
    { parti: 'YENIDEN REFAH', soylem: 31.4, eylem: 15, fark: -16.4, konusmaN: 220, belgeN: 447, konusmaK: 69, belgeK: 67 },
    { parti: 'YENI YOL', soylem: 27.3, eylem: 16.9, fark: -10.4, konusmaN: 1580, belgeN: 2213, konusmaK: 431, belgeK: 374 },
  ],
};
const DONEMLER = {
  success: true, parti: 'CHP', aktif_donem: 28,
  donemler: [
    { donem: 26, n: 25119, ilk: '2015-11-02', son: '2018-05-16', yil: 2.5, kategoriler: { 'Ekonomi & Finans': 18.1, 'Çevre & Tarım': 10.8, 'Eğitim': 10.7 } },
    { donem: 27, n: 48242, ilk: '2018-07-02', son: '2023-05-05', yil: 4.8, kategoriler: { 'Ekonomi & Finans': 19.2, 'Çevre & Tarım': 11.6, 'Eğitim': 9.3 } },
    { donem: 28, n: 20938, ilk: '2023-06-08', son: '2026-07-03', yil: 3.1, kategoriler: { 'Ekonomi & Finans': 14.7, 'Çevre & Tarım': 15.6, 'Eğitim': 8.0 } },
  ],
};

const OY = {
  success: true, oylama_n: 68, toplam_oylama: 129, ilk: '2023-07-05', son: '2026-04-02',
  partiler: [
    { parti: 'AKP', kabul: 14471, ret: 492, cekimser: 2, katilmadi: 3268, vekil: 284 },
    { parti: 'CHP', kabul: 1000, ret: 2367, cekimser: 17, katilmadi: 5595, vekil: 146 },
    { parti: 'MHP', kabul: 1658, ret: 50, cekimser: 0, katilmadi: 1577, vekil: 53 },
    { parti: 'DEM', kabul: 138, ret: 836, cekimser: 132, katilmadi: 2745, vekil: 62 },
  ],
};

const OYLAMA = {
  success: true,
  ozet: { toplam: 129, cekismeli: 103, oybirligi: 26, ilk: '2023-07-05', son: '2026-07-02', ret_ortanca: 19.661016949152543 },
};

const RANK_ADALET = [
  { p: 'DEM', pct: 33.3, n: 5323, d: 15984 },
  { p: 'TIP', pct: 18.9, n: 210, d: 1111 },
  { p: 'CHP', pct: 12.1, n: 2550, d: 21070 },
];
const RANK_EKONOMI = [
  { p: 'YENI YOL', pct: 16.8, n: 374, d: 2225 },
  { p: 'BAGIMSIZ', pct: 15.4, n: 49, d: 318 },
  { p: 'CHP', pct: 14.6, n: 3084, d: 21070 },
];

const takas = (s) => s.replaceAll('CHP', '@@').replaceAll('AKP', 'CHP').replaceAll('@@', 'AKP');

test('T1 eşdeğişim — CHP↔AKP takası çıktıya birebir yansır', () => {
  const j2 = JSON.parse(takas(JSON.stringify(YASAMA)));
  assert.equal(icgoruYasama(j2, 'AKP'), takas(icgoruYasama(YASAMA, 'CHP')));
  assert.equal(icgoruYasama(j2, 'CHP'), takas(icgoruYasama(YASAMA, 'AKP')));
});

test('T1b eşdeğişim — lider argmax\'tır, sabit parti adı değil', () => {
  const j = JSON.parse(JSON.stringify(YASAMA));
  j.partiler.find((r) => r.parti === 'AKP').kanunlasti = 0;
  j.partiler.find((r) => r.parti === 'MHP').kanunlasti = 80;
  assert.match(icgoruYasama(j, 'CHP'), /80<\/b> tanesi MHP imzalı/);
});

test('T2 iskelet — yalnız belgelenmiş 2 dal üretilir', () => {
  const iskelet = (s) => s.replace(/<b>[^<]*<\/b>/g, '#').replace(/\b(CHP|AKP|DEM|MHP)\b/g, 'P');
  const set = new Set(YASAMA.partiler.map((r) => iskelet(icgoruYasama(YASAMA, r.parti))));
  assert.equal(set.size, 2, `beklenmeyen iskelet sayısı: ${[...set].join(' ||| ')}`);
});

const YASAK = [
  /\bçünkü\b/i, /\bnedeniyle\b/i, /\bsayesinde\b/i, /\byüzünden\b/i, /\bdolayısıyla\b/i,
  /\bbu nedenle\b/i, /\bbu yüzden\b/i, /\bdemek ki\b/i, /gösteriyor ki/i,
  /\bbaşarılı\b/i, /\bbaşarısız\b/i, /\betkili\b/i, /\betkisiz\b/i, /\bverimli\b/i, /\byetersiz\b/i,
  /\bsamimi\b/i, /\btutarsız\b/i, /\bçelişki/i, /\ben iyi\b/i, /\ben kötü\b/i, /\bbelirgin\b/i,
  /\brağmen\b/i, /\boysa\b/i, /\baslında\b/i, /\bgerçekte\b/i, /\bmaalesef\b/i, /\bne yazık ki\b/i,
];
const lintle = (s, etiket) => {
  if (s == null) return;
  const duz = s.replace(/<[^>]+>/g, '');
  for (const re of YASAK) assert.ok(!re.test(duz), `[${etiket}] YASAKLI KALIP ${re} → "${duz}"`);
};

test('T3 lint — üretilen TÜM içgörü cümleleri temiz', () => {
  for (const r of YASAMA.partiler) lintle(icgoruYasama(YASAMA, r.parti), 'yasama:' + r.parti);
  lintle(icgoruCesaret(CESARET, 'CHP'), 'cesaret');
  lintle(icgoruCesaretKonu(CESARET_KONU, 'Ekonomi & Finans'), 'cesaret-konu');
  lintle(icgoruRankKonu(RANK_ADALET, 'Adalet & Hukuk'), 'rank-konu');
  lintle(icgoruRankParti([{ k: 'Adalet & Hukuk', pct: 33.3 }, { k: 'Ekonomi & Finans', pct: 12.1 }], 'DEM'), 'rank-parti');
  lintle(icgoruAyrisma({ 'Adalet & Hukuk': 33.3 }, { 'Adalet & Hukuk': 12.1 }, ['Adalet & Hukuk'], 'DEM', 'CHP'), 'ayrisma');
  lintle(icgoruOylama(OYLAMA), 'oylama');
  lintle(icgoruOylama({ ...OYLAMA, ozet: { ...OYLAMA.ozet, cekismeli: 129, oybirligi: 0 } }), 'oylama:ob-sifir');
  for (const r of OY.partiler) lintle(icgoruOy(OY, r.parti), 'oy:' + r.parti);
  lintle(icgoruDonemler(DONEMLER, 'CHP'), 'donemler');
});

test('T1d eşdeğişim — dönemler: CHP↔AKP takası çıktıya birebir yansır', () => {
  const j2 = JSON.parse(takas(JSON.stringify(DONEMLER)));
  assert.equal(icgoruDonemler(j2, 'AKP'), takas(icgoruDonemler(DONEMLER, 'CHP')));
});

test('T2d — DEĞİŞİM FİİLİ YOK: sayılar çıplak yan yana, yön iddiası edilmez', () => {
  const s = icgoruDonemler(DONEMLER, 'CHP').replace(/<[^>]+>/g, '');
  for (const fiil of [/\bçıktı\b/i, /\bartt[ıi]\b/i, /\bd[üu]şt[üu]\b/i, /\by[üu]kseldi\b/i,
    /\bgeriledi\b/i, /\bazald[ıi]\b/i, /\bdeğişti\b/i, /\bkayd[ıi]\b/i])
    assert.ok(!fiil.test(s), `değişim/yön fiili: ${fiil} → "${s}"`);
});

test('T4e suskunluk — dönemler: taban altı / tek dönem / anlamsız fark → null', () => {
  assert.equal(icgoruDonemler(null, 'CHP'), null);
  assert.equal(icgoruDonemler({ success: false }, 'CHP'), null);
  assert.equal(icgoruDonemler({ success: true, donemler: [] }, 'CHP'), null);
  assert.equal(icgoruDonemler({ ...DONEMLER, donemler: [DONEMLER.donemler[0]] }, 'CHP'), null);
  const az = { ...DONEMLER, donemler: DONEMLER.donemler.map((d) => ({ ...d, n: 127 })) };
  assert.equal(icgoruDonemler(az, 'CHP'), null);
});

test('T5e — fark ÖRNEKLEME DUYARLI kapıdan geçer (sabit puan eşiği DEĞİL)', () => {
  const kur = (n) => ({
    success: true, parti: 'X', donemler: [
      { donem: 27, n, yil: 4.8, kategoriler: { 'Ekonomi & Finans': 10.0 } },
      { donem: 28, n, yil: 3.1, kategoriler: { 'Ekonomi & Finans': 14.0 } },
    ],
  });
  assert.ok(icgoruDonemler(kur(20000), 'X'), 'n=20.000\'de 4 puanlık fark ANLAMLI — basılmalı');
  assert.equal(icgoruDonemler(kur(320), 'X'), null, 'n=320\'de 4 puanlık fark GÜRÜLTÜ — susmalı');
});

test('nokta kontrol — dönemler cümlesi (canlı sayılar)', () => {
  const s = icgoruDonemler(DONEMLER, 'CHP').replace(/<[^>]+>/g, '');
  assert.match(s, /en çok ayrışan konu Çevre & Tarım/);
  assert.match(s, /26\. Dönem %10,8 · 27\. Dönem %11,6 · 28\. Dönem %15,6/);
  assert.match(s, /en büyük fark 4,8 puan/);
  for (const adet of ['25.119', '48.242', '20.938', '25119', '48242', '20938'])
    assert.ok(!s.includes(adet), `cümlede HAM ADET var (${adet}) — dönem uzunluğu tuzağı: "${s}"`);
});

test('T1c eşdeğişim — oy: CHP↔AKP takası çıktıya birebir yansır', () => {
  const j2 = JSON.parse(takas(JSON.stringify(OY)));
  assert.equal(icgoruOy(j2, 'AKP'), takas(icgoruOy(OY, 'CHP')));
  assert.equal(icgoruOy(j2, 'CHP'), takas(icgoruOy(OY, 'AKP')));
});

test('T2c iskelet — oy: belgelenmiş dal sayısını aşmaz', () => {
  const iskelet = (s) => s.replace(/<b>[^<]*<\/b>/g, '#').replace(/\b(CHP|AKP|DEM|MHP)\b/g, 'P');
  const set = new Set(OY.partiler.map((r) => iskelet(icgoruOy(OY, r.parti))));
  assert.equal(set.size, 1, `beklenmeyen iskelet: ${[...set].join(' ||| ')}`);
  const retSifir = iskelet(icgoruOy({ ...OY, partiler: [{ parti: 'X', kabul: 500, ret: 0, cekimser: 0, katilmadi: 10, vekil: 5 }] }, 'X'));
  assert.match(retSifir, /hiçbiri ret değil/);
});

test('T4d suskunluk — oy: taban altı / bozuk veride null', () => {
  assert.equal(icgoruOy(null, 'CHP'), null);
  assert.equal(icgoruOy({ success: false }, 'CHP'), null);
  assert.equal(icgoruOy({ success: true, partiler: [], oylama_n: 68 }, 'CHP'), null);
  assert.equal(icgoruOy({ ...OY, oylama_n: 0 }, 'CHP'), null);
  assert.equal(icgoruOy(OY, 'YOK_PARTI'), null);
  const az = { ...OY, partiler: [{ parti: 'Z', kabul: 50, ret: 49, cekimser: 0, katilmadi: 3, vekil: 2 }] };
  assert.equal(icgoruOy(az, 'Z'), null);
});

test('nokta kontrol — oy cümlesi (canlı sayılar)', () => {
  const s = icgoruOy(OY, 'CHP').replace(/<[^>]+>/g, '');
  assert.match(s, /68 açık oylamada 3\.384 oy kullandı/);
  assert.match(s, /2\.367 tanesi ret, 1\.000 tanesi kabul/);
  assert.match(s, /5\.595 kez oy kullanılmadı/);
  assert.match(s, /ret payı %17,7; CHP için bu pay %69,9/);
  assert.ok(!/%[\d,]+'[a-zıiuü]/.test(s), `sayıya ek yapışmış (Türkçe ek tuzağı): "${s}"`);
  assert.ok(!s.includes('%26,4'), 'katılmadı paydaya karışmış');
});

test('T2b iskelet — oylama yalnız belgelenmiş 2 dal üretir (oybirliği var/yok)', () => {
  const iskelet = (s) => s.replace(/<[^>]+>/g, '').replace(/[\d.,]+/g, '#');
  const varsa = iskelet(icgoruOylama(OYLAMA));
  const yoksa = iskelet(icgoruOylama({ ...OYLAMA, ozet: { ...OYLAMA.ozet, cekismeli: 129, oybirligi: 0 } }));
  assert.notEqual(varsa, yoksa);
  assert.match(varsa, /# tanesi oybirliğiyle sonuçlandı/);
  assert.match(yoksa, /hiçbiri oybirliğiyle sonuçlanmadı/);
});

test('T4c suskunluk — oylama: bozuk/eksik/tutarsız veride null', () => {
  assert.equal(icgoruOylama(null), null);
  assert.equal(icgoruOylama({ success: false }), null);
  assert.equal(icgoruOylama({ success: true, ozet: { toplam: 0 } }), null);
  assert.equal(icgoruOylama({ success: true, ozet: { toplam: 129, cekismeli: 100, oybirligi: 26 } }), null);
});

test('nokta kontrol — oylama cümlesi (canlı sayılar)', () => {
  const s = icgoruOylama(OYLAMA).replace(/<[^>]+>/g, '');
  assert.match(s, /kayda geçen 129 açık oylamanın 103 tanesinde ret oyu kullanıldı/);
  assert.match(s, /26 tanesi oybirliğiyle sonuçlandı/);
  assert.match(s, /yarısında ret oranı %19,7 ya da daha az/);
  assert.ok(!/ortalama/.test(s), 'ortanca "ortalama" diye yanlış adlandırılmış');
  for (const p of ['CHP', 'AKP', 'DEM', 'MHP', 'İYİ']) assert.ok(!s.includes(p), `oylama cümlesinde parti adı: ${p}`);
});

test('T4 suskunluk — yetersiz/bozuk veride null döner', () => {
  assert.equal(icgoruYasama(null, 'CHP'), null);
  assert.equal(icgoruYasama({ success: false }, 'CHP'), null);
  assert.equal(icgoruYasama({ success: true, partiler: [] }, 'CHP'), null);
  assert.equal(icgoruYasama(YASAMA, 'YOK_PARTI'), null);
  assert.equal(icgoruYasama({ ...YASAMA, toplam_kanunlasti: 0 }, 'CHP'), null);
  const hicKanun = { success: true, toplam_kanunlasti: 5, partiler: [{ parti: 'X', toplam: 10, kanunlasti: 0, komisyonda: 10, gundemde: 0 }] };
  assert.equal(icgoruYasama(hicKanun, 'X'), null);
});

test('nokta kontrol — CHP cümlesi (0 kanunlaştı dalı)', () => {
  const s = icgoruYasama(YASAMA, 'CHP');
  assert.match(s, /^CHP <b>1\.185<\/b> kanun teklifi verdi; hiçbiri kanunlaşmadı/);
  assert.match(s, /<b>1\.183<\/b> tanesi komisyonda bekliyor/);
  assert.match(s, /kanunlaşan <b>87<\/b> teklifin <b>80<\/b> tanesi AKP imzalı/);
  assert.match(s, /<b>7<\/b> tanesinde parti kaydı yok/);
});

test('nokta kontrol — AKP cümlesi (>0 kanunlaştı dalı)', () => {
  const s = icgoruYasama(YASAMA, 'AKP');
  assert.match(s, /^AKP <b>186<\/b> kanun teklifi verdi; <b>80<\/b> tanesi kanunlaştı/);
  assert.match(s, /<b>52<\/b> tanesi komisyonda bekliyor/);
});

test('kayitsiz — Bilinmiyor kaydı yoksa cümleciği hiç çıkmaz', () => {
  const tam = { ...YASAMA, toplam_kanunlasti: 80 };
  assert.ok(!icgoruYasama(tam, 'CHP').includes('parti kaydı yok'));
});

test('T5 taban — cesaret argmax taban-altı kategoriye oturmaz', () => {
  const s = icgoruCesaret(CESARET, 'CHP');
  assert.match(s, /Ekonomi/);
  assert.ok(!s.includes('Din'), 'taban-altı kategori taçlandırıldı');
});

test('T5b taban — cesaret-konu DP\'yi (konusmaN=47) taçlandırmaz', () => {
  const s = icgoruCesaretKonu(CESARET_KONU, 'Ekonomi & Finans');
  assert.ok(!s.includes('DP'), 'taban-altı parti (n=47) taçlandırıldı');
  assert.match(s, /YENIDEN REFAH/);
});

test('T5c rank — fark-kapısı: Adalet basar, Ekonomi susar', () => {
  const a = icgoruRankKonu(RANK_ADALET, 'Adalet & Hukuk');
  assert.match(a, /DEM/); assert.match(a, /%33,3/); assert.match(a, /TIP/); assert.match(a, /%18,9/);
  assert.equal(icgoruRankKonu(RANK_EKONOMI, 'Ekonomi & Finans'), null);
});

test('T5d ayrışma — eşik altında susar, sıfat kullanmaz', () => {
  assert.equal(icgoruAyrisma({ K: 10 }, { K: 10.5 }, ['K'], 'A', 'B'), null);
  const s = icgoruAyrisma({ K: 33.3 }, { K: 12.1 }, ['K'], 'A', 'B');
  assert.match(s, /21,2 puan/);
});

test('T4b suskunluk — yeni içgörüler de yetersiz veride null', () => {
  assert.equal(icgoruCesaret({ ...CESARET, yeterli: false }, 'CHP'), null);
  assert.equal(icgoruCesaret(null, 'CHP'), null);
  assert.equal(icgoruCesaretKonu({ success: true, data: [] }, 'X'), null);
  assert.equal(icgoruRankKonu([], 'X'), null);
  assert.equal(icgoruRankKonu([{ p: 'A', pct: 50, n: 500 }], 'X'), null);
  assert.equal(icgoruRankParti([], 'CHP'), null);
  assert.equal(icgoruAyrisma({}, {}, [], 'A', 'B'), null);
});

test('nf/pf — TR biçimi', () => {
  assert.equal(nf(1185), '1.185');
  assert.equal(pf(74.8), '74,8');
  assert.equal(pf(11.53), '11,5');
});

test('M6 — kırpma, ölçünün bir ucunu listeden ELEYEMEZ', () => {
  const rows = [
    { p: 'DEV', toplam: 1000, kanunlasti: 0 },
    { p: 'BUYUK2', toplam: 900, kanunlasti: 0 },
    { p: 'BUYUK3', toplam: 800, kanunlasti: 0 },
    { p: 'ORTA1', toplam: 700, kanunlasti: 0 },
    { p: 'ORTA2', toplam: 600, kanunlasti: 0 },
    { p: 'IKTIDAR', toplam: 500, kanunlasti: 80 },
    { p: 'KUCUK1', toplam: 40, kanunlasti: 0 },
    { p: 'KUCUK2', toplam: 30, kanunlasti: 0 },
    { p: 'MINI', toplam: 3, kanunlasti: 1 },
  ];
  const secilen = secVeSirala(rows, { buyukluk: (r) => r.toplam, olcu: (r) => r.kanunlasti, n: 6 })
    .map((r) => r.p);

  for (const p of ['DEV', 'BUYUK2', 'BUYUK3', 'ORTA1', 'ORTA2', 'IKTIDAR']) {
    assert.ok(secilen.includes(p), `en büyük 6'dan '${p}' düşmüş: ${secilen.join(',')}`);
  }
  assert.ok(!secilen.includes('MINI'), `n=3'lük parti ölçü sayesinde listeye girdi: ${secilen.join(',')}`);
  assert.equal(secilen[0], 'IKTIDAR', `sıra ölçüye göre değil: ${secilen.join(',')}`);

  const eski = rows.slice().sort((a, b) => b.kanunlasti - a.kanunlasti || b.toplam - a.toplam).slice(0, 6).map((r) => r.p);
  assert.ok(eski.includes('MINI') && !eski.includes('ORTA2'),
    `kurgu yanlılığı üretmiyor → test hiçbir şey kilitlemiyor. eski=${eski.join(',')}`);
});

test('M6 — eşdeğişim: parti adları permüte edilince seçim AYNEN takip eder (M3)', () => {
  const rows = [
    { p: 'A', toplam: 100, kanunlasti: 5 },
    { p: 'B', toplam: 90, kanunlasti: 0 },
    { p: 'C', toplam: 80, kanunlasti: 2 },
  ];
  const takas = (s) => (s === 'A' ? 'B' : s === 'B' ? 'A' : s);
  const d = { buyukluk: (r) => r.toplam, olcu: (r) => r.kanunlasti, n: 2 };
  const duz = secVeSirala(rows, d).map((r) => takas(r.p));
  const takasli = secVeSirala(rows.map((r) => ({ ...r, p: takas(r.p) })), d).map((r) => r.p);
  assert.deepEqual(duz, takasli, 'seçim parti adına bağlı — M3 eşdeğişimi kırık');
});

test('notYasama — M2 temiz + M3 eşdeğişim + "Dönem-28" sabiti YOK', () => {
  const j28 = { ...YASAMA, donem: '28' };
  const c = notYasama(j28);
  assert.ok(c, 'notYasama null döndü');
  const duz = c.replace(/<[^>]+>/g, '');
  for (const re of [...YASAK, /iktidar/i, /muhalefet/i, /olsa da/i, /neredeyse/i, /sabit/i])
    assert.ok(!re.test(duz), `notYasama'da yasaklı kalıp ${re}: "${duz}"`);
  assert.ok(!/Dönem-?28|28\. [Dd]önem/.test(duz), 'notYasama "Dönem-28" sabitini içeriyor');
  const c2 = notYasama(JSON.parse(takas(JSON.stringify(j28))));
  assert.equal(c2, takas(c), 'notYasama M3 eşdeğişimini geçmiyor (sabit parti adı var)');
});

test('notYasama — yetersiz veride null (suskunluk)', () => {
  assert.equal(notYasama({ success: false }), null);
  assert.equal(notYasama({ success: true, partiler: [] }), null);
  assert.equal(notYasama({ success: true, partiler: YASAMA.partiler, toplam_kanunlasti: 0 }), null);
});

test('M5 — .cnote metinlerinde tek-yönlü rol mazereti / yanlı sabit iddia YOK', () => {
  const dosyalar = ['parti.html', 'konu.html', 'index.html', 'karsilastir.html'];
  const YASAK_CNOTE = [
    /neredeyse tamamı iktidar partisinin/i,
    /iktidar partileri denetim.*yerine/i,
    /iktidar denetim.*yerine.*kullanabilir/i,
    /muhalefet teklifleri.*olsa da/i,
    /Dönem-28'de kanunlaşan/i,
  ];
  for (const dosya of dosyalar) {
    const src = readFileSync(join(HERE, '..', dosya), 'utf8');
    for (const re of YASAK_CNOTE) {
      assert.ok(!re.test(src), `${dosya}: yasaklı .cnote kalıbı geri geldi: ${re}`);
    }
  }
});

test('kirpmaNot — ek soğuran kalıp, her birim adında bozuk Türkçe üretmez', () => {
  for (const birim of ['parti', 'konu', 'vekil', 'oylama', 'kurum', 'satır']) {
    const m = kirpmaNot(5, 17, { birim });
    assert.ok(m.includes(`17 ${birim} arasından`), `"${birim}" için ek soğuran kalıp kullanılmamış: ${m.slice(0, 60)}`);
    assert.ok(!new RegExp(`${birim}(dan|den|tan|ten)\\b`).test(m), `"${birim}" için şablon EK yapıştırmış (ünlü uyumu kırılır)`);
  }
});

test('kirpmaNot — kırpma yokken SUSAR, varken gizlenen payı söyler', () => {
  assert.equal(kirpmaNot(17, 17, { birim: 'parti' }), '', 'kırpma yokken not basılmamalı');
  assert.equal(kirpmaNot(20, 17, { birim: 'parti' }), '', 'gösterilen toplamdan fazlaysa not basılmamalı');
  const m = kirpmaNot(9, 16, { birim: 'konu', gizliPay: 12.9 });
  assert.ok(m.includes('%12,9'), 'gizlenen pay yazılmamış');
  assert.match(m, /“gösterilmiyor” ile “yok” aynı şey değildir/, 'kırpmanın anlamı açıklanmamış');
});

test('farkAyirtEdilebilir — büyük tabanda küçük fark geçer, küçük tabanda geçmez', () => {
  assert.equal(farkAyirtEdilebilir(10.3, 20584, 9.1, 20584), true, 'büyük tabanda gerçek fark susturulmuş');
  assert.equal(farkAyirtEdilebilir(10.3, 705, 9.1, 664), false, 'küçük tabanda gürültü liderlik ilan ediyor');
  assert.equal(farkAyirtEdilebilir(9.1, 664, 10.3, 705), farkAyirtEdilebilir(10.3, 705, 9.1, 664), 'kapı sıraya duyarlı');
  assert.equal(farkAyirtEdilebilir(5, 0, 5, 100), false, 'sıfır tabanda karar veriyor');
});

test('lint — hiçbir sayfada şablona yapıştırılmış Türkçe ek yok', () => {
  const dosyalar = ['index.html', 'parti.html', 'konu.html', 'karsilastir.html', 'vekil.html', 'arac.html', 'ortak.js'];
  const ihlal = [];
  for (const f of dosyalar) {
    const satirlar = readFileSync(join(HERE, '..', f), 'utf8').split('\n');
    satirlar.forEach((s, i) => {
      if (/^\s*(\/\/|\*|<!--)/.test(s)) return;
      const temiz = s.replace(/<\/?[a-z][^>]*>/gi, '');
      if (/\$\{[^}]*\}'[iıuü]\b/.test(temiz)) ihlal.push(`${f}:${i + 1} → ${s.trim().slice(0, 90)}`);
      if (/\$\{[^}]*\}'(lik|lık|luk|lük)\b/.test(temiz)) ihlal.push(`${f}:${i + 1} → ${s.trim().slice(0, 90)}`);
      if (/\$\{[^}]*\}(dan|den|tan|ten|da|de|ta|te)\b/.test(temiz)) ihlal.push(`${f}:${i + 1} → ${s.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(ihlal, [], `şablona ek yapıştırılmış (ünlü uyumu kırılır):\n  ${ihlal.join('\n  ')}`);
});

test('cesaretAyrim — eşik tek kaynakta, içgörüyle rozet asla çelişmez', () => {
  assert.equal(cesaretAyrim(CESARET_ESIK - 0.1), null, 'eşik altında yön iddia ediliyor');
  assert.equal(cesaretAyrim(-(CESARET_ESIK - 0.1)), null, 'eşik altında (negatif) yön iddia ediliyor');
  assert.equal(cesaretAyrim(CESARET_ESIK), 'eylem', 'eşikte eylem yönü verilmiyor');
  assert.equal(cesaretAyrim(-CESARET_ESIK), 'soz', 'eşikte söz yönü verilmiyor');
  for (const f of [3.0, 3.9, 4.7, 5.9, 6.1, 7.5]) {
    assert.ok(cesaretAyrim(f), `fark ${f}: içgörü konuşur ama rozet susuyor — kart kendi kendisiyle çelişir`);
    assert.ok(cesaretAyrim(-f), `fark -${f}: aynı çelişki ters yönde`);
  }
  assert.equal(cesaretAyrim(null), null);
  assert.equal(cesaretAyrim(NaN), null);
  assert.equal(cesaretAyrim(undefined), null);
});

test('lint — söz/eylem rozeti eşiği koda gömmez, ortak kuraldan geçer', () => {
  const ihlal = [];
  for (const f of ['parti.html', 'konu.html']) {
    const src = readFileSync(join(HERE, '..', f), 'utf8');
    src.split('\n').forEach((s, i) => {
      if (/^\s*\/\//.test(s)) return;
      if (/\bf\s*[<>]\s*-?\d+(\.\d+)?\s*\?/.test(s)) ihlal.push(`${f}:${i + 1} → ${s.trim().slice(0, 80)}`);
    });
    assert.match(src, /cesaretAyrim\(/, `${f}: rozet ortak kuraldan geçmiyor`);
  }
  assert.deepEqual(ihlal, [], `rozet eşiği koda gömülmüş (içgörüyle sapar):\n  ${ihlal.join('\n  ')}`);
});

test('USUL — her tanım hem NE olduğunu hem NEDEN önemli olduğunu söyler', () => {
  const anahtarlar = Object.keys(USUL);
  assert.ok(anahtarlar.length >= 5, 'sözlük çok dar');
  for (const k of anahtarlar) {
    const t = USUL[k];
    assert.ok(t.length > 60, `${k}: tanım çok kısa, "neden önemli" kısmı eksik olabilir`);
    assert.match(t, /değil|demektir|sayılmaz|geçmez|gelmez|aynı şey/i,
      `${k}: yalnız tanım var, okurun yapacağı YANLIŞ çıkarımı önleyen kısım yok`);
    assert.doesNotMatch(t, /başarılı|etkili|yetersiz|maalesef|ne yazık|iyi ki/i, `${k}: değer yargısı içeriyor`);
  }
});

test('usulNot — birden çok terim birleştirilebilir, bilinmeyen anahtar sessizce düşer', () => {
  const iki = usulNot('hukumsuz', 'intikal');
  assert.ok(iki.includes('Hükümsüz') && iki.includes('intikal'), 'iki tanım birleşmiyor');
  assert.equal(usulNot('boyleBirSeyYok'), '', 'bilinmeyen anahtar gürültü üretiyor');
  assert.equal(usulNot(), '', 'argümansız çağrı boş dönmeli');
});

test('lint — konu yüzdesi paydası partiToplam DEĞİL, payın geldiği küme olmalı', () => {
  const src = readFileSync(join(HERE, '..', 'karsilastir.html'), 'utf8');
  const fn = src.match(/function konular\(p\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fn, 'konular() bulunamadı — sözleşme denetlenemiyor');
  assert.doesNotMatch(fn[0], /DATA\.partiToplam/,
    'konular() paydayı partiToplam\'dan alıyor: pay tarihli kayıtlardan, payda tam sayımdan gelir ' +
    've yüzdeler %100\'e toplanmaz (ölçüldü: AKP %84,7). Payda, payı üreten kümenin kendisi olmalı.');
  assert.match(fn[0], /konuKumeToplam/,
    'konular() paydayı konu kümesi toplamından almıyor');
  assert.match(src, /const nA = konuKumeToplam\(selA\)/,
    'gürültü testi tabanı yüzdenin geldiği kümeden alınmıyor');
});
