<div align="center">

# Mizan

### Türkiye Yasama ve Kamu Denetimi Analitik Platformu

**Resmî kamu verileri üzerinden yasama faaliyetlerini, siyasi süreçleri ve yerel yönetim kararlarını analiz etmek için geliştirilen açık kaynaklı platform.**

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.5.0-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5.2-000000?style=flat-square&logo=fastify&logoColor=white)](https://fastify.dev/)
[![SQLite](https://img.shields.io/badge/SQLite-node%3Asqlite-003B57?style=flat-square&logo=sqlite&logoColor=white)](https://nodejs.org/api/sqlite.html)
[![Testler](https://img.shields.io/badge/Test_Suitleri-27_Başarılı-brightgreen?style=flat-square)](./backend-node/test/)
[![Lisans](https://img.shields.io/badge/Lisans-MIT-blue?style=flat-square)](./LICENSE)

</div>

---

## **Genel Bakış**

Mizan, Türkiye'deki yasama faaliyetlerini, parlamenter süreçleri ve yerel yönetim kararlarını kamuya açık resmî kaynaklardan elde edilen veriler üzerinden analiz etmek amacıyla geliştirilmiş bir veri gazeteciliği ve kamu denetimi platformudur.

Platform; TBMM, Anayasa Mahkemesi, Resmî Gazete, TÜİK, YSK ve yerel yönetimlerden elde edilen verileri işleyerek doğrulanabilir analitik çıktılar sunar.

Mizan'ın temel yaklaşımı, siyasi süreçleri öznel yorumlardan bağımsız biçimde değerlendirmek ve bütün analitik sonuçları matematiksel kurallar, kanıt zinciri ve katı tarafsızlık ilkeleri çerçevesinde üretmektir.

### **Temel İlkeler**

- **Veri Bütünlüğü** — Analizler kamuya açık resmî kayıtlar üzerinden yürütülür.
- **Belirlenimci İşleme** — Veri işleme ve konu sınıflandırma süreçlerinde belirlenimci yöntemler kullanılır.
- **Siyasi Tarafsızlık** — Parti veya siyasi aktörlere özel koşullu analiz mantığına izin verilmez.
- **Kanıta Dayalı Analiz** — Veri kaynakları arasındaki farklılıklar gizlenmeden açıkça belirtilir.
- **Tasarım Gereği Gizlilik** — Gereksiz kişisel veriler toplanmaz ve demografik tahminler yapılmaz.

---

## **Özellikler**

- **Çok Kaynaklı Veri Toplama** — TBMM, AYM, Resmî Gazete, TÜİK, YSK ve yerel yönetimlerden veri toplama.
- **Yasama Faaliyetlerinin Analizi** — Kanun teklifleri, soru önergeleri, genel kurul tutanakları ve oylama kayıtlarının analizi.
- **Yerel Yönetim Takibi** — Belediye meclisi kararları ve oylama sonuçlarının incelenmesi.
- **Belirlenimci Doğal Dil İşleme** — Multinomial Naive Bayes tabanlı, çevrimdışı konu sınıflandırma sistemi.
- **Oylama Analizi** — Basılmış oylama cetvellerinden parti bazlı oylama dağılımlarının hesaplanması.
- **İstatistiksel İlişkilendirme** — TÜİK verileri ile kamu ve yasama faaliyetleri arasındaki ilişkilerin incelenmesi.
- **Kanıt Zinciri** — Farklı resmî kayıtlar arasındaki veri uyuşmazlıklarının tespit edilmesi.
- **Etkileşimli Gösterge Paneli** — SVG tabanlı grafikler ve analitik veri tabloları.
- **Güvenlik Denetimleri** — SSRF koruması, istek sınırlama ve devre kesici mekanizmaları.

---

## **Veri Kaynakları**

Mizan, analizlerini aşağıdaki resmî kamu kaynaklarından elde edilen veriler üzerine kurar.

| Kaynak | Veriler |
|---|---|
| **TBMM** | Kanun teklifleri, soru önergeleri, genel kurul tutanakları ve oylama cetvelleri |
| **AYM** | Norm denetimi ve siyasi parti kapatma kararları |
| **Resmî Gazete** | Mevzuat ilanları ve resmî yayımlar |
| **TÜİK** | Sosyo-ekonomik istatistikler ve bültenler |
| **YSK** | Seçim sonuçları ve sandalye dağılımları |
| **Yerel Yönetimler** | Belediye meclisi tutanakları ve kararları |

---

## **Sistem Mimarisi**

Mizan, veri toplama aşamasından kullanıcı arayüzüne kadar katmanlı bir mimari kullanır.

```text
┌──────────────────────────────────────────────┐
│                RESMÎ VERİ KAYNAKLARI         │
│                                              │
│  TBMM │ AYM │ Resmî Gazete │ TÜİK │ YSK      │
│              Yerel Yönetimler                │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│              GÜVENLİK VE VERİ TOPLAMA        │
│                                              │
│  SSRF Koruması │ İstek Sınırlama             │
│  DNS Doğrulama │ Devre Kesici                │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│                 VERİ İŞLEME                  │
│                                              │
│  Türkçe Metin Normalleştirme                 │
│  Anakronizm Koruması                         │
│  Naive Bayes Sınıflandırması                 │
│  Belge Tutarlılığı Denetimi                  │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│                  VERİ DEPOLAMA               │
│                                              │
│  SQLite │ WAL │ İndeksli Tablolar            │
│  Birleşik Anahtarlar │ Değişmezlik Koruması  │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│                  FASTIFY API                 │
│                                              │
│  /api/ozet/*                                 │
│  /api/istatistik/*                           │
│  /health                                     │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│                 WEB ARAYÜZÜ                  │
│                                              │
│  HTML5 │ JavaScript ESM │ Vite │ SVG         │
└──────────────────────────────────────────────┘
```

### **Teknoloji Altyapısı**

| Bileşen | Teknoloji |
|---|---|
| Çalışma Ortamı | Node.js 22.5+ |
| Backend Dili | TypeScript 5.7 |
| API Çatısı | Fastify 5.2 |
| Veritabanı | Node.js `node:sqlite` |
| Veritabanı Modu | SQLite WAL |
| Arayüz | HTML5, CSS, JavaScript ESM |
| Geliştirme Sunucusu | Vite |
| Sınıflandırma | Multinomial Naive Bayes |
| Test Altyapısı | Node.js Test Suite, JSDOM |

---

## **Metodoloji ve Tarafsızlık**

Mizan, analitik çıktılarında siyasi tarafsızlığı korumak amacıyla matematiksel ve mekanik olarak doğrulanabilir kurallar uygular.

Platformdaki içgörü cümleleri ve veri kartları, `tablo/ortak.js` içerisinde tanımlanan ve testlerle doğrulanan kurallara tabidir.

| İlke | Kural | Açıklama |
|---|---|---|
| **Eşdeğişim Garantisi** | `T1 Equivariance` | A ve B partileri yer değiştirdiğinde çıktı da simetrik olarak yer değiştirmelidir. |
| **Yasaklı Kalıp Denetimi** | `T3 Neutrality` | Nedensellik, değer yargısı ve karşıtlık bildiren kalıplar otomatik olarak engellenir. |
| **Yön İddiası Kısıtlaması** | `T2d Directional` | Dönem karşılaştırmalarında yön bildiren ifadeler yerine sayısal veriler kullanılır. |
| **Suskunluk Sözleşmesi** | `T4 Silence` | Örneklem güven sınırının altında kaldığında sistem tahmin üretmez ve `null` döndürür. |
| **Kapalı Güvenli Yayınlama** | `Etiket Kapısı` | Gerekli bakanlık teyitli etiketler bulunmadığında ilgili analizler yayımlanmaz. |
| **Kanıt Zinciri Şeffaflığı** | `Evidence Chain` | Resmî kayıtlar arasında tespit edilen sayısal uyuşmazlıklar açıkça belirtilir. |
| **Kişisel Veri Minimizasyonu** | `Data Minimization` | Gereksiz kişisel veriler saklanmaz ve demografik tahminler yapılmaz. |

### **Belirlenimci Konu Sınıflandırması**

Mizan, konu sınıflandırma işlemlerinde çevrimdışı çalışan Multinomial Naive Bayes modelini kullanır.

Bu yaklaşımın temel özellikleri:

- Harici LLM servisine bağımlılık bulunmaması.
- Sınıflandırma işlemlerinin belirlenimci yürütülmesi.
- Bakanlık muhatabı etiketlerinin kullanılması.
- LOPO sapma kontrolü.
- Yayın öncesinde gerekli etiketlerin doğrulanması.

---

## **Güvenlik Mimarisi**

Güvenlik, Mizan'ın veri toplama, işleme ve yönetim katmanlarına entegre edilmiştir.

### **SSRF Koruması**

`kaynakIzin.ts` üzerinden yürütülen kaynak doğrulama mekanizması:

- Yalnızca izin verilen resmî `.gov.tr` alan adlarına erişim sağlar.
- RFC 1918 özel IP bloklarını reddeder.
- AWS ve GCP metadata servislerine erişimi engeller.
- Localhost ve izin verilmeyen portları reddeder.
- DNS sonek manipülasyonlarını kontrol eder.
- Yönlendirme zincirindeki her adımı yeniden doğrular.

### **Yönetim Erişim Denetimi**

- `ADMIN_TOKEN` tanımlı olmadığında yönetim uç noktaları `503 Service Unavailable` döndürür.
- Token karşılaştırmaları `crypto.timingSafeEqual` kullanılarak gerçekleştirilir.
- Yönetim erişimi kapalı güvenli yaklaşımıyla korunur.

### **Veri Sağlığı İzleme**

`/health` uç noktası yalnızca uygulamanın çalışır durumda olup olmadığını değil, yayımlanan verilerin güncelliğini de denetler.

TBMM, Resmî Gazete veya TÜİK verilerinde belirlenen eşiklerin üzerinde bayatlama tespit edildiğinde sistem `ok: false` durumuna geçer.

---

## **Proje Dizini**

```text
.
├── .gitignore
├── LICENSE
├── README.md
├── deputy_master_list.json
│
├── backend-node/
│   ├── package.json
│   ├── tsconfig.json
│   │
│   ├── src/
│   │   ├── index.ts
│   │   ├── engines/
│   │   │   └── yerelYonetimEk/
│   │   ├── lib/
│   │   ├── routes/
│   │   └── tools/
│   │
│   └── test/
│
└── tablo/
    ├── package.json
    ├── vite.config.js
    ├── index.html
    ├── kanun.html
    ├── parti.html
    ├── konu.html
    ├── vekil.html
    ├── karsilastir.html
    ├── stil.css
    ├── ortak.js
    └── test/
```

### **Dizin Açıklamaları**

| Dizin / Dosya | Açıklama |
|---|---|
| `backend-node/` | Analitik API ve veri işleme motoru |
| `backend-node/src/engines/` | Kamu kaynaklarından veri toplama motorları |
| `backend-node/src/lib/` | Veritabanı, HTTP, önbellek, NLP ve güvenlik kütüphaneleri |
| `backend-node/src/routes/` | API uç noktaları |
| `backend-node/src/tools/` | ETL, migrasyon ve zamanlanmış veri toplama araçları |
| `backend-node/test/` | Backend testleri |
| `tablo/` | Web arayüzü |
| `tablo/test/` | Arayüz ve tarafsızlık testleri |
| `deputy_master_list.json` | 1–28. dönem milletvekili ana sicil listesi |

---

## **Kurulum ve Çalıştırma**

### **Sistem Gereksinimleri**

- Node.js `v22.5.0` veya üzeri
- npm `v10.0.0` veya üzeri

Node.js ve npm sürümlerinizi kontrol edin:

```bash
node --version
npm --version
```

### **1. Depoyu Klonlama**

```bash
git clone <repository-url>
cd mizan
```

### **2. Backend Servisini Başlatma**

Backend dizinine geçin:

```bash
cd backend-node
```

Bağımlılıkları yükleyin:

```bash
npm install
```

Ortam dosyasını isteğe bağlı olarak oluşturun:

```bash
cp .env.example .env
```

Geliştirme sunucusunu başlatın:

```bash
npm run dev
```

Backend varsayılan olarak `8000` portunda çalışır.

### **3. Arayüzü Başlatma**

Yeni bir terminal açın:

```bash
cd tablo
```

Bağımlılıkları yükleyin:

```bash
npm install
```

Vite geliştirme sunucusunu başlatın:

```bash
npm run dev
```

Arayüze aşağıdaki adres üzerinden erişebilirsiniz:

```text
http://localhost:5180
```

Geliştirme ortamında `/api` istekleri otomatik olarak `http://127.0.0.1:8000` adresine yönlendirilir.

---

## **Testler**

Backend testlerini çalıştırmak için:

```bash
cd backend-node
npm test
```

TypeScript derleme ve tip kontrolü:

```bash
npm run build
```

Arayüz testleri için:

```bash
cd tablo
npm test
```

---

## **API Referansı**

Mizan, analitik verileri Fastify tabanlı REST API üzerinden sunar.

| Metot | Uç Nokta | Açıklama |
|---|---|---|
| `GET` | `/health` | Sistem ve veri güncelliği durumu |
| `GET` | `/api/ozet/yasama` | Yasama dönemi, kanunlaşma ve komisyon istatistikleri |
| `GET` | `/api/ozet/oy` | Parti bazlı oylama dağılımları |
| `GET` | `/api/ozet/cesaret` | Söylem ve eylem konu tutarlılığı metriği |
| `GET` | `/api/ozet/kanun-hikaye` | Kanun tekliflerinin aşamaları ve kayıt uyuşmazlıkları |
| `GET` | `/api/milletvekili/liste` | Milletvekili sicili ve faaliyet geçmişi |
| `GET` | `/api/yerel-yonetim/kararlar` | Belediye meclisi oylama sonuçları ve karar özetleri |

---

## **Yasal Uyarı ve Sorumluluk Reddi**

1. **Kamuya Açıklık:** Mizan, kamuya açık resmî kanunları, tutanakları, yargı kararlarını ve istatistikleri kamu yararı amacıyla işler.
2. **Bağımsızlık:** Proje herhangi bir siyasi parti, parlamento grubu, kamu kurumu veya sivil toplum kuruluşuyla organik, finansal ya da kurumsal bağlantıya sahip değildir.
3. **Veri Bütünlüğü:** Hesaplamalar nesnel algoritmalarla yürütülür. Kaynak kurumların kayıtlarında tespit edilen veri hataları ve eksiklikleri kullanıcıya açıkça bildirilir.

---

## **Lisans**

Mizan, [MIT Lisansı](LICENSE) altında açık kaynak olarak sunulmaktadır.
