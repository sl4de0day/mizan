import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar, kararNoSiraDoldur,
  docxMetinCikar, pdfMetinCikar, type YerelKararSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Batman');

const BATMAN_BASE = 'https://www.batman.bel.tr';
const DONEMLER_URL = `${BATMAN_BASE}/meclis-donemleri`;

const AY_SLUG: Record<string, string> = {
  ocak: '01', subat: '02', mart: '03', nisan: '04', mayis: '05', haziran: '06',
  temmuz: '07', agustos: '08', eylul: '09', ekim: '10', kasim: '11', aralik: '12',
};

const TABLO_RE = /(?:^|\s)(\d{1,3})\s+(\d{2})\.(\d{2})\.(\d{4})\s+(\d{1,5})\s+/g;
const MADDE_RE = /MADDE\s*-?\s*(\d{1,3})\s*-?\s*:?\s+/g;

function gundemTarihiCikar(metin: string): string | null {
  const sikistirilmis = metin.slice(0, 500).replace(/\s+/g, '');
  const m = sikistirilmis.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function govdeTemizle(govde: string): string {
  return govde
    .replace(/\s*T\.C\.?\s*BATMAN\s+İL\s+BELEDİYESİ[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface AccordionBelge { baslik: string; href: string }

function accordionBelgeleriniCikar(html: string): AccordionBelge[] {
  const $ = cheerio.load(html);
  const sonuc: AccordionBelge[] = [];
  $('.accordion-item').each((_, it) => {
    const baslik = $(it).find('.accordion-button').first().text().replace(/\s+/g, ' ').trim();
    const href = $(it).find('a[href]').filter((_, a) => /\.(pdf|docx?)$/i.test($(a).attr('href') ?? '')).first().attr('href');
    if (href) sonuc.push({ baslik, href: href.startsWith('http') ? href : `${BATMAN_BASE}${href}` });
  });
  return sonuc;
}

async function belgeMetniIndir(url: string): Promise<string | null> {
  if (/\.(rar|zip|doc)$/i.test(url)) {
    logger.error(`[yerel-batman] desteklenmeyen format, atlanıyor: ${url}`);
    return null;
  }
  const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 45000 }, 3);
  if (!res.ok) { logger.error(`[yerel-batman] belge indirilemedi: HTTP ${res.status} — ${url}`); return null; }
  const buf = Buffer.from(await res.arrayBuffer());
  if (/\.docx$/i.test(url)) return docxMetinCikar(buf);
  return pdfMetinCikar(new Uint8Array(buf));
}

function kararlaraAyristir(metin: string, kaynakUrl: string, madeGundemTarihi: string | null): YerelKararSonucu[] {
  const sonuc: YerelKararSonucu[] = [];
  const tabloEslesme = [...metin.matchAll(TABLO_RE)];
  if (tabloEslesme.length) {
    for (let i = 0; i < tabloEslesme.length; i++) {
      const m = tabloEslesme[i];
      const baslangic = (m.index ?? 0) + m[0].length;
      const bitis = i + 1 < tabloEslesme.length ? tabloEslesme[i + 1].index! : metin.length;
      const govde = govdeTemizle(metin.slice(baslangic, bitis));
      const tarih = `${m[4]}-${m[3]}-${m[2]}`;
      if (tarih < BASLANGIC_TARIHI || govde.length < ASGARI_KARAR_UZUNLUK) continue;
      sonuc.push({
        belediye: 'Batman', karar_no: m[5], tarih, konu: null, metin: govde,
        oylama_sonucu: oylamaSonucuCikar(govde), kaynak_url: kaynakUrl,
      });
    }
    return sonuc;
  }
  if (!madeGundemTarihi || madeGundemTarihi < BASLANGIC_TARIHI) return sonuc;
  const maddeEslesme = [...metin.matchAll(MADDE_RE)];
  for (let i = 0; i < maddeEslesme.length; i++) {
    const m = maddeEslesme[i];
    const baslangic = (m.index ?? 0) + m[0].length;
    const bitis = i + 1 < maddeEslesme.length ? maddeEslesme[i + 1].index! : metin.length;
    const govde = govdeTemizle(metin.slice(baslangic, bitis));
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({
      belediye: 'Batman', karar_no: null, tarih: madeGundemTarihi, konu: null, metin: govde,
      oylama_sonucu: oylamaSonucuCikar(govde), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

export async function fetchBatmanKararlar(): Promise<YerelKararSonucu[]> {
  const listRes = await fetchWithBackoff(DONEMLER_URL, { headers: HEADERS, timeoutMs: 45000 }, 3);
  if (!listRes.ok) throw new Error(`[yerel-batman] dönem listesi: HTTP ${listRes.status}`);
  const $ = cheerio.load(await listRes.text());

  const ayLinkleri: { url: string; etiket: string }[] = [];
  $('a[href*="meclis-donemi-karar-ozetleri"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const m = href.match(/(\d{4})-yili-([a-z]+)-meclis-donemi-karar-ozetleri/);
    if (!m) return;
    const ayNo = AY_SLUG[m[2]];
    if (!ayNo) return;
    if (`${m[1]}-${ayNo}-01` < BASLANGIC_TARIHI) return;
    ayLinkleri.push({ url: href, etiket: `${m[1]}-${m[2]}` });
  });

  const sonuc: YerelKararSonucu[] = [];
  const gorulenAnahtar = new Set<string>();

  for (const { url, etiket } of ayLinkleri) {
    try {
      const dres = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 45000 }, 3);
      if (!dres.ok) { logger.error(`[yerel-batman] ay sayfası (${etiket}): HTTP ${dres.status}`); continue; }
      const belgeler = accordionBelgeleriniCikar(await dres.text());

      let guncelGundemTarihi: string | null = null;
      for (const { baslik, href } of belgeler) {
        const buyukBaslik = baslik.toLocaleUpperCase('tr');
        const gundemMi = buyukBaslik.includes('GÜNDEM');
        const kararMi = buyukBaslik.includes('KARAR');

        if (gundemMi && !kararMi) {
          try {
            const metin = await belgeMetniIndir(href);
            guncelGundemTarihi = metin ? gundemTarihiCikar(metin) : null;
          } catch (e) {
            logger.error(`[yerel-batman] gündem (${etiket}, ${baslik}): ${(e as Error).message}`);
            guncelGundemTarihi = null;
          }
          await new Promise((r) => setTimeout(r, 180));
          continue;
        }
        if (!kararMi) continue;

        try {
          const metin = await belgeMetniIndir(href);
          if (!metin) { await new Promise((r) => setTimeout(r, 180)); continue; }
          const kararlar = kararlaraAyristir(metin, href, guncelGundemTarihi);
          for (const k of kararlar) {
            const anahtar = `${k.karar_no}|${k.tarih}|${k.metin}`;
            if (gorulenAnahtar.has(anahtar)) continue;
            gorulenAnahtar.add(anahtar);
            sonuc.push(k);
          }
        } catch (e) {
          logger.error(`[yerel-batman] karar belgesi (${etiket}, ${baslik}): ${(e as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, 180));
      }
    } catch (e) {
      logger.error(`[yerel-batman] ay (${etiket}): ${(e as Error).message}`);
    }
  }

  return kararNoSiraDoldur(sonuc);
}
