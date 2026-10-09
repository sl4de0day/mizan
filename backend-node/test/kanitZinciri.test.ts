import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backendHazir } from './_canli.js';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DB_YOL = join(dirname(fileURLToPath(import.meta.url)), '..', 'storage', 'analytics.db');
const db = new DatabaseSync(DB_YOL, { readOnly: true });
const B = 'http://localhost:8000/api/ozet';
const canli = await backendHazir();

type Cift = { ss: string; birlesim: string; t_kabul: number; c_kabul: number; t_ret: number; c_ret: number };

const ciftler = db.prepare(
  `SELECT o.sira_sayisi AS ss, o.birlesim_id AS birlesim,
          o.kabul AS t_kabul, o.ret AS t_ret,
          SUM(CASE WHEN v.oy='Kabul' THEN 1 ELSE 0 END) AS c_kabul,
          SUM(CASE WHEN v.oy='Ret'   THEN 1 ELSE 0 END) AS c_ret
     FROM oylama o JOIN oy v
       ON v.birlesim_id = o.birlesim_id AND v.sira_sayisi = o.sira_sayisi
    WHERE o.sira_sayisi <> '' AND o.sira_sayisi <> '0'
    GROUP BY o.birlesim_id, o.sira_sayisi`,
).all() as Cift[];

const celiskili = ciftler.filter((c) => c.t_kabul !== c.c_kabul || c.t_ret !== c.c_ret);

test('K1: iki kaynak çelişkisi ölçülebilir durumda (kaynaklardan biri sessizce düşmemiş)', () => {
  assert.ok(ciftler.length >= 20, `özet+döküm çifti beklenmedik biçimde az: ${ciftler.length} (kaynaklardan biri mi düştü?)`);
  assert.ok(
    celiskili.length > 0,
    'Hiç çelişki yok — bu İYİ HABER OLABİLİR ama sessizce olmamalı. ' +
      'İki kaynak gerçekten uyuştuysa bu testi ve kanun.html:celiskiNot beyanını GÜNCELLE.',
  );
});

test('K2: kanun-hikaye ucu çelişkiyi beyan eder (sessizce tek sayı göstermez)', { skip: !canli && 'backend kapalı' }, async () => {
  const hedef = celiskili[0];
  assert.ok(hedef, 'çelişkili çift bulunamadı (K1 zaten uyarır)');

  const r = await fetch(`${B}/kanun-hikaye?ss=${encodeURIComponent(hedef.ss)}&donem=28`);
  const j = await r.json() as { bulundu?: boolean; oy?: { celiski?: { tutanak: { kabul: number }; cetvel: { kabul: number }; fark: { kabul: number } } } };
  if (!j.bulundu) return;

  const c = j.oy?.celiski;
  assert.ok(c, `ss=${hedef.ss}: tutanak ${hedef.t_kabul} kabul, cetvel ${hedef.c_kabul} kabul — uç ÇELİŞKİYİ BEYAN ETMİYOR`);
  assert.equal(c.tutanak.kabul, hedef.t_kabul, 'beyan edilen tutanak sayısı DB ile uyuşmuyor');
  assert.equal(c.cetvel.kabul, hedef.c_kabul, 'beyan edilen cetvel sayısı DB ile uyuşmuyor');
  assert.equal(c.fark.kabul, hedef.c_kabul - hedef.t_kabul, 'fark yanlış hesaplanmış');
});

test('K3: dökümdeki toplam, ÖZETİN birleşimine ait satırlardan gelir', { skip: !canli && 'backend kapalı' }, async () => {
  const hedef = celiskili[0] ?? ciftler[0];
  const r = await fetch(`${B}/kanun-hikaye?ss=${encodeURIComponent(hedef.ss)}&donem=28`);
  const j = await r.json() as { bulundu?: boolean; oy?: { partiler?: { kabul: number; ret: number; cekimser: number }[] } };
  if (!j.bulundu || !j.oy?.partiler?.length) return;

  const top = j.oy.partiler.reduce((a, b) => a + b.kabul, 0);
  assert.equal(
    top, hedef.c_kabul,
    `ss=${hedef.ss}: uç ${top} kabul döküyor, o birleşimin cetvelinde ${hedef.c_kabul} var — ` +
      'döküm başka birleşim(ler)den satır topluyor olabilir (dönem/birleşim kapısı düşmüş).',
  );
});

test('K4: faaliyet.tarih (kanun) = teklifin VERİLİŞ tarihi, kanunlaşma tarihi DEĞİL', () => {
  const satir = db.prepare(
    `SELECT f.tarih AS ftarih, t.gelis_tarihi AS gelis
       FROM teklif_sirasayisi t JOIN faaliyet f ON f.id = t.faaliyet_id
      WHERE t.gelis_tarihi IS NOT NULL AND f.tarih IS NOT NULL`,
  ).all() as { ftarih: string; gelis: string }[];
  assert.ok(satir.length >= 50, `karşılaştırılacak kayıt az (${satir.length}) — gelis_tarihi çekilmemiş olabilir`);

  const ayni = satir.filter((r) => r.ftarih === r.gelis).length;
  assert.equal(
    ayni, satir.length,
    `${satir.length - ayni} kayıtta faaliyet.tarih ≠ gelis_tarihi. Bu alanın anlamı değişmiş ` +
      'olabilir — süre/kronoloji hesabı yapan her yer gözden geçirilmeli.',
  );

  const gunler = satir.map((r) => Math.round((Date.parse(r.ftarih) - Date.parse(r.gelis)) / 86_400_000));
  assert.ok(
    gunler.every((g) => g === 0),
    'faaliyet.tarih − gelis_tarihi sıfırdan farklı çıktı; bu farkı SÜRE sanan kod yanlış ölçer.',
  );
});

test('K5: teklif → oylama süresi ölçülebilir ve makul (sıfır/negatif değil)', () => {
  const s = db.prepare(
    `SELECT t.gelis_tarihi AS g, MIN(o.tarih) AS oy
       FROM teklif_sirasayisi t
       JOIN oylama o ON o.sira_sayisi = t.sira_sayisi
                    AND o.tarih >= t.gelis_tarihi
                    AND o.tarih <= date(t.gelis_tarihi, '+3 years')
      WHERE t.gelis_tarihi IS NOT NULL AND t.kanun_no IS NOT NULL
      GROUP BY t.faaliyet_id`,
  ).all() as { g: string; oy: string }[];
  assert.ok(s.length >= 50, `süre hesaplanabilen kanun az (${s.length})`);

  const gun = s.map((r) => Math.round((Date.parse(r.oy) - Date.parse(r.g)) / 86_400_000)).sort((a, b) => a - b);
  assert.ok(gun.every((g) => g >= 0), 'oylama tarihi gelişten ÖNCE çıkan kayıt var — eşleşme yanlış');
  const ortanca = gun[Math.floor(gun.length / 2)]!;
  assert.ok(ortanca > 5 && ortanca < 1100, `süre ortancası şüpheli: ${ortanca} gün`);
});

test('K6: vekil dökümü olan oylamada kanıt PDF linki var', { skip: !canli && 'backend kapalı' }, async () => {
  const kapsam = db.prepare(
    `SELECT COUNT(DISTINCT o.birlesim_id) AS oylu,
            COUNT(DISTINCT CASE WHEN y.basilmis_url IS NOT NULL AND y.basilmis_url <> '' THEN o.birlesim_id END) AS linkli
       FROM oy o LEFT JOIN oylama y ON y.birlesim_id = o.birlesim_id`,
  ).get() as { oylu: number; linkli: number };
  assert.ok(kapsam.oylu > 0, 'oy dökümü olan birleşim yok — test konusuz');
  assert.equal(
    kapsam.linkli, kapsam.oylu,
    `${kapsam.oylu} birleşimin ${kapsam.linkli}'inde kanıt linki var. Eksikse "kim nasıl oy verdi" ` +
      'iddiası kaynağına kadar izlenemez. Doldurmak için: npm run basilmis-url',
  );

  const ss = (db.prepare(
    `SELECT t.sira_sayisi AS ss FROM teklif_sirasayisi t
      WHERE EXISTS (SELECT 1 FROM oy o WHERE o.sira_sayisi = t.sira_sayisi) LIMIT 1`,
  ).get() as { ss: string } | undefined)?.ss;
  if (!ss) return;
  const j = await (await fetch(`${B}/kanun-hikaye?ss=${encodeURIComponent(ss)}`)).json() as
    { oy?: { durum: string; kanit_pdf: string | null } };
  if (j.oy?.durum !== 'var') return;
  assert.ok(j.oy.kanit_pdf, `ss=${ss}: vekil dökümü var ama kanıt PDF linki yok`);
  assert.match(j.oy.kanit_pdf, /\/Basilmis\/.*\.pdf$/i, 'kanıt linki basılmış cetvel PDF\'i değil');
});
