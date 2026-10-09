import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  pdfMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Yozgat');

const YOZGAT_BASE = 'https://yozgat.bel.tr';
const YOZGAT_KARARLAR_URL = `${YOZGAT_BASE}/mecliskararlari`;
const YOZGAT_UYELER_URL = `${YOZGAT_BASE}/meclisuyeleri`;

interface YozgatOturum { baslik: string; tarih: string; pdfUrl: string }

function oturumlariCikar(html: string): YozgatOturum[] {
  const $ = cheerio.load(html);
  const sonuc: YozgatOturum[] = [];
  $('.accordion-item').each((_, el) => {
    const baslik = $(el).find('.accordion-header button').first().text().replace(/\s+/g, ' ').trim();
    const tarihMatch = baslik.match(/TARİH:(\d{4}-\d{2}-\d{2})/);
    if (!tarihMatch) return;
    const pdfHref = $(el).find('a[href$=".pdf"]').first().attr('href');
    if (!pdfHref) return;
    const pdfUrl = pdfHref.startsWith('http') ? pdfHref : `${YOZGAT_BASE}${pdfHref}`;
    sonuc.push({ baslik, tarih: tarihMatch[1], pdfUrl });
  });
  return sonuc;
}

interface YozgatKararBasligi { headerIndex: number; govdeBaslangic: number; tarih: string; kararNo: string }

function baslıklariBul(metin: string): YozgatKararBasligi[] {
  const headerRe = /BELEDİYE MECLİSİNİN/g;
  const sonuc: YozgatKararBasligi[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(metin))) {
    const headerIndex = m.index;
    const pencere = metin.slice(headerIndex, headerIndex + 600);
    const tarihMatch = pencere.match(/Toplantı Tarihi\s*:\s*(\d{2})\/(\d{2})\/(\d{4})/);
    const sayiMatch = pencere.match(/Sayı\s*:\s*(\d+)\s*TOPLANTIYA KATILANLAR/);
    if (!tarihMatch || !sayiMatch) continue;
    const tarih = `${tarihMatch[3]}-${tarihMatch[2]}-${tarihMatch[1]}`;
    const govdeBaslangic = headerIndex + sayiMatch.index! + sayiMatch[0].length;
    sonuc.push({ headerIndex, govdeBaslangic, tarih, kararNo: sayiMatch[1] });
  }
  return sonuc;
}

function kararlariAyristir(metin: string, kaynakUrl: string): YerelKararSonucu[] {
  const basliklar = baslıklariBul(metin);
  const sonuc: YerelKararSonucu[] = [];
  for (let i = 0; i < basliklar.length; i++) {
    const b = basliklar[i];
    if (b.tarih < BASLANGIC_TARIHI) continue;
    const govdeSonu = i + 1 < basliklar.length ? basliklar[i + 1].headerIndex : metin.length;
    const govde = metin.slice(b.govdeBaslangic, govdeSonu).replace(/\s+/g, ' ').trim();
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({
      belediye: 'Yozgat', karar_no: b.kararNo, tarih: b.tarih, konu: null, metin: govde,
      oylama_sonucu: oylamaSonucuCikar(govde), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

async function csrfBaslatVeGetir(): Promise<{ token: string; cookie: string }> {
  const getRes = await fetchWithBackoff(YOZGAT_KARARLAR_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!getRes.ok) throw new Error(`[yerel-yozgat] GET (CSRF): HTTP ${getRes.status}`);
  const html = await getRes.text();
  const tokenMatch = html.match(/name="_token"\s+value="([^"]+)"/);
  if (!tokenMatch) throw new Error('[yerel-yozgat] _token bulunamadı — sayfa yapısı değişmiş olabilir');
  const setCookies = getRes.headers.getSetCookie ? getRes.headers.getSetCookie() : [];
  const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('[yerel-yozgat] Set-Cookie alınamadı — CSRF akışı kırılmış olabilir');
  return { token: tokenMatch[1], cookie };
}

export async function fetchYozgatKararlar(): Promise<YerelKararSonucu[]> {
  const { token, cookie } = await csrfBaslatVeGetir();
  await new Promise((r) => setTimeout(r, 180));

  const body = new URLSearchParams({ _token: token, yil: '', ay: '', kararno: '', kararkonu: '' });
  const postRes = await fetchWithBackoff(YOZGAT_KARARLAR_URL, {
    method: 'POST',
    headers: {
      ...HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: YOZGAT_KARARLAR_URL,
      Cookie: cookie,
    },
    body: body.toString(),
    timeoutMs: 60000,
  }, 3);
  if (!postRes.ok) throw new Error(`[yerel-yozgat] POST (oturum listesi): HTTP ${postRes.status}`);
  const oturumlar = oturumlariCikar(await postRes.text());

  const sonuc: YerelKararSonucu[] = [];
  const gorulenKarar = new Set<string>();
  for (const { baslik, tarih, pdfUrl } of oturumlar) {
    if (tarih < BASLANGIC_TARIHI) continue;
    try {
      const pres = await fetchWithBackoff(pdfUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!pres.ok) { logger.error(`[yerel-yozgat] PDF indirilemedi (${baslik}): HTTP ${pres.status}`); continue; }
      const metin = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
      for (const k of kararlariAyristir(metin, pdfUrl)) {
        const anahtar = `${k.tarih}|${k.karar_no}`;
        if (gorulenKarar.has(anahtar)) continue;
        gorulenKarar.add(anahtar);
        sonuc.push(k);
      }
    } catch (e) {
      logger.error(`[yerel-yozgat] (${baslik}): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

export async function fetchYozgatUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(YOZGAT_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-yozgat-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.personnel-card').each((_, kart) => {
    const ad = $(kart).find('.title').first().text().replace(/\s+/g, ' ').trim();
    const hamParti = $(kart).find('.tag').first().text().replace(/\s+/g, ' ').trim();
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Yozgat', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
