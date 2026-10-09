import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar, kararNoSiraDoldur,
  type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Usak');

const USAK_BASE = 'https://usak.bel.tr';
const USAK_KARARLAR_URL = `${USAK_BASE}/icerik/meclis-karar-ozetleri`;
const USAK_UYELER_URL = `${USAK_BASE}/profil-kategori/meclis-uyeleri`;
const usakUyelerSayfaUrl = (n: number): string => `${USAK_BASE}/profil-kategori-meclis-uyeleri/${n}`;

interface UsakToplanti { url: string; tarih: string }

function toplantilariCikar(html: string): UsakToplanti[] {
  const $ = cheerio.load(html);
  const sonuc: UsakToplanti[] = [];
  const gorulen = new Set<string>();
  $('a[href*="tarihli-belediye-meclis-karar-ozetleri-ilani"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const m = href.match(/(\d{2})-(\d{2})-(\d{4})-tarihli-belediye-meclis-karar-ozetleri-ilani/);
    if (!m) return;
    const tarih = `${m[3]}-${m[2]}-${m[1]}`;
    if (tarih < BASLANGIC_TARIHI) return;
    const url = `${USAK_BASE}/icerik/${m[0]}`;
    if (gorulen.has(url)) return;
    gorulen.add(url);
    sonuc.push({ url, tarih });
  });
  return sonuc;
}

function govdeMetni(html: string): string {
  const $ = cheerio.load(html);
  $('script, style').remove();
  const detay = $('.detay').first();
  return (detay.length ? detay.text() : $('body').text()).replace(/\s+/g, ' ').trim();
}

function kararOzetleriNarrative(tamMetin: string): string | null {
  const marker = tamMetin.match(/K\s*A\s*R\s*A\s*R\s*Ö\s*Z\s*E\s*T\s*L\s*E\s*R\s*[İI](?![a-zA-ZçğıöşüÇĞİÖŞÜ])\s*:?/i);
  if (marker && marker.index !== undefined) return tamMetin.slice(marker.index + marker[0].length).trim();
  const ilkOya = tamMetin.indexOf('oya sunulmuş');
  if (ilkOya === -1) return null;
  const once = tamMetin.slice(0, ilkOya);
  const re = /bağlanması\./g;
  let m: RegExpExecArray | null;
  let son: RegExpExecArray | null = null;
  while ((m = re.exec(once))) son = m;
  if (!son) return null;
  return tamMetin.slice(son.index + son[0].length).trim();
}

function maddeSinirlariniBul(narrative: string): number[] {
  const duz = narrative.toLocaleLowerCase('tr');
  const re = /oy\s*(birliği|çokluğu)\s+ile\s+(kabul|redd)\s*edil(miştir|miş)/g;
  const sonuc: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(duz))) sonuc.push(m.index + m[0].length);
  return sonuc;
}

function maddeleriAyristir(narrative: string, tarih: string, kaynakUrl: string): YerelKararSonucu[] {
  const sinirlar = maddeSinirlariniBul(narrative);
  const govdeler: string[] = [];
  if (sinirlar.length === 0) {
    govdeler.push(narrative.trim());
  } else {
    let onceki = 0;
    for (const sinir of sinirlar) {
      let bitis = sinir;
      const noktaIdx = narrative.indexOf('.', sinir);
      if (noktaIdx !== -1 && noktaIdx - sinir < 250) bitis = noktaIdx + 1;
      govdeler.push(narrative.slice(onceki, bitis).trim());
      onceki = bitis;
    }
  }
  const sonuc: YerelKararSonucu[] = [];
  for (const govde of govdeler) {
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({
      belediye: 'Uşak', karar_no: null, tarih, konu: null, metin: govde,
      oylama_sonucu: oylamaSonucuCikar(govde), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

export async function fetchUsakKararlar(): Promise<YerelKararSonucu[]> {
  const listRes = await fetchWithBackoff(USAK_KARARLAR_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!listRes.ok) throw new Error(`[yerel-usak] liste sayfası: HTTP ${listRes.status}`);
  const toplantilar = toplantilariCikar(await listRes.text());

  const sonuc: YerelKararSonucu[] = [];
  for (const { url, tarih } of toplantilar) {
    try {
      const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!res.ok) { logger.error(`[yerel-usak] ilan (${url}): HTTP ${res.status}`); continue; }
      const tamMetin = govdeMetni(await res.text());
      const narrative = kararOzetleriNarrative(tamMetin);
      if (!narrative) { logger.error(`[yerel-usak] ilan (${url}): "KARAR ÖZETLERİ" bölümü bulunamadı`); continue; }
      sonuc.push(...maddeleriAyristir(narrative, tarih, url));
    } catch (e) {
      logger.error(`[yerel-usak] ilan (${url}): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return kararNoSiraDoldur(sonuc);
}

export async function fetchUsakUyeler(): Promise<YerelUyeSonucu[]> {
  const sonuc: YerelUyeSonucu[] = [];
  const gorulen = new Set<string>();
  for (let sayfa = 1; sayfa <= 10; sayfa++) {
    const url = sayfa === 1 ? USAK_UYELER_URL : usakUyelerSayfaUrl(sayfa);
    const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 30000 }, 3);
    if (!res.ok) { if (sayfa === 1) throw new Error(`[yerel-usak-uye] HTTP ${res.status}`); break; }
    const $ = cheerio.load(await res.text());
    const kartlar = $('.personeldis');
    if (kartlar.length === 0) break;
    kartlar.each((_, kart) => {
      const ad = $(kart).find('.ad').first().text().replace(/\s+/g, ' ').trim();
      const hamUnvan = $(kart).find('.unvan').first().text().replace(/\s+/g, ' ').trim();
      if (!ad || !hamUnvan || !/parti/i.test(hamUnvan)) return;
      if (gorulen.has(ad)) return;
      gorulen.add(ad);
      const kanonik = normParti(hamUnvan);
      sonuc.push({ belediye: 'Uşak', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamUnvan : kanonik, ilce: null });
    });
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}
