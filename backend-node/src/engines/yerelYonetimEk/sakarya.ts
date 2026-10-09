import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  type YerelKararSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Sakarya');

const SAKARYA_BASE = 'https://www.sakarya.bel.tr';
const SAKARYA_LISTE_URL = `${SAKARYA_BASE}/tr/EBelediye/MeclisKararlari`;

interface SakaryaToplanti { id: string; tarih: string }

function toplantilariCikar(html: string): SakaryaToplanti[] {
  const $ = cheerio.load(html);
  const sonuc: SakaryaToplanti[] = [];
  $('a[href*="/tr/KararDetay/"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const baslik = $(el).attr('title') ?? '';
    const idMatch = href.match(/\/tr\/KararDetay\/[^/]+\/(\d+)/);
    const tarihMatch = baslik.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
    if (!idMatch || !tarihMatch) return;
    const tarih = `${tarihMatch[3]}-${tarihMatch[2]}-${tarihMatch[1]}`;
    if (tarih < BASLANGIC_TARIHI) return;
    sonuc.push({ id: idMatch[1], tarih });
  });
  return sonuc;
}

function kararlariAyristir(html: string, kaynakUrl: string): YerelKararSonucu[] {
  const $ = cheerio.load(html);
  const sonuc: YerelKararSonucu[] = [];
  $('li.karar-card').each((_, kart) => {
    const $kart = $(kart);
    const baslikHam = $kart.find('.card-header .card-title').first();
    const kararNo = baslikHam.find('b').first().text().replace(/\s+/g, ' ').trim() || null;
    const tarihHam = baslikHam.clone().children().remove().end().text().replace(/\s+/g, ' ').trim();
    const tarihMatch = tarihHam.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    const tarih = tarihMatch ? `${tarihMatch[3]}-${tarihMatch[2]}-${tarihMatch[1]}` : null;
    if (!tarih || tarih < BASLANGIC_TARIHI) return;

    const cardTextler = $kart.find('.card-header .card-text');
    const konu = cardTextler.length > 1 ? cardTextler.eq(1).text().replace(/\s+/g, ' ').trim() || null : null;

    const govdeHam = $kart.find('.card-content').text();
    const metin = govdeHam.split(/Dosyalar:/)[0].replace(/\s+/g, ' ').trim();
    if (metin.length < ASGARI_KARAR_UZUNLUK) return;

    sonuc.push({
      belediye: 'Sakarya', karar_no: kararNo, tarih, konu, metin,
      oylama_sonucu: oylamaSonucuCikar(metin), kaynak_url: kaynakUrl,
    });
  });
  return sonuc;
}

export async function fetchSakaryaKararlar(): Promise<YerelKararSonucu[]> {
  const listRes = await fetchWithBackoff(SAKARYA_LISTE_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!listRes.ok) throw new Error(`[yerel-sakarya] liste sayfası: HTTP ${listRes.status}`);
  const toplantilar = toplantilariCikar(await listRes.text());

  const sonuc: YerelKararSonucu[] = [];
  for (const { id } of toplantilar) {
    const kararUrl = `${SAKARYA_BASE}/tr/EBelediye/ToplantiKararlari/${id}`;
    try {
      const res = await fetchWithBackoff(kararUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!res.ok) { logger.error(`[yerel-sakarya] toplantı ${id}: HTTP ${res.status}`); continue; }
      sonuc.push(...kararlariAyristir(await res.text(), kararUrl));
    } catch (e) {
      logger.error(`[yerel-sakarya] toplantı ${id}: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}
