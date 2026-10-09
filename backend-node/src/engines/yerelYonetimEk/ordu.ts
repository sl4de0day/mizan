import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  pdfMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Ordu');

const ORDU = 'Ordu' as unknown as Belediye;

const ORDU_KARARLAR_URL = 'https://www.ordu.bel.tr/meclis-kararlari';
const ORDU_UYELER_URL = 'https://www.ordu.bel.tr/meclis-uyeleri';

interface OrduSatir { href: string; baslik: string }

function satirlariCikar(html: string): OrduSatir[] {
  const $ = cheerio.load(html);
  const sonuc: OrduSatir[] = [];
  const gorulen = new Set<string>();
  $('a.js-name[href]').each((_, el) => {
    const href = $(el).attr('href');
    const baslik = $(el).text().replace(/\s+/g, ' ').trim();
    if (!href || gorulen.has(href)) return;
    gorulen.add(href);
    sonuc.push({ href, baslik });
  });
  return sonuc;
}

function birlesimBasliklariniBul(metin: string): { index: number; tarih: string }[] {
  const re = /(\d{2})\.(\d{2})\.(\d{4})\s+\d{1,2}:\d{2}/g;
  const sonuc: { index: number; tarih: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(metin))) {
    sonuc.push({ index: m.index, tarih: `${m[3]}-${m[2]}-${m[1]}` });
  }
  return sonuc;
}

interface OrduKararSatiri { sno: string; kararNo: string; gundemNo: string; startIndex: number; endIndex: number }

function kararSatirlariniBul(metin: string): OrduKararSatiri[] {
  const re = /(?:^|\s)(\d{1,3})\s+(\d{4}\/\d{1,4})\s+(\d{1,3})\s+/g;
  const sonuc: OrduKararSatiri[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(metin))) {
    sonuc.push({ sno: m[1], kararNo: m[2], gundemNo: m[3], startIndex: m.index, endIndex: m.index + m[0].length });
  }
  return sonuc;
}

function kararlariAyristir(metin: string, kaynakUrl: string): YerelKararSonucu[] {
  const basliklar = birlesimBasliklariniBul(metin);
  const satirlar = kararSatirlariniBul(metin);
  const sonuc: YerelKararSonucu[] = [];
  for (let i = 0; i < satirlar.length; i++) {
    const satir = satirlar[i];
    const govdeSonu = i + 1 < satirlar.length ? satirlar[i + 1].startIndex : metin.length;
    const govde = metin.slice(satir.endIndex, govdeSonu).replace(/\s+/g, ' ').trim();
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    let tarih: string | null = null;
    for (const b of basliklar) {
      if (b.index <= satir.startIndex) tarih = b.tarih; else break;
    }
    if (!tarih || tarih < BASLANGIC_TARIHI) continue;
    sonuc.push({
      belediye: ORDU, karar_no: satir.kararNo, tarih, konu: null, metin: govde,
      oylama_sonucu: oylamaSonucuCikar(govde), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

export async function fetchOrduKararlar(): Promise<YerelKararSonucu[]> {
  const listRes = await fetchWithBackoff(ORDU_KARARLAR_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!listRes.ok) throw new Error(`[yerel-ordu] liste sayfası: HTTP ${listRes.status}`);
  const satirlar = satirlariCikar(await listRes.text());

  const sonuc: YerelKararSonucu[] = [];
  const gorulenKarar = new Set<string>();
  for (const { href, baslik } of satirlar) {
    const detayUrl = href.startsWith('http') ? href : `https://www.ordu.bel.tr${href}`;
    try {
      const dres = await fetchWithBackoff(detayUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!dres.ok) { logger.error(`[yerel-ordu] detay (${baslik}): HTTP ${dres.status}`); continue; }
      const $ = cheerio.load(await dres.text());
      const pdfHref = $('a.document-card[href$=".pdf"]').first().attr('href');
      if (!pdfHref) continue;
      const pdfUrl = pdfHref.startsWith('http') ? pdfHref : `https://www.ordu.bel.tr${pdfHref}`;
      const pres = await fetchWithBackoff(pdfUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!pres.ok) { logger.error(`[yerel-ordu] PDF indirilemedi (${baslik}): HTTP ${pres.status}`); continue; }
      const metin = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
      const kararlar = kararlariAyristir(metin, pdfUrl);
      for (const k of kararlar) {
        const anahtar = `${k.karar_no}|${k.tarih}`;
        if (gorulenKarar.has(anahtar)) continue;
        gorulenKarar.add(anahtar);
        sonuc.push(k);
      }
    } catch (e) {
      logger.error(`[yerel-ordu] (${baslik}): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

export async function fetchOrduUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(ORDU_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-ordu-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.personnel-card').each((_, kart) => {
    const ad = $(kart).find('.title').first().text().replace(/\s+/g, ' ').trim();
    const rankler = $(kart).find('.rank');
    const hamParti = rankler.eq(0).text().replace(/\s+/g, ' ').trim();
    const ilce = rankler.eq(1).text().replace(/\s+/g, ' ').trim() || null;
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: ORDU, ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce });
  });
  return sonuc;
}
