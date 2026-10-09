import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  kanunAtiflari, aymNorm, torbaKararMi, esasKararAnahtari, rgSayiNorm, esastanMi, AYM_SONUC_ETIKET,
} from '../src/lib/aymKopru.js';

const db = new DatabaseSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'storage', 'analytics.db'), { readOnly: true });

test('T1: ardışık kanun atıfları KAÇMAZ (regex tüketme bugu)', () => {
  const s = "12/3/2025 tarihli ve 7531 sayılı Kanun'un 18. maddesiyle eklenen geçici madde, "
          + "4/12/2004 tarihli ve 5271 sayılı Ceza Muhakemesi Kanunu'nun 100. maddesi ve "
          + "12/3/2025 tarihli ve 7531 sayılı Kanun'un 19. maddesi";
  assert.deepEqual(kanunAtiflari(s).map((x) => x.no), ['7531', '5271', '7531']);
});

test('T2: RG sayısı / KHK / CB Kararnamesi kanun numarası SAYILMAZ', () => {
  assert.equal(kanunAtiflari("10/7/2018 tarihli ve 30474 sayılı Resmî Gazete'de yayımlanan").length, 0);
  assert.equal(kanunAtiflari('2/7/2018 tarihli ve 703 sayılı Kanun Hükmünde Kararname').length, 0);
  assert.equal(kanunAtiflari('12/2/2026 tarihli ve 193 sayılı Cumhurbaşkanlığı Kararnamesi').length, 0);
});

test('T3: tarihteki yıl kanun numarası sanılmaz', () => {
  const a = kanunAtiflari('13/12/2004 tarihli ve 5275 sayılı Ceza ve Güvenlik Tedbirlerinin İnfazı Hakkında Kanun');
  assert.deepEqual(a.map((x) => x.no), ['5275'], '2004 (tarih yılı) kanun numarası olarak yakalandı');
});

test('T4: naif kırpma sahte kanun üretmez (30651 → 3065 = KDV Kanunu)', () => {
  assert.equal(kanunAtiflari("10/1/2019 tarihli ve 30651 sayılı Resmî Gazete'de yayımlanan").length, 0);
});

test('T5: metnin ilk atfı ANA, sonrakiler metin-içi', () => {
  const a = kanunAtiflari("12/3/2025 tarihli ve 7531 sayılı Kanun'un 18. maddesiyle "
    + "4/12/2004 tarihli ve 5271 sayılı Kanun'a eklenen fıkra");
  assert.equal(a[0]!.ana, true);
  assert.equal(a[0]!.no, '7531');
  assert.equal(a[1]!.ana, false);
});

test('T6: "değişiklik öncesinde" bağlamı olumsuz işaretlenir', () => {
  const a = kanunAtiflari("12/3/2025 tarihli ve 7550 sayılı Kanun'un 9. maddesiyle yapılan değişiklik öncesinde yer alan ibare");
  assert.equal(a.length, 1);
  assert.equal(a[0]!.olumsuz, true, 'olumsuz bağlam yakalanmadı → köprü sahte kurulur');
});

test('T7: aşırı uzun / aşırı atıflı karar torba sayılır', () => {
  assert.equal(torbaKararMi('x'.repeat(5001), 2), true);
  assert.equal(torbaKararMi('kısa', 16), true);
  assert.equal(torbaKararMi('kısa', 3), false);
});

test('T8: float-string ve mojibake tuzakları kapalı', () => {
  assert.equal(rgSayiNorm('33310.0'), '33310');
  assert.equal(rgSayiNorm('33310'), '33310');
  assert.equal(esasKararAnahtari('… E:?2024/233, K:?2024/12 …'), '2024/233|2024/12');
  assert.equal(esasKararAnahtari('E: 2024/233 , K: 2024/12'), '2024/233|2024/12');
  assert.equal(esasKararAnahtari('başlıkta E/K yok'), null);
});

test('T9: sonuç etiketleri ayırt edici, ilk_ret esastan sayılmaz', () => {
  assert.equal(esastanMi('iptal'), true);
  assert.equal(esastanMi('ret'), true);
  assert.equal(esastanMi('ilk_ret'), false, 'usulden ret esas incelemesi sayılıyor → sayaç şişer');
  assert.notEqual(AYM_SONUC_ETIKET.ret, AYM_SONUC_ETIKET.ilk_ret);
  for (const v of Object.values(AYM_SONUC_ETIKET)) assert.doesNotMatch(v, /^Esas - |^İlk - /, 'ham sonuç sızmış');
});

test('T10: canlı korpusta eşleşme sayıları ölçülen bantta', () => {
  const kanunNo = new Set((db.prepare('SELECT DISTINCT kanun_no FROM teklif_sirasayisi WHERE kanun_no IS NOT NULL')
    .all() as { kanun_no: string }[]).map((r) => r.kanun_no));
  const kanunIlk = (db.prepare(
    `SELECT MIN(f.tarih) t FROM teklif_sirasayisi t2 JOIN faaliyet f ON f.id = t2.faaliyet_id
      WHERE t2.kanun_no IS NOT NULL AND f.tarih IS NOT NULL`,
  ).get() as { t: string | null }).t ?? '2015-01-01';
  const kararlar = db.prepare(
    'SELECT konu FROM aym_karar WHERE konu IS NOT NULL AND karar_tarihi >= ?',
  ).all(kanunIlk.slice(0, 10)) as { konu: string }[];
  const toplamKarar = (db.prepare('SELECT COUNT(*) c FROM aym_karar WHERE konu IS NOT NULL').get() as { c: number }).c;
  assert.ok(toplamKarar >= 600, `AYM korpusu küçülmüş: ${toplamKarar}`);
  assert.ok(kararlar.length >= 600, `pencere-içi (${kanunIlk.slice(0, 7)}→) karar az: ${kararlar.length}`);
  assert.ok(kanunNo.size >= 130, `kanun_no kümesi küçülmüş: ${kanunNo.size}`);

  let cift = 0; const kanunlar = new Set<string>();
  for (const k of kararlar) {
    const atif = kanunAtiflari(k.konu);
    if (torbaKararMi(k.konu, atif.length)) continue;
    for (const a of atif) if (!a.olumsuz && kanunNo.has(a.no)) { cift++; kanunlar.add(a.no); }
  }
  const kararBasina = cift / kararlar.length;
  assert.ok(kararBasina > 0.15 && kararBasina < 1.2,
    `karar başına eşleşme bandın dışında: ${kararBasina.toFixed(2)} (${cift} çift / ${kararlar.length} pencere-içi karar) — kural gevşemiş ya da aşırı sıkışmış olabilir`);
  assert.ok(kanunlar.size >= 18, `eşleşen kanun sayısı düşmüş: ${kanunlar.size}`);
});

test('T11: hiçbir karar birden çok kanuna bağlanmıyor', () => {
  const kararlar = db.prepare('SELECT id, konu FROM aym_karar WHERE konu IS NOT NULL').all() as { id: number; konu: string }[];
  const kanunNo = new Set((db.prepare('SELECT DISTINCT kanun_no FROM teklif_sirasayisi WHERE kanun_no IS NOT NULL')
    .all() as { kanun_no: string }[]).map((r) => r.kanun_no));
  const cokAna: string[] = [];
  for (const k of kararlar) {
    const atif = kanunAtiflari(k.konu);
    if (torbaKararMi(k.konu, atif.length)) continue;
    const es = atif.filter((a) => !a.olumsuz && kanunNo.has(a.no));
    const anaSet = new Set(es.filter((a) => a.ana).map((a) => a.no));
    if (anaSet.size > 1) cokAna.push(`karar ${k.id} → ${[...anaSet].join(', ')}`);
  }
  assert.deepEqual(cokAna, [],
    `bir kararın BİRDEN ÇOK ana kanunu var — "hangi kanun yargılandı" AYIRT EDİLEMEZ:\n  ${cokAna.join('\n  ')}`);
});

test('T12: AYM kararları RG öğesine E:/K: anahtarıyla bağlanıyor (%99+, mükerrersiz)', () => {
  const gz = db.prepare(
    `SELECT tarih, sayi, baslik FROM gazete WHERE tur = 'ANAYASA MAHKEMESİ KARARLARI'`,
  ).all() as { tarih: string; sayi: string; baslik: string }[];
  assert.ok(gz.length > 1000, `RG'de AYM satırı beklenenden az: ${gz.length} — 'tur' değeri değişmiş olabilir`);

  const idx = new Map<string, { tarih: string; sayi: string }>();
  let mukerrer = 0;
  for (const g of gz) {
    const a = esasKararAnahtari(g.baslik);
    if (!a) continue;
    if (idx.has(a)) mukerrer++; else idx.set(a, { tarih: g.tarih, sayi: rgSayiNorm(g.sayi) });
  }
  assert.equal(mukerrer, 0, `${mukerrer} mükerrer E:/K: anahtarı — hangi RG kaydı olduğu AYIRT EDİLEMEZ`);

  const rgIlk = (db.prepare("SELECT MIN(tarih) t FROM gazete WHERE tur='ANAYASA MAHKEMESİ KARARLARI'").get() as { t: string }).t;
  const ay = (db.prepare(
    `SELECT esas_no, karar_no, rg_tarihi, rg_sayisi FROM aym_karar WHERE rg_tarihi IS NOT NULL AND rg_tarihi <> ''`,
  ).all() as { esas_no: string; karar_no: string; rg_tarihi: string; rg_sayisi: string }[])
    .filter((k) => k.rg_tarihi >= rgIlk);
  assert.ok(ay.length > 300, `pencere içi rg_tarihi dolu karar az: ${ay.length}`);

  let bagli = 0, ikisiDeTutmaz = 0;
  const kotu: string[] = [];
  for (const k of ay) {
    const g = idx.get(`${k.esas_no}|${k.karar_no}`);
    if (!g) continue;
    bagli++;
    const tarihTutar = g.tarih === k.rg_tarihi;
    const sayiTutar = rgSayiNorm(g.sayi) === rgSayiNorm((k as { rg_sayisi?: string }).rg_sayisi);
    if (!tarihTutar && !sayiTutar) { ikisiDeTutmaz++; if (kotu.length < 5) kotu.push(`E:${k.esas_no} K:${k.karar_no}`); }
  }
  const oran = bagli / ay.length;
  assert.ok(oran >= 0.95, `öğe köprüsü zayıflamış: %${(100 * oran).toFixed(1)} (RG'de yayımlanmış ${ay.length} kararın ${bagli}'i bağlandı; ölçüm %98,9)`);
  assert.equal(ikisiDeTutmaz, 0,
    `${ikisiDeTutmaz} eşleşmede HEM tarih HEM sayı tutmuyor — anahtar eşleşmesi şüpheli:\n  ${kotu.join('\n  ')}`);
});
