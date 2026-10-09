import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  pdfMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Artvin');

const ARTVIN_BASE = 'https://artvin.bel.tr';
const ARTVIN_UYELER_URL = `${ARTVIN_BASE}/belediye-meclisi`;

function kararSayfaUrl(yil: number): string {
  return `${ARTVIN_BASE}/meclis-${yil}-kararlari`;
}

interface ArtvinBelge { href: string; baslik: string }

function belgeLinkleriniCikar(html: string): ArtvinBelge[] {
  const $ = cheerio.load(html);
  const sonuc: ArtvinBelge[] = [];
  const gorulen = new Set<string>();
  $('a.faq-category-card[href]').each((_, el) => {
    const href = $(el).attr('href');
    const baslik = $(el).find('.card-title').first().text().replace(/\s+/g, ' ').trim();
    if (!href || gorulen.has(href)) return;
    gorulen.add(href);
    sonuc.push({ href, baslik });
  });
  return sonuc;
}

const SATIR_BASLANGIC_RE = /(?:^|\s)(\d{1,3})\s+(\d{2})[./](\d{2})[./](\d{4})\s+(\d{1,4})\s+/g;

function belgeKararlariniAyristir(metin: string, kaynakUrl: string): YerelKararSonucu[] {
  const eslesmeler = [...metin.matchAll(SATIR_BASLANGIC_RE)];
  const sonuc: YerelKararSonucu[] = [];
  for (let i = 0; i < eslesmeler.length; i++) {
    const m = eslesmeler[i];
    const [, , gun, ay, yil, kararSayisi] = m;
    const tarih = `${yil}-${ay}-${gun}`;
    if (tarih < BASLANGIC_TARIHI) continue;
    const basla = m.index + m[0].length;
    const bitis = i + 1 < eslesmeler.length ? eslesmeler[i + 1].index : metin.length;
    const govde = metin.slice(basla, bitis).replace(/\s+/g, ' ').trim();
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({
      belediye: 'Artvin',
      karar_no: `${yil}/${kararSayisi}`,
      tarih,
      konu: null,
      metin: govde,
      oylama_sonucu: oylamaSonucuCikar(govde),
      kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

export async function fetchArtvinKararlar(): Promise<YerelKararSonucu[]> {
  const suAn = new Date();
  const sonYil = suAn.getUTCFullYear();
  const sonuc: YerelKararSonucu[] = [];
  const gorulenKarar = new Set<string>();

  for (let yil = 2024; yil <= sonYil; yil++) {
    const listUrl = kararSayfaUrl(yil);
    let belgeler: ArtvinBelge[];
    try {
      const listRes = await fetchWithBackoff(listUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!listRes.ok) {
        logger.error(`[yerel-artvin] liste sayfası (${yil}): HTTP ${listRes.status}`);
        continue;
      }
      belgeler = belgeLinkleriniCikar(await listRes.text());
    } catch (e) {
      logger.error(`[yerel-artvin] liste sayfası (${yil}): ${(e as Error).message}`);
      continue;
    }
    await new Promise((r) => setTimeout(r, 180));

    for (const { href, baslik } of belgeler) {
      if (!/\.pdf$/i.test(href)) {
        logger.error(`[yerel-artvin] desteklenmeyen belge türü (${baslik}), atlanıyor: ${href}`);
        continue;
      }
      const pdfUrl = href.startsWith('http') ? href : `${ARTVIN_BASE}${href}`;
      try {
        const pres = await fetchWithBackoff(pdfUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
        if (!pres.ok) { logger.error(`[yerel-artvin] PDF indirilemedi (${baslik}): HTTP ${pres.status}`); continue; }
        const buf = new Uint8Array(await pres.arrayBuffer());
        let metin: string;
        try {
          metin = await pdfMetinCikar(buf);
        } catch (e) {
          logger.error(`[yerel-artvin] PDF ayrıştırma (${baslik}): ${(e as Error).message}`);
          continue;
        }
        if (metin.replace(/\s+/g, '').length < ASGARI_KARAR_UZUNLUK) {
          logger.error(`[yerel-artvin] metin katmanı yok/çok kısa (muhtemelen taranmış görüntü), OCR yapılmadan atlanıyor: ${pdfUrl}`);
          continue;
        }
        const kararlar = belgeKararlariniAyristir(metin, pdfUrl);
        for (const k of kararlar) {
          const anahtar = `${k.karar_no}|${k.tarih}`;
          if (gorulenKarar.has(anahtar)) continue;
          gorulenKarar.add(anahtar);
          sonuc.push(k);
        }
      } catch (e) {
        logger.error(`[yerel-artvin] (${baslik}): ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 180));
    }
  }
  return sonuc;
}

export async function fetchArtvinUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(ARTVIN_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-artvin-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.manager-vertical-card').each((_, kart) => {
    const ad = $(kart).find('.manager-name').first().text().replace(/\s+/g, ' ').trim();
    const hamParti = $(kart).find('.manager-sm-card-body p').first().text().replace(/\s+/g, ' ').trim();
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Artvin', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
