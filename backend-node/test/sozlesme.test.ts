import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backendHazir } from './_canli.js';

const B = 'http://localhost:8000/api/ozet';
const canli = await backendHazir();
const jj = async (u: string) => (await fetch(B + u)).json() as Promise<Record<string, any>>;

function alanlarVar(j: Record<string, any>, yollar: string[]): string[] {
  return yollar.filter((y) => {
    let v: any = j;
    for (const p of y.split('.')) { if (v == null || !(p in v)) return true; v = v[p]; }
    return v === undefined;
  });
}

interface Sozlesme {
  uc: string;
  alanlar: string[];
  bantlar?: [string, number, number][];
}

const SOZLESMELER: Sozlesme[] = [
  { uc: '/meta', alanlar: ['success'] },
  { uc: '/yasama?donem=28', alanlar: ['success', 'partiler', 'toplam_kanunlasti'],
    bantlar: [['toplam_kanunlasti', 100, 400]] },
  { uc: '/kanunlar?donem=28&limit=10', alanlar: ['success', 'toplam', 'kayitlar'],
    bantlar: [['toplam', 100, 400]] },
  { uc: '/onerge-durum?donem=28', alanlar: ['success', 'toplam', 'dagilim'],
    bantlar: [['toplam', 30000, 90000]] },
  { uc: '/muhatap-cevap?donem=28', alanlar: ['success', 'kapsanan', 'toplam', 'kurumlar', 'muhatapsiz'],
    bantlar: [['kapsanan', 30000, 90000]] },
  { uc: '/konu-cevap', alanlar: ['success', 'donemler', 'konular', 'taban', 'taban_alti.konu_n', 'beyan'] },
  { uc: '/onerge-ara?q=deprem', alanlar: ['success', 'toplam', 'gosterilen', 'cevap.hic_pay', 'cevap.sinif_toplam', 'kayitlar'],
    bantlar: [['toplam', 500, 6000]] },
  { uc: '/konusma-ara?q=deprem', alanlar: ['success', 'toplam', 'gosterilen', 'kayitlar', 'parti_dagilim.sinif_toplam'],
    bantlar: [['toplam', 500, 6000]] },
  { uc: '/kanun-ara?q=vergi+kanunu&donem=hepsi', alanlar: ['success', 'toplam', 'gosterilen', 'durum_dagilim', 'parti_dagilim.partiler', 'parti_dagilim.artik', 'kayitlar'],
    bantlar: [['toplam', 500, 3000]] },
  { uc: '/aym-ara?q=vergi+kanunu&donem=hepsi', alanlar: ['success', 'toplam', 'gosterilen', 'sonuc_dagilim.esas', 'sonuc_dagilim.oran', 'yil_dagilim', 'kayitlar'],
    bantlar: [['toplam', 150, 700]] },
  { uc: '/gazete-ara?q=vergi+kanunu&donem=hepsi', alanlar: ['success', 'toplam', 'gosterilen', 'tur_dagilim', 'zaman_dagilim', 'kayitlar'],
    bantlar: [['toplam', 150, 900]] },
  { uc: '/birlesim?donem=28&limit=5', alanlar: ['success', 'toplam', 'birlesimler'],
    bantlar: [['toplam', 100, 800]] },
  { uc: '/vekil-oy?il=Ankara', alanlar: ['success', 'vekiller', 'oylama_n', 'parti_katilim', 'kapsam.ilk', 'kapsam.gerilik_gun'],
    bantlar: [['oylama_n', 50, 300]] },
  { uc: '/kanun-hikaye?ss=161', alanlar: ['success', 'bulundu', 'kanun.kanun_no', 'kanun.gelis_tarihi', 'imza.toplam', 'imza.kisiler', 'oy.durum', 'aym_uygulanabilir'] },
  { uc: '/oylama?donem=28', alanlar: ['success'] },
  { uc: '/yargi?donem=28', alanlar: ['success'] },
  { uc: '/yururluk?donem=28', alanlar: ['success'] },
  { uc: '/son-hareket', alanlar: ['success', 'en_son'] },
  { uc: '/secim-sonucu?donem=28', alanlar: ['success', 'donemler', 'secim.donem', 'secim.tarih', 'secim.secmen_sayisi', 'secim.katilma_orani', 'secim.gecerli_oy_toplami', 'secim.parti_oy_toplami', 'secim.toplam_sandalye', 'secim.partiler', 'secim.diger.n', 'secim.diger.oy', 'secim.tum_partiler', 'secim.kapsam_notu', 'secim.kaynak_url'],
    bantlar: [['secim.partiler.length', 7, 7], ['secim.tum_partiler.length', 25, 25], ['secim.toplam_sandalye', 600, 600]] },
  { uc: '/parti-program-ara?q=ekonomi', alanlar: ['success', 'terim', 'toplam', 'kapsam_notu', 'kayitlar'],
    bantlar: [['toplam', 6, 6]] },
  { uc: '/yerel-karar-ara?q=imar', alanlar: ['success', 'terim', 'toplam', 'belediye_dagilim', 'kapsam_notu', 'kayitlar'],
    bantlar: [['toplam', 1000, 50000]] },
  { uc: '/yerel-meclis?belediye=İstanbul', alanlar: ['success', 'belediyeler', 'meclis.belediye', 'meclis.toplam_uye', 'meclis.partiler', 'meclis.kapsam_notu'],
    bantlar: [['belediyeler.length', 6, 81], ['meclis.toplam_uye', 322, 322]] },
];

test('SZ1: uçların YANIT ŞEKLİ korunuyor (alan sessizce düşmedi)', { skip: !canli && 'backend kapalı' }, async () => {
  const sorun: string[] = [];
  for (const s of SOZLESMELER) {
    let j: Record<string, any>;
    try { j = await jj(s.uc); } catch (e) { sorun.push(`${s.uc}: İSTEK BAŞARISIZ (${String(e).slice(0, 50)})`); continue; }
    const eksik = alanlarVar(j, s.alanlar);
    if (eksik.length) sorun.push(`${s.uc}: eksik alan → ${eksik.join(', ')}`);
  }
  assert.deepEqual(
    sorun, [],
    `Uç sözleşmesi bozulmuş:\n  ${sorun.join('\n  ')}\n` +
      'Bir alanın sessizce düşmesi, UI\'da kartın boşalması demektir ve hata vermez. ' +
      'Alan bilerek kaldırıldıysa bu listeyi güncelle — sessizce geçme.',
  );
});

test('SZ2: uçların DEĞERLERİ ölçülen bantta (hesap sessizce kaymadı)', { skip: !canli && 'backend kapalı' }, async () => {
  const sorun: string[] = [];
  for (const s of SOZLESMELER) {
    if (!s.bantlar) continue;
    const j = await jj(s.uc);
    for (const [alan, alt, ust] of s.bantlar) {
      let v: any = j;
      for (const p of alan.split('.')) v = v?.[p];
      if (typeof v !== 'number') { sorun.push(`${s.uc}.${alan}: sayı değil (${typeof v})`); continue; }
      if (v < alt || v > ust) sorun.push(`${s.uc}.${alan} = ${v} · beklenen ${alt}–${ust}`);
    }
  }
  assert.deepEqual(
    sorun, [],
    `Uç değerleri banttan çıkmış:\n  ${sorun.join('\n  ')}\n` +
      'Korpus büyümesi MEŞRU olabilir — o hâlde bandı ÖLÇEREK genişlet. Ama önce şunu doğrula: ' +
      'sayı gerçekten mi büyüdü, yoksa bir filtre/kapı mı düştü? İkincisi sessiz veri sızıntısıdır.',
  );
});

test('SZ3: her uç makul sürede yanıtlıyor (canlı HTTP sızıntısı yok)', { skip: !canli && 'backend kapalı' }, async () => {
  const yavas: string[] = [];
  for (const s of SOZLESMELER) {
    const t0 = Date.now();
    await jj(s.uc);
    const ms = Date.now() - t0;
    if (ms > 3000) yavas.push(`${s.uc}: ${ms}ms`);
  }
  assert.deepEqual(yavas, [], `Yavaş uç(lar) — canlı ağ isteği ya da eksik indeks:\n  ${yavas.join('\n  ')}`);
});

test('BT1: bütçe kaydı, cetvelin KENDİ S.Sayısı ile bağlanır — tahminle değil', { skip: !canli && 'backend kapalı' }, async () => {
  const j = await jj('/butce?donem=28');
  assert.equal(j.success, true);
  assert.ok(Array.isArray(j.kayitlar), 'kayitlar dizi değil');
  for (const k of j.kayitlar as { ss: string; baslik: string; kanit_pdf: string|null; partiler: unknown[]; toplam: number }[]) {
    assert.ok(k.ss, 'S.Sayısı yok — köprü anahtarsız');
    assert.ok(k.baslik && k.baslik.length > 10, 'belge başlığı yok');
    assert.ok(k.kanit_pdf, `S.S.${k.ss}: kanıt PDF'i yok — "kim nasıl oy verdi" doğrulanamaz`);
    assert.ok((k.partiler ?? []).length > 0, `S.S.${k.ss}: parti dökümü boş`);
    assert.ok(k.toplam > 0, `S.S.${k.ss}: kullanılan oy 0`);
  }
});

test('BT2: bütçe · kesin hesap · ek ödenek AYRI türler — toplanmaz', { skip: !canli && 'backend kapalı' }, async () => {
  const j = await jj('/butce?donem=28');
  const turler = new Set<string>((j.kayitlar ?? []).map((k: { tur: string }) => k.tur));
  for (const t of turler) assert.ok(['butce', 'kesin-hesap', 'ek-odenek'].includes(t), `bilinmeyen tür: ${t}`);
  assert.ok(turler.size >= 2, 'tür ayrımı yapılmıyor — hepsi tek kovada');
});

test('BT3: ölçüt + kapsam + eksik BEYAN EDİLİR (sessiz düşme yok)', { skip: !canli && 'backend kapalı' }, async () => {
  const j = await jj('/butce?donem=28');
  assert.match(j.olcut ?? '', /Sıra Sayısı/, 'seçim ölçütü beyan edilmemiş (M6)');
  assert.match(j.olcut ?? '', /KULLANILMADI|kullanılmadı/, 'tahminle eşleştirilmediği söylenmiyor');
  assert.ok(j.kapsam_uyarisi, 'kapsam uyarısı yok — okur "bütçenin tamamı bu" sanır');
  assert.ok(j.katilmadi_notu, '"Katılmadı" notu yok (M5)');
  assert.ok(j.eksik && typeof j.eksik.koprusuz_cetvel === 'number', 'eksik beyanı yok');
  if (j.eksik.koprusuz_cetvel > 0) assert.ok(j.eksik.not, 'eksik var ama gerekçesi yazılmamış');
});

test('DY1: duyuru eki korpus çıpalı ve başlık AYNEN — haber akışı değil', { skip: !canli && 'backend kapalı' }, async () => {
  const j = await jj('/kanun-hikaye?ss=404');
  assert.equal(j.bulundu, true);
  assert.ok(Array.isArray(j.duyurular), 'duyurular dizisi yok');
  if (j.duyurular.length) {
    assert.ok(j.duyuru_not, 'duyuru varsa açıklama notu olmalı');
    for (const d of j.duyurular) {
      assert.ok(d.baslik && d.baslik.length > 5, 'duyuru başlığı yok');
      assert.ok(d.url, 'duyuru kaynağı (RG url) yok — doğrulanamaz');
      assert.doesNotMatch(d.baslik, /(skandal|başarısız|olumlu|olumsuz)/i, 'başlıkta editoryal sıfat');
    }
  }
});

test('CS1: cevap süresi ÖRNEKLEM olarak beyan edilir, payda her satırda taşınır', { skip: !canli && 'backend kapalı' }, async () => {
  const j = await jj('/cevap-suresi?donem=28');
  assert.equal(j.success, true);
  assert.ok(Array.isArray(j.kurumlar), 'kurumlar dizisi yok');
  assert.match(j.olcut ?? '', /ÖRNEKLEM|örneklem/i, 'örneklem beyanı yok');
  assert.match(j.olcut ?? '', /tam sayım değil|tam sayım DEĞİL/i, '"tam sayım değil" denmemiş');
  for (const k of j.kurumlar as { ornek_n: number; ortanca_gun: number | null; gecikmis_pay: number | null; taban_alti: boolean }[]) {
    assert.ok(typeof k.ornek_n === 'number' && k.ornek_n > 0, 'satırda örneklem sayısı (payda) yok');
    if (k.taban_alti) {
      assert.equal(k.ortanca_gun, null, `taban altı kurumda ortanca verilmiş (n=${k.ornek_n})`);
      assert.equal(k.gecikmis_pay, null, `taban altı kurumda oran verilmiş (n=${k.ornek_n})`);
    }
  }
});

test('CS2: "gecikmiş" nitelemesi KAYNAĞIN, bizim eşiğimiz DEĞİL', { skip: !canli && 'backend kapalı' }, async () => {
  const j = await jj('/cevap-suresi?donem=28');
  assert.ok(j.gecikme_notu, 'gecikme nitelemesinin kaynağı beyan edilmemiş');
  assert.match(j.gecikme_notu, /TBMM|kayıt ibaresi/i, 'nitelemenin kaynağın kendi ibaresi olduğu yazmıyor');
  assert.match(j.gecikme_notu, /eşik|değildir/i, 'sitenin kendi eşiği olmadığı söylenmiyor');
});

test('CS3: kapsam — bu tablo "kaç önerge cevapsız" sorusunu yanıtlamaz', { skip: !canli && 'backend kapalı' }, async () => {
  const j = await jj('/cevap-suresi?donem=28');
  assert.ok(j.kapsam_notu, 'kapsam notu yok');
  assert.match(j.kapsam_notu, /cevapsız/i, 'cevapsızların tabloda olmadığı söylenmiyor');
});
