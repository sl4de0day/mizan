import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Bayburt');

const BAYBURT_BASE = 'https://www.bayburt.bel.tr';
const BAYBURT_KARARLAR_URL = `${BAYBURT_BASE}/mecliskararlari`;
const BAYBURT_UYELER_URL = `${BAYBURT_BASE}/meclisuyeleri`;

const KARAR_MARKER_RE = /KARAR\s*NO\s*[.:]?\s*(\d+)/g;

function kararlariAyristir(bodyText: string, tarih: string, kaynakUrl: string): YerelKararSonucu[] {
  const sonuc: YerelKararSonucu[] = [];
  const eslesmeler = [...bodyText.matchAll(KARAR_MARKER_RE)];
  for (let i = 0; i < eslesmeler.length; i++) {
    const baslangic = eslesmeler[i].index + eslesmeler[i][0].length;
    const bitis = i + 1 < eslesmeler.length ? eslesmeler[i + 1].index : bodyText.length;
    const metin = bodyText.slice(baslangic, bitis).replace(/\s+/g, ' ').trim();
    if (metin.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({
      belediye: 'Bayburt', karar_no: eslesmeler[i][1], tarih, konu: null, metin,
      oylama_sonucu: oylamaSonucuCikar(metin), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

async function csrfBaslatVeGetir(): Promise<{ token: string; cookie: string }> {
  const getRes = await fetchWithBackoff(BAYBURT_KARARLAR_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!getRes.ok) throw new Error(`[yerel-bayburt] GET (CSRF): HTTP ${getRes.status}`);
  const html = await getRes.text();
  const tokenMatch = html.match(/name="_token"\s+value="([^"]+)"/);
  if (!tokenMatch) throw new Error('[yerel-bayburt] _token bulunamadı — sayfa yapısı değişmiş olabilir');
  const setCookies = getRes.headers.getSetCookie ? getRes.headers.getSetCookie() : [];
  const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('[yerel-bayburt] Set-Cookie alınamadı — CSRF akışı kırılmış olabilir');
  return { token: tokenMatch[1], cookie };
}

export async function fetchBayburtKararlar(): Promise<YerelKararSonucu[]> {
  const { token, cookie } = await csrfBaslatVeGetir();
  await new Promise((r) => setTimeout(r, 180));

  const body = new URLSearchParams({ _token: token, yil: '', ay: '', kararno: '', kararkonu: '' });
  const postRes = await fetchWithBackoff(BAYBURT_KARARLAR_URL, {
    method: 'POST',
    headers: {
      ...HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: BAYBURT_KARARLAR_URL,
      Cookie: cookie,
    },
    body: body.toString(),
    timeoutMs: 60000,
  }, 3);
  if (!postRes.ok) throw new Error(`[yerel-bayburt] POST (kararlar): HTTP ${postRes.status}`);
  const html = await postRes.text();

  const $ = cheerio.load(html);
  const sonuc: YerelKararSonucu[] = [];
  const gorulen = new Set<string>();
  $('.accordion-item').each((_, el) => {
    const baslikMetni = $(el).find('.accordion-header button').first().text().replace(/\s+/g, ' ').trim();
    const tarihMatch = baslikMetni.match(/TARİH:(\d{4}-\d{2}-\d{2})/);
    if (!tarihMatch) { logger.error(`[yerel-bayburt] beklenmeyen başlık biçimi, tarih yok: "${baslikMetni}"`); return; }
    const tarih = tarihMatch[1];
    if (tarih < BASLANGIC_TARIHI) return;
    const govdeMetni = $(el).find('.accordion-body').first().text();
    for (const k of kararlariAyristir(govdeMetni, tarih, BAYBURT_KARARLAR_URL)) {
      const anahtar = `${k.tarih}|${k.karar_no}`;
      if (gorulen.has(anahtar)) continue;
      gorulen.add(anahtar);
      sonuc.push(k);
    }
  });
  return sonuc;
}

export async function fetchBayburtUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(BAYBURT_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-bayburt-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.personnel-card').each((_, kart) => {
    const ad = $(kart).find('.title').first().text().replace(/\s+/g, ' ').trim();
    const hamParti = $(kart).find('.tag').first().text().replace(/\s+/g, ' ').trim();
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Bayburt', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
