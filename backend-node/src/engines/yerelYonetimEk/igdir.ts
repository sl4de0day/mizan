import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  pdfMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Igdir');

const IGDIR_BASE = 'https://www.igdir.bel.tr';
const IGDIR_KARARLAR_URL = `${IGDIR_BASE}/belediye-meclis-kararlari`;
const IGDIR_UYELER_URL = `${IGDIR_BASE}/belediye-meclis-uyeleri`;

interface IgdirSatir { href: string; baslik: string }

function satirlariCikar(html: string): IgdirSatir[] {
  const $ = cheerio.load(html);
  const sonuc: IgdirSatir[] = [];
  $('.custom-table-row').each((_, el) => {
    const href = $(el).find('a[href$=".pdf"]').first().attr('href');
    const baslik = $(el).find('.custom-table-cell[data-header="Başlık"]').first().text().replace(/\s+/g, ' ').trim();
    if (!href) return;
    sonuc.push({ href, baslik });
  });
  return sonuc;
}

function kapanisiKes(metin: string): string {
  const idx = metin.search(/toplam\s+\d+\s+adet karar alınmıştır/i);
  if (idx === -1) return metin;
  const oncekiNokta = metin.lastIndexOf('.', idx);
  return oncekiNokta === -1 ? metin.slice(0, idx) : metin.slice(0, oncekiNokta + 1);
}

interface IgdirKararSatiri { sira: string; kararNo: string; tarih: string; startIndex: number; endIndex: number }

function kararSatirlariniBul(metin: string): IgdirKararSatiri[] {
  const re = /(?:^|\s)(\d{1,2})\.\s+(\d{2})\.(\d{2})\.(\d{4})\s+(\d{1,5})\s+/g;
  const sonuc: IgdirKararSatiri[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(metin))) {
    sonuc.push({
      sira: m[1], tarih: `${m[4]}-${m[3]}-${m[2]}`, kararNo: m[5],
      startIndex: m.index, endIndex: m.index + m[0].length,
    });
  }
  return sonuc;
}

function kararlariAyristir(metinHam: string, kaynakUrl: string): YerelKararSonucu[] {
  const metin = kapanisiKes(metinHam);
  const satirlar = kararSatirlariniBul(metin);
  const sonuc: YerelKararSonucu[] = [];
  for (let i = 0; i < satirlar.length; i++) {
    const satir = satirlar[i];
    const govdeSonu = i + 1 < satirlar.length ? satirlar[i + 1].startIndex : metin.length;
    const govde = metin.slice(satir.endIndex, govdeSonu).replace(/\s+/g, ' ').trim();
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    if (satir.tarih < BASLANGIC_TARIHI) continue;
    sonuc.push({
      belediye: 'Iğdır', karar_no: satir.kararNo, tarih: satir.tarih, konu: null, metin: govde,
      oylama_sonucu: oylamaSonucuCikar(govde), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

export async function fetchIgdirKararlar(): Promise<YerelKararSonucu[]> {
  const listRes = await fetchWithBackoff(IGDIR_KARARLAR_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!listRes.ok) throw new Error(`[yerel-igdir] liste sayfası: HTTP ${listRes.status}`);
  const satirlar = satirlariCikar(await listRes.text());

  const sonuc: YerelKararSonucu[] = [];
  for (const { href, baslik } of satirlar) {
    const pdfUrl = href.startsWith('http') ? href : `${IGDIR_BASE}${href}`;
    try {
      const pres = await fetchWithBackoff(pdfUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!pres.ok) { logger.error(`[yerel-igdir] PDF indirilemedi (${baslik}): HTTP ${pres.status}`); continue; }
      const metin = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
      if (metin.trim().length < ASGARI_KARAR_UZUNLUK) {
        logger.error(`[yerel-igdir] (${baslik}): metin katmanı yok/çok kısa (${metin.trim().length} krk) — muhtemelen taranmış görüntü, OCR yapılmıyor, atlanıyor`);
        continue;
      }
      sonuc.push(...kararlariAyristir(metin, pdfUrl));
    } catch (e) {
      logger.error(`[yerel-igdir] (${baslik}): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

export async function fetchIgdirUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(IGDIR_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-igdir-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.card.faq-category-card').each((_, kart) => {
    const ad = $(kart).find('.card-title').first().text().replace(/\s+/g, ' ').trim();
    const hamParti = $(kart).find('.card-text').first().text().replace(/\s+/g, ' ').trim();
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Iğdır', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
