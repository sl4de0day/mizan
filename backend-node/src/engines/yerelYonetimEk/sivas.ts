import * as cheerio from 'cheerio';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { Agent, ProxyAgent } from 'undici';
import tls from 'node:tls';
import { proxyUrlForKaynak } from '../../lib/http.js';
import {
  HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Sivas');

const SIVAS_BASE = 'https://www.sivas.bel.tr';
const SIVAS_KARARLAR_URL = `${SIVAS_BASE}/meclis-kararlari`;
const SIVAS_UYELER_URL = `${SIVAS_BASE}/meclis-uyeleri`;
const NEZAKET_MS = 180;

const SIVAS_ARA_SERTIFIKA = `-----BEGIN CERTIFICATE-----
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
const SIVAS_CA = [SIVAS_ARA_SERTIFIKA, ...tls.rootCertificates];

const DOGRUDAN_AGENT = new Agent({ connect: { ca: SIVAS_CA } });
function sivasDispatcher(): Agent | ProxyAgent {
  const proxyUrl = proxyUrlForKaynak('yerel_yonetim');
  if (!proxyUrl) return DOGRUDAN_AGENT;
  return new ProxyAgent({ uri: proxyUrl, requestTls: { ca: SIVAS_CA } });
}

async function sivasFetchWithBackoff(url: string, retries = 3): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const init: RequestInit = { headers: HEADERS, signal: AbortSignal.timeout(45000) };
      (init as unknown as { dispatcher: unknown }).dispatcher = sivasDispatcher();
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
  throw lastErr instanceof Error ? lastErr : new Error('[yerel-sivas] fetch başarısız');
}

function bekle(): Promise<void> {
  return new Promise((r) => setTimeout(r, NEZAKET_MS));
}

const AY_UPPER: Record<string, string> = {
  OCAK: '01', ŞUBAT: '02', MART: '03', NİSAN: '04', MAYIS: '05', HAZİRAN: '06',
  TEMMUZ: '07', AĞUSTOS: '08', EYLÜL: '09', EKİM: '10', KASIM: '11', ARALIK: '12',
};

function pdfBaslikTarihiCikar(baslik: string): string | null {
  const rakamli = baslik.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (rakamli) return `${rakamli[3]}-${rakamli[2]}-${rakamli[1]}`;
  const ayAdli = baslik.match(/(\d{1,2})\s+([A-ZÇĞİÖŞÜ]+)\s+(\d{4})/);
  if (ayAdli) {
    const ay = AY_UPPER[ayAdli[2]];
    if (ay) return `${ayAdli[3]}-${ay}-${ayAdli[1].padStart(2, '0')}`;
  }
  return null;
}

interface SivasOturum { url: string; baslik: string }

function indexOturumlariCikar(html: string): SivasOturum[] {
  const $ = cheerio.load(html);
  const esikYil = parseInt(BASLANGIC_TARIHI.slice(0, 4), 10);
  const gorulen = new Set<string>();
  const sonuc: SivasOturum[] = [];
  $('a[href*="/meclis-kararlari/"]').each((_, el) => {
    const href = $(el).attr('href');
    const baslik = $(el).text().replace(/\s+/g, ' ').trim();
    if (!href || !baslik || gorulen.has(href)) return;
    const yilM = baslik.match(/\b(20\d{2})\b/);
    const yil = yilM ? parseInt(yilM[1], 10) : null;
    if (yil !== null && yil < esikYil) return;
    gorulen.add(href);
    sonuc.push({ url: href, baslik });
  });
  return sonuc;
}

interface SivasBelge { pdfUrl: string; tarih: string }

function belgeleriCikar(html: string): SivasBelge[] {
  const $ = cheerio.load(html);
  const sonuc: SivasBelge[] = [];
  $('a[href$=".pdf"]').each((_, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!href || !text) return;
    if (!text.includes('KARAR ÖZET')) return;
    const tarih = pdfBaslikTarihiCikar(text);
    if (!tarih) { logger.error(`[yerel-sivas] belge tarihi parse edilemedi: "${text}"`); return; }
    if (tarih < BASLANGIC_TARIHI) return;
    sonuc.push({ pdfUrl: href.startsWith('http') ? href : `${SIVAS_BASE}${href}`, tarih });
  });
  return sonuc;
}

interface SivasMetinOgesi { str: string; x: number; w: number; y: number; page: number }

async function sivasMetinOgeleriGetir(data: Uint8Array): Promise<SivasMetinOgesi[]> {
  const doc = await getDocument({ data, verbosity: 0 }).promise;
  const ogeler: SivasMetinOgesi[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await doc.getPage(p).then((pg) => pg.getTextContent());
    for (const it of tc.items as { str: string; transform: number[]; width: number }[]) {
      if (it.str.length === 0) continue;
      const y = it.transform[5];
      if (y < 100 && /^\d{1,3}\/\d{1,3}$/.test(it.str.trim())) continue;
      ogeler.push({ str: it.str, x: it.transform[4], w: it.width, y, page: p });
    }
  }
  return ogeler;
}

const ALAN_BOSLUK_ESIGI = 15;

function ilkAlaniCikar(satirOgeleri: SivasMetinOgesi[]): { metin: string; sonrakiIndex: number } {
  const siraliy = satirOgeleri.slice().sort((a, b) => a.x - b.x);
  let fieldEnd = siraliy[0]!.x;
  let i = 0;
  let metin = '';
  for (; i < siraliy.length; i++) {
    const it = siraliy[i]!;
    const gap = it.x - fieldEnd;
    const genisBosluk = it.str.trim() === '' && it.w > ALAN_BOSLUK_ESIGI;
    if (i > 0 && (gap > ALAN_BOSLUK_ESIGI || genisBosluk)) break;
    metin += it.str;
    fieldEnd = it.x + it.w;
  }
  return { metin, sonrakiIndex: i };
}

interface SivasKararAday { n: number; x: number; y: number; page: number; itemIndex: number }

function kararSinirlariniBul(ogeler: SivasMetinOgesi[]): SivasKararAday[] {
  const satirlar = new Map<string, SivasMetinOgesi[]>();
  const satirIndeksleri = new Map<string, number[]>();
  ogeler.forEach((it, idx) => {
    const k = `${it.page}|${it.y.toFixed(1)}`;
    if (!satirlar.has(k)) { satirlar.set(k, []); satirIndeksleri.set(k, []); }
    satirlar.get(k)!.push(it);
    satirIndeksleri.get(k)!.push(idx);
  });

  const adaylar: SivasKararAday[] = [];
  for (const [k, satirOgeleri] of satirlar) {
    const { metin, sonrakiIndex } = ilkAlaniCikar(satirOgeleri);
    if (sonrakiIndex >= satirOgeleri.length) continue;
    const digits = metin.trim();
    if (!/^\d{1,5}$/.test(digits)) continue;
    const siraliy = satirOgeleri.slice().sort((a, b) => a.x - b.x)[0]!;
    const idxListesi = satirIndeksleri.get(k)!;
    const ilkOgeGlobalIdx = idxListesi[satirOgeleri.indexOf(siraliy)]!;
    adaylar.push({ n: parseInt(digits, 10), x: siraliy.x, y: siraliy.y, page: siraliy.page, itemIndex: ilkOgeGlobalIdx });
  }
  adaylar.sort((a, b) => (a.page - b.page) || (b.y - a.y));

  const sayfaBazinda = new Map<number, SivasKararAday[]>();
  for (const a of adaylar) { if (!sayfaBazinda.has(a.page)) sayfaBazinda.set(a.page, []); sayfaBazinda.get(a.page)!.push(a); }
  const suzulmus: SivasKararAday[] = [];
  for (const [, sayfaAdaylari] of sayfaBazinda) {
    const xSayaci = new Map<number, number>();
    for (const a of sayfaAdaylari) { const anahtar = Math.round(a.x); xSayaci.set(anahtar, (xSayaci.get(anahtar) ?? 0) + 1); }
    let modX: number | null = null, modSayisi = 0;
    for (const [x, sayi] of xSayaci) if (sayi > modSayisi) { modSayisi = sayi; modX = x; }
    for (const a of sayfaAdaylari) if (modX !== null && Math.abs(a.x - modX) <= 3) suzulmus.push(a);
  }
  suzulmus.sort((a, b) => (a.page - b.page) || (b.y - a.y));

  const kabul: SivasKararAday[] = [];
  let sonKabul = -Infinity;
  for (const a of suzulmus) {
    if (a.n > sonKabul) { kabul.push(a); sonKabul = a.n; }
  }
  return kabul;
}

async function sivasPdfKararlariCikar(pdfUrl: string, tarih: string): Promise<Omit<YerelKararSonucu, 'belediye'>[]> {
  const res = await sivasFetchWithBackoff(pdfUrl);
  if (!res.ok) { logger.error(`[yerel-sivas] PDF indirilemedi (${pdfUrl}): HTTP ${res.status}`); return []; }
  const data = new Uint8Array(await res.arrayBuffer());
  const ogeler = await sivasMetinOgeleriGetir(data);
  if (!ogeler.length) return [];
  const sinirlar = kararSinirlariniBul(ogeler);
  if (!sinirlar.length) { logger.error(`[yerel-sivas] karar sınırı bulunamadı (${pdfUrl}) — format değişmiş olabilir`); return []; }

  const yil = tarih.slice(0, 4);
  const sonuc: Omit<YerelKararSonucu, 'belediye'>[] = [];
  for (let i = 0; i < sinirlar.length; i++) {
    const baslangic = sinirlar[i]!.itemIndex;
    const bitis = i + 1 < sinirlar.length ? sinirlar[i + 1]!.itemIndex : ogeler.length;
    const satirKey = `${sinirlar[i]!.page}|${sinirlar[i]!.y.toFixed(1)}`;
    const satirOgeleri: SivasMetinOgesi[] = [];
    for (let idx = baslangic; idx < bitis; idx++) {
      const it = ogeler[idx]!;
      if (`${it.page}|${it.y.toFixed(1)}` !== satirKey) break;
      satirOgeleri.push(it);
    }
    const { sonrakiIndex } = ilkAlaniCikar(satirOgeleri);
    const govdeBaslangic = baslangic + sonrakiIndex;
    const metin = ogeler.slice(govdeBaslangic, bitis).map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
    if (metin.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({
      karar_no: `${yil}/${sinirlar[i]!.n}`,
      tarih,
      konu: null,
      metin,
      oylama_sonucu: oylamaSonucuCikar(metin),
      kaynak_url: pdfUrl,
    });
  }
  return sonuc;
}

export async function fetchSivasKararlar(): Promise<YerelKararSonucu[]> {
  const indexRes = await sivasFetchWithBackoff(SIVAS_KARARLAR_URL);
  if (!indexRes.ok) throw new Error(`[yerel-sivas] ana sayfa: HTTP ${indexRes.status}`);
  const oturumlar = indexOturumlariCikar(await indexRes.text());

  const sonuc: YerelKararSonucu[] = [];
  for (const oturum of oturumlar) {
    await bekle();
    let oturumHtml: string;
    try {
      const ores = await sivasFetchWithBackoff(oturum.url);
      if (!ores.ok) { logger.error(`[yerel-sivas] oturum (${oturum.baslik}): HTTP ${ores.status}`); continue; }
      oturumHtml = await ores.text();
    } catch (e) { logger.error(`[yerel-sivas] oturum (${oturum.baslik}): ${(e as Error).message}`); continue; }

    const belgeler = belgeleriCikar(oturumHtml);
    for (const belge of belgeler) {
      await bekle();
      try {
        const kararlar = await sivasPdfKararlariCikar(belge.pdfUrl, belge.tarih);
        for (const k of kararlar) sonuc.push({ belediye: 'Sivas', ...k });
      } catch (e) {
        logger.error(`[yerel-sivas] belge (${belge.pdfUrl}): ${(e as Error).message}`);
      }
    }
  }
  return sonuc;
}

export async function fetchSivasUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await sivasFetchWithBackoff(SIVAS_UYELER_URL);
  if (!res.ok) throw new Error(`[yerel-sivas-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.personnel-card').each((_, kart) => {
    const ad = $(kart).find('h3.title').text().replace(/\s+/g, ' ').trim();
    const hamParti = $(kart).find('.rank').first().text().replace(/\s+/g, ' ').trim();
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Sivas', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
