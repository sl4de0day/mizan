<div align="center">

# Mizan
### Türkiye Yasama ve Kamu Denetimi Analitik Platformu

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.5.0-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5.2-000000?style=flat-square&logo=fastify&logoColor=white)](https://fastify.dev/)
[![SQLite](https://img.shields.io/badge/SQLite-node%3Asqlite%20(WAL)-003B57?style=flat-square&logo=sqlite&logoColor=white)](https://nodejs.org/api/sqlite.html)
[![Tests](https://img.shields.io/badge/Test_Suites-27_Passed-brightgreen?style=flat-square)](./backend-node/test/)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](./LICENSE)

<p align="center">
  <b>TBMM, Anayasa Mahkemesi, Resmî Gazete, TÜİK, YSK ve 81 il yerel yönetim meclis kararlarını matematiksel eşdeğişim (equivariance) ve katı tarafsızlık sözleşmesi altında işleyen açık kaynaklı veri gazeteciliği ve kamu denetimi altyapısı.</b>
</p>

</div>

---

## Genel Bakış

**Mizan**, Türkiye'deki siyasi süreçlerin, parlamenter faaliyetlerin ve yerel yönetim kararlarının hesap verilebilirliğini sağlamak amacıyla geliştirilmiş kurumsal düzeyde bir analitik platformdur.

Geleneksel siyasi analiz araçlarının aksine, Mizan **öznel editoryal yorum üretmez**, **üretken yapay zekâ halüsinasyonlarına dayanmaz** ve **veri eksikliklerini örtbas etmez**. Tüm metrikler; kanıt zinciri (chain of evidence), matematiksel simetri ve kamuya açık resmî kayıtların doğrulanabilirliği esasına göre hesaplanır.

### Temel Özellikler
* **Çok Boyutlu Korpus:** TBMM kanun teklifleri, yazılı soru önergeleri, genel kurul tutanakları, basılmış oylama cetvelleri (roll-call oylamalar), AYM norm denetimi ve 81 ilin belediye meclis kararları.
* **Deterministik Doğal Dil İşleme (NLP):** LLM tabanlı yanılsamaları ve önyargıları engellemek için mikrosaniye seviyesinde çalışan, sıfır-dış-bağımlılıklı, bakanlık muhatabı etiketli offline **Multinomial Naive Bayes** konu modeli.
* **Sıfır C-Derleme Bağımlılığı:** Node.js 22'nin yerleşik `node:sqlite` (`DatabaseSync`) motoru üzerinde WAL (Write-Ahead Logging) modunda çalışan, ACID uyumlu yüksek performanslı depolama.
* **Erişilebilir & Hızlı Arayüz:** Modern CSS değişkenleri, katı 4-renk kurumsal palet (WCAG AAA kontrast uyumlu), SVG tabanlı reaktif grafikler ve sıfır bundle şişkinliği.

---

## Sistem Mimarisi ve Veri Akışı

```text
[ RESMÎ KAMU KAYNAKLARI ]
 ├── TBMM (Kanun, Önerge, Tutanak, Oy Cetveli PDF)
 ├── AYM (Norm Denetimi & Parti Kapatma Kararları)
 ├── Resmî Gazete (Fihrist & Mevzuat İlanları)
 ├── TÜİK (Sosyo-Ekonomik Bültenler)
 ├── YSK (Seçim Sonuçları & Sandalye Dağılımları)
 └── Yerel Yönetimler (81 İl Belediye Meclis Tutanakları)
            │
            ▼ [ GÜVENLİK & KAZIMA KATMANI ]
 ├── SSRF Koruması (Özel IP, Cloud Metadata, DNS Sonek Filtresi)
 ├── TBMM / CDN Nezaket Havuzu (Backoff & Rate Limiting)
 └── Kırılganlık Kalkanı (Devre Kesici - Circuit Breaker)
            │
            ▼ [ VERİ DÖNÜŞÜM & MÜHENDİSLİK (ETL) ]
 ├── Türkçe Morfoloji & Harf Katlama (CleanStr / TrLower)
 ├── Anokronizm Koruması (Vekil Transfer & İmza-Anı Doğrulaması)
 ├── Offline Naive Bayes Konu Tespiti (LOPO Sapma Kontrollü)
 └── Çift Belge Çelişki Denetimi (Tutanak Metni vs. PDF Cetveli)
            │
            ▼ [ KALICILIK KATMANI - node:sqlite ]
 ├── analytics.db (WAL Modu, İndeksli Faaliyet/Olay Tabloları)
 └── Composite Key & Invariant Koruması (UNIQUE: kaynak, id, donem)
            │
            ▼ [ ÇEKİRDEK SERVİS (Fastify API) ]
 ├── /api/ozet/* (Özet Metrikler, Kanun/Önerge/Oy Dağılımları)
 ├── /api/istatistik/* (TÜİK & Faaliyet Korelasyonları)
 └── /health (Veri Tazeliği ve Güvenilirlik Ölçümü)
            │
            ▼ [ KULLANICI ARABİRİMİ (tablo/) ]
 └── Minimal HTML5/ESM İstemci (Vite Proxy, SVG Görselleştirme)
```

---

## Metodolojik Çerçeve ve Tarafsızlık İlkeleri

Mizan platformunda yer alan her içgörü cümlesi ve veri kartı, [`tablo/ortak.js`](file:///c:/Users/sl4de/Desktop/Desk/mizan/siyasisiteprojesi/main/tablo/ortak.js) içerisinde tanımlanan ve [`tablo/test/icgoru.test.js`](file:///c:/Users/sl4de/Desktop/Desk/mizan/siyasisiteprojesi/main/tablo/test/icgoru.test.js) ile mekanik olarak doğrulanan kurallara tabidir:

| İlke | Kural Kodu | Teknik Tanım & Güvence |
| :--- | :---: | :--- |
| **Eşdeğişim Garantisi** | `T1 Equivariance` | Girdide A ve B partileri takas edildiğinde çıktı simetrik olarak yer değiştirir: $f(\text{swap}(A, B)) \equiv \text{swap}(f(A, B))$. Partiye özel koşullu kod (`if/else`) barındırılamaz. |
| **Yasaklı Kalıp Linterı** | `T3 Neutrality` | Nedensellik (`çünkü`, `sayesinde`, `gösteriyor ki`), değer yargısı (`başarılı`, `yetersiz`, `çelişki`) ve karşıtlık bağlaçları (`rağmen`, `oysa`, `aslında`) regex tabanlı AST linter ile engellenir. |
| **Yön İddiası Yasağı** | `T2d Directional` | Dönem karşılaştırmalarında `arttı`, `düştü`, `yükseldi` gibi yön fiilleri kullanılamaz; sayılar ve yüzdeler nötr olarak yan yana listelenir. |
| **Suskunluk Sözleşmesi** | `T4 Silence` | Örneklem sayısı asgari güven sınırının altındaysa sistem tahminde bulunmaz, doğrudan `null` döner ve kartı gizler. |
| **Yayın Kapısı (Fail-Closed)** | `Etiket Kapısı` | İlgili yasama döneminde bakanlık teyitli "altın etiket" yoksa, model tahminleri yanlılık doğurabileceğinden parti×konu payları yayına kapatılır. |
| **Kanıt Zinciri Açıklığı** | `Evidence Chain` | TBMM tutanak metni ile basılı oylama cetveli arasında sayısal fark varsa (28. dönemde 48 kanunda tespit edilmiştir), sayı gizlenmez; çelişki açıkça beyan edilir. |
| **Kişisel Veri Sınırı** | `Data Minimization` | Vekillerin telefon, e-posta veya aile bilgileri saklanmaz; LLM ile demografik tahmin yapılması (cinsiyet, eğitim vb.) mimariden tamamen yasaklanmıştır. |

---

## Dizin Yapısı

```text
.
├── .gitignore                   # Büyük veritabanları, geçici dosyalar ve log filtreleri
├── LICENSE                      # MIT Açık Kaynak Lisansı
├── README.md                    # Proje ana dokümantasyonu
├── deputy_master_list.json      # 1-28. Dönem kanonik milletvekili ana sicil listesi
├── backend-node/                # Analitik API ve Veri Motoru
│   ├── package.json             # Bağımlılıklar, scriptler ve Node >=22.5.0 motor kısıtı
│   ├── tsconfig.json            # Katı TypeScript derleyici yapılandırması
│   ├── src/
│   │   ├── index.ts             # Fastify uygulama girişi & dinamik /health uç noktası
│   │   ├── engines/             # Veri çekme motorları (TBMM, AYM, YSK, Gazete, TÜİK, 81 İl)
│   │   │   └── yerelYonetimEk/  # 73 il belediye meclisi özel adaptörleri
│   │   ├── lib/                 # Çekirdek kütüphaneler (db, http, cache, nb, taxonomy, auth)
│   │   ├── routes/              # API rotaları (ozet, parliament, news, adminOps vb.)
│   │   └── tools/               # ETL, migrasyon ve zamanlanmış veri kazıma araçları
│   └── test/                    # 27 adet kapsamlı birim, invariant ve güvenlik test suiti
└── tablo/                       # İstemci Paneli (Frontend)
    ├── package.json             # Vite geliştirme ve test bağımlılıkları
    ├── vite.config.js           # API ters vekil (proxy) ayarları
    ├── index.html               # Ana gösterge paneli ve arama arayüzü
    ├── kanun.html / parti.html  # Kanun ve siyasi parti odaklı detay sayfaları
    ├── konu.html / vekil.html   # Konu dağılımı ve milletvekili analiz sayfaları
    ├── karsilastir.html         # Söz vs. Eylem karşılaştırma matrisi
    ├── stil.css                 # Katı 4-renk marka paleti ve erişilebilir tipografi
    ├── ortak.js                 # Paylaşılan sözlükler ve saf içgörü fonksiyonları
    └── test/                    # JSDOM render simülasyonları ve tarafsızlık testleri
```

---

## Kurulum ve Çalıştırma

### Sistem Gereksinimleri
* **Node.js:** `v22.5.0` veya üzeri (`node:sqlite` yerleşik modülü zorunludur)
* **npm:** `v10.0.0` veya üzeri

### 1. Backend Servisi

```bash
# Backend dizinine geçiş
cd backend-node

# Bağımlılıkları yükleyin
npm install

# İsteğe bağlı ortam dosyasını oluşturun
cp .env.example .env

# Geliştirme sunucusunu başlatın (Port: 8000)
npm run dev
```

#### Doğrulama ve Testler:
```bash
# Tip kontrolü (0 hata garantisi)
npm run build

# Tüm test suitlerini çalıştırın
npm test
```

### 2. Frontend İstemcisi

Ayrı bir terminal penceresinde:

```bash
# Tablo dizinine geçiş
cd tablo

# Bağımlılıkları yükleyin
npm install

# Vite geliştirme sunucusunu başlatın (Port: 5180)
npm run dev
```

Tarayıcınızdan `http://localhost:5180` adresini açarak gösterge panelini görüntüleyebilirsiniz. Geliştirme modunda `/api` istekleri otomatik olarak `http://127.0.0.1:8000` adresine yönlendirilir.

---

## Güvenlik Mimarisi

* **SSRF (Server-Side Request Forgery) Kapısı:** [`kaynakIzin.ts`](file:///c:/Users/sl4de/Desktop/Desk/mizan/siyasisiteprojesi/main/backend-node/src/lib/kaynakIzin.ts) yalnızca resmî `.gov.tr` alan adlarına izin verir. RFC 1918 özel IP blokları, AWS/GCP bulut metadata servisleri (`169.254.169.254`), localhost, alternatif portlar ve DNS sonek manipülasyonları reddedilir. Yönlendirme (redirect) zinciri her sıçramada denetlenir.
* **Fail-Closed Yönetim Kapısı:** `ADMIN_TOKEN` ortam değişkeni tanımlı olmadığında tüm `/api/admin/*` uçları doğrudan `503 Service Unavailable` döner. Token doğrulaması zamanlama saldırılarına (timing attacks) karşı sabit-zamanlı `crypto.timingSafeEqual` ile korunur.
* **Gelişmiş Veri Sağlığı İzleme:** `/health` ucu salt sürecin ayakta olmasını değil, yayınlanan verinin güncelliğini denetler. TBMM, Resmî Gazete veya TÜİK verilerinde belirlenen eşiklerin üzerinde bayatlama tespit edilirse sistem otomatik olarak `ok: false` durumuna geçer.

---

## Temel API Uç Noktaları

| Metod | Rota | Açıklama |
| :--- | :--- | :--- |
| `GET` | `/health` | Sistem ve veri tazelik durumu (semantic healthcheck) |
| `GET` | `/api/ozet/yasama` | Dönem bazlı kanunlaşma, komisyon ve ret oranları |
| `GET` | `/api/ozet/oy` | Basılmış roll-call cetvellerinden parti oylama dağılımları |
| `GET` | `/api/ozet/cesaret` | Söylem (tutanak) vs. Eylem (önerge/kanun) konu tutarlılık metriği |
| `GET` | `/api/ozet/kanun-hikaye` | Kanun teklifinin aşamaları ve tutanak-cetvel çelişki beyanı |
| `GET` | `/api/milletvekili/liste` | 1-28. Dönem vekil sicili, faaliyet ve komisyon geçmişi |
| `GET` | `/api/yerel-yonetim/kararlar` | 81 il belediye meclisi oylama sonuçları ve karar özetleri |

---

## Yasal Uyarı ve Sorumluluk Reddi (Disclaimer)

1. **Kamuya Açıklık:** Mizan, Türkiye Cumhuriyeti Fikir ve Sanat Eserleri Kanunu (FSEK) Madde 31 uyarınca resmî olarak yayımlanan kanun, tutanak, yargı kararı ve istatistiki verileri kamu yararı doğrultusunda işler.
2. **Bağımsızlık Bildirimi:** Bu proje hiçbir siyasi parti, parlamento grubu, kamu kurumu veya sivil toplum kuruluşu ile organik, finansal ya da kurumsal bir bağa sahip değildir.
3. **Veri Bütünlüğü:** Tüm hesaplamalar nesnel algoritmalarla yürütülür; kaynak kurumların kendi resmî kayıtlarındaki veri tabanı hataları veya eksiklikleri tespit edildiğinde kullanıcıya açıkça beyan edilir.

---

## Lisans

Bu proje **[MIT Lisansı](LICENSE)** altında açık kaynak olarak sunulmuştur.
