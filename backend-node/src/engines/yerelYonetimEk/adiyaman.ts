import { Agent, ProxyAgent } from 'undici';
import tls from 'node:tls';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { proxyUrlForKaynak } from '../../lib/http.js';
import {
  HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar, kararNoSiraDoldur,
  type YerelKararSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Adiyaman');
const execFileAsync = promisify(execFile);

const ADIYAMAN_API_BASE = 'https://ebelediye.adiyaman.bel.tr/api/';
const ADIYAMAN_LISTE_URL = `${ADIYAMAN_API_BASE}MeclisKararlariListe`;
const ADIYAMAN_INDIR_URL = `${ADIYAMAN_API_BASE}Dys/download`;
const INDIRME_NEZAKET_MS = 1100;

const ADIYAMAN_ARA_SERTIFIKA = `-----BEGIN CERTIFICATE-----
MIIEszCCA5ugAwIBAgIQCyWUIs7ZgSoVoE6ZUooO+jANBgkqhkiG9w0BAQsFADBh
MQswCQYDVQQGEwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3
d3cuZGlnaWNlcnQuY29tMSAwHgYDVQQDExdEaWdpQ2VydCBHbG9iYWwgUm9vdCBH
MjAeFw0xNzExMDIxMjI0MzNaFw0yNzExMDIxMjI0MzNaMGAxCzAJBgNVBAYTAlVT
MRUwEwYDVQQKEwxEaWdpQ2VydCBJbmMxGTAXBgNVBAsTEHd3dy5kaWdpY2VydC5j
b20xHzAdBgNVBAMTFlJhcGlkU1NMIFRMUyBSU0EgQ0EgRzEwggEiMA0GCSqGSIb3
DQEBAQUAA4IBDwAwggEKAoIBAQC/uVklRBI1FuJdUEkFCuDL/I3aJQiaZ6aibRHj
ap/ap9zy1aYNrphe7YcaNwMoPsZvXDR+hNJOo9gbgOYVTPq8gXc84I75YKOHiVA4
NrJJQZ6p2sJQyqx60HkEIjzIN+1LQLfXTlpuznToOa1hyTD0yyitFyOYwURM+/CI
8FNFMpBhw22hpeAQkOOLmsqT5QZJYeik7qlvn8gfD+XdDnk3kkuuu0eG+vuyrSGr
5uX5LRhFWlv1zFQDch/EKmd163m6z/ycx/qLa9zyvILc7cQpb+k7TLra9WE17YPS
n9ANjG+ECo9PDW3N9lwhKQCNvw1gGoguyCQu7HE7BnW8eSSFAgMBAAGjggFmMIIB
YjAdBgNVHQ4EFgQUDNtsgkkPSmcKuBTuesRIUojrVjgwHwYDVR0jBBgwFoAUTiJU
IBiV5uNu5g/6+rkS7QYXjzkwDgYDVR0PAQH/BAQDAgGGMB0GA1UdJQQWMBQGCCsG
AQUFBwMBBggrBgEFBQcDAjASBgNVHRMBAf8ECDAGAQH/AgEAMDQGCCsGAQUFBwEB
BCgwJjAkBggrBgEFBQcwAYYYaHR0cDovL29jc3AuZGlnaWNlcnQuY29tMEIGA1Ud
HwQ7MDkwN6A1oDOGMWh0dHA6Ly9jcmwzLmRpZ2ljZXJ0LmNvbS9EaWdpQ2VydEds
b2JhbFJvb3RHMi5jcmwwYwYDVR0gBFwwWjA3BglghkgBhv1sAQEwKjAoBggrBgEF
BQcCARYcaHR0cHM6Ly93d3cuZGlnaWNlcnQuY29tL0NQUzALBglghkgBhv1sAQIw
CAYGZ4EMAQIBMAgGBmeBDAECAjANBgkqhkiG9w0BAQsFAAOCAQEAGUSlOb4K3Wtm
SlbmE50UYBHXM0SKXPqHMzk6XQUpCheF/4qU8aOhajsyRQFDV1ih/uPIg7YHRtFi
CTq4G+zb43X1T77nJgSOI9pq/TqCwtukZ7u9VLL3JAq3Wdy2moKLvvC8tVmRzkAe
0xQCkRKIjbBG80MSyDX/R4uYgj6ZiNT/Zg6GI6RofgqgpDdssLc0XIRQEotxIZcK
zP3pGJ9FCbMHmMLLyuBd+uCWvVcF2ogYAawufChS/PT61D9rqzPRS5I2uqa3tmIT
44JhJgWhBnFMb7AGQkvNq9KNS9dd3GWc17H/dXa1enoxzWjE0hBdFjxPhUb0W3wi
8o34/m8Fxw==
-----END CERTIFICATE-----`;
const ADIYAMAN_CA = [ADIYAMAN_ARA_SERTIFIKA, ...tls.rootCertificates];

const DOGRUDAN_AGENT = new Agent({ connect: { ca: ADIYAMAN_CA } });
function adiyamanDispatcher(): Agent | ProxyAgent {
  const proxyUrl = proxyUrlForKaynak('yerel_yonetim');
  if (!proxyUrl) return DOGRUDAN_AGENT;
  return new ProxyAgent({ uri: proxyUrl, requestTls: { ca: ADIYAMAN_CA } });
}

async function adiyamanFetchWithBackoff(url: string, init: { method?: string } = {}, retries = 3): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const reqInit: RequestInit = { method: init.method ?? 'GET', headers: HEADERS, signal: AbortSignal.timeout(30000) };
      (reqInit as unknown as { dispatcher: unknown }).dispatcher = adiyamanDispatcher();
      const res = await fetch(url, reqInit);
      if ((res.status >= 500 || res.status === 429) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000 + Math.floor(Math.random() * 700)));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000 + Math.floor(Math.random() * 700)));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('[yerel-adiyaman] fetch başarısız');
}

interface AdiyamanKararSatiri {
  kararTarihi: string;
  kararNumarasi: string | null;
  konusu: string | null;
  mudurlukAdi: string | null;
  ozet: string | null;
  dysId: string | null;
}
interface AdiyamanListeYaniti {
  data: AdiyamanKararSatiri[] | null;
  success: boolean;
  message: string | null;
}

function tarihCikar(kararTarihi: string): string | null {
  const m = kararTarihi.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

async function docEskiMetinCikar(buf: Buffer): Promise<string | null> {
  const tmpPath = path.join(tmpdir(), `adiyaman-karar-${randomUUID()}.doc`);
  await writeFile(tmpPath, buf);
  try {
    const { stdout } = await execFileAsync('catdoc', ['-a', '-w', '-d', 'utf-8', tmpPath], {
      maxBuffer: 20 * 1024 * 1024,
      timeout: 15000,
    });
    const metin = stdout.trim();
    return metin || null;
  } catch (e) {
    logger.error(`[yerel-adiyaman] catdoc çalıştırılamadı/hata verdi: ${(e as Error).message}`);
    return null;
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

export async function fetchAdiyamanKararlar(): Promise<YerelKararSonucu[]> {
  const bugun = new Date().toISOString().slice(0, 10);
  const listeUrl = `${ADIYAMAN_LISTE_URL}?ilkTarih=${BASLANGIC_TARIHI}&sonTarih=${bugun}&kararNo=&Icerik=`;
  const listeRes = await adiyamanFetchWithBackoff(listeUrl);
  if (!listeRes.ok) throw new Error(`[yerel-adiyaman] liste: HTTP ${listeRes.status}`);
  const yanit = await listeRes.json() as AdiyamanListeYaniti;
  if (!yanit.success || !Array.isArray(yanit.data)) {
    throw new Error(`[yerel-adiyaman] liste API'si success=false döndü: ${yanit.message ?? '(mesaj yok)'}`);
  }

  const adaylar = yanit.data.filter((k) => {
    const tarih = tarihCikar(k.kararTarihi);
    return tarih !== null && tarih >= BASLANGIC_TARIHI && !!k.dysId;
  });
  const elenenSayisi = yanit.data.length - adaylar.length;
  if (elenenSayisi > 0) {
    logger.warn(`[yerel-adiyaman] ${elenenSayisi}/${yanit.data.length} karar belgesiz (dysId yok) ya da kapsam dışı tarihli olduğu için atlandı.`);
  }

  const sonuc: YerelKararSonucu[] = [];
  let kanaryaBasarili = false;
  let kanaryaBasarisizSayisi = 0;

  for (const k of adaylar) {
    const tarih = tarihCikar(k.kararTarihi)!;
    try {
      const dres = await adiyamanFetchWithBackoff(
        `${ADIYAMAN_INDIR_URL}?uuid=${encodeURIComponent(k.dysId!)}`,
        { method: 'POST' },
      );
      if (!dres.ok) {
        logger.error(`[yerel-adiyaman] belge indirilemedi: HTTP ${dres.status} — karar no ${k.kararNumarasi}, dysId ${k.dysId}`);
        await new Promise((r) => setTimeout(r, INDIRME_NEZAKET_MS));
        continue;
      }
      const buf = Buffer.from(await dres.arrayBuffer());
      const metin = await docEskiMetinCikar(buf);

      if (metin === null) {
        if (!kanaryaBasarili) {
          kanaryaBasarisizSayisi++;
          if (kanaryaBasarisizSayisi >= 2) {
            logger.warn(`[yerel-adiyaman] ilk ${kanaryaBasarisizSayisi} denemede de .doc metni çıkarılamadı (catdoc muhtemelen kurulu değil) — GERÇEK DUVAR kabul edilip döngü erken durduruldu. Kararların KENDİSİ gerçek (${adaylar.length} adet dysId'li aday tespit edildi), yalnız bu ortamda metin çıkarma aracı çalışmıyor.`);
            break;
          }
        } else {
          logger.error(`[yerel-adiyaman] .doc metni çıkarılamadı, atlanıyor: karar no ${k.kararNumarasi}, dysId ${k.dysId}`);
        }
        await new Promise((r) => setTimeout(r, INDIRME_NEZAKET_MS));
        continue;
      }
      kanaryaBasarili = true;

      if (metin.length < ASGARI_KARAR_UZUNLUK) {
        await new Promise((r) => setTimeout(r, INDIRME_NEZAKET_MS));
        continue;
      }

      const konu = k.ozet?.trim() || k.konusu?.trim() || null;
      sonuc.push({
        belediye: 'Adıyaman',
        karar_no: k.kararNumarasi?.trim() || null,
        tarih,
        konu,
        metin,
        oylama_sonucu: oylamaSonucuCikar(metin),
        kaynak_url: `${ADIYAMAN_INDIR_URL}?uuid=${encodeURIComponent(k.dysId!)}`,
      });
    } catch (e) {
      logger.error(`[yerel-adiyaman] karar no ${k.kararNumarasi} (dysId ${k.dysId}): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, INDIRME_NEZAKET_MS));
  }

  return kararNoSiraDoldur(sonuc);
}
