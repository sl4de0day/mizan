# PoliticalInsight — Node/TypeScript Backend (Python/FastAPI portu)

Python backend'inin (`../backend/`) JavaScript/TypeScript'e taşınması. **Mevcut Python'a dokunulmuyor** — bu dizin bağımsız; her motor doğrulandıkça devreye alınır.

## Durum

| Alt sistem | Durum | Doğrulama |
|---|---|---|
| Altyapı (http, cache, logger, config, types) | ✅ Tamam | tsc temiz |
| **TÜİK** (statistics) | ✅ Tamam | Python engine ile **7/7 çıktı byte-identical** + canlı sunucu uçtan-uca |
| **Resmî Gazete** (gazette) | ✅ Tamam | Python `fetch_content` ile fixture'da **byte-identical** (4 section/22 item) |
| **Parlamento — Önerge** (motion) | ✅ Tamam | Detay parse **byte-identical** (bağımsız doğrulandı) + liste transform sentetik veriyle byte-identical + filtreler |
| **Parlamento — Kanun** (law) | ✅ Tamam | Detay parse **byte-identical** (2 fixture) + liste transform (tüm durum dalları) + filtreler |
| **Parlamento — Tutanak** (minute) | ✅ Tamam | Detay parse **byte-identical** + liste transform sentetik veriyle byte-identical |
| **AYM norm + parti** (constitutional) | ✅ Tamam | norm/parti **arama + detay byte-identical** (bağımsız); html_content 42522/25267 byte birebir |
| **Milletvekili** (mv) | ✅ Tamam | bio parse + fallback **byte-identical** (bağımsız); Gemini `@google/genai` env-anahtarıyla uçtan uca |
| **Haber** (gnews + AI + Gemini web + extraction) | ✅ Tamam | `resolveFromJslog` **byte-identical**; route'lar birebir; tarayıcı-otomasyonu yapısal; extraction = **Defuddle** (Readability halefi — tarih+yazar+açıklama da çıkarır; canlı BBC'de doğrulandı, ~%91 trafilatura gövde metni) |
| **Milletvekili istatistik** (list/comparative/performance) | ✅ Tamam | statik veriyle **byte-identical** (bağımsız: 599 satır, CHP total 142) |
| **Önerge/Kanun/Tutanak/AYM istatistik** | ✅ Tamam | sentetik engine-çıktısıyla **byte-identical** (aggregation mantığı) |
| **Admin + Scheduler** (Python portu) | ✅ Tamam | yapısal (admin_ping orkestrasyon + history + scheduler döngüsü); path-traversal yazma tarafı da sanitize edildi — **bu port hiç kullanılmıyor, aşağıya bakın** |

> **Admin paneli (2026-07-30, Python portunun DIŞINDA, yeni):** Yukarıdaki port ölü koddu — `history_logs`/`scheduler_config.json` diskte hiç yoktu, ping 43 route çağırıyordu ki karşılıkları artık yok. Gerçek, çalışan admin sistemi `routes/adminOps.ts` + `tablo/admin.html` — 20 ETL modu (3 katman: güvenli/gecelik-zincir/tehlikeli-onaylı), zamanlayıcı, yedek yönetimi, proxy ayarı, canlı log, kalıcı çalışma geçmişi. `ADMIN_TOKEN` env değişkeni tanımlı değilse tüm `/api/admin/*` 503 döner (fail-closed). Eski port dosyaları bilerek silinmedi/dokunulmadı, aynı auth kapısının altında zararsız duruyor.

**Göç TAMAMLANDI.** Tüm proje `tsc` temiz; sunucu 11 route grubuyla açılıyor; her alt sistem doğrulandı.

> **Bilinen dil-artefaktları (değer-eş, kabul edilebilir):** (1) tam-sayı float'lar JS'te `3`, Python'da `3.0` serileşir. (2) Bazı dağılım dizilerinde eşitlik-sıralaması Python'un `os.listdir` (non-deterministik) sırasına bağlıydı; sayı/değerler her zaman aynı. (3) Tarayıcı-otomasyonu (gnews/Gemini web) ve makale-ayıklama (Readability) canlı ortamda son bir kez doğrulanmalı.

## Doğrulama yöntemi (her motor için)

Aynı girdiyi **hem gerçek Python engine'ine hem TS engine'ine** verip çıktıyı `deep-equal` karşılaştırıyoruz:
- JSON motorlar: canlı endpoint'ten ham veri → her iki transform → karşılaştır (`test/xcheck.ts` + `scratchpad/xcheck_py.py`).
- HTML motorlar: `scraper/**/files/*OuterHtml.txt` fixture → her iki parse → karşılaştır (`test/gazette_parse.ts` + `scratchpad/xcheck_gazette.py`).

Python `httpx`'i patch'lenir (fixture'ı döndürür) ve cache kapatılır; böylece saf çeviri doğruluğu ölçülür.

## Çalıştırma

```bash
npm install
PORT=8000 npm run start      # sunucu
npm run build                # tsc --noEmit (typecheck)
```

Endpoint'ler (Python ile aynı): `/api/istatistik/ozet`, `/api/istatistik/detay/:id`.

## Mimari

- `src/lib/` — paylaşılan: `http.ts` (fetch+proxy), `cache.ts` (Redis+bellek+dosya), `logger.ts`, `config.ts`, `types.ts`.
- `src/engines/` — her Python engine'in birebir çevirisi. Saf `transform*/parse*` metodları fixture ile test edilebilir.
- `src/routes/` — Fastify route modülleri; engine'lere bağlanır.
- `src/index.ts` — Fastify app + CORS.

Redis yoksa otomatik belleğe/dosyaya düşer (Python'daki davranış).
