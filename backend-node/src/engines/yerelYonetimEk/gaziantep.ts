import * as cheerio from 'cheerio';
import { Agent, ProxyAgent } from 'undici';
import tls from 'node:tls';
import { proxyUrlForKaynak } from '../../lib/http.js';
import {
  HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar, pdfMetinCikar,
  type YerelKararSonucu,
} from '../yerelYonetimOrtak.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Gaziantep');

const GAZIANTEP_KARARLAR_URL = 'https://www.gaziantep.bel.tr/tr/meclis-kararlari';

const GAZIANTEP_ARA_SERTIFIKA = `-----BEGIN CERTIFICATE-----
MIIGTDCCBDSgAwIBAgIQOXpmzCdWNi4NqofKbqvjsTANBgkqhkiG9w0BAQwFADBf
MQswCQYDVQQGEwJHQjEYMBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMTYwNAYDVQQD
Ey1TZWN0aWdvIFB1YmxpYyBTZXJ2ZXIgQXV0aGVudGljYXRpb24gUm9vdCBSNDYw
HhcNMjEwMzIyMDAwMDAwWhcNMzYwMzIxMjM1OTU5WjBgMQswCQYDVQQGEwJHQjEY
MBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMTcwNQYDVQQDEy5TZWN0aWdvIFB1Ymxp
YyBTZXJ2ZXIgQXV0aGVudGljYXRpb24gQ0EgRFYgUjM2MIIBojANBgkqhkiG9w0B
AQEFAAOCAY8AMIIBigKCAYEAljZf2HIz7+SPUPQCQObZYcrxLTHYdf1ZtMRe7Yeq
RPSwygz16qJ9cAWtWNTcuICc++p8Dct7zNGxCpqmEtqifO7NvuB5dEVexXn9RFFH
12Hm+NtPRQgXIFjx6MSJcNWuVO3XGE57L1mHlcQYj+g4hny90aFh2SCZCDEVkAja
EMMfYPKuCjHuuF+bzHFb/9gV8P9+ekcHENF2nR1efGWSKwnfG5RawlkaQDpRtZTm
M64TIsv/r7cyFO4nSjs1jLdXYdz5q3a4L0NoabZfbdxVb+CUEHfB0bpulZQtH1Rv
38e/lIdP7OTTIlZh6OYL6NhxP8So0/sht/4J9mqIGxRFc0/pC8suja+wcIUna0HB
pXKfXTKpzgis+zmXDL06ASJf5E4A2/m+Hp6b84sfPAwQ766rI65mh50S0Di9E3Pn
2WcaJc+PILsBmYpgtmgWTR9eV9otfKRUBfzHUHcVgarub/XluEpRlTtZudU5xbFN
xx/DgMrXLUAPaI60fZ6wA+PTAgMBAAGjggGBMIIBfTAfBgNVHSMEGDAWgBRWc1hk
lfmSGrASKgRieaFAFYghSTAdBgNVHQ4EFgQUaMASFhgOr872h6YyV6NGUV3LBycw
DgYDVR0PAQH/BAQDAgGGMBIGA1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0lBBYwFAYI
KwYBBQUHAwEGCCsGAQUFBwMCMBsGA1UdIAQUMBIwBgYEVR0gADAIBgZngQwBAgEw
VAYDVR0fBE0wSzBJoEegRYZDaHR0cDovL2NybC5zZWN0aWdvLmNvbS9TZWN0aWdv
UHVibGljU2VydmVyQXV0aGVudGljYXRpb25Sb290UjQ2LmNybDCBhAYIKwYBBQUH
AQEEeDB2ME8GCCsGAQUFBzAChkNodHRwOi8vY3J0LnNlY3RpZ28uY29tL1NlY3Rp
Z29QdWJsaWNTZXJ2ZXJBdXRoZW50aWNhdGlvblJvb3RSNDYucDdjMCMGCCsGAQUF
BzABhhdodHRwOi8vb2NzcC5zZWN0aWdvLmNvbTANBgkqhkiG9w0BAQwFAAOCAgEA
YtOC9Fy+TqECFw40IospI92kLGgoSZGPOSQXMBqmsGWZUQ7rux7cj1du6d9rD6C8
ze1B2eQjkrGkIL/OF1s7vSmgYVafsRoZd/IHUrkoQvX8FZwUsmPu7amgBfaY3g+d
q1x0jNGKb6I6Bzdl6LgMD9qxp+3i7GQOnd9J8LFSietY6Z4jUBzVoOoz8iAU84OF
h2HhAuiPw1ai0VnY38RTI+8kepGWVfGxfBWzwH9uIjeooIeaosVFvE8cmYUB4TSH
5dUyD0jHct2+8ceKEtIoFU/FfHq/mDaVnvcDCZXtIgitdMFQdMZaVehmObyhRdDD
4NQCs0gaI9AAgFj4L9QtkARzhQLNyRf87Kln+YU0lgCGr9HLg3rGO8q+Y4ppLsOd
unQZ6ZxPNGIfOApbPVf5hCe58EZwiWdHIMn9lPP6+F404y8NNugbQixBber+x536
WrZhFZLjEkhp7fFXf9r32rNPfb74X/U90Bdy4lzp3+X1ukh1BuMxA/EEhDoTOS3l
7ABvc7BYSQubQ2490OcdkIzUh3ZwDrakMVrbaTxUM2p24N6dB+ns2zptWCva6jzW
r8IWKIMxzxLPv5Kt3ePKcUdvkBU/smqujSczTzzSjIoR5QqQA6lN1ZRSnuHIWCvh
JEltkYnTAH41QJ6SAWO66GrrUESwN/cgZzL4JLEqz1Y=
-----END CERTIFICATE-----`;
const GAZIANTEP_CA = [GAZIANTEP_ARA_SERTIFIKA, ...tls.rootCertificates];

const DOGRUDAN_AGENT = new Agent({ connect: { ca: GAZIANTEP_CA } });
function gaziantepDispatcher(): Agent | ProxyAgent {
  const proxyUrl = proxyUrlForKaynak('yerel_yonetim');
  if (!proxyUrl) return DOGRUDAN_AGENT;
  return new ProxyAgent({ uri: proxyUrl, requestTls: { ca: GAZIANTEP_CA } });
}

async function gaziantepFetchWithBackoff(url: string, retries = 3): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const init: RequestInit = { headers: HEADERS, signal: AbortSignal.timeout(30000) };
      (init as unknown as { dispatcher: unknown }).dispatcher = gaziantepDispatcher();
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
  throw lastErr instanceof Error ? lastErr : new Error('[yerel-gaziantep] fetch başarısız');
}

const SATIR_BASLANGIC_RE = /(?:Büyükşehir\s+Belediyesi\s+)?(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2,4})(?!\d)/g;
const ANTET_KIRP_RE = /\s*GAZİANTEP\s+BÜYÜKŞEHİR\s+BELEDİYESİ[\s\S]*$/;

function belgeKararlariCikar(metin: string, kaynakUrl: string): YerelKararSonucu[] {
  const sonuc: YerelKararSonucu[] = [];
  const eslesmeler = [...metin.matchAll(SATIR_BASLANGIC_RE)];
  for (let i = 0; i < eslesmeler.length; i++) {
    const m = eslesmeler[i];
    const [gun, ay, yil, kararNoHam] = [m[1], m[2], m[3], m[4]];
    const tarih = `${yil}-${ay}-${gun}`;
    if (tarih < BASLANGIC_TARIHI) continue;
    const basla = m.index + m[0].length;
    const bitis = i + 1 < eslesmeler.length ? eslesmeler[i + 1].index : metin.length;
    let govde = metin.slice(basla, bitis).replace(/\s+/g, ' ').trim();
    govde = govde.replace(ANTET_KIRP_RE, '').trim();
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({
      belediye: 'Gaziantep',
      karar_no: `${yil}/${kararNoHam}`,
      tarih,
      konu: null,
      metin: govde,
      oylama_sonucu: oylamaSonucuCikar(govde),
      kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

function belgeBaglantilariCikar(html: string): string[] {
  const $ = cheerio.load(html);
  const gorulen = new Set<string>();
  $('a[href*="dosya.gaziantep.bel.tr"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) gorulen.add(href);
  });
  return [...gorulen];
}

export async function fetchGaziantepKararlar(): Promise<YerelKararSonucu[]> {
  const listRes = await gaziantepFetchWithBackoff(GAZIANTEP_KARARLAR_URL);
  if (!listRes.ok) throw new Error(`[yerel-gaziantep] karar listesi: HTTP ${listRes.status}`);
  const belgeler = belgeBaglantilariCikar(await listRes.text());

  const sonuc: YerelKararSonucu[] = [];
  const gorulenKarar = new Set<string>();
  for (const belgeUrl of belgeler) {
    try {
      const res = await gaziantepFetchWithBackoff(belgeUrl);
      if (!res.ok) { logger.error(`[yerel-gaziantep] belge (${belgeUrl}): HTTP ${res.status}`); continue; }
      const buf = new Uint8Array(await res.arrayBuffer());
      let metin: string;
      try {
        metin = await pdfMetinCikar(buf);
      } catch (e) {
        logger.error(`[yerel-gaziantep] PDF ayrıştırma (${belgeUrl}): ${(e as Error).message}`);
        continue;
      }
      if (metin.replace(/\s+/g, '').length < ASGARI_KARAR_UZUNLUK) {
        logger.error(`[yerel-gaziantep] metin katmanı yok/çok kısa (muhtemelen taranmış görüntü), OCR yapılmadan atlanıyor: ${belgeUrl}`);
        continue;
      }
      const kararlar = belgeKararlariCikar(metin, belgeUrl);
      for (const k of kararlar) {
        const anahtar = `${k.karar_no}|${k.tarih}`;
        if (gorulenKarar.has(anahtar)) continue;
        gorulenKarar.add(anahtar);
        sonuc.push(k);
      }
    } catch (e) {
      logger.error(`[yerel-gaziantep] (${belgeUrl}): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

