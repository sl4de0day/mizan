
export const KISA = {
  'Afet & Acil Durum':'Afet','Enerji & Madencilik':'Enerji','Sağlık':'Sağlık','Eğitim':'Eğitim',
  'Çalışma & Sosyal Güvenlik':'Çalışma','Ulaştırma & Altyapı':'Ulaştırma','Adalet & Hukuk':'Adalet',
  'Güvenlik & Savunma':'Güvenlik','Dış Politika':'Dış Politika','Kadın, Aile & Çocuk':'Kadın & Aile',
  'Konut & Şehircilik':'Konut','Yerel Yönetim':'Yerel Yönetim','Din & İnanç':'Din',
  'Kültür, Turizm & Spor':'Kültür & Spor','Çevre & Tarım':'Çevre & Tarım','Ekonomi & Finans':'Ekonomi','Diğer':'Diğer'
};
export const KONU_RENK = {
  'Afet & Acil Durum':'#e0564e','Enerji & Madencilik':'#cf9012','Sağlık':'#12a488','Eğitim':'#3f7fd6',
  'Çalışma & Sosyal Güvenlik':'#e07a35','Ulaştırma & Altyapı':'#8a6fd0','Adalet & Hukuk':'#2f9fce',
  'Güvenlik & Savunma':'#7c9a2b','Dış Politika':'#12a0b4','Kadın, Aile & Çocuk':'#d55b9a',
  'Konut & Şehircilik':'#bd8a2e','Yerel Yönetim':'#a066cc','Din & İnanç':'#22a596',
  'Kültür, Turizm & Spor':'#cf5fc4','Çevre & Tarım':'#4a9e52','Ekonomi & Finans':'#5b6ee0','Diğer':'#96a09c'
};
export const PARTI_RENK = { 'CHP':'#d0392f','AKP':'#d98a1e','DEM':'#8560cc','IYI':'#2f78c8','YENI YOL':'#3f9c66','MHP':'#b0432c',
  'YENIDEN REFAH':'#2f8f7a','EMEP':'#c94f86','SAADET':'#b5883a','TIP':'#c0392b','GELECEK':'#5a8f8a','HUDA PAR':'#6b7f4a','DP':'#7a6cae','DSP':'#c26a2a','DBP':'#4f9d7e',
  'Yeni Parti':'#af43b6', 'YENI PARTI':'#af43b6' };
export const partiRenk = (p) => PARTI_RENK[p] || '#6b7a76';
export const AY = ['Oca','Şub','Mar','Nis','May','Haz','Tem','Ağu','Eyl','Eki','Kas','Ara'];

export const nf = (n) => Number(n).toLocaleString('tr-TR');
export const pf = (v, d = 1) => Number(v).toFixed(d).replace('.', ',');

export function katlanirNot(ozet, tamHtml) {
  return `<details class="cnote"><summary>${ozet}</summary><div class="cnote-body">${tamHtml}</div></details>`;
}

export function etiketKokeniNot(ek) {
  if (!ek || !ek.toplam) return 'Konu sınıflandırması otomatik (anahtar-kelime + muhatap bakanlık).';
  const p = pf(ek.altin_pay);
  if (!ek.altin) {
    return `Bu dönemde konu etiketlerinin <b>hiçbiri</b> belge muhatabından doğrulanmadı; tamamı otomatik model tahminidir `
      + `ve tahminin hatası partiler arasında eşit dağılmaz. Bu yüzden parti×konu payları bu dönemde yayımlanmaz.`;
  }
  const kirilim = (ek.kaynaklar ?? []).filter((k) => k.toplam > 0);
  const kirilimNot = ek.kaynak_uyarisi
    ? ` <b>Belge türüne göre değişir:</b> `
      + kirilim.map((k) => `${k.kaynak === 'onerge' ? 'önerge' : 'kanun teklifi'} <b>%${pf(k.pay)}</b>`).join(' · ')
      + `. Kanun teklifinin muhatabı olmadığı için etiketi doğrulanamaz — ve doğrulanamayacaktır.`
    : '';
  return `Konu etiketlerinde <b>kesin</b> etiket (belgenin muhatabı bakanlıktan türeyen) oranı <b>%${p}</b>; `
    + `kalan <b>%${pf(100 - ek.altin_pay)}</b> oranındaki etiket otomatik model tahminidir ve tahminin hatası partiler `
    + `arasında eşit değildir — bu yüzden küçük parti farkları tek başına delil sayılmamalı.${kirilimNot}`;
}

export function olcekNot(max, birim = '%') {
  if (!(max > 0)) return '';
  const deger = birim === '%' ? `%${pf(max)}` : `${nf(max)} ${birim}`;
  return `Çubuk boyu %100'e göre değil, bu kartta görünen <b>en yüksek değere</b> (${deger}) göre ölçeklidir; `
    + `dolu çubuk “tamamı” demek değildir. Mutlak büyüklük için satırdaki sayıyı okuyun.`;
}

export function boslukNot(seriler, esik, birim = 'hafta') {
  if (!seriler?.length) return '';
  const desen = (v) => v.map((x) => (x == null ? '0' : '1')).join('');
  const ortakPayda = seriler.length > 1 && new Set(seriler.map(desen)).size === 1;
  const sayilacak = ortakPayda ? [seriler[0]] : seriler;
  const toplam = sayilacak.reduce((s, v) => s + v.length, 0);
  const bos = sayilacak.reduce((s, v) => s + v.filter((x) => x == null).length, 0);
  if (!toplam || !bos) return '';
  return `O ${birim} içindeki toplam kayıt sayısı <b>${esik}</b> değerinin altındaysa nokta çizilmez ve çizgi kopar: `
    + (ortakPayda
        ? `bu grafikteki <b>${nf(toplam)}</b> ${birim} içinden <b>${nf(bos)}</b> tanesinde hiçbir çizgi çizilmedi (tüm çizgiler aynı anda kopar, çünkü hepsi aynı paydayı kullanır). `
        : `bu grafikteki <b>${nf(toplam)}</b> noktadan <b>${nf(bos)}</b> tanesi bu nedenle boş. `)
    + `Boşluk <b>“sıfır” değil, “ölçmeye yetecek kayıt yok”</b> demektir.`;
}

export const USUL = {
  sirasayisi: 'Bir teklif komisyondan rapor alınca Genel Kurul gündemine <b>sıra sayısı</b> ile iner. ' +
    'Sıra sayısı olmayan teklif Genel Kurul\'a hiç gelmemiş demektir — oylanmamış olması eksiklik değil, usul.',
  hukumsuz: '<b>Hükümsüz</b>: yasama dönemi bittiğinde görüşülmemiş teklifler kendiliğinden düşer. ' +
    'Yeniden verilmedikçe işlem görmez; bu bir ret kararı değildir.',
  intikal: '<b>Sonraki döneme intikal</b>: teklif düşmeyip yeni dönemde görüşülmek üzere aktarılmıştır. ' +
    'Kabul edildiği anlamına gelmez — görüşme yeni dönemde baştan başlar.',
  esasKomisyon: '<b>Esas komisyon</b>, teklifi asıl inceleyip rapor yazan komisyondur; tali komisyonlar ' +
    'yalnız görüş bildirir, kararı onlar vermez. Rapor yazılmadan teklif Genel Kurul gündemine inmez — ' +
    'komisyonda bekleyen teklif reddedilmiş değildir, henüz sıraya girmemiştir.',
  cekimser: '<b>Çekimser</b> oy kullanılmış sayılır (kabul/ret gibi) ama yön belirtmez — katılmamakla aynı şey değildir.',
  acikOylama: '<b>Açık oylama</b>: kimin nasıl oy verdiği tutanağa geçen oylama türü. Kanunların çoğu ' +
    '<b>işaretle</b> (el kaldırarak) oylanır ve kişi bazında kayda geçmez.',
};
export function usulNot(...anahtarlar) {
  return anahtarlar.map((k) => USUL[k]).filter(Boolean).join(' ');
}

const TABAN_OY = 100;
const TABAN_N = 100;
const TABAN_KON = 30, TABAN_BEL = 20;
const MIN_FARK = 3.0;
const PARTI_DISI = new Set(['BAGIMSIZ', 'Bilinmiyor', 'YÜRÜTME']);

export function farkAyirtEdilebilir(p1, n1, p2, n2) {
  if (!(n1 > 0) || !(n2 > 0)) return false;
  const q1 = p1 / 100, q2 = p2 / 100;
  const se = 100 * Math.sqrt((q1 * (1 - q1)) / n1 + (q2 * (1 - q2)) / n2);
  return Math.abs(p1 - p2) >= 1.96 * se;
}

export function kirpmaNot(gosterilen, toplam, { birim = 'satır', gizliPay = null, tabanNot = '' } = {}) {
  if (!(toplam > gosterilen)) return '';
  const kalan = toplam - gosterilen;
  return `Bu listede ${toplam} ${birim} arasından <b>${gosterilen}</b> tanesi gösteriliyor; `
    + `kalan <b>${kalan}</b> tanesi listede yoktur`
    + (gizliPay != null && gizliPay > 0 ? ` ve toplamda <b>%${pf(gizliPay)}</b> oranında bir payı temsil eder` : '')
    + `. Kırpma her zaman küçük olanı eler; “gösterilmiyor” ile “yok” aynı şey değildir.`
    + (tabanNot ? ' ' + tabanNot : '');
}

export function secVeSirala(rows, { buyukluk, olcu, n }) {
  return rows.slice()
    .sort((a, b) => buyukluk(b) - buyukluk(a)).slice(0, n)
    .sort((a, b) => olcu(b) - olcu(a) || buyukluk(b) - buyukluk(a));
}

export function cesaretAyrim(fark) {
  const f = Number(fark);
  if (!Number.isFinite(f) || Math.abs(f) < MIN_FARK) return null;
  return f < 0 ? 'soz' : 'eylem';
}
export const CESARET_ESIK = MIN_FARK;

export function icgoruYasama(j, parti) {
  if (!j?.success || !j.partiler?.length) return null;
  const me = j.partiler.find((r) => r.parti === parti);
  if (!me?.toplam) return null;
  const lider = j.partiler.reduce((a, b) => (b.kanunlasti > a.kanunlasti ? b : a));
  if (!j.toplam_kanunlasti || !lider.kanunlasti) return null;
  const kayitsiz = j.toplam_kanunlasti - j.partiler.reduce((s, r) => s + r.kanunlasti, 0);
  const kl = me.kanunlasti === 0 ? 'hiçbiri kanunlaşmadı' : `<b>${nf(me.kanunlasti)}</b> tanesi kanunlaştı`;
  const donEt = j.donem ? `${j.donem}. dönemde` : 'Bu dönemde';
  return `${parti} <b>${nf(me.toplam)}</b> kanun teklifi verdi; ${kl}, `
       + `<b>${nf(me.komisyonda)}</b> tanesi komisyonda bekliyor. `
       + `${donEt.charAt(0).toUpperCase() + donEt.slice(1)} kanunlaşan <b>${nf(j.toplam_kanunlasti)}</b> teklifin `
       + `<b>${nf(lider.kanunlasti)}</b> tanesi ${lider.parti} imzalı`
       + (kayitsiz > 0 ? `, <b>${nf(kayitsiz)}</b> tanesinde parti kaydı yok` : '')
       + ` — kanunlaşmayı komisyon ve Genel Kurul çoğunluğu belirler.`;
}

export function notYasama(j) {
  if (!j?.success || !j.partiler?.length || !j.toplam_kanunlasti) return null;
  const lider = j.partiler.reduce((a, b) => (b.kanunlasti > a.kanunlasti ? b : a));
  if (!lider.kanunlasti) return null;
  const digerN = j.partiler.filter((r) => r.kanunlasti > 0 && r.parti !== lider.parti).length;
  const kayitsiz = j.toplam_kanunlasti - j.partiler.reduce((s, r) => s + r.kanunlasti, 0);
  return `<b>Nasıl okunur:</b> Kanunlaşmayı komisyon ve Genel Kurul <b>çoğunluğu</b> belirler; `
       + `hangi teklifin Genel Kurul'a geleceğine komisyonlardaki çoğunluk karar verir. `
       + `Kanunlaşan <b>${nf(j.toplam_kanunlasti)}</b> teklifin <b>${nf(lider.kanunlasti)}</b> tanesi tek bir partide (${lider.parti}) toplanıyor`
       + (digerN > 0 ? `; kanunlaşan teklifi olan diğer parti sayısı <b>${nf(digerN)}</b>` : '')
       + (kayitsiz > 0 ? `, <b>${nf(kayitsiz)}</b> tanesinde parti kaydı yok` : '')
       + `. Bu tablo bir parti için <b>başarı/kalite göstergesi DEĞİLDİR</b> — parlamento aritmetiğini gösterir. `
       + `Kaynak: TBMM'nin resmî teklif durumu (eşleştirme/tahmin yok).`;
}

export function icgoruCesaret(d, parti) {
  if (!d?.success || !d.yeterli || !d.kategoriler?.length) return null;
  const uygun = d.kategoriler.filter((x) => x.konusma >= TABAN_KON && x.belge >= TABAN_BEL);
  if (!uygun.length) return null;
  const x = uygun.reduce((a, b) => (Math.abs(b.fark) > Math.abs(a.fark) ? b : a));
  if (!cesaretAyrim(x.fark)) return null;
  return `<b>${parti}</b> için en büyük söz–eylem aralığı <b>${KISA[x.kategori] ?? x.kategori}</b> konusunda: `
       + `konuşmalarında <b>%${pf(x.soylem)}</b>, önerge/tekliflerinde <b>%${pf(x.eylem)}</b> — `
       + `<b>${pf(Math.abs(x.fark))} puan</b>. Söz-eylem örtüşmesi <b>%${pf(d.ortusme)}</b>.`;
}

export function icgoruCesaretKonu(j, konu) {
  if (!j?.success || !j.data?.length) return null;
  const uygun = j.data.filter((x) => !PARTI_DISI.has(x.parti) && x.konusmaN >= TABAN_N && x.belgeN >= TABAN_N);
  if (!uygun.length) return null;
  const x = uygun.reduce((a, b) => (Math.abs(b.fark) > Math.abs(a.fark) ? b : a));
  if (!cesaretAyrim(x.fark)) return null;
  return `<b>${KISA[konu] ?? konu}</b> konusunda en büyük söz–eylem aralığı <b>${x.parti}</b> için: `
       + `konuşmalarında <b>%${pf(x.soylem)}</b>, önerge/tekliflerinde <b>%${pf(x.eylem)}</b> — `
       + `<b>${pf(Math.abs(x.fark))} puan</b>.`;
}

export function icgoruRankKonu(rows, konu) {
  if (!rows?.length) return null;
  const uygun = rows.filter((r) => !PARTI_DISI.has(r.p) && r.n >= TABAN_N);
  if (uygun.length < 2) return null;
  const [a, b] = uygun;
  if (a.pct - b.pct < MIN_FARK) return null;
  const esik = uygun.length < rows.filter((r) => !PARTI_DISI.has(r.p)).length
    ? ` (en az ${nf(TABAN_N)} kayıtlı partiler arasında; daha az kayıtlı partiler listede daha yüksek oranla görünebilir — az kayıtta oran oynaktır)`
    : '';
  return `<b>${a.p}</b>, gündeminde <b>${KISA[konu] ?? konu}</b> konusuna en çok yer veren parti: `
       + `<b>%${pf(a.pct)}</b>; ikinci <b>${b.p}</b> (<b>%${pf(b.pct)}</b>)${esik}.`;
}

export function icgoruRankParti(real, parti) {
  if (!real?.length) return null;
  const t = real.slice(0, 2).map((x) => KISA[x.k] ?? x.k);
  return `${parti} gündeminin en çoğunu <b>${t[0]}</b> (%${pf(real[0].pct)})`
       + (t[1] ? ` ve <b>${t[1]}</b> (%${pf(real[1].pct)})` : '') + ` oluşturuyor.`;
}

const AYM_BOILERPLATE = /bazı (kanun|alacak)|kanun hükmünde kararname|değişiklik yapıl|bazı kanunlarda/i;
export function aymKanunAdi(konu) {
  if (!konu) return null;
  const re = /sayılı\s+(.{2,70}?)\s+kanun/gi;
  const adlar = [];
  let m;
  while ((m = re.exec(konu)) !== null && adlar.length < 2) {
    const a = m[1].replace(/^[;,.\s]*[A-Za-zÇĞİÖŞÜ]\.\s*/, '').replace(/[;,]/g, ' ').replace(/\s+/g, ' ').trim();
    if (a.length >= 2) adlar.push(`${a} Kanunu`);
  }
  if (!adlar.length) return null;
  if (adlar.every((a) => AYM_BOILERPLATE.test(a))) return null;
  return adlar.join(' · ');
}

export function aymMaddeNo(konu) {
  const m = /kanun[a-zçğıöşü'’]*\s+(?:ek\s+)?(\d{1,3}(?:\/[A-Za-z])?)\.\s*madde/i.exec(konu || '');
  return m ? `m.${m[1]}` : null;
}

export const ANAYASA_M = {
  2: 'hukuk devleti', 5: 'devletin temel amaçları', 7: 'yasama yetkisi', 10: 'eşitlik',
  13: 'hak sınırlaması', 17: 'kişi dokunulmazlığı', 20: 'özel hayat', 35: 'mülkiyet',
  36: 'hak arama', 38: 'suç ve cezada esaslar', 40: 'hak arama yolları', 49: 'çalışma hakkı',
  138: 'mahkemelerin bağımsızlığı', 141: 'gerekçeli karar',
};
export function aymMaddeler(konu) {
  const out = new Set();
  const re = /Anayasa[’'`]?n[ıi]n\s+([0-9.,\s ve]{1,80}?)\s*madde(?:sine|lerine)/gi;
  let m;
  while ((m = re.exec(konu || '')) !== null) for (const d of m[1].matchAll(/(\d{1,3})/g)) out.add(+d[1]);
  return [...out].sort((a, b) => a - b).filter((n) => ANAYASA_M[n]).slice(0, 3).map((n) => `m.${n} ${ANAYASA_M[n]}`);
}

export const BASVURU = {
  itiraz: { k: 'İTİRAZ', t: 'davaya bakan mahkeme AYM\'ye taşıdı' },
  iptal: { k: 'İPTAL DAVASI', t: 'siyasi aktör doğrudan dava açtı' },
};

export function icgoruYargi(o, konu) {
  if (!o?.esas) return null;
  const iptalT = o.iptal + (o.kismen || 0);
  return `<b>${KISA[konu] ?? konu}</b> konusunda <b>AYM'ye taşınıp</b> esastan karara bağlanan `
       + `<b>${nf(o.esas)}</b> düzenlemeden <b>${nf(iptalT)}</b> tanesi anayasaya aykırı bulundu — <b>%${o.oran}</b>`
       + (o.genel_oran != null ? ` (tüm konularda <b>%${o.genel_oran}</b>)` : '') + `.`
       + ` Bu oranın paydası <b>yürürlükteki mevzuatın tamamı değil</b>, yalnız dava ya da itiraz yoluyla mahkemeye götürülen normlardır.`
       + (o.usulden ? ` Ayrıca <b>${nf(o.usulden)}</b> başvuru usulden reddedildi (esasa girilmeden).` : '');
}

export function icgoruAyrisma(A, B, top, selA, selB) {
  if (!top?.length) return null;
  let bestK = '', bestD = -1;
  for (const k of top) { const d = Math.abs((A[k] || 0) - (B[k] || 0)); if (d > bestD) { bestD = d; bestK = k; } }
  if (!bestK || bestD < MIN_FARK) return null;
  const a = A[bestK] || 0, b = B[bestK] || 0;
  const [hi, hiP, lo, loP] = a > b ? [selA, a, selB, b] : [selB, b, selA, a];
  return `En büyük ayrışma <b>${KISA[bestK] ?? bestK}</b> konusunda: <b>${hi}</b> <b>%${pf(hiP)}</b>, `
       + `<b>${lo}</b> <b>%${pf(loP)}</b> — <b>${pf(bestD)} puan</b> fark.`;
}

export function icgoruOylama(j) {
  const o = j?.success ? j.ozet : null;
  if (!o?.toplam) return null;
  const cek = o.cekismeli ?? 0;
  const ob = o.oybirligi ?? 0;
  if (cek + ob !== o.toplam) return null;
  const obc = ob === 0 ? 'hiçbiri oybirliğiyle sonuçlanmadı' : `<b>${nf(ob)}</b> tanesi oybirliğiyle sonuçlandı`;
  const ort = o.ret_ortanca != null && cek > 0
    ? ` Bu oylamaların yarısında ret oranı <b>%${pf(o.ret_ortanca)}</b> ya da daha az oldu.` : '';
  return `Genel Kurul'da kayda geçen <b>${nf(o.toplam)}</b> açık oylamanın <b>${nf(cek)}</b> tanesinde ret oyu `
       + `kullanıldı, ${obc}.${ort}`;
}

export function icgoruOy(j, parti) {
  if (!j?.success || !j.partiler?.length || !j.oylama_n) return null;
  const me = j.partiler.find((r) => r.parti === parti);
  if (!me) return null;
  const kul = me.kabul + me.ret + me.cekimser;
  if (kul < TABAN_OY) return null;
  const gKul = j.partiler.reduce((s, r) => s + r.kabul + r.ret + r.cekimser, 0);
  const gRet = j.partiler.reduce((s, r) => s + r.ret, 0);
  if (!gKul) return null;
  const retC = me.ret === 0 ? 'hiçbiri ret değil' : `<b>${nf(me.ret)}</b> tanesi ret`;
  const kabC = me.kabul === 0 ? 'hiçbiri kabul değil' : `<b>${nf(me.kabul)}</b> tanesi kabul`;
  return `${parti} vekilleri, vekil dökümü kayda geçen <b>${nf(j.oylama_n)}</b> açık oylamada `
       + `<b>${nf(kul)}</b> oy kullandı; ${retC}, ${kabC}. `
       + (me.katilmadi > 0 ? `<b>${nf(me.katilmadi)}</b> kez oy kullanılmadı. ` : '')
       + `Aynı oylamalarda tüm partilerin kullandığı <b>${nf(gKul)}</b> oyda ret payı `
       + `<b>%${pf(gRet / gKul * 100)}</b>; ${parti} için bu pay <b>%${pf(me.ret / kul * 100)}</b>.`;
}

const TABAN_DONEM = 300;

const farkAnlamli = (p1, n1, p2, n2) => {
  const a = p1 / 100, b = p2 / 100;
  const se = Math.sqrt((a * (1 - a)) / n1 + (b * (1 - b)) / n2) * 100;
  return Math.abs(p1 - p2) > 2 * se;
};

export function icgoruDonemler(j, parti) {
  if (!j?.success || !j.donemler?.length) return null;
  const uygun = j.donemler.filter((d) => d.n >= TABAN_DONEM);
  if (uygun.length < 2) return null;
  let enK = null, enFark = 0, enAnlamli = false;
  const tumK = new Set(uygun.flatMap((d) => Object.keys(d.kategoriler)));
  for (const k of tumK) {
    const paylar = uygun.map((d) => ({ p: d.kategoriler[k] ?? 0, n: d.n }));
    const enB = paylar.reduce((a, b) => (b.p > a.p ? b : a));
    const enK2 = paylar.reduce((a, b) => (b.p < a.p ? b : a));
    const fark = enB.p - enK2.p;
    if (fark > enFark) { enFark = fark; enK = k; enAnlamli = farkAnlamli(enB.p, enB.n, enK2.p, enK2.n); }
  }
  if (!enK || !enAnlamli) return null;
  const diz = uygun.map((d) => `${d.donem}. Dönem <b>%${pf(d.kategoriler[enK] ?? 0)}</b>`).join(' · ');
  return `${parti} için dönemler arasında en çok ayrışan konu <b>${KISA[enK] ?? enK}</b>: ${diz} `
       + `— en büyük fark <b>${pf(enFark)} puan</b>.`;
}

export async function fetchJSON(url, { retries = 1, timeout = 8000 } = {}) {
  for (let deneme = 0; deneme <= retries; deneme++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      clearTimeout(t);
      if (deneme === retries) { console.error(`fetchJSON(${url}) başarısız:`, e); return null; }
    }
  }
  return null;
}

export function bar(pct, max, color, { min = 1.5, trackClass = 'chart-track', fillClass = 'chart-fill' } = {}) {
  const w = Math.max(min, max > 0 ? (pct / max) * 100 : 0);
  return `<div class="${trackClass}"><div class="${fillClass}" style="width:${w}%;background:${color}"></div></div>`;
}

export function sayfaCanlandir() {
  const cubuk = document.createElement('div');
  cubuk.id = 'scrollCubuk';
  cubuk.setAttribute('aria-hidden', 'true');
  document.body.prepend(cubuk);
  const guncelle = () => {
    const h = document.documentElement;
    const toplam = h.scrollHeight - h.clientHeight;
    cubuk.style.width = (toplam > 0 ? Math.min(100, (h.scrollTop / toplam) * 100) : 0) + '%';
  };
  document.addEventListener('scroll', guncelle, { passive: true });
  guncelle();

  if ('IntersectionObserver' in window) {
    const gozlemci = new IntersectionObserver((girisler) => {
      for (const g of girisler) {
        if (g.isIntersecting) { g.target.classList.add('belir'); gozlemci.unobserve(g.target); }
      }
    }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });
    document.querySelectorAll('.blk, .card, .demo').forEach((el) => {
      el.classList.add('belir-oncesi');
      gozlemci.observe(el);
    });
  }
}

const TEMA_ANAHTAR = 'mizan-tema';
export function temaDegistir() {
  const r = document.documentElement;
  const yeni = r.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  r.setAttribute('data-theme', yeni);
  try { localStorage.setItem(TEMA_ANAHTAR, yeni); } catch {  }
}

export function baslikSeridi(elId, mesajlar, { aralikMs = 3200 } = {}) {
  const el = document.getElementById(elId);
  if (!el || !mesajlar?.length) return;
  el.classList.add('baslik-serit');
  el.setAttribute('aria-live', 'polite');
  const azalt = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const yaz = (metin, sinif) => {
    const oge = document.createElement('span');
    oge.className = 'bs-oge' + (sinif ? ' ' + sinif : '');
    oge.textContent = metin;
    el.appendChild(oge);
    return oge;
  };
  let simdiki = yaz(mesajlar[0]);
  if (mesajlar.length < 2) return;
  let i = 0;
  setInterval(() => {
    i = (i + 1) % mesajlar.length;
    const eski = simdiki;
    simdiki = yaz(mesajlar[i], azalt ? '' : 'bs-giren');
    if (!azalt) eski.classList.add('bs-cikan');
    setTimeout(() => eski.remove(), azalt ? 0 : 520);
  }, aralikMs);
}
