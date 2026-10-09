export interface BilinenSinir {
  id: string;
  tablo: string;
  baslik: string;
  aciklama: string;
  kod_referansi: string;
  umuma_acik_beyan_var_mi: boolean;
}

export const BILINEN_SINIRLAR: BilinenSinir[] = [
  {
    id: 'iyi-parti-program',
    tablo: 'parti_program',
    baslik: 'İYİ Parti\'nin seçim beyannamesi/parti programı yok',
    aciklama: 'İYİ Parti için ne seçim beyannamesi ne parti programı belgesi mevcut kaynaklarda bulunabildi.',
    kod_referansi: 'lib/db.ts (parti_program şema notu)',
    umuma_acik_beyan_var_mi: true,
  },
  {
    id: 'diyarbakir-meclis-uye',
    tablo: 'yerel_meclis_uye',
    baslik: 'Diyarbakır büyükşehir meclis üyesi verisi yok',
    aciklama: 'Diyarbakır büyükşehir belediyesi kaynak sayfası meclis üyesi listesini hiç yayımlamıyor — 6 şehirden 5\'inde üye verisi var.',
    kod_referansi: 'lib/db.ts (yerel_meclis_uye şema notu)',
    umuma_acik_beyan_var_mi: true,
  },
  {
    id: 'onerge-cevap-kismi-orneklem',
    tablo: 'onerge_cevap',
    baslik: 'Önerge cevap süresi yapısal olarak kısmi örneklem',
    aciklama: 'ETL sayfa başına yalnız ilk 20 kaydın detayını çekiyor (tam doldurma yüz binlerce istek demek, TBMM\'ye karşı savunulamaz) — bu tablo AGREGAT yanıt-oranı istatistiği için kullanılamaz, yalnız GÖSTERİM amaçlıdır.',
    kod_referansi: 'lib/db.ts (onerge_cevap şema notu)',
    umuma_acik_beyan_var_mi: false,
  },
  {
    id: 'ysk-secim-id-elle',
    tablo: 'secim_sonucu',
    baslik: 'secim_sonucu.secim_id elle türetilmiş, algoritmik değil',
    aciklama: 'YSK sitesinin kullanıcıya gösterdiği seçim ID\'si ile sorguda kullanılan dahili ID farklı — bu eşleme hiçbir API çağrısında açık görünmüyor, yalnız tarayıcı otomasyonuyla tek tek çözülüp elle sabitlendi.',
    kod_referansi: 'engines/ysk.ts / lib/db.ts (secim_sonucu şema notu)',
    umuma_acik_beyan_var_mi: false,
  },
  {
    id: 'model-4-kategori-uretemez',
    tablo: 'faaliyet',
    baslik: 'Sınıflandırma modeli 4 kategoriyi yapısal olarak üretemez',
    aciklama: 'Afet & Acil Durum, Konut & Şehircilik, Yerel Yönetim, Din & İnanç kategorileri için hiç muhatap-ground-truth eğitim verisi yok — bu kategoriler yalnız anahtar-kelime katmanından (daha düşük güvenilirlik) gelebilir.',
    kod_referansi: 'lib/taxonomy.ts (classifyDetailed yorumu)',
    umuma_acik_beyan_var_mi: false,
  },
  {
    id: 'tufe-gsyh-2024-duvari',
    tablo: 'tuik',
    baslik: 'TÜFE/GSYH 2024-10 öncesine geri doldurulamaz',
    aciklama: 'TÜİK\'in databrowser2 kataloğunun 367 datasetinin tamamı tarandı — ulusal TÜFE ve çeyreklik GSYH büyümesi orada yok, yalnız ana sayfa widget\'ından geliyor ve bu widget yalnız son ~16-21 ayı döndürüyor.',
    kod_referansi: 'tools/etl.ts (ingestTuik yorumu)',
    umuma_acik_beyan_var_mi: true,
  },
  {
    id: 'oy-cetveli-2023-duvari',
    tablo: 'oy',
    baslik: 'Vekil bazlı oy cetveli 2023 (28. dönem) öncesine geçmez',
    aciklama: 'Kanıt PDF\'i (Basılmış cetvel) yalnız 28. dönemden itibaren taranmış görüntü olarak mevcut — eski dönemlerde "kim nasıl oy verdi" verisi yapısal olarak yok.',
    kod_referansi: 'proje belleği (project-oy-cetveli-pdf)',
    umuma_acik_beyan_var_mi: true,
  },
];
