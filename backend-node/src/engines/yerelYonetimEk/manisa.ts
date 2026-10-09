import * as cheerio from 'cheerio';
import { Agent } from 'undici';
import tls from 'node:tls';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK,
  pdfMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Manisa');

const MANISA_ORIGIN = 'https://meclis.manisa.bel.tr';
const MANISA_LISTE_URL = `${MANISA_ORIGIN}/meclis-goruntule`;
const MANISA_UYELER_URL = 'https://www.manisa.bel.tr/t7_buyuksehir-belediye-meclisi.aspx';

const MANISA_ARA_SERTIFIKA = `-----BEGIN CERTIFICATE-----
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
const MANISA_CA = [MANISA_ARA_SERTIFIKA, ...tls.rootCertificates];
const MANISA_UYE_AGENT = new Agent({ connect: { ca: MANISA_CA } });

async function manisaUyeFetch(url: string): Promise<Response> {
  const init: RequestInit = { headers: HEADERS, signal: AbortSignal.timeout(30000) };
  (init as unknown as { dispatcher: unknown }).dispatcher = MANISA_UYE_AGENT;
  return fetch(url, init);
}

function belgeUrl(dataFilepath: string): string {
  const rel = dataFilepath.replace(/^wwwroot\\/, '/').replace(/\\/g, '/');
  return MANISA_ORIGIN + rel.split('/').map(encodeURIComponent).join('/');
}

const AY_GOVDESI: [RegExp, number][] = [
  [/ocak/, 1], [/ubat/, 2], [/mart/, 3], [/nisan/, 4], [/may.?s/, 5],
  [/haziran/, 6], [/temmuz/, 7], [/ustos/, 8], [/eyl.?l/, 9],
  [/ekim/, 10], [/kas.?m/, 11], [/aral.?k/, 12],
];
function ayNumarasi(kelime: string): number | null {
  const duz = kelime.toLocaleLowerCase('tr');
  for (const [re, no] of AY_GOVDESI) if (re.test(duz)) return no;
  return null;
}

function belgeTarihiCikar(hamMetin: string): string | null {
  const duz = hamMetin.replace(/\s+/g, ' ');
  const m = duz.match(/Meclisi,?\s*(\d{1,2})\s+(\S+)\s+(\d{4})/);
  if (!m) return null;
  const gun = Number(m[1]);
  const ay = ayNumarasi(m[2]);
  const yil = Number(m[3]);
  if (!ay || !gun || gun > 31 || !yil) return null;
  return `${yil}-${String(ay).padStart(2, '0')}-${String(gun).padStart(2, '0')}`;
}

function manisaOylamaSonucuCikar(parca: string): 'oybirlik' | 'oycoklugu' | null {
  const duz = parca.toLocaleLowerCase('tr').replace(/\s+/g, ' ');
  if (/\boy\s*birli/.test(duz)) return 'oybirlik';
  if (/\boy\s{0,3}.{0,3}oklu/.test(duz)) return 'oycoklugu';
  return null;
}

function maddeNoCikar(lookback: string): string | null {
  const numaralar = [...lookback.matchAll(/(\d{1,3})\s*\.\s*madde/gi)].map((m) => m[1]);
  if (!numaralar.length) return null;
  const ilk = numaralar[0];
  const son = numaralar[numaralar.length - 1];
  return ilk === son ? ilk : `${ilk}-${son}`;
}

function konuCikar(lookback: string): string | null {
  const m = lookback.match(/\d{1,3}\s*\.\s*madde[\s\S]*$/);
  if (!m) return null;
  const parca = m[0].replace(/\s+/g, ' ').trim();
  return parca.length > 8 ? parca.slice(0, 180) : null;
}

const TETIKLEYICI = /oyla\S{0,10}\s*sunuyorum/gi;
const KAPANIS = /kabul\s*(?:edil|olmu)\S*/i;

function tutanaktanKararlarCikar(hamMetin: string, tarih: string, kaynakUrl: string): YerelKararSonucu[] {
  const metin = hamMetin.replace(/\s+/g, ' ').trim();
  const sonuc: YerelKararSonucu[] = [];
  let oncekiSon = 0;
  TETIKLEYICI.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TETIKLEYICI.exec(metin))) {
    const tetikBas = m.index;
    const ilerisi = metin.slice(tetikBas, tetikBas + 500);
    const kapanis = KAPANIS.exec(ilerisi);
    if (!kapanis) continue;
    const blokSon = tetikBas + kapanis.index + kapanis[0].length;
    const blokBas = Math.max(oncekiSon, tetikBas - 1500);
    const govde = metin.slice(blokBas, blokSon).trim();
    oncekiSon = blokSon;
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    const lookback = metin.slice(Math.max(0, tetikBas - 350), tetikBas);
    sonuc.push({
      belediye: 'Manisa', karar_no: maddeNoCikar(lookback), tarih, konu: konuCikar(lookback),
      metin: govde, oylama_sonucu: manisaOylamaSonucuCikar(ilerisi.slice(0, kapanis.index + kapanis[0].length + 20)),
      kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

export async function fetchManisaKararlar(): Promise<YerelKararSonucu[]> {
  const listRes = await fetchWithBackoff(MANISA_LISTE_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!listRes.ok) throw new Error(`[yerel-manisa] liste sayfası: HTTP ${listRes.status}`);
  const $ = cheerio.load(await listRes.text());
  const idler = $('.meeting-card[data-meeting-id]').toArray()
    .map((el) => $(el).attr('data-meeting-id'))
    .filter((id): id is string => !!id);

  const sonuc: YerelKararSonucu[] = [];
  const islenenTutanak = new Set<string>();
  for (const id of idler) {
    const detayUrl = `${MANISA_ORIGIN}/meclis-goruntule-${id}`;
    try {
      const dres = await fetchWithBackoff(detayUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!dres.ok) { logger.error(`[yerel-manisa] detay (${id}): HTTP ${dres.status}`); continue; }
      const $$ = cheerio.load(await dres.text());
      const tutanakYolu = $$('[data-filepath]').toArray()
        .map((el) => $$(el).attr('data-filepath') || '')
        .find((fp) => /tutan/i.test(fp));
      if (!tutanakYolu) continue;
      const pdfUrl = belgeUrl(tutanakYolu);
      if (islenenTutanak.has(pdfUrl)) continue;
      islenenTutanak.add(pdfUrl);
      const pres = await fetchWithBackoff(pdfUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!pres.ok) { logger.error(`[yerel-manisa] tutanak indirilemedi (${id}): HTTP ${pres.status}`); continue; }
      const hamMetin = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
      const tarih = belgeTarihiCikar(hamMetin);
      if (!tarih || tarih < BASLANGIC_TARIHI) continue;
      sonuc.push(...tutanaktanKararlarCikar(hamMetin, tarih, pdfUrl));
    } catch (e) {
      logger.error(`[yerel-manisa] toplantı ${id}: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

export async function fetchManisaUyeler(): Promise<YerelUyeSonucu[]> {
  let res: Response | undefined;
  let sonErr: unknown;
  for (let deneme = 0; deneme <= 3; deneme++) {
    try { res = await manisaUyeFetch(MANISA_UYELER_URL); break; }
    catch (e) { sonErr = e; if (deneme < 3) await new Promise((r) => setTimeout(r, 2 ** deneme * 1000)); }
  }
  if (!res) throw new Error(`[yerel-manisa-uye] bağlantı başarısız: ${(sonErr as Error)?.message}`);
  if (!res.ok) throw new Error(`[yerel-manisa-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  let ilceAd: string | null = null;
  $('.maindivbaslikust, .divblok').each((_, el) => {
    const $el = $(el);
    if ($el.hasClass('maindivbaslikust')) {
      const baslik = $el.text().replace(/\s+/g, ' ').trim();
      ilceAd = baslik === 'Büyükşehir Meclis Üyeleri' ? null : baslik;
      return;
    }
    const ad = $el.find('h2').first().text().replace(/\s+/g, ' ').trim();
    const h3ler = $el.find('h3');
    const hamParti = h3ler.length ? h3ler.last().text().replace(/\s+/g, ' ').trim() : '';
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Manisa', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: ilceAd });
  });
  return sonuc;
}
