import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = dirname(fileURLToPath(import.meta.url));
const KOK = join(HERE, '..');
const API = 'http://localhost:8000';
const NODE_FETCH = globalThis.fetch;

let kosuNo = 0;
const canli = await fetch(`${API}/api/ozet/meta`, { signal: AbortSignal.timeout(3000) })
  .then((r) => r.ok).catch(() => false);

function gorunenMetin(w) {
  const k = w.document.body.cloneNode(true);
  k.querySelectorAll('script,style,template').forEach((e) => e.remove());
  return k.textContent;
}

async function sayfaKos(dosya, arama, gozle, mobil = false, engelle = []) {
  const html = readFileSync(join(KOK, dosya), 'utf8');
  const dom = new JSDOM(html, { url: `http://localhost:5180/${dosya}${arama}`, pretendToBeVisual: true });
  const w = dom.window;
  const hatalar = [];
  w.addEventListener('error', (e) => hatalar.push(String(e.error ?? e.message)));
  const nodeFetch = NODE_FETCH;
  let ucus = 0;
  w.fetch = (u, o) => {
    const s = String(u); if (gozle) gozle(s);
    if (engelle.some((p) => s.includes(p))) {
      return Promise.resolve({
        ok: false, status: 503,
        json: async () => ({ success: false, error: 'test: engellendi' }),
        text: async () => '{"success":false,"error":"test: engellendi"}',
      });
    }
    ucus++;
    return nodeFetch(s.startsWith('/') ? API + s : s, o).finally(() => { ucus--; });
  };
  w.matchMedia = (q) => ({ matches: mobil && /max-width/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
  const kopru = ['document', 'location', 'history', 'fetch', 'matchMedia', 'addEventListener', 'removeEventListener',
    'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
    'HTMLElement', 'customElements', 'Node', 'Element', 'CustomEvent'];
  globalThis.window = w;
  for (const k of kopru) {
    const v = w[k];
    try { globalThis[k] = typeof v === 'function' && !/^[A-Z]/.test(k) ? v.bind(w) : v; }
    catch {  }
  }

  const kod = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(kod, `${dosya}: <script type="module"> bulunamadı`);
  const ortakUrl = pathToFileURL(join(KOK, 'ortak.js')).href;
  let mod = kod.replace(/from '\.\/ortak\.js'/g, `from '${ortakUrl}'`);
  mod += `\n// cache-bust: ${dosya}${arama} #${++kosuNo}\n`;
  try {
    await import(`data:text/javascript;base64,${Buffer.from(mod).toString('base64')}`);
  } catch (e) {
    hatalar.push(String(e));
  }
  const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
  const KARARLI_ORNEK = 6;
  let onceki = '', kararli = 0, durdu = false;
  for (let i = 0; i < 300; i++) {
    await bekle(100);
    if (ucus > 0) { onceki = ''; kararli = 0; continue; }
    const simdi = w.document.body.innerHTML.length + '|' + w.document.querySelectorAll('*').length;
    if (simdi === onceki) { kararli++; if (kararli >= KARARLI_ORNEK) { durdu = true; break; } }
    else { kararli = 0; onceki = simdi; }
  }
  if (!durdu) hatalar.push(`HARNESS ZAMAN AŞIMI: sayfa 30 sn'de durulmadı (uçuşta ${ucus} istek). `
    + `Bu bir SAYFA hatası değil, testin beklemesi yetmedi — backend yavaş ya da yük altında.`);
  return { dom, w, hatalar };
}

test('parti.html — JS hatasız çalışır ve kartlar dolar', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('parti.html', '?p=CHP');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const $ = (id) => w.document.getElementById(id);

  assert.match($('yasama').innerHTML, /kozet/, 'yasama içgörüsü yok');
  assert.match($('yasama').textContent, /CHP.*kanun teklifi verdi/s, 'yasama cümlesi yok');

  assert.equal($('oyCard').hidden, false, 'oy kartı açılmadı (veri var ama kart gizli)');
  assert.match($('oy').textContent, /açık oylamada .* oy kullandı/s, 'oy içgörüsü yok');
  assert.match($('oy').textContent, /işaretle \(el kaldırarak\) oylanır/s, 'ZORUNLU kapsam notu yok');
  assert.ok($('oy').querySelectorAll('.ykar').length >= 3, 'parti karşılaştırma çubukları yok');
  const oyMetin = $('oy').textContent;
  assert.match(oyMetin, /ret/i, 'ret payı ölçüsü yok');
  assert.match(oyMetin, /katılım/i, 'M7 ihlali: ret payı var ama katılım ölçüsü YOK (payda tek-yönlü)');
});

test('parti.html — dönem kıyası kapalıysa SESSİZ değil, GEREKÇELİ', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('parti.html', '?p=CHP');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const $ = (id) => w.document.getElementById(id);
  const j = await fetch(`${API}/api/ozet/donem-karsilastir?parti=CHP`).then((r) => r.json());
  const yayimlanan = (j.donemler ?? []).filter((d) => d.n >= 300);

  if (yayimlanan.length < 2) {
    assert.equal($('donemCard').hidden, false, 'kıyas yapılamıyor ve kart SESSİZCE kayboldu — boşluk beyan edilmeli');
    const t = $('donemK').textContent;
    assert.match(t, /yayımlanmıyor|doğrulama bekleniyor/, 'kapının GEREKÇESİ (yayın kararı) yok — "veri yok" ile karışır');
    assert.ok(!/veri yok/i.test(t), 'yanıltıcı "veri yok" ifadesi kullanılmış (yayın kararı olmalı)');
    assert.ok((j.atlanan ?? []).length > 0, 'API atlanan dönemleri bildirmiyor → sessiz eksiltme');
    for (const a of j.atlanan) assert.ok(t.includes(String(a.donem)), `atlanan d${a.donem} beyanda anılmıyor`);
    return;
  }

  assert.equal($('donemCard').hidden, false, 'dönem karşılaştırma kartı açılmadı');
  const t = $('donemK').textContent;
  assert.match(t, /en çok ayrışan konu/, 'içgörü cümlesi yok');
  assert.match(t, /26\. D|27\. D|28\. D/, 'dönem çubukları yok');
  for (const adet of ['48.242', '20.938', '25.119'])
    assert.ok(!t.includes(adet), `kartta HAM ADET var (${adet}) — dönem uzunluğu tuzağı`);
  assert.match(t, /farklı uzunlukta/, 'ZORUNLU "dönemler farklı uzunlukta" notu yok');
  assert.match(t, /adet değil pay/, 'ZORUNLU "adet değil pay" notu yok');
  assert.match(t, /hâlâ sürüyor/, 'd28\'in sürdüğü söylenmiyor (uzunluk kıyası eksik kalır)');
});

test('parti.html — .kozet görünür ve boş değil (sessiz boş kart tuzağı)', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('parti.html', '?p=AKP');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  for (const k of w.document.querySelectorAll('.kozet')) {
    assert.ok(k.textContent.trim().length > 40, `.kozet neredeyse boş: "${k.textContent}"`);
    assert.ok(!/undefined|NaN|null/.test(k.textContent), `.kozet içinde undefined/NaN: "${k.textContent}"`);
  }
});

test('parti.html — yasama kartı: seçim BÜYÜKLÜĞE göre, kırpma ölçüyü gizlemiyor', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('parti.html', '?p=CHP');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const j = await fetch(`${API}/api/ozet/yasama?donem=28`).then((r) => r.json());
  const gosterilen = [...w.document.querySelectorAll('#yasama .ykar .yp')].map((s) => s.textContent.trim());
  assert.ok(gosterilen.length > 0, 'yasama kartında hiç parti satırı yok');
  const beklenen = j.partiler.slice().sort((a, b) => b.toplam - a.toplam).slice(0, gosterilen.length)
    .map((r) => r.parti);
  for (const p of beklenen) {
    assert.ok(
      gosterilen.includes(p),
      `En büyük ${gosterilen.length} partiden '${p}' listede YOK → seçim ölçütü gösterilen ölçüyle ` +
      `aynı (kanunlasti) demektir ve liste yapısal olarak yanlı. Gösterilen: ${gosterilen.join(',')}`,
    );
  }
  const kanunlasti = gosterilen.map((p) => j.partiler.find((r) => r.parti === p)?.kanunlasti ?? 0);
  for (let i = 1; i < kanunlasti.length; i++) {
    assert.ok(kanunlasti[i - 1] >= kanunlasti[i], `sıra gösterilen ölçüye göre değil: ${kanunlasti.join(',')}`);
  }
});

test('parti.html — dönem seçici: d27 seçilince kartlar GERÇEKTEN değişir', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('parti.html', '?p=CHP&donem=27');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const $ = (id) => w.document.getElementById(id);
  assert.equal($('donemSel').value, '27', 'seçici d27 göstermiyor');
  assert.match($('ftDonem').textContent, /27\. Dönem/, 'footer dönemi sabit kalmış (yalan)');

  const d27chp = await fetch(`${API}/api/ozet/yasama?donem=27`).then((r) => r.json());
  const d28chp = await fetch(`${API}/api/ozet/yasama?donem=28`).then((r) => r.json());
  const chp27 = d27chp.partiler.find((r) => r.parti === 'CHP')?.toplam;
  const chp28 = d28chp.partiler.find((r) => r.parti === 'CHP')?.toplam;
  assert.ok(chp27 && chp28 && chp27 !== chp28, 'test önkoşulu: d27 ve d28 CHP sayıları farklı olmalı');
  assert.ok($('yasama').textContent.includes(chp27.toLocaleString('tr-TR')), `yasama kartı d27 sayısını (${chp27}) göstermiyor`);
  assert.ok(!$('yasama').textContent.includes(chp28.toLocaleString('tr-TR')), `yasama kartı d28 sayısında (${chp28}) DONMUŞ`);

  assert.equal($('fldZaman').hidden, true, 'd27 konu kapalı ama Zaman dilimi kontrolü görünür (ölü kontrol)');
  assert.equal($('fldKonu').hidden, true, 'd27 konu kapalı ama Konu seçici görünür (ölü kontrol)');
  assert.equal($('chartCard').hidden, true, 'd27 grafik kartı gizlenmedi (boş eksen çizilir)');
  assert.match($('rank').textContent, /doğrulanacak|model tahmini|yayımlanmıyor/i, 'rank kapı gerekçesini söylemiyor');
});

test('parti.html — d27 oy kartı: agregat oylama GÖSTERİLİR + vekil-döküm yokluğu BEYAN edilir', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('parti.html', '?p=CHP&donem=27');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const $ = (id) => w.document.getElementById(id);
  assert.equal($('oyCard').hidden, false, 'oy kartı d27\'de gizli — sessiz kaybolma (GAP geri geldi)');

  const agg = await fetch(`${API}/api/ozet/oylama?donem=27`).then((r) => r.json());
  const toplam = agg.ozet?.toplam;
  assert.ok(toplam > 0, 'test önkoşulu: d27 agregat oylama > 0 olmalı');
  const kozet = $('oy').querySelector('.kozet');
  assert.ok(kozet, 'agregat (.kozet) çizilmemiş — d27 oylama-agregat hücresi hâlâ sessiz boşluk');
  assert.match(kozet.textContent, /açık oylama/i, 'agregat cümlesi "açık oylama" demiyor');
  assert.ok(kozet.textContent.includes(String(toplam)), `agregat d27 oylama sayısını (${toplam}) göstermiyor`);

  const oy = $('oy').textContent;
  assert.match(oy, /taranmış görüntü/i, 'vekil-döküm yokluğu (taranmış görüntü) beyanı yok');
  assert.match(oy, /vekil/i, 'beyan eksik olanı (vekil bazlı döküm) adlandırmıyor');
});

test('parti.html — d28 yıl düğmesi GERÇEKTEN filtreliyor (2024/2025 sabit tuzağı, genel regex)', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('parti.html', '?p=CHP&donem=28');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const $ = (id) => w.document.getElementById(id);
  const yilBtn = [...$('period').querySelectorAll('button')].find((b) => b.dataset.v === '2023')
    ?? [...$('period').querySelectorAll('button')].find((b) => /^20\d\d$/.test(b.dataset.v));
  assert.ok(yilBtn, 'd28 için yıl düğmesi yok');
  const oncekiSvg = $('chart')?.innerHTML ?? '';
  yilBtn.click();
  await new Promise((r) => setTimeout(r, 800));
  assert.notEqual($('chart')?.innerHTML ?? '', oncekiSvg, `"${yilBtn.dataset.v}" düğmesi grafiği değiştirmedi — yıl filtresi çalışmıyor`);
  assert.equal($('period').querySelector('button.on')?.dataset.v, yilBtn.dataset.v, 'düğme seçili görünmüyor');
});

for (const [dosya, arama, idler] of [
  ['konu.html', '?k=' + encodeURIComponent('Adalet & Hukuk') + '&donem=27', []],
  ['karsilastir.html', '?donem=27', []],
  ['arac.html', '?donem=27', []],
]) {
  test(`${dosya} — d27: TÜM /api çağrıları donem taşır + JS hatasız`, { skip: !canli && 'backend :8000 kapalı' }, async () => {
    const cagrilar = [];
    const { w, hatalar } = await sayfaKos(dosya, arama, (u) => cagrilar.push(u));
    assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
    assert.ok(cagrilar.length > 0, 'hiç /api çağrısı yapılmadı — sayfa çalışmıyor');
    const eksik = cagrilar.filter((u) => !u.includes('/meta') && !/[?&]donem=/.test(u));
    assert.deepEqual(eksik, [], `donem'siz çağrı(lar): ${eksik.join(' | ')}`);
    const yanlis = cagrilar.filter((u) => /[?&]donem=/.test(u) && !/[?&]donem=27(&|$)/.test(u));
    assert.deepEqual(yanlis, [], `yanlış dönem gönderen çağrı(lar): ${yanlis.join(' | ')}`);
    if (dosya === 'karsilastir.html') {
      const cb = w.document.getElementById('donemCb');
      assert.ok(cb, 'dönem seçici (donemCb) yok');
      const d27 = cb.querySelector('.dcb[data-d="27"]');
      assert.ok(d27 && d27.getAttribute('aria-pressed') === 'true', 'karsilastir d27 seçili göstermiyor');
    } else {
      const sel = w.document.getElementById('donemSel');
      assert.ok(sel, 'dönem seçici yok');
      assert.equal(sel.value, '27', 'seçici d27 göstermiyor');
    }
  });
}

test('index.html — vitrin kartları dolar (demo/oylama)', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('index.html', '');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const $ = (id) => w.document.getElementById(id);
  assert.match($('demo').innerHTML, /dbar/, '.demo yasama çubukları yok');
  assert.match($('demoLede').textContent, /Teklif vermek|kanunlaştığı/, '.demo lede giriş cümlesi yok');
  assert.equal($('oySec').hidden, false, 'oylama bölümü açılmadı');
  assert.match($('oyDemo').textContent, /işaretle/, 'oylama kapsam notu yok');
  assert.match($('oyDemo').textContent, /ret payı/, 'parti ret payı bloğu yok');
  assert.match($('oyDemo').textContent, /vekil dökümü bulunabildi/, 'dürüst payda (79/129) notu yok');
  const cubuk = [...$('oyDemo').querySelectorAll('.dbar .dl span')].map((s) => s.textContent);
  assert.ok(cubuk.includes('Ret oyu var'), 'kurumsal olgu çubuğu kaybolmuş');
  const parti = cubuk.filter((t) => /^(AKP|CHP|DEM|MHP|IYI|SAADET|YENI YOL|DEVA|BAGIMSIZ)$/.test(t));
  assert.ok(parti.length >= 3, `parti çubuğu yok/az: ${cubuk.join(',')}`);
  assert.ok(parti.includes('AKP'), `en büyük grup (AKP) listede yok — seçim ölçütü yanlı: ${parti.join(',')}`);
  assert.ok(parti.includes('CHP'), `CHP listede yok: ${parti.join(',')}`);
  const ilk = $('oyDemo').textContent.indexOf(parti[0]);
  const son = $('oyDemo').textContent.indexOf(parti[parti.length - 1]);
  assert.ok(ilk < son, 'parti sırası bozuk');
});

test('etiket kapısı — donem=hepsi TÜM parti×konu uçlarında bloklu (bypass kapalı)', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const d27 = await fetch(`${API}/api/ozet/parti-konu?donem=27`).then((r) => r.json());
  if (d27.yayimlanabilir !== false) return;

  const uclar = ['parti-konu', 'siralama', 'karsilastir', 'cesaret', 'trend', 'cesaret-konu', 'konu-zaman', 'parti-ay-konu'];
  for (const e of uclar) {
    const qs = new URLSearchParams({ donem: 'hepsi', parti: 'CHP', a: 'CHP', b: 'AKP', partiler: 'CHP', kategori: 'Sağlık' });
    const j = await fetch(`${API}/api/ozet/${e}?${qs}`).then((r) => r.json());
    assert.equal(j.yayimlanabilir, false, `${e}?donem=hepsi bloklanmadı — kapı bypass'ı geri geldi (d26/d27 payları havuzda sızıyor)`);
  }
});

test('/oylama — dönem toplamları hepsi ile tutuyor (yetim/dönem-dışı satır yok)', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const g = async (d) => (await fetch(`${API}/api/ozet/oylama?donem=${d}`).then((r) => r.json())).ozet.toplam;
  const [d28, d27, d26, hepsi] = await Promise.all([g(28), g(27), g(26), g('hepsi')]);
  assert.equal(d28 + d27 + d26, hepsi, `dönem toplamları (${d28}+${d27}+${d26}) hepsi'ye (${hepsi}) eşit değil — yetim/dönem-dışı oylama var`);
});

test('konu.html — TÜİK göstergesi .ynote kapsam notu + kaynak linki taşır (M5)', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const kat = 'Ekonomi & Finans';
  const api = await fetch(`${API}/api/ozet/gosterge?kategori=${encodeURIComponent(kat)}&donem=28`).then((r) => r.json());
  if (!api.gosterge || !api.seri?.length) return;
  const { w, hatalar } = await sayfaKos('konu.html', '?k=' + encodeURIComponent(kat) + '&donem=28');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const g = w.document.getElementById('gosterge');
  assert.ok(g && g.innerHTML.includes('TÜİK'), 'TÜİK şeridi çizilmemiş (test önkoşulu)');
  const ynote = g.querySelector('.ynote');
  assert.ok(ynote, "TÜİK şeridinde kapsam notu (.ynote) YOK — M5 ihlali (RG/AYM'de var, TÜİK'te yoktu)");
  assert.ok(ynote.textContent.includes(api.gosterge.baslik), `.ynote gösterge adını (${api.gosterge.baslik}) anmıyor — M5 metrik adı`);
  assert.match(ynote.textContent, /partiye ait değildir|bağlam/i, '.ynote "neyi saymadığını" (partiye ait değil) söylemiyor');
  assert.ok(ynote.querySelector('a[href]'), '.ynote kaynak linki (TÜİK) taşımıyor');
});

test('vekil.html — il seçilince vekil oy karneleri + tıklayınca oy geçmişi', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('vekil.html', '?il=Ankara');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const $ = (id) => w.document.getElementById(id);
  assert.equal($('vkCard').hidden, false, 'vekil kartı açılmadı');
  const vk = w.document.querySelectorAll('.vk');
  const api = await fetch(`${API}/api/ozet/vekil-oy?il=Ankara`).then((r) => r.json());
  assert.equal(vk.length, api.vekiller.length, `Ankara vekil sayısı UI(${vk.length}) ≠ API(${api.vekiller.length})`);
  assert.ok(vk.length > 10, 'Ankara için makul sayıda vekil yok');
  const iller = await fetch(`${API}/api/ozet/vekil-oy`).then((r) => r.json());
  const ankara = iller.iller.find((x) => x.il === 'Ankara');
  assert.equal(api.vekiller.length, ankara.vekil,
    `kişi sayısı tutmuyor: il listesi ${ankara.vekil} vekil derken kart ${api.vekiller.length} satır — parti değiştirenler çoğaltılıyor`);
  const sw = api.vekiller.filter((v) => v.parti_n > 1);
  if (sw.length) {
    assert.ok(sw[0].toplam >= api.oylama_n * 0.9,
      `parti değiştiren vekilin oyları bölünmüş: ${sw[0].ad} ${sw[0].soyad} ${sw[0].toplam}/${api.oylama_n}`);
  }
  assert.ok(vk[0].querySelector('.vkbar i'), 'oy dağılım çubuğu yok');
  assert.ok(vk[0].querySelector('.vkad .d'), 'parti rengi noktası yok');
  assert.ok(api.parti_katilim && Object.keys(api.parti_katilim).length >= 3,
    'uç parti katılım ortancasını döndürmüyor — ham katılmadı sayısı kıyassız kalır (M7)');
  const kiyasli = [...vk].filter((el) => el.querySelector('.vkort')).length;
  const kiyasBeklenen = api.vekiller.filter((v) => api.parti_katilim[v.parti]).length;
  assert.equal(kiyasli, kiyasBeklenen,
    `ortanca kıyası eksik: ${kiyasli}/${kiyasBeklenen} vekilde gösteriliyor`);
  for (const [parti, p] of Object.entries(api.parti_katilim)) {
    assert.ok(p.vekil_n >= 10, `${parti} ortancası yalnız ${p.vekil_n} vekilden — taban altı yayımlanmamalı`);
    assert.ok(p.ortanca >= 0 && p.ortanca <= 1, `${parti} ortancası oran değil: ${p.ortanca}`);
  }
  const cnote = w.document.querySelector('.cnote')?.textContent ?? '';
  assert.match(cnote, /28\. dönem/i, 'kapsam notu d28-only beyanını içermiyor');
  assert.match(cnote, /katılmadı/i, 'katılmadı yargısızlık notu yok');
  vk[0].querySelector('.vkhead').click();
  await new Promise((r) => setTimeout(r, 2200));
  assert.equal(vk[0].getAttribute('aria-expanded'), 'true', 'tıklama satırı açmadı');
  assert.ok(vk[0].querySelectorAll('.orow').length > 0, 'oy geçmişi (satırlar) yüklenmedi');
  assert.ok(vk[0].querySelector('.otag'), 'oy etiketi (Kabul/Ret) yok');

  const v0 = api.vekiller[0];
  const kj = await fetch(`${API}/api/ozet/vekil-konusma?il=Ankara&ad=${encodeURIComponent(v0.ad)}&soyad=${encodeURIComponent(v0.soyad)}&limit=5`).then((r) => r.json());
  if (kj.kayitlar?.length) {
    assert.ok(vk[0].querySelector('.soz'), 'konuşma bölümü çizilmedi — 72.688 konuşma yüzeysiz kalıyor');
    assert.ok(vk[0].querySelectorAll('.sozrow').length > 0, 'konuşma satırı yok');
    assert.ok(vk[0].querySelector('.sozrow[href]'), 'konuşma satırı TBMM tutanağına link vermiyor (kaynak dürüstlüğü)');
    assert.match(vk[0].querySelector('.soz').textContent, /seçilmemiştir|başından/, 'alıntının seçilmediği (kiraz toplama yok) beyanı eksik');
  }
});

test('karsilastir.html — oy davranışı + yasama sonucu kartları (2 parti kıyası)', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('karsilastir.html', '');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const $ = (id) => w.document.getElementById(id);
  const sel = $('cmpSel');
  sel.value = 'AKP';
  sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal($('oyCard').hidden, false, 'oy davranışı kartı görünmüyor');
  assert.ok($('oyRows').querySelectorAll('.row').length >= 2, `oy kıyası 2 parti göstermiyor (${$('oyRows').querySelectorAll('.row').length})`);
  assert.match($('oyRows').textContent, /ret/i, 'ret payı yok');
  assert.match($('oyRows').textContent, /(katılım|oy kullanma)/i, 'M7 ihlali: ret payı yanında ikinci ölçü yok');
  assert.equal($('yasamaCard').hidden, false, 'yasama sonucu kartı görünmüyor');
  assert.ok($('yasamaRows').querySelectorAll('.row').length >= 2, 'yasama kıyası 2 parti göstermiyor');
  assert.match($('yasamaRows').textContent, /→/, 'teklif→kanunlaştı oku yok');
  assert.match($('timeTitle').textContent, /vs/, 'zaman kartı başlığı kıyası yansıtmıyor (tek parti gibi)');
  assert.ok(w.document.querySelectorAll('#timeChart polyline[stroke-dasharray]').length > 0,
    'ikinci partinin (kesikli) çizgisi yok — zaman kartı hâlâ tek parti gösteriyor');
  assert.match($('timeLegend').textContent, /kesikli/, 'düz/kesikli ayrımı açıklanmamış');
});

test('index.html — önerge cevaplanma durumu (parti-nötr kurumsal olgu)', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('index.html', '');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const $ = (id) => w.document.getElementById(id);
  assert.equal($('cevapSec').hidden, false, 'önerge cevaplanma bölümü açılmadı');
  const t = $('cevapDemo').textContent, lede = $('cevapLede').textContent;
  assert.match(lede, /hiç cevaplanmadı/i, 'en çarpıcı olgu (hiç cevaplanmayan) lede\'de yok');
  assert.match(t, /Süresinde cevaplandı/, 'süresinde cevaplanan çubuğu yok');
  assert.match(t, /Hiç cevaplanmadı/, 'hiç cevaplanmayan çubuğu yok');
  assert.match(t, /İçtüzük md\.99/, 'usul kaynağı (15 gün / İçtüzük) belirtilmemiş — M5');
  assert.match(t, /partilerin değil|partilerin başarısını değil/, 'parti-nötr olduğu beyan edilmemiş');
  const j = await fetch(`${API}/api/ozet/onerge-durum?donem=28`).then((r) => r.json());
  const hic = j.dagilim.filter((x) => /Cevaplanmadığı/.test(x.durum)).reduce((s, x) => s + x.n, 0);
  assert.ok(t.includes(hic.toLocaleString('tr-TR')), `hiç-cevaplanmayan sayısı (${hic}) kartta yok`);
});

test('konu.html — yürürlük kartı mevzuat gösterir, mahkeme kararı DEĞİL', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const kat = 'Adalet & Hukuk';
  const j = await fetch(`${API}/api/ozet/yururluk?kategori=${encodeURIComponent(kat)}&donem=28&limit=12`).then((r) => r.json());
  assert.ok(j.success, 'yururluk ucu başarısız');
  const yargi = j.kayitlar.filter((k) => /MAHKEMESİ KARARLARI|YARGITAY|DANIŞTAY/i.test(k.tur ?? ''));
  assert.deepEqual(yargi.map((k) => k.tur), [],
    `yürürlük kartında mahkeme kararı var (yargı kartını tekrarlıyor): ${yargi.map((k) => k.tur).join(', ')}`);
  const acik = await fetch(`${API}/api/ozet/yururluk?kategori=${encodeURIComponent(kat)}&donem=28&tur=${encodeURIComponent('ANAYASA MAHKEMESİ')}&limit=3`).then((r) => r.json());
  assert.ok(acik.kayitlar.length > 0, 'tur açıkça istendiğinde yargı kararı yine de gelmeli (filtre çağıranı kilitlememeli)');
});

for (const donem of [26, 27]) {
  test(`konu.html — d${donem}'de AYM/RG kartları GERÇEKTEN görünür (gated'a rağmen)`, { skip: !canli && 'backend :8000 kapalı' }, async () => {
    const { w, hatalar } = await sayfaKos('konu.html', `?k=${encodeURIComponent('Ekonomi & Finans')}&donem=${donem}`);
    assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
    const yururlukCard = w.document.getElementById('yururlukCard');
    const yargiCard = w.document.getElementById('yargiCard');
    assert.ok(yururlukCard && !yururlukCard.hidden, `d${donem}: yururlukCard gizli — RG verisi olmasına rağmen saklanıyor olabilir`);
    assert.ok(yargiCard && !yargiCard.hidden, `d${donem}: yargiCard gizli — AYM verisi olmasına rağmen saklanıyor olabilir`);
    assert.ok(w.document.getElementById('yururluk').children.length > 0, `d${donem}: yururluk kartı içerik taşımıyor`);
    assert.ok(w.document.getElementById('yargi').children.length > 0, `d${donem}: yargi kartı içerik taşımıyor`);
  });
}

test('konu.html — parti programı kartı konu kelimesiyle arar, vaat-tutuldu hükmü VERMEZ', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('konu.html', '?k=' + encodeURIComponent('Ekonomi & Finans'));
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const kart = w.document.getElementById('partiProgramCard');
  assert.ok(kart, 'partiProgramCard yok');
  const satirlar = kart.querySelectorAll('.pprow');
  assert.ok(satirlar.length >= 3, `parti programı satırları eksik (${satirlar.length})`);
  for (const s of satirlar) {
    assert.ok(s.querySelector('.ppbaslik b')?.textContent, 'parti adı yok');
    assert.ok(s.querySelector('.ppalinti')?.textContent?.trim().length > 10, 'alıntı yok/çok kısa');
    const link = s.querySelector('.ppkaynak');
    assert.ok(link?.getAttribute('href')?.startsWith('http'), 'kaynağa giden link yok');
    assert.equal(link.getAttribute('target'), '_blank', 'kaynak linki yeni sekmede açılmıyor');
  }
  const metin = kart.textContent;
  assert.match(metin, /İYİ Parti/, 'İYİ Parti eksikliği beyan edilmemiş');
  assert.match(metin, /Millet İttifakı|2025/, 'CHP belgesinin 2023\'e özgü olmadığı beyan edilmemiş');
  const veriMetni = [...kart.querySelectorAll('.pprow')].map((r) => r.textContent).join(' ');
  assert.doesNotMatch(veriMetni, /\btutuldu\b|\byerine getir(di|medi)\b|✓|✗/i,
    'parti satırlarında vaat-tutuldu-mu hükmü var gibi görünüyor — bu Mizan\'ın kaçındığı editoryal yargı');
});

test('konu.html — parti programı kartı: eşleşme yoksa NEDEN olmadığını söyler (susmaz)', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const j = await fetch(`${API}/api/ozet/parti-program-ara?q=asdfqwerzxcvasdfqwer`).then((r) => r.json());
  assert.equal(j.toplam, 0, 'anlamsız terim eşleşme döndürüyor — test terimi kontrol edilmeli');
});

test('konu.html — yerel karar kartı belediye meclisi kararlarını gösterir, roll-call hükmü VERMEZ', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('konu.html', '?k=' + encodeURIComponent('Konut & Şehircilik'));
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const kart = w.document.getElementById('yerelKararCard');
  assert.ok(kart, 'yerelKararCard yok');
  const satirlar = kart.querySelectorAll('.pprow');
  assert.ok(satirlar.length >= 1, `yerel karar satırları eksik (${satirlar.length})`);
  for (const s of satirlar) {
    assert.ok(s.querySelector('.ppbaslik b')?.textContent, 'belediye adı yok');
    const link = s.querySelector('.ppkaynak');
    assert.ok(link?.getAttribute('href')?.startsWith('http'), 'kaynağa giden link yok');
  }
  const veriMetni = [...kart.querySelectorAll('.pprow')].map((r) => r.textContent).join(' ');
  assert.doesNotMatch(veriMetni, /\bret\s+oy(u)?\s+veren\b|\bkabul\s+oyu\s+veren\b/i,
    'yerel karar satırlarında üye-bazlı oy hükmü var gibi görünüyor — bu kaynaklarda yok/güvenilmez');
  assert.match(kart.textContent, /2024 yerel seçimi/, 'zaman penceresi (2024 sonrası) beyan edilmemiş');
});

test('yerel-yonetim.html — belediye seçilince meclis kompozisyonu + kararlar birlikte yüklenir', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('yerel-yonetim.html', '?belediye=' + encodeURIComponent('İstanbul'));
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const sec = w.document.getElementById('belediyeSec');
  assert.equal(sec.value, 'İstanbul', 'URL parametresi belediye=İstanbul uygulanmalı');
  const secenekler = [...sec.options].map((o) => o.value);
  const orijinalAlti = ['Ankara', 'Bursa', 'Diyarbakır', 'İstanbul', 'İzmir', 'Konya'];
  const eksik = orijinalAlti.filter((b) => !secenekler.includes(b));
  assert.deepEqual(eksik, [], `orijinal 6 büyükşehirden bazıları seçenekten DÜŞMÜŞ: ${eksik.join(', ')} (gelen: ${secenekler.join(', ')})`);
  const govde = w.document.getElementById('govde');
  assert.match(govde.textContent, /CHP|AKP|AK PARTİ/, 'parti kompozisyonu görünmüyor');
  assert.ok(govde.querySelectorAll('.chart-track .chart-fill').length >= 2, 'parti çubukları eksik');
  const kararlar = w.document.getElementById('kararlarGovde');
  assert.ok(kararlar.querySelectorAll('.krow').length >= 1, 'kararlar listesi boş');
});

test('yerel-yonetim.html — Diyarbakır seçilince üye listesi YOK diye dürüstçe söyler, kararlar yine gelir', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('yerel-yonetim.html', '?belediye=' + encodeURIComponent('Diyarbakır'));
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const govde = w.document.getElementById('govde');
  assert.match(govde.textContent, /mevcut değil|yok/i, 'üye listesi eksikliği beyan edilmemiş');
  const kararlar = w.document.getElementById('kararlarGovde');
  assert.ok(kararlar.querySelectorAll('.krow').length >= 1, 'Diyarbakır kararları gelmedi (üye eksikliği kararları da gizlememeli)');
});

test('vekil.html — vekil adıyla aranabiliyor (il rozetli sonuçlar)', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('vekil.html', '?ara=' + encodeURIComponent('özgür'));
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const vk = w.document.querySelectorAll('.vk');
  const j = await fetch(`${API}/api/ozet/vekil-oy?ara=${encodeURIComponent('özgür')}`).then((r) => r.json());
  assert.equal(j.mod, 'ara', 'API arama moduna girmiyor (il listesine düşüyor)');
  assert.ok(j.vekiller.length > 0, 'arama sonuç döndürmüyor — Türkçe harf katlanması bozuk olabilir');
  assert.equal(vk.length, j.vekiller.length, `UI arama sonucu (${vk.length}) API ile (${j.vekiller.length}) tutmuyor`);
  assert.equal(w.document.querySelectorAll('#vekiller .vkil').length, vk.length,
    'arama sonuçlarında il rozeti yok (hangi ilden belli değil)');
  assert.ok(w.document.querySelectorAll('.vksay').length > 0, 'oy sayısı görünür değil (yalnız title ipucunda)');
});

test('vekil.html — konuşmalarda kelime araması (etiketten bağımsız, kaynağa linkli)', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const terim = 'asgari ücret';
  const { w, hatalar } = await sayfaKos('vekil.html', '?soz=' + encodeURIComponent(terim));
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const rows = w.document.querySelectorAll('#sozSonuc .sozrow');
  const j = await fetch(`${API}/api/ozet/konusma-ara?q=${encodeURIComponent(terim)}&limit=12`).then((r) => r.json());
  assert.ok(j.success && j.kayitlar.length > 0, 'arama ucu sonuç döndürmüyor');
  assert.equal(rows.length, j.kayitlar.length, `UI sonucu (${rows.length}) API ile (${j.kayitlar.length}) tutmuyor`);
  for (const r of rows) assert.match(r.getAttribute('href') ?? '', /tbmm\.gov\.tr/, 'konuşma satırı TBMM tutanağına link vermiyor');
  assert.ok(j.kayitlar.some((k) => k.alinti.toLocaleLowerCase('tr').includes('asgari')),
    'alıntı aranan kelimeyi içermiyor — pencere yanlış yerden alınmış');
});

test('index.html — M7 çift payda (ret payı + katılım birlikte)', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('index.html', '');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const $ = (id) => w.document.getElementById(id);
  const oyMetin = $('oyDemo').textContent;
  assert.match(oyMetin, /ret/i, 'ret payı yok');
  assert.match(oyMetin, /katılım/i, 'M7 ihlali: ana sayfada ret payı var ama katılım YOK');
});

test('vekil.html — parti çizgisinden ayrılanlar toplu listesi', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('vekil.html', '');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const $ = (id) => w.document.getElementById(id);
  assert.equal($('farkliCard').hidden, false, 'parti çizgisi kartı açılmadı');
  assert.ok($('farkliListe').querySelectorAll('.sozrow').length >= 5, 'liste boş/az');
  const j = await fetch(`${API}/api/ozet/vekil-oy?farkli=1`).then((r) => r.json());
  assert.equal(j.mod, 'farkli', 'uç farklı moduna girmiyor');
  for (const v of j.vekiller) {
    assert.ok(Number(v.farkli) > 0, 'sapması olmayan vekil listede');
    assert.notEqual(v.parti, 'BAGIMSIZ', 'bağımsız listede — parti çizgisi tanımsız olmalı');
  }
  const s = j.vekiller.map((v) => Number(v.farkli));
  assert.deepEqual(s, [...s].sort((a, b) => b - a), 'sıralama azalan değil');
});

test('index.html — cevaplanma çubukları toplama eşit (sessiz eksiltme yok)', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('index.html', '');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const $ = (id) => w.document.getElementById(id);
  const j = await fetch(`${API}/api/ozet/onerge-durum?donem=28`).then((r) => r.json());
  const adetler = [...$('cevapDemo').querySelectorAll('.dl')]
    .map((e) => e.textContent.match(/·\s*([\d.]+)\s*$/)?.[1])
    .filter(Boolean).map((s) => Number(s.replace(/\./g, '')));
  assert.ok(adetler.length >= 3, `çubuk adetleri okunamadı: ${adetler.length}`);
  const toplam = adetler.reduce((s, n) => s + n, 0);
  assert.equal(toplam, j.toplam, `çubuklar ${toplam} ediyor ama toplam ${j.toplam} — ${j.toplam - toplam} kayıt sessizce düşmüş`);
  assert.ok($('cevapLede').textContent.includes(j.toplam.toLocaleString('tr-TR')), 'lede toplamı API ile tutmuyor');
});

test('karsilastir.html — seçim URL\'de taşınır (kıyas paylaşılabilir)', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('karsilastir.html', '?a=DEM&b=MHP');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const baslik = w.document.getElementById('heroTitle').textContent;
  assert.match(baslik, /DEM/, 'URL\'deki a partisi uygulanmadı');
  assert.match(baslik, /MHP/, 'URL\'deki b partisi uygulanmadı');
  assert.match(w.location.search, /a=DEM/, 'URL a parametresini taşımıyor');
  assert.match(w.location.search, /b=MHP/, 'URL b parametresini taşımıyor');
  assert.match(w.location.search, /donem=/, 'URL dönem parametresini kaybetti');
});

test('tüm sayfalar — ana sayfaya çıkış var (gerçek çıkmaz sokak yok)', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  for (const dosya of ['parti.html', 'konu.html', 'vekil.html', 'karsilastir.html', 'arac.html']) {
    const html = readFileSync(join(KOK, dosya), 'utf8');
    assert.ok(html.includes('href="/"'), `${dosya}: ana sayfaya dönüş linki yok — gerçek çıkmaz sokak`);
  }
});

test('index.html — cevapsızlık kurum bazında (bakan adı geçmemeli)', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const j = await fetch(`${API}/api/ozet/muhatap-cevap?donem=28`).then((r) => r.json());
  assert.ok(j.success && j.kurumlar.length >= 3, 'kurum kırılımı boş');
  for (const k of j.kurumlar) {
    assert.ok(!/[A-ZÇĞİÖŞÜ]{3,}/.test(k.kurum.replace(/^TBMM/, '')),
      `kurum adında BÜYÜK HARFLİ kişi soyadı var: "${k.kurum}"`);
    assert.ok(!/Önceki/i.test(k.kurum), `"önceki" etiketi kuruma sızmış: "${k.kurum}"`);
    assert.ok(k.toplam >= 100, `taban altı kurum listede: ${k.kurum} (${k.toplam})`);
  }
  assert.ok(j.kapsanan <= j.toplam, 'kapsanan toplamı aşıyor');
  assert.ok(j.kapsanan / j.toplam > 0.9, `kapsam düşük: ${j.kapsanan}/${j.toplam}`);
  const { w, hatalar } = await sayfaKos('index.html', '');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  assert.match(w.document.getElementById('cevapDemo').textContent, /önerge/, 'kurum kırılımı çizilmemiş');
});

test('index.html — çip listeleri kırpılıyorsa "daha fazlası" kapısı var', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('index.html', '');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  for (const id of ['parties', 'topics']) {
    const cipler = [...w.document.getElementById(id).querySelectorAll('.tchip')].map((e) => e.textContent.trim());
    assert.ok(cipler.length > 0, `${id} boş`);
    const son = cipler[cipler.length - 1];
    if (/daha/.test(son)) {
      assert.match(son, /\+\d+/, `${id}: kapı çipinde kaç tane kaldığı yazmıyor: "${son}"`);
      assert.ok(w.document.getElementById(id).querySelector('a[href*="karsilastir"]'), `${id}: kapı çipi bir yere gitmiyor`);
    }
  }
});

test('yeni yüzeyler — PARTI_DISI sızıntısı yok, kırpma beyan edilir, beraberlik ortadan kesilmez', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  for (const terim of ['kesin hesap', 'bütçe', 'deprem']) {
    const j = await fetch(`${API}/api/ozet/konusma-ara?q=${encodeURIComponent(terim)}&limit=12`).then((r) => r.json());
    if (!j.success) continue;
    for (const k of j.kayitlar) {
      assert.ok(k.parti !== 'YÜRÜTME' && k.parti !== 'Bilinmiyor',
        `"${terim}": parti-dışı etiket parti gibi dönüyor (${k.parti}) — #2 yolunun nüksü`);
    }
    assert.ok(typeof j.toplam === 'number' && j.toplam >= j.kayitlar.length,
      `"${terim}": eşleşen TOPLAM beyan edilmiyor — sessiz kırpma`);
  }
  const { w, hatalar } = await sayfaKos('vekil.html', '?soz=' + encodeURIComponent('deprem'));
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const jd = await fetch(`${API}/api/ozet/konusma-ara?q=${encodeURIComponent('deprem')}&limit=12`).then((r) => r.json());
  assert.ok(w.document.getElementById('sozSonuc').textContent.includes(jd.toplam.toLocaleString('tr-TR')),
    'UI eşleşen toplamı göstermiyor — okur gösterilen diliminin tamamı sanır');

  const f = await fetch(`${API}/api/ozet/vekil-oy?farkli=1`).then((r) => r.json());
  const esik = f.gosterilen_esik;
  assert.ok(esik >= 1, 'eşik bildirilmiyor');
  for (const v of f.vekiller) {
    assert.ok(Number(v.farkli) >= esik, `eşik altı vekil listede: ${v.ad} (${v.farkli} < ${esik})`);
  }
  const esiktekiler = f.vekiller.filter((v) => Number(v.farkli) === esik).length;
  assert.ok(esiktekiler > 0, 'eşik grubu boş — kesim mantığı bozuk');
});

test('karsilastir.html d27 — yasama dolu, oy yokluğu BEYAN edilir, teklif kaderi yazılı', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('karsilastir.html', '?donem=27');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const $ = (id) => w.document.getElementById(id);
  assert.equal($('yasamaCard').hidden, false, 'yasama kartı gizli');
  assert.ok($('yasamaRows').querySelectorAll('.row').length > 0, 'yasama kartı BAŞLIKLI AMA BOŞ — veri var ama çizilmemiş');
  const j = await fetch(`${API}/api/ozet/yasama?donem=27`).then((r) => r.json());
  const dusen = (j.durumlar ?? []).filter((x) => /HÜKÜMSÜZ/.test(x.durum)).reduce((s, x) => s + x.n, 0);
  if (dusen > 0) {
    assert.ok($('yasamaNote').textContent.includes(dusen.toLocaleString('tr-TR')),
      `teklif kaderi yazılmamış: ${dusen} hükümsüz teklif anılmıyor`);
  }
  assert.equal($('oyCard').hidden, false, 'oy kartı SESSİZCE gizlenmiş (beyan yok)');
  assert.match($('oyRows').textContent, /taranmış görüntü|dökümü yok/i, 'oy yokluğunun GEREKÇESİ yazılmamış');
  const vo = await fetch(`${API}/api/ozet/vekil-oy?donem=27&il=Ankara`).then((r) => r.json());
  assert.equal(vo.mod, 'donem-yok', 'vekil-oy d27 isteğine d28 verisi dönüyor (sessiz YANLIŞ)');
  assert.ok((vo.sebep ?? '').length > 20, 'dönem yokluğu gerekçesiz');
});

test('vekil.html — her oy satırı tutanağa gider, konusu bilinmeyen satır BEYAN eder', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const j = await fetch(`${API}/api/ozet/vekil-oy?il=Ankara&ad=${encodeURIComponent('Yıldırım Tuğrul')}&soyad=${encodeURIComponent('Türkeş')}`).then((r) => r.json());
  assert.ok(j.bulundu, 'vekil bulunamadı — fixture kaydı değişmiş');
  const linksiz = j.kayitlar.filter((k) => !k.url);
  assert.equal(linksiz.length, 0, `${linksiz.length} oy satırı kaynaksız`);
  assert.ok(j.kayitlar.every((k) => /^https:\/\/www\.tbmm\.gov\.tr\/Tutanaklar\/Tutanak\?Id=/.test(k.url)), 'link TBMM tutanağına gitmiyor');
  assert.equal(j.ozet.toplam, j.kayitlar.length, 'özet toplamı satır sayısıyla tutmuyor');
  assert.ok(j.ozet.toplam <= j.oylama_n, `vekilin oy sayısı (${j.ozet.toplam}) toplam oylamayı (${j.oylama_n}) aşıyor — satır çoğalması`);

  const { w, hatalar } = await sayfaKos('vekil.html', `?il=Ankara&ad=${encodeURIComponent('Yıldırım Tuğrul')}&soyad=${encodeURIComponent('Türkeş')}`);
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const satirlar = [...w.document.querySelectorAll('.orow')];
  if (satirlar.length) {
    assert.ok(satirlar.every((r) => r.querySelector('a.okay')), 'bazı oy satırında tutanak linki çizilmemiş');
    const metin = w.document.getElementById('vbody').textContent;
    assert.ok(!/Açık oylama(?!\s*(cetveli|sonuc))/.test(metin) || /tutanakta yazılı değil/.test(metin),
      'konusu bilinmeyen satır hâlâ boşluğu yutan "Açık oylama" etiketiyle çiziliyor');
  }
});

test('karsilastir.html — yasama artığı TÜM parti kümesinden hesaplanır, seçili ikisinden değil', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const j = await fetch(`${API}/api/ozet/yasama?donem=28`).then((r) => r.json());
  const tum = j.partiler ?? [];
  const artikT = j.toplam_teklif - tum.reduce((s, r) => s + (r.toplam ?? 0), 0);
  const artikK = j.toplam_kanunlasti - tum.reduce((s, r) => s + (r.kanunlasti ?? 0), 0);
  assert.ok(artikT >= 0 && artikK >= 0, 'parti toplamı dönem toplamını aşıyor — payda karışmış');

  const { w, hatalar } = await sayfaKos('karsilastir.html', '?donem=28&a=CHP&b=AKP');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const not = w.document.getElementById('yasamaNote').textContent;
  if (artikT > 0) {
    assert.ok(not.includes(artikT.toLocaleString('tr-TR')), `artık (${artikT} teklif) adlandırılmamış`);
    const secili = ['CHP', 'AKP'].map((p) => tum.find((r) => r.parti === p)).filter(Boolean);
    const yanlis = j.toplam_teklif - secili.reduce((s, r) => s + (r.toplam ?? 0), 0);
    if (yanlis !== artikT) {
      assert.ok(!not.includes(yanlis.toLocaleString('tr-TR')),
        `artık SEÇİLİ partilerden hesaplanmış (${yanlis}) — ${yanlis - artikT} teklif yanlışlıkla "yürütme metni" ilan ediliyor`);
    }
  }
});

for (const [sayfa, sorgu] of [['parti.html', '?p=CHP&donem=28'], ['konu.html', '?k=Ekonomi%20%26%20Finans&donem=28']]) {
  test(`${sayfa} — konu payı kartı etiket kökenini ve paydayı beyan eder`, { skip: !canli && 'backend :8000 kapalı' }, async () => {
    const yanit = await fetch(`${API}/api/ozet/parti-ay-konu?donem=28`).then((r) => r.json());
    const ek = sayfa === 'konu.html' ? (yanit.konu_etiket ?? {})['Ekonomi & Finans'] : yanit.etiket_kaynagi;
    assert.ok(ek && ek.toplam, 'API etiket kökeni döndürmüyor — beyan dayanaksız kalır');
    const { w, hatalar } = await sayfaKos(sayfa, sorgu);
    assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
    const kart = w.document.getElementById('rank');
    assert.ok(kart, '#rank kartı yok');
    const metin = kart.textContent;
    assert.ok(metin.includes(String(ek.altin_pay).replace('.', ',')),
      `etiket kökeni oranı (%${ek.altin_pay}) kartta yazmıyor — okur payı doğrulanmış ölçüm sanıyor`);
    assert.match(metin, /model tahmini/i, 'model tahmini olduğu söylenmiyor');
    assert.match(metin, /konuşma/i, 'paydanın konuşmaları kapsamadığı beyan edilmemiş');
  });
}

test('karsilastir.html — oy kartı kapsam dışı oylamaları SAYIYLA beyan eder', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const j = await fetch(`${API}/api/ozet/oy?donem=28`).then((r) => r.json());
  const { w, hatalar } = await sayfaKos('karsilastir.html', '?donem=28&a=CHP&b=AKP');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const not = w.document.getElementById('oyNote').textContent;
  if (j.toplam_oylama > j.oylama_n) {
    assert.ok(not.includes(j.toplam_oylama.toLocaleString('tr-TR')) && not.includes(String(j.oylama_n)),
      `kapsam beyanı eksik: ${j.oylama_n}/${j.toplam_oylama} oylama oranı kartta yazmıyor`);
  }
  assert.match(not, /(katılım|oy kullanma)/, 'M7: ret payı yanında ikinci ölçü yok');
  assert.match(not, /devamsızlık/i, 'M5: "Katılmadı" devamsızlık değildir notu kartta yok');
});

test('karsilastir.html — liderlik rozeti gürültüde SUSAR, sayılar kalır', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const j = await fetch(`${API}/api/ozet/parti-ay-konu?donem=28`).then((r) => r.json());
  const PT = j.partiToplam ?? {};
  const pay = (p) => {
    const s = j.seri?.[p] ?? {}; const out = {}; let tot = 0;
    for (const k of j.kategoriler ?? []) { const n = (s[k] ?? []).reduce((a, b) => a + (b ?? 0), 0); out[k] = n; tot += n; }
    return { out, tot };
  };
  const A = pay('AKP'), B = pay('MHP');
  assert.ok(A.tot > 0 && B.tot > 0, 'fixture partileri veri döndürmüyor');
  const se = (p1, n1, p2, n2) => 100 * Math.sqrt((p1 / 100) * (1 - p1 / 100) / n1 + (p2 / 100) * (1 - p2 / 100) / n2);
  const gurultulu = (j.kategoriler ?? []).filter((k) => {
    const p1 = 100 * A.out[k] / A.tot, p2 = 100 * B.out[k] / B.tot;
    return p1 !== p2 && Math.abs(p1 - p2) < 1.96 * se(p1, A.tot, p2, B.tot);
  });

  const { w, hatalar } = await sayfaKos('karsilastir.html', '?donem=28&a=AKP&b=MHP');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const satirlar = [...w.document.querySelectorAll('.pair')];
  assert.ok(satirlar.length > 0, 'kıyas satırı çizilmemiş');
  for (const k of gurultulu) {
    const kisa = (w.KISA ?? {})[k] ?? k;
    const sat = satirlar.find((r) => r.querySelector('.kat')?.textContent.startsWith(kisa));
    if (sat) assert.equal(sat.querySelector('.lead-tag'), null,
      `"${k}" farkı gürültüden ayırt edilemiyor ama liderlik rozeti basılmış`);
  }
  assert.ok(satirlar.every((r) => r.querySelectorAll('.lab').length === 2), 'yüzdeler gizlenmiş — veri saklanmamalı');
  const pn = w.document.getElementById('pairNote').textContent;
  assert.ok(pn.includes(PT.AKP?.toLocaleString('tr-TR') ?? '§') || pn.includes(String(A.tot)),
    'taban beyanı yok — okur iki yüzdeyi aynı kesinlikte sanır');
  assert.match(pn, /ayırt edilemez/i, 'rozet yokluğunun anlamı ("eşit değil, ayırt edilemez") yazılmamış');
});

test('karsilastir.html — kapalı dönemde bayat d28 içeriği kalmaz, boş veriden hüküm üretilmez', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const d28 = await fetch(`${API}/api/ozet/parti-ay-konu?donem=28`).then((r) => r.json());
  const d27 = await fetch(`${API}/api/ozet/parti-ay-konu?donem=27`).then((r) => r.json());
  assert.equal(d27.yayimlanabilir, false, 'fixture varsayımı bozuldu: d27 artık yayımlanabilir');

  const { w, hatalar } = await sayfaKos('karsilastir.html', '?donem=27&a=CHP&b=AKP');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi (kapalı dönemde istisna)');
  const govde = gorunenMetin(w);
  for (const p of ['CHP', 'AKP']) {
    const n28 = d28.partiToplam?.[p];
    if (n28 && d27.partiToplam?.[p] !== n28) {
      assert.ok(!govde.includes(n28.toLocaleString('tr-TR')),
        `d28 tabanı (${p} ${n28}) d27 ekranında duruyor — okur onu d27 sanır`);
    }
  }
  if (d28.etiket_kaynagi?.altin_pay && !d27.etiket_kaynagi?.altin) {
    assert.ok(!govde.includes(String(d28.etiket_kaynagi.altin_pay).replace('.', ',')),
      'd27 ekranında d28\'in altın etiket oranı duruyor — kapının gerekçesiyle çelişiyor');
  }
  assert.ok(!/benzer oranlara sahip/.test(govde),
    'hiç ölçüm yapılmadan "benzer oranlara sahip" hükmü basılmış (boş küme)');
  assert.match(w.document.getElementById('ranking').textContent, /yayımlanmıyor/, 'kapı gerekçesi silinmiş');
});

test('konu.html — altın etiket oranı GÖSTERİLEN konudan gelir, dönem genelinden değil', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const j = await fetch(`${API}/api/ozet/parti-ay-konu?donem=28`).then((r) => r.json());
  const ke = j.konu_etiket ?? {};
  const donemPay = String(j.etiket_kaynagi?.altin_pay ?? '').replace('.', ',');
  const sifir = Object.entries(ke).find(([k, v]) => v.altin === 0 && v.toplam > 100 && k !== 'Diğer');
  assert.ok(sifir, 'fixture varsayımı bozuldu: altın=0 olan konu yok');

  const { w, hatalar } = await sayfaKos('konu.html', `?k=${encodeURIComponent(sifir[0])}&donem=28`);
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const rank = w.document.getElementById('rank').textContent;
  assert.ok(!rank.includes(donemPay),
    `"${sifir[0]}" konusunda altın etiket YOK ama kartta dönem geneli oranı (%${donemPay}) yazıyor`);
  assert.match(rank, /hiçbiri/i, 'altın etiketi olmayan konuda doğrulanmamışlık beyan edilmemiş');
});

test('grafik boşluğu — masaüstü ve mobil yolların İKİSİNDE de beyan edilir', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  for (const [sayfa, sorgu] of [['parti.html', '?p=AKP&donem=28'], ['konu.html', '?k=Sa%C4%9Fl%C4%B1k&donem=28']]) {
    for (const mobil of [false, true]) {
      const { w, hatalar } = await sayfaKos(sayfa, sorgu, undefined, mobil);
      assert.deepEqual(hatalar, [], `${sayfa} (mobil=${mobil}) JS hatası verdi`);
      const notlar = w.document.querySelectorAll('#bosNot');
      assert.ok(notlar.length <= 1, `${sayfa} (mobil=${mobil}): #bosNot ÇOĞALMIŞ (${notlar.length})`);
      const not = notlar[0];
      if (not && !not.hidden && not.textContent.trim()) {
        assert.match(not.textContent, mobil ? /\b15\b/ : /\b5\b/,
          `${sayfa} (mobil=${mobil}): beyan edilen eşik o yolun gerçek eşiği değil`);
        assert.match(not.textContent, mobil ? /\bay\b/ : /\bhafta\b/,
          `${sayfa} (mobil=${mobil}): birim yanlış (mobil aylık, masaüstü haftalık gruplar)`);
        const m = not.textContent.match(/([\d.]+)\s*(?:hafta|ay|nokta)[^\d]*([\d.]+)/);
        if (m) {
          const toplam = Number(m[1].replace(/\./g, '')), bos = Number(m[2].replace(/\./g, ''));
          assert.ok(bos <= toplam, `${sayfa}: boş (${bos}) toplamı (${toplam}) aşıyor — sayaç bozuk`);
        }
      }
    }
  }
});

test('vekil oy satırları — köprü kurulan oylamalar kanunun ADINI taşır, satır çoğalmaz', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const j = await fetch(`${API}/api/ozet/vekil-oy?il=Ankara&ad=${encodeURIComponent('Yıldırım Tuğrul')}&soyad=${encodeURIComponent('Türkeş')}`).then((r) => r.json());
  assert.ok(j.bulundu, 'fixture vekili bulunamadı');
  assert.equal(j.ozet.toplam, j.kayitlar.length, 'köprü JOIN\'i oy satırlarını çoğaltmış');
  assert.ok(j.ozet.toplam <= j.oylama_n, `oy sayısı (${j.ozet.toplam}) toplam oylamayı (${j.oylama_n}) aşıyor`);

  const adli = j.kayitlar.filter((k) => k.kanun_basligi);
  assert.ok(adli.length > 0, 'hiçbir oy satırı kanun adına bağlanamamış — köprü çalışmıyor');
  assert.ok(adli.every((k) => k.kanun_url), 'kanun adı var ama kaynak linki yok');

  const { w, hatalar } = await sayfaKos('vekil.html', `?il=Ankara&ad=${encodeURIComponent('Yıldırım Tuğrul')}&soyad=${encodeURIComponent('Türkeş')}`);
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const satirlar = [...w.document.querySelectorAll('.orow')];
  if (satirlar.length) {
    assert.equal(satirlar.length, j.kayitlar.length, 'ekrandaki satır sayısı API ile tutmuyor');
    const metin = w.document.getElementById('vbody').textContent;
    const ornek = adli[0].kanun_basligi.slice(0, 30);
    assert.ok(metin.includes(ornek), `kanun adı ekranda çizilmemiş: "${ornek}"`);
  }
});

test('index.html — il kapısı çizilir, derin bağlantı kurar, ana veri düşse de ayakta kalır', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const j = await fetch(`${API}/api/ozet/vekil-oy`).then((r) => r.json());
  assert.ok((j.iller ?? []).length > 50, 'API il listesi döndürmüyor — kapı dayanaksız');

  const { w, hatalar } = await sayfaKos('index.html', '');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const kapi = w.document.getElementById('ilKapi');
  const sel = w.document.getElementById('ilSec');
  assert.ok(kapi && !kapi.hidden, 'il kapısı görünmüyor');
  assert.equal(sel.options.length, j.iller.length + 1, 'il sayısı API ile tutmuyor (+1 = "İl seç…")');

  const git = w.document.getElementById('ilGit');
  sel.value = 'Ankara';
  sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(git.getAttribute('href'), '/vekil.html?il=Ankara', 'derin bağlantı kurulmuyor');
  assert.match(git.textContent, /Ankara/, 'buton seçili ili söylemiyor');

  const not = w.document.getElementById('ilNot').textContent;
  assert.match(not, new RegExp(String(j.oylama_n)), 'kapsam (oylama sayısı) beyan edilmemiş');

  const { w: w2 } = await sayfaKos('index.html', '', (u) => u, false, ['parti-ay-konu']);
  const kapi2 = w2.document.getElementById('ilKapi');
  if (kapi2) assert.equal(kapi2.hidden, false, 'ana veri düşünce il kapısı da kapanıyor — giriş yolu yok oluyor');
});

test('kanun.html — teklif→imza→oylama→sonuç zinciri kurulur ve kaynağa bağlanır', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const liste = await fetch(`${API}/api/ozet/kanunlar?donem=28&limit=200`).then((r) => r.json());
  const ss = (liste.kayitlar ?? []).find((k) => k.sira_sayisi)?.sira_sayisi;
  assert.ok(ss, 'hiçbir kanunun S.Sayısı yok — köprü kopmuş');

  const j = await fetch(`${API}/api/ozet/kanun-hikaye?ss=${ss}`).then((r) => r.json());
  assert.ok(j.bulundu, 'hikâye endpoint kaydı bulamadı');
  assert.ok(['var', 'ss-yok', 'toplu', 'kayit-yok'].includes(j.oy.durum), `oy durumu beyan edilmemiş: ${j.oy.durum}`);
  if (j.oy.ozet) assert.ok(['tutanak', 'cetvel-toplami'].includes(j.oy.ozet_kaynagi), 'özet kaynağı beyan edilmemiş');

  const { w, hatalar } = await sayfaKos('kanun.html', `?ss=${ss}`);
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const halka = [...w.document.querySelectorAll('.halka')];
  const komVar = Array.isArray(j.komisyon) && j.komisyon.length > 0;
  assert.equal(halka.length, komVar ? 6 : 5,
    `zincir ${komVar ? 6 : 5} halka olmalı (komisyon ${komVar ? 'VAR' : 'yok'}), ${halka.length} çizildi`);
  for (const h of halka) assert.ok((h.querySelector('.hv')?.textContent ?? '').trim().length > 3, 'boş halka var');
  assert.ok(w.document.querySelector('.halka a.kay[href*="tbmm.gov.tr"]'), 'TBMM kaynak linki yok');
  assert.match(w.document.title, /Mizan/, 'başlık ayarlanmamış');
  assert.ok(w.document.title.length > 20, 'başlık kanunu adlandırmıyor (paylaşımda anlamsız görünür)');
});

test('index.html — arama çizgi grafiği çalışır, toplam ve kaynak kapsamı BEYAN edilir', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('index.html', '');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const kutu = w.document.getElementById('araKutu');
  assert.ok(kutu, 'ana sayfada arama kutusu YOK');

  kutu.value = 'deprem';
  w.document.getElementById('araForm').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (w.document.querySelectorAll('#araSonuc svg polyline').length) break;
  }

  const cikti = w.document.getElementById('araSonuc');
  assert.equal(cikti.hidden, false, 'sonuç kutusu açılmadı');
  const cizgiler = cikti.querySelectorAll('svg polyline');
  assert.ok(cizgiler.length >= 1, 'hiç çizgi (parti serisi) render edilmedi');
  assert.ok(cikti.querySelectorAll('.hs-cizgi-legend span').length === cizgiler.length,
    'lejant satır sayısı çizgi sayısıyla tutmuyor');

  const metin = cikti.textContent;
  const api = await NODE_FETCH(`${API}/api/ozet/ara-parti-donem?q=deprem`).then((r) => r.json());
  const bekle = Number(api.toplam).toLocaleString('tr-TR');
  assert.ok(metin.includes(bekle), `eşleşen TOPLAM (${bekle}) ekranda yok`);

  assert.match(metin, /metninde/i, 'aramanın metin-tabanlı olduğu beyan edilmemiş (etiket sanılabilir)');
  assert.match(metin, /önerge.*konuşma.*kanun teklifi/is, 'kapsanan üç kaynak beyan edilmemiş');
});

test('index.html — sonuçsuz arama SESSİZ kalmaz, nedenini söyler', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('index.html', '');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const kutu = w.document.getElementById('araKutu');
  kutu.value = 'zzqxvwkj';
  w.document.getElementById('araForm').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (/bulunamadı/i.test(w.document.getElementById('araSonuc').textContent)) break;
  }
  const metin = w.document.getElementById('araSonuc').textContent;
  assert.match(metin, /bulunamadı/i, 'sonuçsuz aramada açıklama yok');
  assert.match(metin, /metninde/i, 'boş sonucun NEDENİ (metinde arar) açıklanmamış');
});

test('index.html — arama yapılamazsa bağlantı hatası sessizce yutulmaz', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('index.html', '', undefined, false, ['ara-parti-donem']);
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const kutu = w.document.getElementById('araKutu');
  kutu.value = 'deprem';
  w.document.getElementById('araForm').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (/hata/i.test(w.document.getElementById('araSonuc').textContent)) break;
  }
  assert.match(w.document.getElementById('araSonuc').textContent, /bağlantı hatası/i, 'uç çökünce sessiz kaldı');
});

test('index.html — çizgi grafiği GERÇEK VERİDEN çıkar, kategori tahmini karışmaz', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('index.html', '');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const kutu = w.document.getElementById('araKutu');
  kutu.value = 'vergi';
  w.document.getElementById('araForm').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (w.document.querySelectorAll('#araSonuc svg polyline').length) break;
  }
  const api = await NODE_FETCH(`${API}/api/ozet/ara-parti-donem?q=vergi`).then((r) => r.json());
  assert.ok(api.hucre.length > 0, 'test önkoşulu bozuk: API hiç hücre dönmedi');

  const noktalar = w.document.querySelectorAll('#araSonuc .hs-nokta');
  assert.equal(noktalar.length, api.partiler.length * api.donemler.length,
    'nokta sayısı parti×dönem eksenleriyle tutmuyor');

  assert.doesNotMatch(w.document.getElementById('araSonuc').textContent, /kategori/i,
    'arama sonucunda "kategori" geçiyor — tahmin sınıflandırıcısı sızmış olabilir');
});

test('index.html — çizgi grafiği noktasına gelince ipucu kartı kaynak kırılımını gösterir', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('index.html', '');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const kutu = w.document.getElementById('araKutu');
  kutu.value = 'vergi';
  w.document.getElementById('araForm').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (w.document.querySelectorAll('#araSonuc .hs-nokta').length) break;
  }
  const api = await NODE_FETCH(`${API}/api/ozet/ara-parti-donem?q=vergi`).then((r) => r.json());
  const dolu = api.hucre.find((h) => h.n > 0);
  assert.ok(dolu, 'test önkoşulu bozuk: dolu hücre yok');
  const nokta = [...w.document.querySelectorAll('#araSonuc .hs-nokta')]
    .find((el) => el.dataset.parti === dolu.parti && Number(el.dataset.donem) === dolu.donem);
  assert.ok(nokta, `${dolu.parti}/${dolu.donem} için nokta bulunamadı`);

  nokta.dispatchEvent(new w.MouseEvent('mouseover', { bubbles: true }));
  const tip = w.document.querySelector('#araSonuc .hs-tip');
  assert.ok(tip && !tip.hidden, 'ipucu kartı açılmadı');
  assert.match(tip.textContent, new RegExp(dolu.parti), 'ipucu kartında parti adı yok');
  assert.match(tip.textContent, new RegExp(`${dolu.donem}\\. dönem`), 'ipucu kartında dönem yok');

  const detaylar = api.detay.filter((d) => d.parti === dolu.parti && d.donem === dolu.donem);
  for (const kod of ['onerge', 'konusma', 'kanun']) {
    const beklenen = detaylar.find((d) => d.kaynak === kod)?.n ?? 0;
    assert.ok(tip.textContent.includes(String(beklenen)), `ipucu kartında ${kod} sayısı (${beklenen}) yok`);
  }

  nokta.dispatchEvent(new w.MouseEvent('mouseout', { bubbles: true }));
  assert.ok(tip.hidden, 'fare noktadan ayrılınca ipucu kartı kapanmadı');
});

test('vekil.html — vekilin önergeleri + cevapsızlık ATIF YÖNÜYLE birlikte', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('vekil.html', '?il=Kocaeli');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const vk = w.document.querySelectorAll('.vk');
  assert.ok(vk.length > 3, 'Kocaeli vekilleri yüklenmedi');

  let bulundu = null;
  for (let i = 0; i < Math.min(vk.length, 6) && !bulundu; i++) {
    vk[i].querySelector('.vkhead').click();
    for (let t = 0; t < 30; t++) {
      await new Promise((r) => setTimeout(r, 100));
      const g = vk[i].textContent;
      if (/yazılı soru önergesi verdi/i.test(g)) { bulundu = vk[i]; break; }
    }
  }
  assert.ok(bulundu, 'hiçbir vekilde önerge kartı çıkmadı (uç bağlanmamış olabilir)');

  const metin = bulundu.textContent;
  assert.match(metin, /cevap vermek\s+yürütmenin\s+görevidir/i,
    'cevapsızlık gösteriliyor ama "cevabı veren yürütmedir" beyanı YOK — oran vekile atfedilir');
  assert.match(metin, /soruyu soran vekile\s+atfedilemez/i, 'atıf yasağı açıkça yazılmamış');
  assert.match(metin, /önerge üzerinden hesaplandı/i, 'oranın paydası beyan edilmemiş');
  assert.match(metin, /15 gün/i, 'usul (İçtüzük md.99 süresi) yazılmamış');
  const satir = bulundu.querySelectorAll('.sozrow[href*="tbmm.gov.tr"]');
  assert.ok(satir.length >= 1, 'önerge satırları TBMM kaydına gitmiyor');
});

test('kanun.html — AYM halkası: ham sonuç sızmaz, usulden ret şişirmez, "taşınmadı" demez', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const j = await fetch(`${API}/api/ozet/kanun-hikaye?ss=157`).then((r) => r.json());
  assert.ok(j.bulundu && j.aym, 'AYM verisi gelmedi — test varsayımı eskimiş olabilir');
  assert.ok(j.aym.kararlar.length > j.aym.esas_n,
    'test anlamsız: bu kanunda usulden ret yok, şişme riski ölçülemiyor');

  const { w, hatalar } = await sayfaKos('kanun.html', '?ss=157');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const metin = gorunenMetin(w);

  assert.doesNotMatch(metin, /Esas - Ret|İlk - Ret/, 'ham AYM sonuç değeri ekrana sızmış');
  assert.match(metin, /usulden reddedildi/i, 'usulden ret ayrı etiketlenmemiş');

  const toplam = j.aym.kararlar.length;
  assert.doesNotMatch(metin, new RegExp(`${toplam}\\s*esas incelemesi`),
    `${toplam} kararın tamamı "esas incelemesi" diye sunulmuş — usulden ret sayaca girmiş`);

  assert.match(metin, /kanun numarasının geçmesinden/i, 'bağın kökeni beyan edilmemiş');
  assert.match(metin, /resmî bir bağ değildir/i, 'çıkarım, resmî bağ gibi sunuluyor');
});

test('kanun.html — AYM eşleşmesi YOKKEN "taşınmadı" denmez, kapsam beyan edilir', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const liste = await fetch(`${API}/api/ozet/kanunlar?donem=28&limit=200`).then((r) => r.json());
  let hedef = null;
  for (const k of (liste.kayitlar ?? []).filter((x) => x.sira_sayisi).slice(0, 40)) {
    const h = await fetch(`${API}/api/ozet/kanun-hikaye?ss=${k.sira_sayisi}`).then((r) => r.json());
    if (h.bulundu && h.aym_uygulanabilir && h.aym && h.aym.kararlar.length === 0) { hedef = k.sira_sayisi; break; }
  }
  assert.ok(hedef, 'eşleşmesiz kanun bulunamadı — test varsayımı eskimiş');

  const { w, hatalar } = await sayfaKos('kanun.html', `?ss=${hedef}`);
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const metin = gorunenMetin(w);
  assert.match(metin, /korpusumuzda bu kanuna ilişkin kayıt yok/i, 'boşluk dürüstçe beyan edilmemiş');
  assert.match(metin, /taşınmadığı anlamına gelmez/i, 'okur yanlış çıkarımdan korunmamış');
  const uyarisiz = metin.replace(/taşınmadığı anlamına gelmez/gi, '');
  assert.doesNotMatch(uyarisiz, /taşınmadı|denetlenmedi|AYM'ye gitmedi/i,
    'eşleşme yokluğu OLUMLU bir "taşınmadı" iddiası gibi sunulmuş — veriden çıkarılamaz');
  assert.match(metin, /Anayasa Mahkemesi kararını kapsar/i, 'kapsam penceresi yazılmamış');
});

test('index.html — katlı not başlıkları SORU değil, koruyucu ifade', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('index.html', '');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const ozetler = [...w.document.querySelectorAll('details.n > summary')];
  assert.ok(ozetler.length >= 3, `katlı not az/yok (${ozetler.length}) — test anlamsız`);

  const sorular = ozetler.map((e) => e.textContent.trim()).filter((t) => t.endsWith('?'));
  assert.deepEqual(sorular, [],
    `Katlı not başlığı SORU: ${sorular.join(' · ')}\n` +
      'Soru, notu açmayan okuru KORUMAZ. Başlık, üstündeki sayının yanlış okunmasını önleyen ' +
      'tek cümle olmalı; tam gerekçe gövdede kalır (ortak.js katlanirNot sözleşmesi).');
});

test('index.html — arama grafik notu SORU değil (aynı ev üslubu)', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('index.html', '');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const kutu = w.document.getElementById('araKutu');
  kutu.value = 'vergi';
  w.document.getElementById('araForm').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (w.document.querySelectorAll('#araSonuc svg polyline').length) break;
  }
  const parcalar = [...w.document.querySelectorAll('#araSonuc .hs-cbar-not, #araSonuc .hs-ozet')];
  assert.ok(parcalar.length >= 2, `grafik başlık/notu az/yok (${parcalar.length}) — test anlamsız`);
  const sorular = parcalar.map((e) => e.textContent.trim()).filter((t) => t.endsWith('?'));
  assert.deepEqual(sorular, [], `Arama grafiği başlık/notu SORU: ${sorular.join(' · ')}`);
});

test('kanun.html — imzacıların ADLARI görünür, kırpma beyan edilir', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const liste = await fetch(`${API}/api/ozet/kanunlar?donem=28&limit=200`).then((r) => r.json());
  let hedef = null, api = null;
  for (const k of (liste.kayitlar ?? []).filter((x) => x.sira_sayisi).slice(0, 25)) {
    const j = await fetch(`${API}/api/ozet/kanun-hikaye?ss=${k.sira_sayisi}`).then((r) => r.json());
    if (j.bulundu && (j.imza?.kisiler?.length ?? 0) >= 5) { hedef = k.sira_sayisi; api = j; break; }
  }
  assert.ok(hedef, 'imzacı listesi olan kanun bulunamadı');

  const { w, hatalar } = await sayfaKos('kanun.html', `?ss=${hedef}`);
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const metin = gorunenMetin(w);

  const ilk = api.imza.kisiler.find((p) => p.ilk_imza) ?? api.imza.kisiler[0];
  assert.ok(metin.includes(ilk.ad_soyad), `imzacı adı ekranda yok: ${ilk.ad_soyad}`);
  assert.match(metin, /ilk imza sahibi/i, 'ilk imza ile destekleyen imza ayrımı yazılmamış');

  if (api.imza.toplam > api.imza.kisiler.length) {
    assert.match(metin, /kırpıldı|toplam/i,
      `${api.imza.toplam} imzanın ${api.imza.kisiler.length}'i gösteriliyor ama kırpma beyan edilmemiş`);
  }
});

test('parti.html — kapsam/kaynak etiketi SVG İÇİNE gömülü (ekran görüntüsü savunması)', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('parti.html', '?parti=CHP');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const svg = w.document.querySelector('#chart svg');
  if (!svg) return;

  const icMetin = [...svg.querySelectorAll('text')].map((t) => t.textContent).join(' ');
  assert.match(icMetin, /CHP/, 'grafiğin içinde hangi partinin olduğu yazmıyor');
  assert.match(icMetin, /TBMM/, 'grafiğin içinde kaynak yazmıyor');
  assert.match(icMetin, /pay/i, 'grafiğin içinde ÖLÇÜNÜN NE OLDUĞU (pay) yazmıyor — çıplak eğri yanıltır');
});

test('index.html — konu bazlı cevapsızlık, d28\'in neden dışarıda olduğunu SÖYLER', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const api = await fetch(`${API}/api/ozet/konu-cevap`).then((r) => r.json());
  if (!api?.success || (api.konular?.length ?? 0) < 3) return;

  const { w, hatalar } = await sayfaKos('index.html', '');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const metin = gorunenMetin(w);

  assert.match(metin, /Konuya göre/i, 'konu bazlı cevapsızlık bloğu ekranda yok');
  assert.match(metin, /28\. dönem bu tabloda YOK/i,
    'd28\'in dışarıda olduğu söylenmemiş — okur kapsamı eksiklik sanar');
  assert.match(metin, /kendi girdisini geri okur/i, 'tautoloji gerekçesi yazılmamış');
  assert.match(metin, /tahmindir/i, 'konu etiketinin tahmin olduğu beyan edilmemiş (M5)');
  const blok = metin.slice(Math.max(0, metin.indexOf('Konuya göre')), metin.indexOf('Konuya göre') + 900);
  assert.doesNotMatch(blok, /\b(CHP|AKP|MHP|İYİ|DEM)\b/, 'konu×cevapsızlık bloğuna parti adı sızmış');
});

test('vekil.html — birleşim seçilince o oturumun konuşmaları sırayla gelir', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const api = await fetch(`${API}/api/ozet/birlesim?limit=5`).then((r) => r.json());
  assert.ok(api?.success && api.birlesimler?.length, 'birleşim ucu boş — test konusuz');

  const { w, hatalar } = await sayfaKos('vekil.html', '');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const sec = w.document.getElementById('blSec');
  assert.ok(sec, 'birleşim seçici yok');
  assert.ok(sec.options.length > 3, `seçicide birleşim yok (${sec.options.length})`);

  const alt = w.document.getElementById('blSub').textContent;
  assert.ok(alt.includes(Number(api.toplam).toLocaleString('tr-TR')),
    'toplam birleşim sayısı beyan edilmemiş — gösterilen liste toplam sanılır');

  sec.value = api.birlesimler[0].birlesim;
  sec.dispatchEvent(new w.Event('change'));
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (w.document.querySelectorAll('#blSonuc .sozrow').length) break;
  }
  const satir = w.document.querySelectorAll('#blSonuc .sozrow');
  assert.ok(satir.length >= 5, `birleşim konuşmaları gelmedi (${satir.length})`);
  for (const s of satir) {
    assert.match(s.getAttribute('href') ?? '', /tbmm\.gov\.tr/, 'konuşma satırı kaynağa gitmiyor');
  }
  assert.match(w.document.getElementById('blSonuc').textContent, /tutanaktaki konuşma sırasıdır/i,
    'sıralamanın seçim olmadığı beyan edilmemiş');
});

test('api — araç asimetrisi hesaplanır, rol adlandırılmaz', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const api = await fetch(`${API}/api/ozet/yasama?donem=28`).then((r) => r.json());
  const a = api.arac_asimetri;
  assert.ok(a?.kanun && a?.onerge, 'uç araç asimetrisi döndürmüyor');
  assert.equal(a.ayni_parti, false, 'test varsayımı eskimiş: iki argmax aynı parti (asimetri yok)');
});

test('index.html — araç profili: yüzdeler parti İÇİ, kıyas olmadığı beyan edilir', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const api = await fetch(`${API}/api/ozet/arac-profili?donem=28`).then((r) => r.json());
  assert.ok(api?.success && api.partiler?.length >= 3, 'araç profili ucu boş');

  for (const p of api.partiler) {
    const t = p.pay.onerge + p.pay.kanun + p.pay.konusma;
    assert.ok(Math.abs(t - 100) < 1.5, `${p.parti} yüzdeleri %100'e toplanmıyor: ${t.toFixed(1)}`);
  }

  for (const p of api.partiler) {
    if (p.vekil_basina) {
      assert.ok(p.vekil_n >= api.vekil_esik,
        `${p.parti}: ${p.vekil_n} vekille oran gösteriliyor (eşik ${api.vekil_esik}) — payda güvenilmez`);
    }
  }

  const { w, hatalar } = await sayfaKos('index.html', '');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  assert.equal(w.document.getElementById('profilSec').hidden, false, 'araç profili bölümü açılmadı');
  const metin = gorunenMetin(w);
  assert.match(metin, /farklı parlamento araçlarıdır/i, 'araçların farklılığı beyan edilmemiş');
  assert.match(metin, /kendi faaliyeti içindeki|partiler arası kıyas değildir/i,
    'yüzdelerin parti İÇİ olduğu söylenmemiş — okur partiler arası kıyas sanır');
});

test('index.html — kanunlaşma oranının İKİ paydası da gösterilir', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const api = await fetch(`${API}/api/ozet/yasama?donem=28`).then((r) => r.json());
  const o = api.oran;
  assert.ok(o, 'oran bloğu yok');
  assert.ok(o.verilen_pay > 0 && o.gundeme_gelen_pay > 0, 'iki oran da hesaplanmalıydı');
  assert.ok(o.gundeme_gelen_pay > o.verilen_pay * 3,
    'iki payda birbirine çok yakın — test varsayımı eskimiş olabilir');

  for (const d of [26, 27]) {
    const j = await fetch(`${API}/api/ozet/yasama?donem=${d}`).then((r) => r.json());
    if (j.oran.gundeme_gelen_payda === j.oran.kanunlasti) {
      assert.equal(j.oran.gundeme_gelen_pay, null,
        `d${d}: payda paya eşitken oran yayımlanıyor — mekanik %100, ölçülen hiçbir şey yok`);
      assert.ok(j.oran.gundeme_gelen_sebep, `d${d}: oranın neden hesaplanamadığı beyan edilmemiş`);
    }
  }
});

test('kanun.html — komisyon halkası: veri varsa çizilir, süre TR tarihinden doğru hesaplanır', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const j = await fetch(`${API}/api/ozet/kanun-hikaye?ss=280`).then((r) => r.json());
  if (!j.bulundu || !(j.komisyon ?? []).length) return;
  const { w, hatalar } = await sayfaKos('kanun.html', '?ss=280');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const metin = w.document.body.textContent;
  assert.match(metin, /Komisyon/, 'komisyon halkası çizilmemiş — kurtarılan veri sessizce düşüyor');
  const esas = j.komisyon.find((k) => /esas/i.test(k.tip)) ?? j.komisyon[0];
  assert.ok(esas.ad && metin.includes(esas.ad), `esas komisyon adı (${esas.ad}) sayfada yok`);
  if (esas.giris && esas.cikis) {
    const iso = (t) => { const m = String(t).match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
    const a2 = iso(esas.giris), b2 = iso(esas.cikis);
    if (a2 && b2) {
      const bek = Math.round((new Date(b2 + 'T00:00:00Z') - new Date(a2 + 'T00:00:00Z')) / 86400000);
      assert.ok(Number.isFinite(bek), 'beklenen süre hesaplanamadı');
      assert.match(metin, new RegExp(`${bek}\\s*gün`), `komisyon süresi ${bek} gün olarak yazmıyor (NaN/yanlış ay olabilir)`);
      assert.doesNotMatch(metin, /NaN/, 'sayfada NaN var — tarih ayrıştırma bozuk');
    }
  }
  assert.match(metin, /KANITLAMAZ|kayıt eksik/, 'komisyon kartında eksik-kayıt uyarısı yok');
});

test('index.html — bütçe kartı: oy dökümü + kanıt PDF + ölçüt/kapsam/eksik beyanı', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const j = await fetch(`${API}/api/ozet/butce?donem=28`).then((r) => r.json());
  if (!(j.kayitlar ?? []).length) return;
  const { w, hatalar } = await sayfaKos('index.html', '');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const sec = w.document.getElementById('butceSec');
  assert.ok(sec, 'butceSec bölümü yok');
  assert.equal(sec.hidden, false, 'bütçe kartı gizli kaldı — veri var ama gösterilmiyor');
  const metin = sec.textContent;
  assert.match(metin, /kabul/i, 'kabul oyu yazmıyor');
  assert.match(metin, /ret/i, 'ret oyu yazmıyor');
  const pdf = sec.querySelector('a[href*="pdf"], a[href*="PDF"], a.arrow[target="_blank"]');
  assert.ok(pdf, 'kanıt PDF linki yok — "kim nasıl oy verdi" doğrulanamaz');
  assert.match(metin, /Sıra Sayısı/, 'seçim ölçütü kartta yazmıyor (M6)');
  assert.match(metin, /nihai|komisyon/i, 'kapsam uyarısı yok — "bütçenin tamamı bu" sanılır');
  assert.match(metin, /devamsızlık/i, '"Katılmadı" devamsızlık değildir notu yok (M5)');
  if (j.eksik?.koprusuz_cetvel > 0) {
    assert.match(metin, /listede YOK|köprü/i, 'eksik kayıtlar beyan edilmiyor — liste tam sanılır');
  }
  for (const yasak of [/çünkü/i, /sayesinde/i, /başarısız/i, /skandal/i, /israf/i]) {
    assert.doesNotMatch(metin, yasak, `M2 ihlali: değer yargısı/nedensellik kalıbı (${yasak})`);
  }
});

test('kanun.html — duyuru eki: RG izi, başlık aynen, editoryal sıfat yok', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const j = await fetch(`${API}/api/ozet/kanun-hikaye?ss=404`).then((r) => r.json());
  if (!(j.duyurular ?? []).length) return;
  const { w, hatalar } = await sayfaKos('kanun.html', '?ss=404');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const metin = w.document.body.textContent;
  assert.match(metin, /Resmî Gazete izi/, 'duyuru halkası çizilmemiş');
  const ilk = j.duyurular[0].baslik;
  assert.ok(metin.includes(ilk.slice(0, 40)), 'duyuru başlığı aynen gösterilmiyor');
  const satirlar = [...w.document.querySelectorAll('.drow')].map((d) => d.textContent).join(' ');
  for (const yasak of [/skandal/i, /başarısız/i, /flaş/i, /son dakika/i]) {
    assert.doesNotMatch(satirlar, yasak, `M2 ihlali: duyuru başlığında haber/değer dili (${yasak})`);
  }
  const link = [...w.document.querySelectorAll('.drow a')].some((a) => /resmigazete|gov\.tr/.test(a.href));
  assert.ok(link || j.duyurular.every((d) => !d.url), 'duyuru RG kaynağına bağlanmıyor');
});

test('kanun.html — komisyon üye dağılımı: kanonik parti adı, sandalye ≠ oy beyanı', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const j = await fetch(`${API}/api/ozet/kanun-hikaye?ss=277`).then((r) => r.json());
  const komUye = (j.komisyon ?? []).find((c) => (c.uye_toplam ?? 0) > 0);
  if (!komUye) return;
  const { w, hatalar } = await sayfaKos('kanun.html', '?ss=277');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const metin = w.document.body.textContent;

  const cipler = [...w.document.querySelectorAll('.kchip')];
  assert.ok(cipler.length > 0, 'komisyon üye dağılımı çizilmemiş — veri var, kart göstermiyor');

  assert.doesNotMatch(metin, /AK Parti|İYİ Parti|DEM PARTİ/,
    'ham parti yazımı sızmış — normParti uygulanmamış, renkler kırılır');

  assert.match(metin, /sandalye|oy verdiğini DEĞİL|vekil bazında/i,
    'komisyon kompozisyonu "oy" sanılabilir — sandalye/oy ayrımı beyan edilmemiş');
});

test('index.html — cevap süresi: her satır paydalı, "gecikmiş" kaynağa atfedilir', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const j = await fetch(`${API}/api/ozet/cevap-suresi?donem=28`).then((r) => r.json());
  const yayin = (j.kurumlar ?? []).filter((x) => x.ortanca_gun != null);
  if (yayin.length < 3) return;
  const { w, hatalar } = await sayfaKos('index.html', '');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const sec = w.document.getElementById('csureSec');
  assert.ok(sec && !sec.hidden, 'cevap süresi kartı gizli kaldı — veri var, gösterilmiyor');
  const metin = sec.textContent;
  assert.match(metin, /n=\d+/, 'örneklem sayısı (payda) kartta görünmüyor');
  assert.match(metin, /gün/, 'süre birimi yok');
  if (/gecikmiş/i.test(metin)) {
    assert.match(metin, /TBMM|kayıt ibaresi|eşik/i, '"gecikmiş" sitenin eşiği gibi sunulmuş — kaynak beyanı yok');
  }
  assert.match(metin, /örneklem|tam sayım/i, 'örneklem beyanı kartta yok');
});

test('karsilastir.html — çoklu dönem seçimi kurulur, mod toggle 2+ dönemde görünür', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('karsilastir.html', '?donem=27,28');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const cb = w.document.getElementById('donemCb');
  assert.ok(cb, 'çoklu dönem seçici (donemCb) yok');
  const secili = [...cb.querySelectorAll('.dcb[aria-pressed="true"]')].map((b) => b.dataset.d).sort();
  assert.deepEqual(secili, ['27', '28'], `çoklu dönem seçili değil: ${JSON.stringify(secili)}`);
  const modFld = w.document.getElementById('modFld');
  assert.ok(modFld && !modFld.hidden, 'mod toggle 2+ dönemde görünmeli');
  const modlar = [...w.document.querySelectorAll('.mod-btn')].map((b) => b.dataset.mod);
  assert.deepEqual(modlar.sort(), ['birlesik', 'yanyana'], 'iki mod butonu olmalı');
  const aktif = w.document.querySelector('.mod-btn[aria-pressed="true"]');
  assert.equal(aktif?.dataset.mod, 'birlesik', 'varsayılan mod Birleştir olmalı');
});

test('karsilastir.html — tek dönemde mod toggle GİZLİ (birleştir/yan yana aynı)', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('karsilastir.html', '?donem=28');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const modFld = w.document.getElementById('modFld');
  assert.ok(modFld && modFld.hidden, 'tek dönemde mod toggle gizli olmalı');
  const secili = [...w.document.querySelectorAll('#donemCb .dcb[aria-pressed="true"]')].map((b) => b.dataset.d);
  assert.deepEqual(secili, ['28'], 'tek dönem seçili olmalı');
});

test('secim.html — varsayılan (d28) sandalye kazanan partiler belirgin, kuyruk toplulaştırılır', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('secim.html', '');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const sec = w.document.getElementById('donemSec');
  assert.equal(sec.value, '28', 'varsayılan seçim d28 olmalı');
  const govde = w.document.getElementById('govde');
  assert.match(govde.textContent, /AKP/, 'en büyük parti (AKP) satırı yok');
  assert.ok(govde.querySelectorAll('.grup-baslik ~ .prow .chart-track .chart-fill').length >= 4,
    'sandalye kazanan parti çubukları eksik');
  assert.match(govde.textContent, /sandalye kazanamadı/, 'diğer partiler özet satırı yok');
  const tumuBtn = w.document.getElementById('tumuBtn');
  assert.ok(tumuBtn, 'tümünü göster anahtarı yok');
  assert.match(tumuBtn.textContent, /25 parti/, 'tam liste sayısı (25) beyan edilmemiş');
  tumuBtn.dispatchEvent(new w.Event('click'));
  const tumuListe = w.document.getElementById('tumuListe');
  assert.ok(tumuListe.classList.contains('acik'), 'tümünü göster açılmadı');
  assert.equal(tumuListe.querySelectorAll('.prow').length, 25, 'tam listede 25 parti/bağımsız olmalı');
  assert.match(govde.textContent, /gümrük/i, 'kapsam/fark notu kartta yok');
  assert.match(govde.textContent, /600/, 'toplam sandalye (600) kartta yok');
  const ttl = govde.querySelector('.ttl')?.textContent ?? '';
  assert.ok(!ttl.trim().endsWith('?'), 'başlık soru cümlesi olmamalı');
});

test('secim.html — ?donem=25 ile 2015 seçimine geçer, farklı parti dökümü + sandalye toplamı (550) gelir', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('secim.html', '?donem=25');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const sec = w.document.getElementById('donemSec');
  assert.equal(sec.value, '25', 'URL parametresi donem=25 uygulanmalı');
  const govde = w.document.getElementById('govde');
  assert.match(govde.textContent, /2015-06-07/, 'seçim tarihi (2015-06-07) kartta yok');
  assert.match(govde.textContent, /AKP/, 'AKP satırı yok');
  assert.match(govde.textContent, /550/, 'dönem 25 toplam sandalyesi (550) kartta yok');
});

test('secim.html — ?donem=20 (1995, sandalye verisi YOK) "bilinmiyor" gösterir, "0 sandalye" DEMEZ', { skip: !canli && 'backend :8000 kapalı' }, async () => {
  const { w, hatalar } = await sayfaKos('secim.html', '?donem=20');
  assert.deepEqual(hatalar, [], 'sayfa JS hatası verdi');
  const sec = w.document.getElementById('donemSec');
  assert.equal(sec.value, '20', 'URL parametresi donem=20 uygulanmalı');
  const govde = w.document.getElementById('govde');
  assert.match(govde.textContent, /1995-12-24/, 'seçim tarihi (1995-12-24) kartta yok');
  assert.match(govde.textContent, /RP/, 'RP satırı yok');
  const sandalyeKutusu = [...govde.querySelectorAll('.ozet-item')].find((el) => /Toplam sandalye/i.test(el.textContent));
  assert.ok(sandalyeKutusu, '"Toplam sandalye" istatistik kutusu yok');
  assert.match(sandalyeKutusu.querySelector('.n').textContent, /^—$/, 'toplam sandalye rakamı "—" olmalı, 0 DEĞİL');
  assert.match(sandalyeKutusu.textContent, /bilinmiyor/i, '"sandalye bilinmiyor" notu bu kutuda yok');
  assert.match(govde.textContent, /sandalye verisi bu kaynakta yok/i, 'başlık sandalye-yok durumunu yansıtmıyor');
  assert.ok(!/sandalye kazanamadı/.test(govde.textContent), 'kuyruk metni yanlışlıkla "sandalye kazanamadı" diyor');
});
