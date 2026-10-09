import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  kararNoSiraDoldur, pdfMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Cankiri');

const KARARLAR_URL = 'https://cankiri.bel.tr/mecliskararlari';
const UYELER_URL = 'https://cankiri.bel.tr/meclisuyeleri';

const AYLAR = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];

interface Oturum { token: string; cookie: string }

async function oturumAl(): Promise<Oturum> {
  const res = await fetchWithBackoff(KARARLAR_URL, { headers: HEADERS, timeoutMs: 30000 }, 2);
  if (!res.ok) throw new Error(`oturum GET: HTTP ${res.status}`);
  const html = await res.text();
  const tokenMatch = html.match(/name="_token" value="([^"]+)"/);
  if (!tokenMatch) throw new Error('CSRF _token bulunamadı (sayfa yapısı değişmiş olabilir)');
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('Set-Cookie alınamadı — CSRF akışı kırılmış olabilir');
  return { token: tokenMatch[1], cookie };
}

async function ayYilGetir(ay: string, yil: number, deneme = 5): Promise<string> {
  let sonHata: unknown;
  for (let i = 0; i < deneme; i++) {
    try {
      const oturum = await oturumAl();
      await new Promise((r) => setTimeout(r, 180));
      const body = new URLSearchParams({ _token: oturum.token, yil: String(yil), ay, kararno: '', kararkonu: '' });
      const res = await fetchWithBackoff(KARARLAR_URL, {
        method: 'POST',
        headers: {
          ...HEADERS,
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: KARARLAR_URL,
          Cookie: oturum.cookie,
        },
        body: body.toString(),
        timeoutMs: 30000,
      }, 1);
      if (res.status === 200) return await res.text();
      sonHata = new Error(`POST: HTTP ${res.status}`);
    } catch (e) {
      sonHata = e;
    }
    await new Promise((r) => setTimeout(r, 400 + i * 250));
  }
  throw new Error(`${yil}-${ay}: ${deneme} denemede oturum kurulamadı (${(sonHata as Error)?.message})`);
}

function pdfBaglantilariniCikar(html: string): string[] {
  const $ = cheerio.load(html);
  const hrefler: string[] = [];
  $('.accordion-item').each((_, el) => {
    $(el).find('a[href$=".pdf"]').each((_, a) => {
      const href = $(a).attr('href');
      if (!href) return;
      hrefler.push(href.startsWith('http') ? href : `https://cankiri.bel.tr${href}`);
    });
  });
  return hrefler;
}

function garbledDuzelt(s: string): string {
  return s.replace(/Ġ/g, 'İ').replace(/ġ/g, 'ş').replace(/Ģ/g, 'Ş');
}

const KARAR_MARKER_RE = /Karar\s*No\s*:\s*(\d+)\s*Dairesi/g;
const TARIH_RE = /Karar\s*Tarihi\s*:\s*(\d{2})\.(\d{2})\.(\d{4})/;
const KONU_RE = /Konusu\s*:?\s*([\s\S]*?)TOPLANTIYA/;

function kararlariAyristir(pdfMetni: string, kaynakUrl: string): YerelKararSonucu[] {
  const sonuc: YerelKararSonucu[] = [];
  const eslesmeler = [...pdfMetni.matchAll(KARAR_MARKER_RE)];
  for (let i = 0; i < eslesmeler.length; i++) {
    const baslangic = eslesmeler[i].index ?? 0;
    const bitis = i + 1 < eslesmeler.length ? (eslesmeler[i + 1].index ?? pdfMetni.length) : pdfMetni.length;
    const dilim = pdfMetni.slice(baslangic, bitis);
    const tarihM = dilim.match(TARIH_RE);
    if (!tarihM) continue;
    const tarih = `${tarihM[3]}-${tarihM[2]}-${tarihM[1]}`;
    if (tarih < BASLANGIC_TARIHI) continue;
    const konuM = dilim.match(KONU_RE);
    const konu = konuM ? (garbledDuzelt(konuM[1].replace(/\s+/g, ' ').trim()) || null) : null;
    const metin = garbledDuzelt(dilim.replace(/\s+/g, ' ').trim());
    if (metin.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({
      belediye: 'Çankırı', karar_no: eslesmeler[i][1], tarih, konu, metin,
      oylama_sonucu: oylamaSonucuCikar(metin), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

export async function fetchCankiriKararlar(): Promise<YerelKararSonucu[]> {
  const bugun = new Date();
  const kombinasyonlar: { ay: string; yil: number }[] = [];
  for (let yil = 2024; yil <= bugun.getFullYear(); yil++) {
    for (const ay of AYLAR) {
      const ayBasi = `${yil}-${ay}-01`;
      if (ayBasi < `${BASLANGIC_TARIHI.slice(0, 7)}-01`) continue;
      if (yil === bugun.getFullYear() && Number(ay) > bugun.getMonth() + 1) continue;
      kombinasyonlar.push({ ay, yil });
    }
  }

  const sonuc: YerelKararSonucu[] = [];
  const gorulenPdf = new Set<string>();
  const gorulenKarar = new Set<string>();

  for (const { ay, yil } of kombinasyonlar) {
    try {
      const html = await ayYilGetir(ay, yil);
      const hrefler = pdfBaglantilariniCikar(html);
      for (const href of hrefler) {
        if (gorulenPdf.has(href)) continue;
        gorulenPdf.add(href);
        try {
          const pres = await fetchWithBackoff(href, { headers: HEADERS, timeoutMs: 30000 }, 3);
          if (!pres.ok) { logger.error(`[yerel-cankiri] PDF indirilemedi (${href}): HTTP ${pres.status}`); continue; }
          const buf = new Uint8Array(await pres.arrayBuffer());
          const metin = await pdfMetinCikar(buf);
          const kararlar = kararlariAyristir(metin, href);
          if (kararlar.length === 0) {
            logger.warn(`[yerel-cankiri] PDF'te tanınan karar yok (taranmış görüntü ya da sevk yazısı olabilir): ${href}`);
          }
          for (const k of kararlar) {
            const anahtar = `${k.tarih}|${k.karar_no}`;
            if (gorulenKarar.has(anahtar)) continue;
            gorulenKarar.add(anahtar);
            sonuc.push(k);
          }
        } catch (e) {
          logger.error(`[yerel-cankiri] PDF (${href}): ${(e as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, 180));
      }
    } catch (e) {
      logger.error(`[yerel-cankiri] ${yil}-${ay}: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return kararNoSiraDoldur(sonuc);
}

export async function fetchCankiriUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-cankiri-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.personnel-card').each((_, kart) => {
    const ad = $(kart).find('.title').first().text().replace(/\s+/g, ' ').trim();
    const hamParti = $(kart).find('.tag').first().text().replace(/\s+/g, ' ').trim();
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Çankırı', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
