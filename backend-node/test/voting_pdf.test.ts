import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { oyCoz, kapiGecti, parseCetvel, type OzetKutusu, type OyKaydi } from '../src/lib/votingPdf.js';

test('T1 oyCoz — düz jetonlar', () => {
  assert.equal(oyCoz('Kabul'), 'Kabul');
  assert.equal(oyCoz('Ret'), 'Ret');
  assert.equal(oyCoz('Çekimser'), 'Çekimser');
  assert.equal(oyCoz('Katılmadı'), 'Katılmadı');
  assert.equal(oyCoz('Mük.'), 'Mük.');
});

test('T1b oyCoz — dipnotlu/birleşik jeton (4 satır bu yüzden düşüyordu)', () => {
  assert.equal(oyCoz('Kabul²/Mük.¹'), 'Kabul');
  assert.equal(oyCoz('Ret¹'), 'Ret');
  assert.equal(oyCoz(' Kabul² '), 'Kabul');
});

test('T1c oyCoz — oy OLMAYAN metin null döner (parti/il/ad jetonu oy sanılmasın)', () => {
  for (const s of ['AK PARTİ', 'Adana', 'Zabun', '', 'Kabulü', 'Sıra Sayısı'])
    assert.equal(oyCoz(s), null, `"${s}" oy sanıldı`);
});

const kutu = (k: number, r: number, c: number): OzetKutusu => ({
  sira_sayisi: '162', uye: 600, kabul: k, ret: r, cekimser: c,
  bos: 0, gecersiz: 0, mukerrer: 7, toplam: k + r + c + 7, acik_uyelik: 7,
});
const oyla = (kabul: number, ret: number, cek: number): OyKaydi[] => [
  ...Array.from({ length: kabul }, (_, i) => ({ il: 'X', soyad: `K${i}`, ad: 'A', parti: 'P', oy: 'Kabul' })),
  ...Array.from({ length: ret }, (_, i) => ({ il: 'X', soyad: `R${i}`, ad: 'A', parti: 'P', oy: 'Ret' })),
  ...Array.from({ length: cek }, (_, i) => ({ il: 'X', soyad: `C${i}`, ad: 'A', parti: 'P', oy: 'Çekimser' })),
];

test('T2 kapı — birebir uyuşma GEÇER', () => {
  assert.equal(kapiGecti(kutu(311, 248, 1), oyla(311, 248, 1)), true);
});

test('T2b kapı — TEK oy sapması bile KALIR (yanlış atıf yazılmasın)', () => {
  assert.equal(kapiGecti(kutu(311, 248, 1), oyla(310, 248, 1)), false, 'kabul 1 eksik geçti');
  assert.equal(kapiGecti(kutu(311, 248, 1), oyla(311, 247, 1)), false, 'ret 1 eksik geçti');
  assert.equal(kapiGecti(kutu(311, 248, 1), oyla(311, 248, 0)), false, 'çekimser 1 eksik geçti');
  assert.equal(kapiGecti(kutu(311, 248, 1), oyla(312, 248, 1)), false, 'kabul 1 fazla geçti');
  assert.equal(kapiGecti(kutu(311, 248, 1), []), false, 'boş cetvel geçti');
});

test('T2c kapı — Katılmadı sayıma girmez (kutu yalnız oy KULLANANLARI sayar)', () => {
  const ile = [...oyla(311, 248, 1), { il: 'X', soyad: 'Y', ad: 'A', parti: 'P', oy: 'Katılmadı' }];
  assert.equal(kapiGecti(kutu(311, 248, 1), ile), true);
});

const FIX = '/tmp/claude-1000/-home-sl4de-Desk-siyasisiteprojesi-main/8b71b0ae-5c70-4e97-83b2-43aef105d511/scratchpad/bas.pdf';

test('T3 canlı PDF — 593 vekil + iki oylama da kutuyu BİREBİR üretir', { skip: !existsSync(FIX) }, async () => {
  const r = await parseCetvel(new Uint8Array(readFileSync(FIX)));
  assert.equal(r.ozetler.length, 2, 'iki özet kutusu bekleniyordu');

  const b162 = r.ozetler.find((o) => o.sira_sayisi === '162')!;
  assert.equal(b162.kabul + b162.ret + b162.cekimser + b162.bos + b162.gecersiz + b162.mukerrer, b162.toplam);
  assert.deepEqual([b162.kabul, b162.ret, b162.cekimser, b162.mukerrer, b162.toplam], [311, 248, 1, 7, 567]);

  for (const o of r.ozetler) {
    const oylar = r.oylar.get(`S. S. ${o.sira_sayisi}`) ?? [];
    assert.equal(oylar.length, o.uye - o.acik_uyelik, `S.S.${o.sira_sayisi}: vekil sayısı`);
    assert.ok(kapiGecti(o, oylar), `S.S.${o.sira_sayisi}: KAPI KALDI`);
  }
});

test('T3b canlı PDF — sabit parti listesi YOK: küçük partiler de gelir (10 satır bu yüzden düşüyordu)',
  { skip: !existsSync(FIX) }, async () => {
    const r = await parseCetvel(new Uint8Array(readFileSync(FIX)));
    const oylar = r.oylar.get('S. S. 162')!;
    const partiler = new Set(oylar.map((o) => o.parti));
    for (const p of ['YENİDEN REFAH', 'DBP', 'GELECEK PARTİSİ', 'DEVA', 'SAADET PARTİSİ'])
      assert.ok(partiler.has(p), `${p} cetvelde yok — sabit parti listesi geri mi geldi?`);
    assert.equal(oylar.filter((o) => o.parti === 'AK PARTİ').length, 272);
  });

test('T3c canlı PDF — vekil kimliği dolu (il/soyad/ad boş kalırsa oy sahipsiz kalır)',
  { skip: !existsSync(FIX) }, async () => {
    const oylar = (await parseCetvel(new Uint8Array(readFileSync(FIX)))).oylar.get('S. S. 162')!;
    for (const o of oylar.slice(0, 50)) {
      assert.ok(o.il && o.soyad && o.ad && o.parti, `eksik kimlik: ${JSON.stringify(o)}`);
    }
  });
