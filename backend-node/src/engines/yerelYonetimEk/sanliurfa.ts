import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  type YerelKararSonucu, type YerelUyeSonucu,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Sanliurfa');

const SANLIURFA_KARARLAR_URL = 'https://www.sanliurfa.bel.tr/kategori/82/0/meclis-kararlari';
const SANLIURFA_UYELER_URL = 'https://www.sanliurfa.bel.tr/meclis-uyeleri';

const KARAR_BEYAN_RE = /Büyükşehir\s+Belediye\s+Meclisi(?:'?nin|nin)?\s+(\d{2}\.\d{2}\.\d{4})\s*tarih\s*ve\s*(\d+)\s*sayılı\s*kararı/i;

function ddmmyyyyToIso(ham: string): string | null {
  const m = ham.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

export async function fetchSanliurfaKararlar(): Promise<YerelKararSonucu[]> {
  const sonuc: YerelKararSonucu[] = [];
  for (let page = 1; page <= 20; page++) {
    const url = page === 1 ? SANLIURFA_KARARLAR_URL : `${SANLIURFA_KARARLAR_URL}?page=${page}`;
    const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 30000 }, 3);
    if (!res.ok) throw new Error(`[yerel-sanliurfa] sayfa ${page}: HTTP ${res.status}`);
    const $ = cheerio.load(await res.text());
    const rows = $('#table tbody tr').toArray().filter((el) => $(el).find('td').length >= 3);
    if (!rows.length) break;
    let durduk = false;
    for (const el of rows) {
      const cells = $(el).find('td');
      const link = $(cells[1]).find('a').first();
      const href = link.attr('href');
      const konu = link.text().replace(/\s+/g, ' ').trim() || null;
      const yuklemeTarih = ddmmyyyyToIso($(cells[2]).text().trim());
      if (!href || !yuklemeTarih) continue;
      if (yuklemeTarih < BASLANGIC_TARIHI) { durduk = true; break; }
      try {
        const dres = await fetchWithBackoff(href, { headers: HEADERS, timeoutMs: 30000 }, 3);
        if (!dres.ok) { logger.error(`[yerel-sanliurfa] belge indirilemedi: HTTP ${dres.status} ${href}`); continue; }
        const $$ = cheerio.load(await dres.text());
        $$('.icerikler script, .icerikler .addthis_toolbox').remove();
        const metin = $$('.icerikler').text().replace(/\s+/g, ' ').trim();
        const m = metin.match(KARAR_BEYAN_RE);
        if (!m) continue;
        const tarih = ddmmyyyyToIso(m[1]);
        if (!tarih || tarih < BASLANGIC_TARIHI) continue;
        if (metin.length < ASGARI_KARAR_UZUNLUK) continue;
        sonuc.push({
          belediye: 'Şanlıurfa', karar_no: m[2], tarih, konu, metin,
          oylama_sonucu: oylamaSonucuCikar(metin), kaynak_url: href,
        });
      } catch (e) {
        logger.error(`[yerel-sanliurfa] karar ${href}: ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 180));
    }
    if (durduk) break;
  }
  return sonuc;
}

export async function fetchSanliurfaUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(SANLIURFA_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-sanliurfa-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.col-md-3.col-xs-4.foto.text-center').each((_, el) => {
    const ad = $(el).find('label').first().text().replace(/\s+/g, ' ').trim();
    const detay = $(el).find('p').first().text().replace(/\s+/g, ' ').trim();
    const parcalar = detay.split(' - ');
    if (!ad || parcalar.length !== 2) return;
    const [ilceHam, hamParti] = parcalar;
    const ilce = ilceHam.trim();
    if (!ilce || !hamParti.trim()) return;
    const kanonik = normParti(hamParti);
    sonuc.push({
      belediye: 'Şanlıurfa', ad_soyad: ad,
      parti: kanonik === 'Bilinmiyor' ? hamParti.trim() : kanonik,
      ilce,
    });
  });
  return sonuc;
}
