import {
  HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar, gunAy,
  fetchWithBackoff, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { proxyUrlForKaynak } from '../../lib/http.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';
import * as cheerio from 'cheerio';
import { Agent, ProxyAgent } from 'undici';
import tls from 'node:tls';

const logger = getLogger('PoliticalInsight.YerelYonetim.Kirikkale');

const KIRIKKALE_UYELER_URL = 'https://www.kirikkale.bel.tr/?sayfa=meclis';
const KIRIKKALE_API_BASE = 'https://ebelediyem.kirikkale.bel.tr/api/';
const KIRIKKALE_KARARLAR_SAYFA_URL = 'https://ebelediyem.kirikkale.bel.tr/bilgilendirmeler/meclis-kararlari';

const KIRIKKALE_ARA_SERTIFIKA = `-----BEGIN CERTIFICATE-----
MIIFjTCCA3WgAwIBAgIRAIN9TriekS/nLK07x2kt3CAwDQYJKoZIhvcNAQELBQAw
TDEgMB4GA1UECxMXR2xvYmFsU2lnbiBSb290IENBIC0gUjYxEzARBgNVBAoTCkds
b2JhbFNpZ24xEzARBgNVBAMTCkdsb2JhbFNpZ24wHhcNMjUwNTIxMDIzNjUyWhcN
MjcwNTIxMDAwMDAwWjBVMQswCQYDVQQGEwJCRTEZMBcGA1UEChMQR2xvYmFsU2ln
biBudi1zYTErMCkGA1UEAxMiR2xvYmFsU2lnbiBHQ0MgUjYgQWxwaGFTU0wgQ0Eg
MjAyNTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAJ/oiu0Bviq52UUE
ADbFWmgu3rC7KDSMoorLN1Wd03McG3Z1aP71DlPCE33838r72Dfuj5M9LXfiQLJp
Au6MwNExmKOzothw4x0zGf5oBYyrCMGm3fBpLPafwYQ3MchBOWMTbf83rKUPLH48
KCJ0MnU8GUl8oA/J81wIvbbKPuNrFf6hvJDccjzc4NyxLz3A89zjV2g5whCg5O0u
9YX4Zxk9JHuc/LvllOJO4waAYLjbWBJkz3rV3ts1SmSYnJqmyRTIjXwQgRvhEYqt
DbRskt0W7M6cPwCze3GTBN2UHNpHkMs3YmVxku68I0aOQn5+uz//fDROP3z1Z/7I
APteRtECAwEAAaOCAV8wggFbMA4GA1UdDwEB/wQEAwIBhjAdBgNVHSUEFjAUBggr
BgEFBQcDAQYIKwYBBQUHAwIwEgYDVR0TAQH/BAgwBgEB/wIBADAdBgNVHQ4EFgQU
xbSTj28r3B5Iv7cQMIXO0bK7SC0wHwYDVR0jBBgwFoAUrmwFo5MT4qLn4tcc1sfw
f8hnU6AwewYIKwYBBQUHAQEEbzBtMC4GCCsGAQUFBzABhiJodHRwOi8vb2NzcDIu
Z2xvYmFsc2lnbi5jb20vcm9vdHI2MDsGCCsGAQUFBzAChi9odHRwOi8vc2VjdXJl
Lmdsb2JhbHNpZ24uY29tL2NhY2VydC9yb290LXI2LmNydDA2BgNVHR8ELzAtMCug
KaAnhiVodHRwOi8vY3JsLmdsb2JhbHNpZ24uY29tL3Jvb3QtcjYuY3JsMCEGA1Ud
IAQaMBgwCAYGZ4EMAQIBMAwGCisGAQQBoDIKAQMwDQYJKoZIhvcNAQELBQADggIB
AB/uvBuZf4CiuSahwiXn4geF52roAH+6jxsEPTXTfb7bbeMDXsYgRRsOTNA70ruZ
Tnz5DfFMuBhNoFhIFb0qR1izdy6VkdKOqFPNF2dOFI1EcnY9l2ory9mrzHqVbrL4
vzUd17FLUVyjTVU7PAv4nxyhnO1GTeT83YlrdRF31NyR6bvZVTEERHmpbWSgeveJ
LRtaMzlGWiLZ8IwkH7o6GH3jp/KPtDW4Npu8w64HrRZdN2pqQhi7+YKwfHM7H+2U
dM1BGN0sjOWMVbMSB9MtCsleS2Mb7TRZEbOHxECJLLIluQypZr7Pol3+hAqrhyKI
k+6y+Da0NeDuWxW59Ku4NvClqW1UFX1SpfNGhzVfp/CH+vPM1tySomx2jE0EnYZu
GwVucXPBsp5nUWqUV9+143glVuS7GTg9hFPjNBInn17HbCoIIQIOzj5Vd9bK3A9U
GxXNpwenDHEalCsD/4eQYDHPhFE7sNe0D/OXu+FAM02VZkARx37Jp4bDdujvgL9P
vZPR3wThvDN1CTU8Bc3xea3yKFAraKcPZLkhReQUAm2VpR+HSJRPlUpYizlF9WkL
h3KcAVCBJWvnOkVwxyU5QJMcnwW95JlOtx+9100GL99jHE5rs3gXp7F4bg8H01QT
9jVOhBBmQ7nQoXuwI0tqal2QUqZz3eeu62CU7xBwtfYR
-----END CERTIFICATE-----`;
const KIRIKKALE_CA = [KIRIKKALE_ARA_SERTIFIKA, ...tls.rootCertificates];

const DOGRUDAN_AGENT = new Agent({ connect: { ca: KIRIKKALE_CA } });
function kirikkaleDispatcher(): Agent | ProxyAgent {
  const proxyUrl = proxyUrlForKaynak('yerel_yonetim');
  if (!proxyUrl) return DOGRUDAN_AGENT;
  return new ProxyAgent({ uri: proxyUrl, requestTls: { ca: KIRIKKALE_CA } });
}

async function kirikkaleFetchWithBackoff(url: string, retries = 3): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const init: RequestInit = { headers: { ...HEADERS, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) };
      (init as unknown as { dispatcher: unknown }).dispatcher = kirikkaleDispatcher();
      const res = await fetch(url, init);
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
  throw lastErr instanceof Error ? lastErr : new Error('[yerel-kirikkale] fetch başarısız');
}

interface KirikkaleKararApi {
  kararTarihi: string;
  kararNumarasi: string;
  konusu: string | null;
  ozet: string | null;
}

function kararlariAyristir(kararlar: KirikkaleKararApi[]): YerelKararSonucu[] {
  const sonuc: YerelKararSonucu[] = [];
  for (const k of kararlar) {
    const tarihM = k.kararTarihi?.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
    if (!tarihM) continue;
    const tarih = `${tarihM[3]}-${tarihM[2]}-${tarihM[1]}`;
    if (tarih < BASLANGIC_TARIHI) continue;
    const metin = (k.ozet ?? '').replace(/\s+/g, ' ').trim();
    if (metin.length < ASGARI_KARAR_UZUNLUK) continue;
    const kararNo = k.kararNumarasi ? `${tarihM[3]}/${k.kararNumarasi}` : null;
    sonuc.push({
      belediye: 'Kırıkkale',
      karar_no: kararNo,
      tarih,
      konu: k.konusu?.trim() || null,
      metin,
      oylama_sonucu: oylamaSonucuCikar(metin),
      kaynak_url: KIRIKKALE_KARARLAR_SAYFA_URL,
    });
  }
  return sonuc;
}

export async function fetchKirikkaleKararlar(): Promise<YerelKararSonucu[]> {
  const sonTarih = gunAy(new Date());
  const url = `${KIRIKKALE_API_BASE}MeclisKararlariListe?ilkTarih=${BASLANGIC_TARIHI}&sonTarih=${sonTarih}&kararNo=&Icerik=`;
  try {
    const res = await kirikkaleFetchWithBackoff(url);
    if (!res.ok) throw new Error(`[yerel-kirikkale] liste: HTTP ${res.status}`);
    const gövde = (await res.json()) as { data?: KirikkaleKararApi[] };
    const kararlar = Array.isArray(gövde.data) ? gövde.data : [];
    return kararlariAyristir(kararlar);
  } catch (e) {
    logger.error(`[yerel-kirikkale] ${(e as Error).message}`);
    throw e;
  }
}

export async function fetchKirikkaleUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(KIRIKKALE_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-kirikkale-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.council-member').each((_, kart) => {
    const ad = $(kart).find('strong').first().text().replace(/\s+/g, ' ').trim();
    const hamParti = $(kart).find('span').first().text().replace(/\s+/g, ' ').trim();
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Kırıkkale', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
