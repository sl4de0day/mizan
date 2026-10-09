import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpeeches } from '../src/lib/minuteParse.js';

const UZUN_METIN = 'Sayın Başkan, değerli milletvekilleri; bu konuda görüşlerimi paylaşmak istiyorum. '
  + 'Ülkemizin ekonomik durumu, tarım politikaları ve sosyal güvenlik sistemi üzerine önemli '
  + 'değerlendirmeler yapmamız gerekiyor. Bu bağlamda hükûmetin attığı adımları değerlendirmek '
  + 'istiyorum. Teşekkür ederim Sayın Başkan, hepinize saygılar sunuyorum.';

test('parseSpeeches — d28 deseni (başlık+konuşma tek satırda) hâlâ doğru çalışıyor (regresyon)', () => {
  const metin = `ALİ DİNÇER (Ankara) – ${UZUN_METIN}`;
  const { speeches, stats } = parseSpeeches(metin, { donem: 20 });
  assert.equal(stats.baslikSatirBirlesti, 0, 'tek-satır başlıkta birleştirme TETİKLENMEMELİ');
  assert.equal(speeches.length, 1);
  assert.equal(speeches[0]!.ad, 'ALİ DİNÇER');
  assert.equal(speeches[0]!.parti, 'CHP', 'gerçek roster (deputy_master_list.json, d20) ile çözülmeli');
});

test('parseSpeeches — KÜRSÜ başlığı 2 satıra bölünmüşse birleştirilip doğru çözülür', () => {
  const metin = `ALİ DİNÇER\n(Ankara) – ${UZUN_METIN}`;
  const { speeches, stats } = parseSpeeches(metin, { donem: 20 });
  assert.equal(stats.baslikSatirBirlesti, 1, 'bölünmüş başlık birleştirilmeli');
  assert.equal(speeches.length, 1, 'konuşmacı KAYBOLMAMALI/yanlış kişiye karışmamalı');
  assert.equal(speeches[0]!.ad, 'ALİ DİNÇER');
  assert.equal(speeches[0]!.parti, 'CHP');
});

test('parseSpeeches — GRUP başlığı 2 satıra bölünmüşse birleştirilip doğru çözülür', () => {
  const metin = `CHP GRUBU ADINA\nALİ DİNÇER (Ankara) – ${UZUN_METIN}`;
  const { speeches, stats } = parseSpeeches(metin, { donem: 20 });
  assert.equal(stats.baslikSatirBirlesti, 1);
  assert.equal(speeches.length, 1);
  assert.equal(speeches[0]!.ad, 'ALİ DİNÇER');
  assert.equal(speeches[0]!.parti, 'CHP', 'GRUP tipi partiyi METİNDEN alır (partiHint), roster\'a bile gerek yok');
  assert.equal(speeches[0]!.partiKaynak, 'GRUP');
});

test('parseSpeeches — bölünmüş başlık ÖNCEKİ konuşmacının gövdesine KARIŞMAZ', () => {
  const ISARET = 'BENZERSİZ-İKİNCİ-KONUŞMACI-İŞARETİ';
  const ilkKonusma = `AYDIN GÜVEN GÜRKAN (İzmir) – ${UZUN_METIN}`;
  const ikinciKonusma = `ALİ DİNÇER\n(Ankara) – ${UZUN_METIN} ${ISARET}`;
  const { speeches } = parseSpeeches(`${ilkKonusma}\n${ikinciKonusma}`, { donem: 20 });
  assert.equal(speeches.length, 2, 'iki ayrı konuşmacı olmalı, biri diğerine karışmamalı');
  const ilk = speeches.find((s) => s.ad === 'AYDIN GÜVEN GÜRKAN');
  const ikinci = speeches.find((s) => s.ad === 'ALİ DİNÇER');
  assert.ok(ilk && ikinci, 'her iki konuşmacı da ayrı ayrı bulunmalı');
  assert.ok(!ilk!.metin.includes(ISARET), 'ikinci konuşmacının metni birinciye SIZMAMALI');
  assert.ok(ikinci!.metin.includes(ISARET), 'ikinci konuşmacının kendi metni kendinde olmalı');
});

test('parseSpeeches — sıradan gövde satırları yanlışlıkla başlık gibi BİRLEŞTİRİLMEZ', () => {
  const metin = `ALİ DİNÇER (Ankara) – ${UZUN_METIN}\nBu ikinci bir cümledir, büyük harfle başlamaz.\nBu da üçüncü bir cümledir.`;
  const { stats } = parseSpeeches(metin, { donem: 20 });
  assert.equal(stats.baslikSatirBirlesti, 0, 'sıradan gövde satırları yanlış birleştirilmemeli');
});

test('parseSpeeches — 3 fiziksel satıra bölünme de (güvenlik payı) birleştirilir', () => {
  const uc = `ALİ\nDİNÇER\n(Ankara) – ${UZUN_METIN}`;
  const { stats: s3 } = parseSpeeches(uc, { donem: 20 });
  assert.equal(s3.baslikSatirBirlesti, 1, '3 fiziksel satır (2 satır ileri bakışın sınırı içinde) birleştirilmeli');
});

test('parseSpeeches — 4 fiziksel satıra bölünme BİLİNEN SINIR: kısmi/yanlış birleşir, temiz atlanmaz', () => {
  const dort = `ALİ\nRIZA\nDİNÇER\n(Ankara) – ${UZUN_METIN}`;
  const { speeches, stats: s4 } = parseSpeeches(dort, { donem: 20 });
  assert.equal(s4.baslikSatirBirlesti, 1, 'belgelenmiş sınır: "RIZA DİNÇER" olarak kısmi birleşiyor, "ALİ" düşüyor');
  assert.equal(speeches[0]?.ad, 'RIZA DİNÇER', 'gerçek ad "ALİ RIZA DİNÇER" olurdu — bu köşe durumu henüz düzeltilmedi');
});
