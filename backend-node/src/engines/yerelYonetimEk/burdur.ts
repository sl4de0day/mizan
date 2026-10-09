import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Burdur');

const BURDUR_BASE = 'https://burdur.bel.tr';
const BURDUR_LISTE_KATEGORI = `${BURDUR_BASE}/category/meclis-kararlari/`;
const BURDUR_UYE_URL = `${BURDUR_BASE}/belediye-meclisi/`;
const AZAMI_LISTE_SAYFA = 14;

const AYLAR: Record<string, number> = {
  ocak: 1, şubat: 2, mart: 3, nisan: 4, mayıs: 5, haziran: 6,
  temmuz: 7, ağustos: 8, eylül: 9, ekim: 10, kasım: 11, aralık: 12,
};
function ayAdindanNumara(ad: string): number | null {
  return AYLAR[ad.toLocaleLowerCase('tr')] ?? null;
}

function listeTarihiCikar(text: string): string | null {
  const m = text.match(/(\d{1,2})\s+([A-ZÇĞİÖŞÜa-zçğıöşü]+)\s+(\d{4})/);
  if (!m) return null;
  const ay = ayAdindanNumara(m[2]);
  if (!ay) return null;
  return `${m[3]}-${String(ay).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function toplantiTarihiCikar(introText: string): string | null {
  const duz = introText.replace(/\s+/g, ' ');
  const yilMatch = duz.match(/(\d{4})\s*\/\s*[A-ZÇĞİÖŞÜa-zçğıöşü]+\s+ayı/);
  const yilFallback = yilMatch ? yilMatch[1] : null;
  const m = duz.match(/toplantısı[^0-9]*?(\d{1,2})\s+([A-ZÇĞİÖŞÜa-zçğıöşü]+)(?:\s+(\d{4}))?\s+[A-ZÇĞİÖŞÜa-zçğıöşü]+\s+günü/);
  if (!m) return null;
  const gun = m[1].padStart(2, '0');
  const ay = ayAdindanNumara(m[2]);
  const yil = m[3] ?? yilFallback;
  if (!ay || !yil) return null;
  return `${yil}-${String(ay).padStart(2, '0')}-${gun}`;
}

function slugdanTarihVeNoCikar(url: string): { kararNo: string | null; tarih: string | null } {
  const m = url.match(/(\d{2})-(\d{2})-(\d{4})-tarih-ve-(\d{4})-(\d{1,4})(?:-|\/|$)/);
  if (!m) return { kararNo: null, tarih: null };
  return { kararNo: `${m[4]}/${m[5]}`, tarih: `${m[3]}-${m[2]}-${m[1]}` };
}

function markerKararNo($el: cheerio.Cheerio<any>): string | null {
  const txt = $el.text().replace(/\s+/g, ' ').trim();
  const m = txt.match(/^KARAR\s*NO\s*[:.]?\s*(\d{4}\/\d{1,4})\.?$/i);
  return m ? m[1] : null;
}

interface BurdurTaslak { kararNo: string; govde: string }

function govdeAyristir($: cheerio.CheerioAPI): { introText: string; taslaklar: BurdurTaslak[] } | null {
  const container = $('.elementor-widget-theme-post-content .elementor-widget-container').first();
  if (container.length === 0) return null;
  const introParts: string[] = [];
  const taslaklar: BurdurTaslak[] = [];
  let current: { kararNo: string; parts: string[] } | null = null;
  for (const el of container.children().toArray()) {
    const $el = $(el);
    const kararNo = markerKararNo($el);
    if (kararNo) {
      if (current) taslaklar.push({ kararNo: current.kararNo, govde: current.parts.join(' ').replace(/\s+/g, ' ').trim() });
      current = { kararNo, parts: [] };
      continue;
    }
    const text = $el.text().replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (current) current.parts.push(text); else introParts.push(text);
  }
  if (current) taslaklar.push({ kararNo: current.kararNo, govde: current.parts.join(' ').replace(/\s+/g, ' ').trim() });
  return { introText: introParts.join(' '), taslaklar };
}

interface BurdurListeSatiri { href: string; baslik: string; listeTarihi: string | null }

function listeSayfasiniAyristir(html: string): BurdurListeSatiri[] {
  const $ = cheerio.load(html);
  const sonuc: BurdurListeSatiri[] = [];
  $('article.elementor-post').each((_, el) => {
    const $el = $(el);
    const a = $el.find('.elementor-post__title a').first();
    const href = a.attr('href');
    const baslik = a.text().replace(/\s+/g, ' ').trim();
    const tarihMetni = $el.find('.elementor-post-date').first().text().replace(/\s+/g, ' ').trim();
    if (!href) return;
    sonuc.push({ href, baslik, listeTarihi: listeTarihiCikar(tarihMetni) });
  });
  return sonuc;
}

export async function fetchBurdurKararlar(): Promise<YerelKararSonucu[]> {
  const satirlar: BurdurListeSatiri[] = [];
  disDongu:
  for (let sayfa = 1; sayfa <= AZAMI_LISTE_SAYFA; sayfa++) {
    const url = sayfa === 1 ? BURDUR_LISTE_KATEGORI : `${BURDUR_LISTE_KATEGORI}page/${sayfa}/`;
    let res;
    try {
      res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 30000 }, 3);
    } catch (e) {
      logger.error(`[yerel-burdur] liste sayfası ${sayfa}: ${(e as Error).message}`);
      break;
    }
    if (!res.ok) {
      if (res.status === 404) break;
      logger.error(`[yerel-burdur] liste sayfası ${sayfa}: HTTP ${res.status}`);
      break;
    }
    const satirlarSayfa = listeSayfasiniAyristir(await res.text());
    if (satirlarSayfa.length === 0) break;
    for (const satir of satirlarSayfa) {
      if (satir.listeTarihi && satir.listeTarihi < BASLANGIC_TARIHI) break disDongu;
      satirlar.push(satir);
    }
    await new Promise((r) => setTimeout(r, 180));
  }

  const sonuc: YerelKararSonucu[] = [];
  for (const satir of satirlar) {
    try {
      const dres = await fetchWithBackoff(satir.href, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!dres.ok) { logger.error(`[yerel-burdur] detay (${satir.baslik}): HTTP ${dres.status}`); continue; }
      const $ = cheerio.load(await dres.text());
      const ayristirilmis = govdeAyristir($);
      if (!ayristirilmis) { logger.error(`[yerel-burdur] gövde bulunamadı (${satir.baslik})`); continue; }
      const { introText, taslaklar } = ayristirilmis;
      const toplantiTarihi = toplantiTarihiCikar(introText);

      if (taslaklar.length > 0) {
        const tarih = toplantiTarihi ?? satir.listeTarihi;
        if (!tarih || tarih < BASLANGIC_TARIHI) continue;
        for (const t of taslaklar) {
          if (t.govde.length < ASGARI_KARAR_UZUNLUK) continue;
          sonuc.push({
            belediye: 'Burdur', karar_no: t.kararNo, tarih, konu: null, metin: t.govde,
            oylama_sonucu: oylamaSonucuCikar(t.govde), kaynak_url: satir.href,
          });
        }
      } else {
        const tumMetin = introText.replace(/\s+/g, ' ').trim();
        if (tumMetin.length < ASGARI_KARAR_UZUNLUK) continue;
        const slug = slugdanTarihVeNoCikar(satir.href);
        const tarih = toplantiTarihi ?? slug.tarih ?? satir.listeTarihi;
        if (!tarih || tarih < BASLANGIC_TARIHI) continue;
        sonuc.push({
          belediye: 'Burdur', karar_no: slug.kararNo, tarih, konu: null, metin: tumMetin,
          oylama_sonucu: oylamaSonucuCikar(tumMetin), kaynak_url: satir.href,
        });
      }
    } catch (e) {
      logger.error(`[yerel-burdur] (${satir.baslik}): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

export async function fetchBurdurUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(BURDUR_UYE_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-burdur-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('table').first().find('tr').each((_, tr) => {
    const hucreler = $(tr).find('td,th').map((_i, td) => $(td).text().replace(/\s+/g, ' ').trim()).get();
    if (hucreler.length < 3) return;
    const [sira, ad, hamParti] = hucreler;
    if (!/^\d+$/.test(sira)) return;
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Burdur', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
