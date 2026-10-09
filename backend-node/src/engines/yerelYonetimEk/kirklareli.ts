import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  pdfMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Kirklareli');

const BASE = 'https://kirklareli.bel.tr';
const KARARLAR_URL = `${BASE}/meclis-kararlari`;
const MECLIS_UYELER_URL = `${BASE}/meclis`;

const TARANMIS_GORUNTU_ESIGI = 200;

const AYLAR: Record<string, string> = {
  'Ocak': '01', 'Şubat': '02', 'Mart': '03', 'Nisan': '04', 'Mayıs': '05', 'Haziran': '06',
  'Temmuz': '07', 'Ağustos': '08', 'Eylül': '09', 'Ekim': '10', 'Kasım': '11', 'Aralık': '12',
};

interface KkBlok { yil: string; baslik: string; kararHref: string | null }

function bloklariCikar(html: string): KkBlok[] {
  const $ = cheerio.load(html);
  const sonuc: KkBlok[] = [];
  $('.accordion-item.year-item').each((_, el) => {
    const $el = $(el);
    const yil = $el.attr('data-year') ?? '';
    const baslik = $el.find('.accordion-header .d-flex > div').eq(1).text().replace(/\s+/g, ' ').trim();
    const kararHref = $el.find('a.file-card.file-karar[href]').attr('href') ?? null;
    sonuc.push({ yil, baslik, kararHref });
  });
  return sonuc;
}

function baslikTarihTahmini(yil: string, baslik: string): string | null {
  if (!yil) return null;
  for (const [ad, no] of Object.entries(AYLAR)) {
    if (baslik.includes(ad)) return `${yil}-${no}-01`;
  }
  return null;
}

function tarihiCikar(duz: string): string | null {
  const m = duz.match(/MECLİSİN\s+TOPLANTI\s+TARİHİ\s*:?\s*(\d{2})\.(\d{2})\.(\d{4})/);
  if (!m) return null;
  const gun = Number(m[1]), ay = Number(m[2]);
  if (ay < 1 || ay > 12 || gun < 1 || gun > 31) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

interface KkAnkor { index: number; end: number; kararNo: string }

function ankorlariBul(duz: string): KkAnkor[] {
  const kapanisSonlari: number[] = [];
  const kapanisRe = /(karar verildi|sunuldu|bilgi verildi)\.?/g;
  let km: RegExpExecArray | null;
  while ((km = kapanisRe.exec(duz))) kapanisSonlari.push(km.index + km[0].length);

  const ham: KkAnkor[] = [];
  const ankorRe = /(?:^|\s)((\d{4})[/lI](\d{1,4}))(?=\s)/g;
  let m: RegExpExecArray | null;
  while ((m = ankorRe.exec(duz))) {
    const numStart = m.index + (m[0].length - m[1].length);
    ham.push({ index: numStart, end: numStart + m[1].length, kararNo: `${m[2]}/${m[3]}` });
  }

  let ilkKabul = false;
  return ham.filter((a) => {
    if (!ilkKabul) { ilkKabul = true; return true; }
    return kapanisSonlari.some((k) => a.index >= k && a.index - k <= 12);
  });
}

function kararlariAyristir(duz: string, tarih: string, kaynakUrl: string): YerelKararSonucu[] {
  const ankorlar = ankorlariBul(duz);
  if (ankorlar.length === 0) return [];
  const kapanisRe = /(karar verildi|sunuldu|bilgi verildi)\.?/g;
  const sonuc: YerelKararSonucu[] = [];
  for (let i = 0; i < ankorlar.length; i++) {
    const baslangic = ankorlar[i].end;
    const bitis = i + 1 < ankorlar.length ? ankorlar[i + 1].index : duz.length;
    const blok = duz.slice(baslangic, bitis).trim();
    if (blok.length < ASGARI_KARAR_UZUNLUK) continue;
    const kapanisSayisi = [...blok.matchAll(kapanisRe)].length;
    if (kapanisSayisi > 1) continue;
    sonuc.push({
      belediye: 'Kırklareli', karar_no: ankorlar[i].kararNo, tarih, konu: null, metin: blok,
      oylama_sonucu: oylamaSonucuCikar(blok), kaynak_url: kaynakUrl,
    });
  }
  const sayac = new Map<string, number>();
  for (const k of sonuc) {
    const n = (sayac.get(k.karar_no ?? '') ?? 0) + 1;
    sayac.set(k.karar_no ?? '', n);
    if (n > 1) k.karar_no = `${k.karar_no}-${n}`;
  }
  return sonuc;
}

export async function fetchKirklareliKararlar(): Promise<YerelKararSonucu[]> {
  const listRes = await fetchWithBackoff(KARARLAR_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!listRes.ok) throw new Error(`[yerel-kirklareli] liste sayfası: HTTP ${listRes.status}`);
  const bloklar = bloklariCikar(await listRes.text());

  const sonuc: YerelKararSonucu[] = [];
  for (const b of bloklar) {
    if (!b.kararHref) continue;
    const baslikTarih = baslikTarihTahmini(b.yil, b.baslik);
    if (baslikTarih) { if (baslikTarih < BASLANGIC_TARIHI) continue; }
    else if (b.yil && `${b.yil}-12-31` < BASLANGIC_TARIHI) continue;

    const pdfUrl = b.kararHref.startsWith('http') ? b.kararHref : `${BASE}${b.kararHref}`;
    try {
      const pres = await fetchWithBackoff(pdfUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!pres.ok) { logger.error(`[yerel-kirklareli] PDF indirilemedi (${b.baslik}): HTTP ${pres.status}`); continue; }
      const metinHam = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
      const duz = metinHam.replace(/\s+/g, ' ').trim();
      if (duz.length < TARANMIS_GORUNTU_ESIGI) {
        logger.error(`[yerel-kirklareli] (${b.baslik}): metin katmanı yok/neredeyse yok (${duz.length} kr) — taranmış görüntü, OCR yapılmadı, atlandı`);
        continue;
      }

      let tarih = tarihiCikar(duz);
      if (!tarih) {
        if (!baslikTarih) { logger.error(`[yerel-kirklareli] (${b.baslik}): tarih hiçbir kaynaktan çıkarılamadı, atlandı`); continue; }
        tarih = baslikTarih;
      } else if (baslikTarih && tarih.slice(0, 7) !== baslikTarih.slice(0, 7)) {
        logger.error(`[yerel-kirklareli] (${b.baslik}): PDF içi tarih (${tarih}) başlıkla uyuşmuyor, başlığın ay/yılı kullanıldı`);
        tarih = baslikTarih;
      }
      if (tarih < BASLANGIC_TARIHI) continue;

      const kararlar = kararlariAyristir(duz, tarih, pdfUrl);
      if (kararlar.length === 0) {
        logger.error(`[yerel-kirklareli] (${b.baslik}): güvenilir karar sınırı bulunamadı (OCR/font bozukluğu olabilir), atlandı`);
      }
      sonuc.push(...kararlar);
    } catch (e) {
      logger.error(`[yerel-kirklareli] (${b.baslik}): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

export async function fetchKirklareliUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(MECLIS_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-kirklareli-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.member-card').each((_, kart) => {
    const $kart = $(kart);
    const ad = $kart.find('.member-name').first().text().replace(/\s+/g, ' ').trim();
    const hamParti = $kart.find('.party-badge').first().text().replace(/\s+/g, ' ').trim();
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Kırklareli', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
