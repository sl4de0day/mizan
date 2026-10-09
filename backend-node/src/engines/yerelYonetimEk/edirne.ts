import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar, kararNoSiraDoldur,
  docxMetinCikar, pdfMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Edirne');

const EDIRNE_BASE = 'https://edirne.bel.tr';
const RAPORLAR_URL = `${EDIRNE_BASE}/kurumsal/raporlar`;
const UYELER_URL = `${EDIRNE_BASE}/kurumsal?encumenmi=false`;

const NEZAKET_MS = 180;
const bekle = () => new Promise((r) => setTimeout(r, NEZAKET_MS));

function oturumTarihiCikar(metin: string): string | null {
  const dateRe = /([0-3]?\d)\.(\d{2})\.(\d{4})/g;
  let idx = -1;
  while (true) {
    idx = metin.indexOf('saat', idx + 1);
    if (idx === -1) break;
    const pencere = metin.slice(Math.max(0, idx - 60), idx);
    const eslesmeler = [...pencere.matchAll(dateRe)];
    if (eslesmeler.length) {
      const m = eslesmeler[eslesmeler.length - 1];
      return `${m[3]}-${m[2]}-${m[1].padStart(2, '0')}`;
    }
  }
  const nemIdx = metin.indexOf('nemine');
  if (nemIdx !== -1) {
    const pencere = metin.slice(nemIdx, nemIdx + 60);
    const m = [...pencere.matchAll(dateRe)][0];
    if (m) return `${m[3]}-${m[2]}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

function oyMetniDuzelt(govde: string): string {
  return govde.replace(/birligi/gi, 'birliği').replace(/[9cç]oklugu/gi, 'çokluğu');
}

const MADDE_RE = /(?:^|\s)(\d{1,3})-\s{2,}/g;

function kararlaraBol(metin: string, tarih: string, kaynakUrl: string): YerelKararSonucu[] {
  const hamEslesme = [...metin.matchAll(MADDE_RE)];
  const eslesme = hamEslesme.filter((m) => !/\d,\s*$/.test(metin.slice(Math.max(0, (m.index ?? 0) - 6), m.index ?? 0)));
  const sonuc: YerelKararSonucu[] = [];
  for (let i = 0; i < eslesme.length; i++) {
    const m = eslesme[i];
    const baslangic = (m.index ?? 0) + m[0].length;
    const bitis = i + 1 < eslesme.length ? (eslesme[i + 1].index ?? metin.length) : metin.length;
    const govde = metin.slice(baslangic, bitis).replace(/\s+/g, ' ').trim();
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({
      belediye: 'Edirne', karar_no: null, tarih, konu: null, metin: govde,
      oylama_sonucu: oylamaSonucuCikar(oyMetniDuzelt(govde)), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

async function belgeMetniIndir(url: string): Promise<string | null> {
  if (/\.doc$/i.test(url)) {
    logger.error(`[yerel-edirne] eski .doc formatı desteklenmiyor, atlanıyor: ${url}`);
    return null;
  }
  if (!/\.(pdf|docx)$/i.test(url)) {
    logger.error(`[yerel-edirne] tanınmayan belge uzantısı, atlanıyor: ${url}`);
    return null;
  }
  const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 45000 }, 3);
  if (!res.ok) { logger.error(`[yerel-edirne] belge indirilemedi: HTTP ${res.status} — ${url}`); return null; }
  const buf = Buffer.from(await res.arrayBuffer());
  if (/\.docx$/i.test(url)) {
    const metin = docxMetinCikar(buf);
    if (!metin || metin.trim().length < ASGARI_KARAR_UZUNLUK) {
      logger.error(`[yerel-edirne] docx metni neredeyse boş (taranmış görüntü/gömülü resim olabilir, OCR yapılmıyor), atlanıyor: ${url}`);
      return null;
    }
    return metin;
  }
  const metin = await pdfMetinCikar(new Uint8Array(buf));
  if (metin.trim().length < ASGARI_KARAR_UZUNLUK) {
    logger.error(`[yerel-edirne] PDF metni neredeyse boş (taranmış görüntü, metin katmanı yok — OCR yapılmıyor), atlanıyor: ${url}`);
    return null;
  }
  return metin;
}

interface AylikKayit { baslik: string; kararOzetiHref: string | null }

function listeSayfasiniAyristir(html: string): AylikKayit[] {
  const $ = cheerio.load(html);
  const sonuc: AylikKayit[] = [];
  $('.job-list-item').each((_, el) => {
    const baslik = $(el).find('.job-list-title').first().text().replace(/\s+/g, ' ').trim();
    const href = $(el).find('a.tp-sqbtn-border').first().attr('href') ?? null;
    sonuc.push({ baslik, kararOzetiHref: href });
  });
  return sonuc;
}

function gecerliBelgeHrefMi(href: string | null): href is string {
  return !!href && /\/Upload\//i.test(href) && /\.(pdf|docx?)$/i.test(href);
}

export async function fetchEdirneKararlar(): Promise<YerelKararSonucu[]> {
  const sonuc: YerelKararSonucu[] = [];
  const gorulenAnahtar = new Set<string>();
  const carYil = new Date().getFullYear();

  for (let yil = 2024; yil <= carYil; yil++) {
    for (let sayfa = 1; ; sayfa++) {
      const listeUrl = `${RAPORLAR_URL}?turid=1&yil=${yil}&sayfa=${sayfa}`;
      let kayitlar: AylikKayit[];
      try {
        const listRes = await fetchWithBackoff(listeUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
        if (!listRes.ok) { logger.error(`[yerel-edirne] liste sayfası (${yil}, sayfa ${sayfa}): HTTP ${listRes.status}`); break; }
        kayitlar = listeSayfasiniAyristir(await listRes.text());
      } catch (e) {
        logger.error(`[yerel-edirne] liste sayfası (${yil}, sayfa ${sayfa}): ${(e as Error).message}`);
        break;
      }
      if (!kayitlar.length) break;

      for (const { baslik, kararOzetiHref } of kayitlar) {
        await bekle();
        if (!gecerliBelgeHrefMi(kararOzetiHref)) {
          logger.error(`[yerel-edirne] Karar Özeti belgesi yok/bozuk href, atlanıyor: ${baslik}`);
          continue;
        }
        try {
          const metin = await belgeMetniIndir(kararOzetiHref);
          if (!metin) continue;
          const tarih = oturumTarihiCikar(metin);
          if (!tarih) {
            logger.error(`[yerel-edirne] oturum tarihi çıkarılamadı (belge aşırı bozuk olabilir), tarih uydurulmadan atlanıyor: ${baslik} — ${kararOzetiHref}`);
            continue;
          }
          if (tarih < BASLANGIC_TARIHI) continue;
          const kararlar = kararlaraBol(metin, tarih, kararOzetiHref);
          for (const k of kararlar) {
            const anahtar = `${k.tarih}|${k.metin}`;
            if (gorulenAnahtar.has(anahtar)) continue;
            gorulenAnahtar.add(anahtar);
            sonuc.push(k);
          }
        } catch (e) {
          logger.error(`[yerel-edirne] belge (${baslik}, ${kararOzetiHref}): ${(e as Error).message}`);
        }
      }
    }
  }

  return kararNoSiraDoldur(sonuc);
}

export async function fetchEdirneUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-edirne-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.tpteam').each((_, kart) => {
    const ad = $(kart).find('.tpteam-title').first().text().replace(/\s+/g, ' ').trim();
    const unvan = $(kart).find('.team-designation').first().text().replace(/\s+/g, ' ').trim();
    const hamParti = unvan.replace(/\s*Meclis\s+Üyesi\s*$/i, '').trim();
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Edirne', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
