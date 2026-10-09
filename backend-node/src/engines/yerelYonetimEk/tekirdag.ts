import * as cheerio from 'cheerio';
import { Agent, ProxyAgent } from 'undici';
import tls from 'node:tls';
import { proxyUrlForKaynak } from '../../lib/http.js';
import {
  HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Tekirdag');

const TEKIRDAG_DONEMLER_URL = 'https://www.tekirdag.bel.tr/meclis_donemleri';
const TEKIRDAG_UYELER_URL = 'https://www.tekirdag.bel.tr/meclis_uye';

const TEKIRDAG_ARA_SERTIFIKA = `-----BEGIN CERTIFICATE-----
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
const TEKIRDAG_CA = [TEKIRDAG_ARA_SERTIFIKA, ...tls.rootCertificates];

const DOGRUDAN_AGENT = new Agent({ connect: { ca: TEKIRDAG_CA } });
function tekirdagDispatcher(): Agent | ProxyAgent {
  const proxyUrl = proxyUrlForKaynak('yerel_yonetim');
  if (!proxyUrl) return DOGRUDAN_AGENT;
  return new ProxyAgent({ uri: proxyUrl, requestTls: { ca: TEKIRDAG_CA } });
}

async function tekirdagFetchWithBackoff(url: string, retries = 3): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const init: RequestInit = { headers: HEADERS, signal: AbortSignal.timeout(30000) };
      (init as unknown as { dispatcher: unknown }).dispatcher = tekirdagDispatcher();
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
  throw lastErr instanceof Error ? lastErr : new Error('[yerel-tekirdag] fetch başarısız');
}

interface TekirdagDonem { id: string; baslik: string }

function donemleriCikar(html: string): TekirdagDonem[] {
  const $ = cheerio.load(html);
  const gorulen = new Map<string, string>();
  $('a[href*="meclis_karar_ozetleri/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/meclis_karar_ozetleri\/(\d+)/);
    if (!m) return;
    const baslik = $(el).text().replace(/\s+/g, ' ').trim();
    if (!gorulen.has(m[1])) gorulen.set(m[1], baslik);
  });
  return [...gorulen.entries()].map(([id, baslik]) => ({ id, baslik }));
}

function ozetKararlariCikar(html: string, ozetUrl: string): YerelKararSonucu[] {
  const $ = cheerio.load(html);
  const sonuc: YerelKararSonucu[] = [];
  $('#ordered-list__dropdown > li').each((_, li) => {
    const desc = $(li).find('.page-content__description');
    const tam = desc.text().replace(/\s+/g, ' ').trim();
    const tarihM = tam.match(/Birleşim Tarihi\s*:\s*(\d{2})\.(\d{2})\.(\d{4})/);
    const kararNoM = tam.match(/Karar No\s*:\s*(\d+)/);
    const konuM = tam.match(/Konu\s*:\s*(.*?)\s*Karar Özeti/);
    const oi = tam.indexOf('Karar Özeti');
    if (!tarihM || !kararNoM || oi === -1) return;
    const tarih = `${tarihM[3]}-${tarihM[2]}-${tarihM[1]}`;
    if (tarih < BASLANGIC_TARIHI) return;
    const metin = tam.slice(oi + 'Karar Özeti;'.length).trim();
    if (metin.length < ASGARI_KARAR_UZUNLUK) return;
    const kararNo = `${tarihM[3]}/${kararNoM[1]}`;
    const pdfHref = desc.find('a[href*="karar_metin_goruntule"]').attr('href') || null;
    sonuc.push({
      belediye: 'Tekirdağ',
      karar_no: kararNo,
      tarih,
      konu: konuM ? konuM[1].trim() || null : null,
      metin,
      oylama_sonucu: oylamaSonucuCikar(metin),
      kaynak_url: pdfHref || ozetUrl,
    });
  });
  return sonuc;
}

export async function fetchTekirdagKararlar(): Promise<YerelKararSonucu[]> {
  const listRes = await tekirdagFetchWithBackoff(TEKIRDAG_DONEMLER_URL);
  if (!listRes.ok) throw new Error(`[yerel-tekirdag] dönem listesi: HTTP ${listRes.status}`);
  const tumDonemler = donemleriCikar(await listRes.text());

  const baslangicYil = parseInt(BASLANGIC_TARIHI.slice(0, 4), 10);
  const donemler = tumDonemler.filter((d) => {
    const ym = d.baslik.match(/^(\d{4})\s*Yılı/);
    return !ym || parseInt(ym[1], 10) >= baslangicYil;
  });

  const sonuc: YerelKararSonucu[] = [];
  const gorulenKarar = new Set<string>();
  for (const { id, baslik } of donemler) {
    const ozetUrl = `${TEKIRDAG_DONEMLER_URL}/meclis_karar_ozetleri/${id}`;
    try {
      const res = await tekirdagFetchWithBackoff(ozetUrl);
      if (!res.ok) { logger.error(`[yerel-tekirdag] dönem özeti (${baslik}): HTTP ${res.status}`); continue; }
      const kararlar = ozetKararlariCikar(await res.text(), ozetUrl);
      for (const k of kararlar) {
        const anahtar = `${k.karar_no}|${k.tarih}`;
        if (gorulenKarar.has(anahtar)) continue;
        gorulenKarar.add(anahtar);
        sonuc.push(k);
      }
    } catch (e) {
      logger.error(`[yerel-tekirdag] (${baslik}): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

const TEKIRDAG_PARTI_LOGO: Record<string, string> = {
  chp: 'CHP', akp: 'AK PARTİ', mhp: 'MHP', iyi_parti: 'İYİ PARTİ', bagimsiz: 'BAĞIMSIZ',
};

export async function fetchTekirdagUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await tekirdagFetchWithBackoff(TEKIRDAG_UYELER_URL);
  if (!res.ok) throw new Error(`[yerel-tekirdag-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.personnel-card').each((_, kart) => {
    const baslik = $(kart).find('.title');
    const ad = baslik.clone().children().remove().end().text().replace(/\s+/g, ' ').trim();
    const imgSrc = baslik.find('img').attr('src');
    let hamParti: string | null = null;
    if (imgSrc) {
      const m = imgSrc.match(/([a-z0-9_]+)\.(?:png|jpe?g)(?:$|\?)/i);
      hamParti = (m && TEKIRDAG_PARTI_LOGO[m[1].toLowerCase()]) || null;
    } else {
      const spanTxt = baslik.find('span').first().text().replace(/\s+/g, ' ').trim();
      if (spanTxt) hamParti = spanTxt;
    }
    if (!ad || !hamParti) return;
    const ilce = $(kart).find('.personnel-footer .text').text().replace(/\s+/g, ' ').trim() || null;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Tekirdağ', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce });
  });
  return sonuc;
}
