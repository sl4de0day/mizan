import * as cheerio from 'cheerio';
import {
  type YerelKararSonucu, type YerelUyeSonucu, BASLANGIC_TARIHI, oylamaSonucuCikar,
  ASGARI_KARAR_UZUNLUK, HEADERS, fetchWithBackoff, pdfMetinCikar,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Kocaeli');

const KOCAELI_LOADER = 'https://www.kocaeli.bel.tr/theme/kbb/council_document_loader.php';
const KOCAELI_LISTE_SAYFA = 'https://www.kocaeli.bel.tr/meclis-karar-ozetleri.html';
const KOCAELI_UYELER_URL = 'https://www.kocaeli.bel.tr/belediye-meclis-uyeleri.html';

interface KocaeliLoaderYanit { status: number; html: string }

async function kocaeliListeParcasi(start: number, offset: number): Promise<{ href: string; etiket: string }[]> {
  const body = new URLSearchParams({ start: String(start), offset: String(offset), category: '1', category_name: 'Döküman' });
  const res = await fetchWithBackoff(KOCAELI_LOADER, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Referer: KOCAELI_LISTE_SAYFA },
    body: body.toString(), timeoutMs: 30000,
  }, 3);
  if (!res.ok) throw new Error(`[yerel-kocaeli] liste start=${start}: HTTP ${res.status}`);
  const j = await res.json() as KocaeliLoaderYanit;
  if (!j.html) return [];
  const $ = cheerio.load(j.html);
  return $('a[href]').toArray().map((el) => ({
    href: $(el).attr('href') ?? '',
    etiket: $(el).text().replace(/\s+/g, ' ').trim(),
  }));
}

async function kocaeliPdfUrlBul(detaySayfaUrl: string): Promise<string | null> {
  const res = await fetchWithBackoff(detaySayfaUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) { logger.error(`[yerel-kocaeli] detay sayfası HTTP ${res.status} (${detaySayfaUrl})`); return null; }
  const $ = cheerio.load(await res.text());
  const href = $('.content_text a[href$=".pdf"]').first().attr('href') || $('a[href$=".pdf"]').first().attr('href');
  if (!href) return null;
  return href.startsWith('http') ? href : `https://www.kocaeli.bel.tr${href}`;
}

function kocaeliMetinTemizle(ham: string): string {
  return ham
    .replace(/Belge Doğrulama Kodu:\s*\S+\s*Belge Doğrulama Adresi:\s*\S+\s*Bu belge, güvenli elektronik imza ile imzalanmıştır\./g, ' ')
    .replace(/T\.C\.\s*KOCAELİ BÜYÜKŞEHİR BELEDİYE MECLİSİ[^\n]*?Karar Özet(?:i|leri)/g, ' ')
    .replace(/Sayfa\s+\d+\s*\/\s*\d+/g, ' ')
    .replace(/\bGÜNDEM\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const KARAR_NO_RE = /\(\s*Karar\s*No\s*:?\s*(\d{4}\/\d+)\s*\)/g;
const GUNDEM_KONU_RE = /Gündem\s+No:?\s*\d+\s*-\s*([^;]{1,300})/;

function kocaeliKararlariAyikla(pdfMetin: string, tarih: string, kaynakUrl: string): YerelKararSonucu[] {
  const temiz = kocaeliMetinTemizle(pdfMetin);
  const eslesmeler = [...temiz.matchAll(KARAR_NO_RE)];
  const sonuc: YerelKararSonucu[] = [];
  let son = 0;
  for (const m of eslesmeler) {
    const bitis = (m.index ?? 0) + m[0].length;
    const blok = temiz.slice(son, bitis).trim();
    son = bitis;
    if (blok.length < ASGARI_KARAR_UZUNLUK) continue;
    const konuEslesme = blok.match(GUNDEM_KONU_RE);
    sonuc.push({
      belediye: 'Kocaeli', karar_no: m[1], tarih,
      konu: konuEslesme ? konuEslesme[1].trim() : null,
      metin: blok, oylama_sonucu: oylamaSonucuCikar(blok), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

async function kocaeliBelgeIsle(href: string, tarih: string): Promise<YerelKararSonucu[]> {
  const pdfUrl = /\.pdf$/i.test(href) ? href : await kocaeliPdfUrlBul(href);
  if (!pdfUrl) { logger.error(`[yerel-kocaeli] PDF linki bulunamadı: ${href}`); return []; }
  const pres = await fetchWithBackoff(pdfUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!pres.ok) { logger.error(`[yerel-kocaeli] PDF indirilemedi (${tarih}): HTTP ${pres.status} (${pdfUrl})`); return []; }
  const metin = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
  const kararlar = kocaeliKararlariAyikla(metin, tarih, pdfUrl);
  if (!kararlar.length) logger.error(`[yerel-kocaeli] PDF'ten karar çıkarılamadı (${tarih}): ${pdfUrl}`);
  return kararlar;
}

export async function fetchKocaeliKararlar(): Promise<YerelKararSonucu[]> {
  const sonuc: YerelKararSonucu[] = [];
  let start = 0;
  const offset = 60;
  let dur = false;
  while (!dur) {
    const oge = await kocaeliListeParcasi(start, offset);
    if (!oge.length) break;
    for (const { href, etiket } of oge) {
      if (!/^https?:\/\//i.test(href)) continue;
      const m = etiket.match(/(\d{2})\.(\d{2})\.(\d{4})/);
      if (!m) continue;
      const tarih = `${m[3]}-${m[2]}-${m[1]}`;
      if (tarih < BASLANGIC_TARIHI) { dur = true; break; }
      try {
        sonuc.push(...await kocaeliBelgeIsle(href, tarih));
      } catch (e) {
        logger.error(`[yerel-kocaeli] ${tarih} (${href}): ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 180));
    }
    start += offset;
  }
  return sonuc;
}

export async function fetchKocaeliUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(KOCAELI_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-kocaeli-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  let hamParti: string | null = null;
  $('div.row.news_two_items').first().children('div').each((_, el) => {
    const $el = $(el);
    const baslik = $el.find('span.card[style*="font-weight:600"]');
    if (baslik.length) { hamParti = baslik.text().replace(/\s+/g, ' ').trim(); return; }
    const kart = $el.find('a.card').first();
    if (!kart.length) return;
    const ad = kart.find('h4.card-title').first().text().replace(/\s+/g, ' ').trim();
    const ilce = kart.find('.icon-location-pin').parent().text().replace(/\s+/g, ' ').trim() || null;
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Kocaeli', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce });
  });
  return sonuc;
}
