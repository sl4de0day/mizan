import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backendHazir } from './_canli.js';

const B = 'http://localhost:8000/api/ozet';
const canli = await backendHazir();

const jj = async (u: string) => (await fetch(B + u)).json() as Promise<Record<string, unknown>>;

function doluMu(j: Record<string, unknown>): boolean {
  return Object.values(j).some((v) => Array.isArray(v) && v.length > 0);
}

const UCLAR: string[] = [
  '/muhatap-cevap?donem=26',
  '/muhatap-cevap?donem=27',
  '/muhatap-cevap?donem=28',
  '/onerge-durum?donem=26',
  '/onerge-durum?donem=28',
  '/yasama?donem=26',
  '/yasama?donem=28',
  '/kanunlar?donem=26',
  '/kanunlar?donem=28',
  '/yargi?donem=28',
  '/yururluk?donem=28',
];

test('SB1: geçerli istekte BOŞ dönen uç, boşluğun SEBEBİNİ beyan eder', { skip: !canli && 'backend kapalı' }, async () => {
  const sessiz: string[] = [];
  for (const u of UCLAR) {
    const j = await jj(u);
    if (j.success !== true) continue;
    if (doluMu(j)) continue;
    const sebep = j.sebep ?? j.aciklama ?? j.neden;
    if (!sebep || String(sebep).trim().length < 20) sessiz.push(u);
  }
  assert.deepEqual(
    sessiz, [],
    `Sessizce boş dönen uç(lar): ${sessiz.join(' · ')}\n` +
      'Geçerli parametreyle boş dönmek meşru OLABİLİR — ama nedeni yazılmadan meşru olamaz. ' +
      'UI boş kart çizdiğinde okur "hiç olmamış" sanar; oysa alan boş ya da çekim kesilmiş olabilir. ' +
      'Yanıta `sebep` alanı ekle (en az bir cümle, neyin neden yok olduğunu söyleyen).',
  );
});

test('SB2: muhatap boşluğu ÖLÇÜLEREK beyan ediliyor (sayı uydurulmuyor)', { skip: !canli && 'backend kapalı' }, async () => {
  const d26 = await jj('/muhatap-cevap?donem=26') as { kapsanan: number; muhatapsiz: number; sebep: string | null; toplam: number };
  assert.equal(d26.kapsanan, 0, 'd26 beklenmedik biçimde kurum kapsıyor — test varsayımı eskimiş olabilir');
  assert.ok(d26.sebep, 'd26 boş dönüyor ama sebep beyan edilmemiş');
  assert.ok(d26.muhatapsiz > 0, 'muhatapsız kayıt sayısı ölçülmemiş');
  assert.equal(d26.muhatapsiz, d26.toplam, 'd26 kayıtlarının TAMAMI muhatapsız olmalıydı (ölçüm: 30.611/30.611)');
  assert.match(d26.sebep, /HESAPLANAMAZ|hesaplanamaz/, 'beyan, ölçünün neden üretilemediğini söylemiyor');

  const d28 = await jj('/muhatap-cevap?donem=28') as { kapsanan: number; sebep: string | null };
  assert.ok(d28.kapsanan > 1000, 'd28 kurum kapsamı beklenenden az');
  assert.equal(d28.sebep, null, 'veri varken de sebep dönüyor — çekince enflasyonu');
});

test('KC1: konu×cevapsızlık yalnız BAĞIMSIZ etiketli dönemleri kapsar (d28 tautolojik)', { skip: !canli && 'backend kapalı' }, async () => {
  const j = await jj('/konu-cevap') as {
    donemler: number[]; konular: { konu: string; toplam: number; hic_pay: number }[];
    taban: number; taban_alti: { konu_n: number; kayit_n: number }; beyan: string;
  };
  assert.deepEqual(j.donemler, [26, 27],
    'kapsam değişmiş — d28 eklendiyse kesişim TAUTOLOJİK olur (kategori muhataptan türüyor)');
  assert.ok(j.konular.length >= 8, `konu sayısı az: ${j.konular.length}`);

  assert.ok(j.taban >= 100, 'taban çok düşük, oranlar gürültü olur');
  assert.ok(typeof j.taban_alti?.konu_n === 'number', 'taban altında kalanlar beyan edilmiyor');
  for (const k of j.konular) assert.ok(k.toplam >= j.taban, `${k.konu} taban altında yayımlanmış`);

  assert.match(j.beyan, /TAHMİN|tahmin/, 'konu etiketinin tahmin olduğu beyan edilmemiş');
  assert.match(j.beyan, /partisine hiçbir atıf/i, 'parti-nötrlük beyan edilmemiş');
  assert.match(j.beyan, /28\. dönem/, 'd28\'in neden dışarıda olduğu yazılmamış');
});

test('EK1: kapı, doğrulanabilirliği KAYNAK bazında ayrıştırıyor', { skip: !canli && 'backend kapalı' }, async () => {
  const j = await fetch(`${B}/parti-konu?donem=28`).then((r) => r.json()) as {
    etiket_kaynagi?: { kaynaklar?: { kaynak: string; toplam: number; altin: number; pay: number }[];
      kaynak_uyarisi?: string | null; altin_pay?: number };
  };
  const ek = j.etiket_kaynagi;
  assert.ok(ek, 'etiket_kaynagi yok');
  assert.ok(Array.isArray(ek.kaynaklar) && ek.kaynaklar.length > 0,
    'kaynak kırılımı yok — havuzlanmış oran, kanun etiketlerinin %0 doğrulanabilirliğini gizler');
  const kanun = ek.kaynaklar!.find((k) => k.kaynak === 'kanun');
  const onerge = ek.kaynaklar!.find((k) => k.kaynak === 'onerge');
  assert.ok(kanun && onerge, 'iki kaynak da kırılımda olmalı');
  assert.equal(kanun!.altin, 0,
    'kanun teklifinde altın etiket ÇIKTI — muhatap taşımadığı varsayımı çürüdü, kapı gözden geçirilmeli');
  if (onerge!.altin > 0) {
    assert.ok(ek.kaynak_uyarisi, 'kaynak farkı beyan edilmiyor — okur tek orana bakıp hepsini doğrulanmış sanar');
    assert.match(ek.kaynak_uyarisi!, /muhatab/i, 'uyarı, altın etiketin nereden geldiğini açıklamıyor');
  }
});
