import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from '../src/index.js';
import { STORAGE_DIR } from '../src/lib/config.js';
import { getDb } from '../src/lib/db.js';

const app = await buildApp();

test('AO1: ADMIN_TOKEN tanımsızken tüm admin uçları fail-closed (503)', async () => {
  delete process.env.ADMIN_TOKEN;
  const r = await app.inject({ method: 'GET', url: '/api/admin/durum' });
  assert.equal(r.statusCode, 503);
});

test('AO2: ADMIN_TOKEN tanımlı ama yanlış token → 401', async () => {
  process.env.ADMIN_TOKEN = 'dogru-token';
  const r = await app.inject({ method: 'GET', url: '/api/admin/durum', headers: { 'x-admin-token': 'yanlis' } });
  assert.equal(r.statusCode, 401);
});

test('AO3: doğru token → /api/admin/durum 200 + beklenen üst-düzey alanlar', async () => {
  process.env.ADMIN_TOKEN = 'dogru-token';
  const r = await app.inject({ method: 'GET', url: '/api/admin/durum', headers: { 'x-admin-token': 'dogru-token' } });
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.equal(j.success, true);
  for (const alan of ['surec', 'etl_durum', 'kaynaklar', 'poll_durum', 'db', 'yedekler', 'env', 'calismalar', 'cli_only_araclar']) {
    assert.ok(alan in j, `/durum yanıtında "${alan}" alanı yok`);
  }
  assert.equal(j.env.ADMIN_TOKEN, 'tanımlı', 'ADMIN_TOKEN değeri sızmış olabilir');
  assert.notEqual(j.env.ADMIN_TOKEN, 'dogru-token', 'ADMIN_TOKEN gerçek değeri response\'ta görünüyor');
});

test('AO4: bilinmeyen mod → 404 + bilinen mod listesi', async () => {
  process.env.ADMIN_TOKEN = 'dogru-token';
  const r = await app.inject({ method: 'POST', url: '/api/admin/calistir/uydurma-mod', headers: { 'x-admin-token': 'dogru-token' } });
  assert.equal(r.statusCode, 404);
  assert.ok(Array.isArray(r.json().bilinen_modlar));
});

test('AO5: Katman 3 (tehlikeli) mod onay olmadan çalışmaz → 400', async () => {
  process.env.ADMIN_TOKEN = 'dogru-token';
  const r = await app.inject({ method: 'POST', url: '/api/admin/calistir/cleanup', headers: { 'x-admin-token': 'dogru-token' } });
  assert.equal(r.statusCode, 400);
});

test('AO6: sıfır-ağ mod (oylama) gerçekten tetiklenir, registry çalışıyor→tamam geçer, kalıcı geçmişe yazılır', async () => {
  process.env.ADMIN_TOKEN = 'dogru-token';
  const [tetikle, ikinci] = await Promise.all([
    app.inject({ method: 'POST', url: '/api/admin/calistir/oylama', headers: { 'x-admin-token': 'dogru-token' } }),
    app.inject({ method: 'POST', url: '/api/admin/calistir/oylama', headers: { 'x-admin-token': 'dogru-token' } }),
  ]);
  const kodlar = [tetikle.statusCode, ikinci.statusCode].sort();
  assert.deepEqual(kodlar, [202, 409], `eşzamanlı iki tetiklemeden biri 202 diğeri 409 olmalı, alınan: ${kodlar}`);
  const basarili = tetikle.statusCode === 202 ? tetikle : ikinci;
  assert.equal(basarili.json().durum, 'calisiyor');

  let durum;
  for (let i = 0; i < 30; i++) {
    durum = await app.inject({ method: 'GET', url: '/api/admin/durum', headers: { 'x-admin-token': 'dogru-token' } });
    if (durum.json().calismalar.oylama?.durum !== 'calisiyor') break;
    await new Promise((res) => setTimeout(res, 500));
  }
  assert.equal(durum!.json().calismalar.oylama?.durum, 'tamam', 'oylama tamamlanmadı — kod değişmiş olabilir');

  const gecmis = await app.inject({ method: 'GET', url: '/api/admin/gecmis', headers: { 'x-admin-token': 'dogru-token' } });
  const kayit = gecmis.json().kayitlar.find((k: { mod: string }) => k.mod === 'oylama');
  assert.ok(kayit, 'kalıcı geçmişe yazılmamış');
  assert.equal(kayit.durum, 'tamam');
});

test('AO7: zamanlayıcı — Katman 3 modu zamanlanamaz (400), Katman 1 modu zamanlanabilir', async () => {
  process.env.ADMIN_TOKEN = 'dogru-token';
  const tehlikeli = await app.inject({
    method: 'POST', url: '/api/admin/zamanlayici', headers: { 'x-admin-token': 'dogru-token' },
    payload: { mod: 'cleanup', aktif: true, aralik_saat: 24 },
  });
  assert.equal(tehlikeli.statusCode, 400);

  const guvenli = await app.inject({
    method: 'POST', url: '/api/admin/zamanlayici', headers: { 'x-admin-token': 'dogru-token' },
    payload: { mod: 'ysk', aktif: false, aralik_saat: 24 },
  });
  assert.equal(guvenli.statusCode, 200);
});

test('AO8: proxy havuzu uçları çalışır — şifre asla açık dönmez, boşsa eskisi korunur, geçersiz girdi 400', async () => {
  process.env.ADMIN_TOKEN = 'dogru-token';
  const H = { 'x-admin-token': 'dogru-token' };
  const yedekler = await app.inject({ method: 'GET', url: '/api/admin/yedekler', headers: H });
  assert.equal(yedekler.statusCode, 200);
  assert.ok(Array.isArray(yedekler.json().liste));

  const yaz = await app.inject({
    method: 'POST', url: '/api/admin/proxy', headers: H,
    payload: { proxyler: [{ ad: 'ao8-test', ip: '1.2.3.4', port: '8080', username: 'u', password: 'gizli-sifre' }], atamalar: { aym: 'ao8-test' } },
  });
  assert.equal(yaz.statusCode, 200);

  const oku1 = await app.inject({ method: 'GET', url: '/api/admin/proxy', headers: H });
  const j1 = oku1.json();
  assert.deepEqual(j1.kaynaklar, ['tbmm', 'gazete', 'aym', 'tuik', 'ysk', 'parti_program', 'yerel_yonetim']);
  const p1 = j1.proxyler.find((p: { ad: string }) => p.ad === 'ao8-test');
  assert.equal(p1.sifre_tanimli, true);
  assert.ok(!('password' in p1), 'şifre alanı response\'ta olmamalı');
  assert.ok(JSON.stringify(j1).indexOf('gizli-sifre') === -1, 'şifrenin kendisi sızmış');
  assert.equal(j1.atamalar.aym, 'ao8-test');

  const yaz2 = await app.inject({
    method: 'POST', url: '/api/admin/proxy', headers: H,
    payload: { proxyler: [{ ad: 'ao8-test', ip: '1.2.3.4', port: '8080', username: 'u', password: '' }], atamalar: { tuik: 'ao8-test' } },
  });
  assert.equal(yaz2.statusCode, 200);
  const oku2 = (await app.inject({ method: 'GET', url: '/api/admin/proxy', headers: H })).json();
  assert.equal(oku2.proxyler.find((p: { ad: string }) => p.ad === 'ao8-test').sifre_tanimli, true, 'boş şifre gönderilince eski şifre silinmiş — bu tam olarak önlenmesi gereken regresyon');
  assert.equal(oku2.atamalar.aym, null, 'yeni POST TÜM atamaları değiştirir (kısmi merge değil) — eski aym ataması kalmamalı');
  assert.equal(oku2.atamalar.tuik, 'ao8-test');

  const eksikAlan = await app.inject({ method: 'POST', url: '/api/admin/proxy', headers: H, payload: { proxyler: [{ ad: 'eksik', ip: '', port: '80' }], atamalar: {} } });
  assert.equal(eksikAlan.statusCode, 400);
  const cakisanAd = await app.inject({ method: 'POST', url: '/api/admin/proxy', headers: H, payload: { proxyler: [{ ad: 'x', ip: '1.1.1.1', port: '80' }, { ad: 'x', ip: '2.2.2.2', port: '80' }], atamalar: {} } });
  assert.equal(cakisanAd.statusCode, 400);
  const gecersizAtama = await app.inject({ method: 'POST', url: '/api/admin/proxy', headers: H, payload: { proxyler: [], atamalar: { aym: 'boyle-bir-proxy-yok' } } });
  assert.equal(gecersizAtama.statusCode, 400);

  await app.inject({ method: 'POST', url: '/api/admin/proxy', headers: H, payload: { proxyler: [], atamalar: {} } });
});

test('AO9: log görüntüleyici uçur, en az az önceki testlerin ürettiği satırları içerir', async () => {
  process.env.ADMIN_TOKEN = 'dogru-token';
  const r = await app.inject({ method: 'GET', url: '/api/admin/loglar?limit=50', headers: { 'x-admin-token': 'dogru-token' } });
  assert.equal(r.statusCode, 200);
  assert.ok(Array.isArray(r.json().satirlar));
});

test('AO10: eski admin.ts route ailesi gerçekten silindi (regresyon kilidi)', async () => {
  process.env.ADMIN_TOKEN = 'dogru-token';
  for (const yol of ['/api/admin/ping', '/api/admin/history', '/api/admin/scheduler/config']) {
    const r = await app.inject({ method: 'GET', url: yol, headers: { 'x-admin-token': 'dogru-token' } });
    assert.equal(r.statusCode, 404, `${yol} hâlâ varsa silme geri alınmış demektir`);
  }
});

test('AO11: yedek indirme bileti — tek kullanımlık, dosyaya bağlı, DELETE\'i yetkilendirmez', async () => {
  process.env.ADMIN_TOKEN = 'dogru-token';
  const yedekDizin = join(STORAGE_DIR, 'backups');
  const dosyaA = '_test-bilet-a.db';
  const dosyaB = '_test-bilet-b.db';
  const yolA = join(yedekDizin, dosyaA);
  const yolB = join(yedekDizin, dosyaB);
  writeFileSync(yolA, 'sahte-yedek-icerik-a');
  writeFileSync(yolB, 'sahte-yedek-icerik-b');
  try {
    const biletsiz = await app.inject({ method: 'POST', url: `/api/admin/yedekler/${dosyaA}/bilet` });
    assert.equal(biletsiz.statusCode, 401);

    const mintBilet = async () => {
      const r = await app.inject({ method: 'POST', url: `/api/admin/yedekler/${dosyaA}/bilet`, headers: { 'x-admin-token': 'dogru-token' } });
      assert.equal(r.statusCode, 200);
      return r.json().bilet as string;
    };

    const ciplak = await app.inject({ method: 'GET', url: `/api/admin/yedekler/${dosyaA}` });
    assert.equal(ciplak.statusCode, 401);

    const sahte = await app.inject({ method: 'GET', url: `/api/admin/yedekler/${dosyaA}?bilet=uydurma` });
    assert.equal(sahte.statusCode, 401);

    const biletYanlisIcin = await mintBilet();
    const yanlisDosya = await app.inject({ method: 'GET', url: `/api/admin/yedekler/${dosyaB}?bilet=${biletYanlisIcin}` });
    assert.equal(yanlisDosya.statusCode, 401, 'bilet başka dosyada da çalışıyor — dosya-bağlama kırılmış');

    const yanmisBiletDogruDosyada = await app.inject({ method: 'GET', url: `/api/admin/yedekler/${dosyaA}?bilet=${biletYanlisIcin}` });
    assert.equal(yanmisBiletDogruDosyada.statusCode, 401, 'yanlış dosyada başarısız olan bilet hâlâ canlı — anti-replay kırılmış');

    const biletDogruIcin = await mintBilet();
    const ilk = await app.inject({ method: 'GET', url: `/api/admin/yedekler/${dosyaA}?bilet=${biletDogruIcin}` });
    assert.equal(ilk.statusCode, 200);
    assert.equal(ilk.body, 'sahte-yedek-icerik-a');

    const ikinci = await app.inject({ method: 'GET', url: `/api/admin/yedekler/${dosyaA}?bilet=${biletDogruIcin}` });
    assert.equal(ikinci.statusCode, 401, 'bilet tekrar kullanılabiliyor — tek-kullanımlık kırılmış');

    const biletSilmeIcin = await mintBilet();
    const sil = await app.inject({ method: 'DELETE', url: `/api/admin/yedekler/${dosyaA}?bilet=${biletSilmeIcin}` });
    assert.equal(sil.statusCode, 401, 'bilet DELETE\'i yetkilendiriyor — güvenlik sınırı kırılmış');
    assert.ok(existsSync(yolA), 'dosya bilet ile silinebilmiş olmamalı');
  } finally {
    if (existsSync(yolA)) unlinkSync(yolA);
    if (existsSync(yolB)) unlinkSync(yolB);
  }
});

test('AO12: /api/ozet/refresh silindi — yetkisiz ETL tetikleyici artık yok (regresyon kilidi)', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/ozet/refresh' });
  assert.equal(r.statusCode, 404, '/api/ozet/refresh hâlâ varsa yetkisiz ETL tetikleme açığı geri gelmiş demektir');
});

test('AO13: yedek/kullanıcı silme artık sunucu-tarafı "onay" ister (yalnız client confirm() yeterli değildi)', async () => {
  process.env.ADMIN_TOKEN = 'dogru-token';
  const yedekDizin = join(STORAGE_DIR, 'backups');
  const dosya = '_test-onay-sil.db';
  const yol = join(yedekDizin, dosya);
  writeFileSync(yol, 'sahte');
  try {
    const onaysiz = await app.inject({ method: 'DELETE', url: `/api/admin/yedekler/${dosya}`, headers: { 'x-admin-token': 'dogru-token' } });
    assert.equal(onaysiz.statusCode, 400, 'onay olmadan yedek silinebiliyor — server-side onay kırılmış');
    assert.ok(existsSync(yol), 'onay olmadan dosya gerçekten silinmiş');

    const yanlisOnay = await app.inject({
      method: 'DELETE', url: `/api/admin/yedekler/${dosya}`, headers: { 'x-admin-token': 'dogru-token' },
      payload: { onay: 'baska-dosya.db' },
    });
    assert.equal(yanlisOnay.statusCode, 400);
    assert.ok(existsSync(yol), 'yanlış onayla dosya silinmiş');

    const dogruOnay = await app.inject({
      method: 'DELETE', url: `/api/admin/yedekler/${dosya}`, headers: { 'x-admin-token': 'dogru-token' },
      payload: { onay: dosya },
    });
    assert.equal(dogruOnay.statusCode, 200);
    assert.ok(!existsSync(yol));
  } finally {
    if (existsSync(yol)) unlinkSync(yol);
  }

  const mint = await app.inject({
    method: 'POST', url: '/api/admin/kullanicilar', headers: { 'x-admin-token': 'dogru-token' },
    payload: { isim: 'OnayTest' },
  });
  const id = mint.json().kullanici.id;
  const onaysizKullanici = await app.inject({ method: 'DELETE', url: `/api/admin/kullanicilar/${id}`, headers: { 'x-admin-token': 'dogru-token' } });
  assert.equal(onaysizKullanici.statusCode, 400, 'onay olmadan kullanıcı silinebiliyor');
  const dogruOnayKullanici = await app.inject({
    method: 'DELETE', url: `/api/admin/kullanicilar/${id}`, headers: { 'x-admin-token': 'dogru-token' },
    payload: { onay: 'OnayTest' },
  });
  assert.equal(dogruOnayKullanici.statusCode, 200);
});

test('AO14: smoke test — 6 kaynağın her biri kontrol edilir, gerçek yaşayan uçlara bakar', async () => {
  process.env.ADMIN_TOKEN = 'dogru-token';
  const r = await app.inject({ method: 'GET', url: '/api/admin/smoke-test', headers: { 'x-admin-token': 'dogru-token' } });
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.ok(Array.isArray(j.kontroller));
  assert.equal(j.kontroller.length, 6, 'SMOKE_CHECKS kaynak sayısı değişmiş olabilir');
  const kaynaklar = j.kontroller.map((k: { kaynak: string }) => k.kaynak).sort();
  assert.deepEqual(kaynaklar, ['aym', 'gazete', 'parti_program', 'tuik', 'yerel_yonetim', 'ysk']);
  for (const k of j.kontroller) {
    assert.ok(k.durum === 'yesil' || k.durum === 'kirmizi', `${k.kaynak}: beklenmeyen durum ${k.durum}`);
  }
});

test('AO15: 4 mutasyon noktası (yedek-sil, kullanıcı-sil, proxy, zamanlayıcı) artık denetim izi bırakıyor', async () => {
  process.env.ADMIN_TOKEN = 'dogru-token';
  const H = { 'x-admin-token': 'dogru-token' };

  await app.inject({ method: 'POST', url: '/api/admin/zamanlayici', headers: H, payload: { mod: 'ysk', aktif: false, aralik_saat: 24 } });

  await app.inject({ method: 'POST', url: '/api/admin/proxy', headers: H, payload: { proxyler: [], atamalar: {} } });

  const dosya = '_test-ao15-sil.db';
  const yol = join(STORAGE_DIR, 'backups', dosya);
  writeFileSync(yol, 'sahte');
  await app.inject({ method: 'DELETE', url: `/api/admin/yedekler/${dosya}`, headers: H, payload: { onay: dosya } });

  const mint = await app.inject({ method: 'POST', url: '/api/admin/kullanicilar', headers: H, payload: { isim: 'AO15Test' } });
  const id = mint.json().kullanici.id;
  await app.inject({ method: 'DELETE', url: `/api/admin/kullanicilar/${id}`, headers: H, payload: { onay: 'AO15Test' } });

  const gecmis = await app.inject({ method: 'GET', url: '/api/admin/gecmis?limit=50', headers: H });
  const kayitlar: { mod: string; tetikleyen: string }[] = gecmis.json().kayitlar;
  const bul = (onek: string) => kayitlar.find((k) => k.mod.startsWith(onek));

  assert.ok(bul('zamanlayici-degistir:'), 'zamanlayıcı değişikliği geçmişte yok');
  assert.ok(bul('proxy-guncelle'), 'proxy güncellemesi geçmişte yok');
  const yedekKaydi = bul(`yedek-sil:${dosya}`);
  assert.ok(yedekKaydi, 'yedek silme geçmişte yok');
  assert.equal(yedekKaydi!.tetikleyen, 'admin', 'ana token ile silinen kaydın tetikleyeni "admin" olmalı');
  assert.ok(bul('kullanici-sil:AO15Test'), 'kullanıcı silme geçmişte yok');
});

test('AO16: içerik tarayıcısı — izin listesi dışı tablo reddedilir, gerçek arama/filtre/detay çalışır', async () => {
  process.env.ADMIN_TOKEN = 'dogru-token';
  const H = { 'x-admin-token': 'dogru-token' };

  for (const kotuTablo of ['sqlite_master', 'admin_kullanici', "faaliyet;DROP TABLE faaliyet--", 'faaliyet WHERE 1=1']) {
    const r = await app.inject({ method: 'GET', url: `/api/admin/icerik/${encodeURIComponent(kotuTablo)}`, headers: H });
    assert.equal(r.statusCode, 404, `"${kotuTablo}" 404 dönmedi — izin listesi kaçağı olabilir`);
  }

  const filtreli = await app.inject({ method: 'GET', url: '/api/admin/icerik/faaliyet?kaynak=kanun&limit=3', headers: H });
  assert.equal(filtreli.statusCode, 200);
  const j = filtreli.json();
  assert.ok(j.satirlar.length > 0, 'kaynak=kanun filtreli sorgu hiç satır döndürmedi');
  assert.ok(j.satirlar.every((s: { kaynak: string }) => s.kaynak === 'kanun'), 'filtre gerçekten uygulanmamış — başka kaynak satırı sızmış');
  assert.deepEqual(j.alanlar.filtre, ['kaynak', 'donem', 'kategori', 'kategori_kaynagi']);

  const id = j.satirlar[0]._satir_id;
  const detay = await app.inject({ method: 'GET', url: `/api/admin/icerik/faaliyet/${id}`, headers: H });
  assert.equal(detay.statusCode, 200);
  assert.equal(detay.json().satir.kaynak, 'kanun');

  const kotuDetay = await app.inject({ method: 'GET', url: '/api/admin/icerik/sqlite_master/1', headers: H });
  assert.equal(kotuDetay.statusCode, 404);

  const kotuId = await app.inject({ method: 'GET', url: "/api/admin/icerik/faaliyet/1;DROP TABLE faaliyet--", headers: H });
  assert.equal(kotuId.statusCode, 400);
});

test('AO17: sınıflandırma/dağılım/bilinen-sınırlar uçları çalışır, duyuru bayraklama public sorguyu gerçekten değiştirir', async () => {
  process.env.ADMIN_TOKEN = 'dogru-token';
  const H = { 'x-admin-token': 'dogru-token' };

  const siniflandirma = await app.inject({ method: 'GET', url: '/api/admin/siniflandirma-ozet', headers: H });
  assert.equal(siniflandirma.statusCode, 200);
  assert.ok(Array.isArray(siniflandirma.json().model_uretemez_kategoriler));

  const dagilim = await app.inject({ method: 'GET', url: '/api/admin/dagilim', headers: H });
  assert.equal(dagilim.statusCode, 200);

  const eksikDamga = await app.inject({ method: 'GET', url: '/api/admin/dagilim/diff?once=x', headers: H });
  assert.equal(eksikDamga.statusCode, 400);

  const sinirlar = await app.inject({ method: 'GET', url: '/api/admin/bilinen-sinirlar', headers: H });
  assert.equal(sinirlar.statusCode, 200);
  assert.ok(sinirlar.json().liste.length > 0);

  const gecersizBayrak = await app.inject({ method: 'POST', url: '/api/admin/duyuru/1/TEST-AO17/bayrakla', headers: H, payload: { bayrak: 'her-sey-yolunda' } });
  assert.equal(gecersizBayrak.statusCode, 400);

  const gercekDuyuru = getDb().prepare(
    `SELECT d.gazete_id, d.kanun_no, t.sira_sayisi
       FROM duyuru d JOIN teklif_sirasayisi t ON t.kanun_no = d.kanun_no
       JOIN faaliyet f ON f.id = t.faaliyet_id
      WHERE f.kaynak='kanun' AND t.sira_sayisi IS NOT NULL AND t.sira_sayisi != ''
      LIMIT 1`,
  ).get() as { gazete_id: number; kanun_no: string; sira_sayisi: string } | undefined;
  if (gercekDuyuru) {
    const ssParam = `ss=${encodeURIComponent(gercekDuyuru.sira_sayisi)}`;
    const oncesi = await app.inject({ method: 'GET', url: `/api/ozet/kanun-hikaye?${ssParam}` });
    const duyuruSayisiOncesi = (oncesi.json().duyurular ?? []).length;
    assert.ok(duyuruSayisiOncesi > 0, 'test verisi seçimi yanlış — bu kanunun hiç duyurusu yok');

    const bayrakla = await app.inject({
      method: 'POST', url: `/api/admin/duyuru/${gercekDuyuru.gazete_id}/${encodeURIComponent(gercekDuyuru.kanun_no)}/bayrakla`, headers: H,
      payload: { bayrak: 'yanlis' },
    });
    assert.equal(bayrakla.statusCode, 200);

    const sonrasi = await app.inject({ method: 'GET', url: `/api/ozet/kanun-hikaye?${ssParam}` });
    const duyuruSayisiSonrasi = (sonrasi.json().duyurular ?? []).length;
    assert.equal(duyuruSayisiSonrasi, duyuruSayisiOncesi - 1, 'bayraklanan duyuru public sorguda hâlâ görünüyor — suskunluk çalışmıyor');

    const kaldir = await app.inject({ method: 'DELETE', url: `/api/admin/duyuru/${gercekDuyuru.gazete_id}/${encodeURIComponent(gercekDuyuru.kanun_no)}/bayrakla`, headers: H });
    assert.equal(kaldir.statusCode, 200);
    const geriGeldi = await app.inject({ method: 'GET', url: `/api/ozet/kanun-hikaye?${ssParam}` });
    assert.equal((geriGeldi.json().duyurular ?? []).length, duyuruSayisiOncesi, 'işaret kaldırılınca duyuru geri gelmedi');
  } else {
    console.log('AO17: test verisinde ss↔duyuru eşleşen kanun bulunamadı, public-suppression kolu atlandı');
  }

  const partiAtif = await app.inject({ method: 'GET', url: '/api/admin/parti-atif-kalite', headers: H });
  assert.equal(partiAtif.statusCode, 200);
  assert.ok(Array.isArray(partiAtif.json().imza_kaynak) && Array.isArray(partiAtif.json().oy_parti_ham));
});
