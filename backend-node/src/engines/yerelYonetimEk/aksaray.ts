import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  pdfMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Aksaray');

const AKSARAY_KARARLAR_URL = 'https://aksaray.bel.tr/MeclisKararlari.aspx';
const AKSARAY_UYELER_URL = 'https://aksaray.bel.tr/BelediyeMeclisi.aspx';
const TOPLAM_SAYFA = 9;

const AY_ISIMLERI: Record<string, string> = {
  ocak: '01', şubat: '02', mart: '03', nisan: '04', mayıs: '05', haziran: '06',
  temmuz: '07', ağustos: '08', eylül: '09', ekim: '10', kasım: '11', aralık: '12',
};

function baslikTarihiCikar(baslikMetni: string): string | null {
  const m = baslikMetni.match(/(\d{1,2})\s+([A-Za-zÇĞİıÖŞÜçğıiöşü]+)\s+(\d{4})/);
  if (!m) return null;
  const ay = AY_ISIMLERI[m[2].toLocaleLowerCase('tr')];
  if (!ay) return null;
  return `${m[3]}-${ay}-${m[1].padStart(2, '0')}`;
}

interface KararMarker { yil: string; sira: string; start: number; end: number }

function kararMarkerleriniBul(metin: string): KararMarker[] {
  const re = /(\d{4})-(\d{1,4}):\s*/g;
  const sonuc: KararMarker[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(metin))) {
    sonuc.push({ yil: m[1], sira: m[2], start: m.index, end: m.index + m[0].length });
  }
  return sonuc;
}

function kararlariAyristir(metin: string, kaynakUrl: string): YerelKararSonucu[] {
  const markerlar = kararMarkerleriniBul(metin);
  if (markerlar.length === 0) return [];
  const baslik = metin.slice(0, markerlar[0].start);
  const tarih = baslikTarihiCikar(baslik);
  if (!tarih || tarih < BASLANGIC_TARIHI) return [];

  const sonuc: YerelKararSonucu[] = [];
  for (let i = 0; i < markerlar.length; i++) {
    const marker = markerlar[i];
    const govdeSonu = i + 1 < markerlar.length ? markerlar[i + 1].start : metin.length;
    let govde = metin.slice(marker.end, govdeSonu).replace(/\s+/g, ' ').trim();
    const kapanisIdx = govde.indexOf('Son gündem maddesinde');
    if (kapanisIdx >= 0) govde = govde.slice(0, kapanisIdx).trim();
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({
      belediye: 'Aksaray', karar_no: `${marker.yil}-${marker.sira}`, tarih, konu: null, metin: govde,
      oylama_sonucu: oylamaSonucuCikar(govde), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

interface AksarayDonemGirdisi { yil: number; ay: number; pdfUrl: string }

function donemGirdileriniCikar(html: string): AksarayDonemGirdisi[] {
  const $ = cheerio.load(html);
  const sonuc: AksarayDonemGirdisi[] = [];
  $('.toggle-content').each((_, el) => {
    const donemMetni = $(el).find('p').first().text().replace(/\s+/g, ' ').trim();
    const pdfHref = $(el).find('a[href$=".pdf"]').first().attr('href');
    const m = donemMetni.match(/(\d{4})\s*\/\s*(\d{1,2})/);
    if (!m || !pdfHref) return;
    sonuc.push({
      yil: Number(m[1]), ay: Number(m[2]),
      pdfUrl: pdfHref.startsWith('http') ? pdfHref : `https://aksaray.bel.tr${pdfHref}`,
    });
  });
  return sonuc;
}

export async function fetchAksarayKararlar(): Promise<YerelKararSonucu[]> {
  const baslangicYil = Number(BASLANGIC_TARIHI.slice(0, 4));
  const baslangicAy = Number(BASLANGIC_TARIHI.slice(5, 7));
  const sonuc: YerelKararSonucu[] = [];
  const gorulenKarar = new Set<string>();

  sayfaDongusu:
  for (let sayfaNo = 1; sayfaNo <= TOPLAM_SAYFA; sayfaNo++) {
    const sayfaUrl = sayfaNo === 1 ? AKSARAY_KARARLAR_URL : `${AKSARAY_KARARLAR_URL}?sayfaNo=${sayfaNo}`;
    let html: string;
    try {
      const res = await fetchWithBackoff(sayfaUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!res.ok) { logger.error(`[yerel-aksaray] liste sayfa ${sayfaNo}: HTTP ${res.status}`); break; }
      html = await res.text();
    } catch (e) {
      logger.error(`[yerel-aksaray] liste sayfa ${sayfaNo}: ${(e as Error).message}`);
      break;
    }
    const girdiler = donemGirdileriniCikar(html);
    if (girdiler.length === 0) break;

    for (const g of girdiler) {
      if (g.yil < baslangicYil || (g.yil === baslangicYil && g.ay < baslangicAy)) break sayfaDongusu;
      try {
        const pres = await fetchWithBackoff(g.pdfUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
        if (!pres.ok) { logger.error(`[yerel-aksaray] PDF (${g.yil}/${g.ay}): HTTP ${pres.status}`); continue; }
        const metin = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
        for (const k of kararlariAyristir(metin, g.pdfUrl)) {
          const anahtar = `${k.karar_no}|${k.tarih}`;
          if (gorulenKarar.has(anahtar)) continue;
          gorulenKarar.add(anahtar);
          sonuc.push(k);
        }
      } catch (e) {
        logger.error(`[yerel-aksaray] PDF (${g.yil}/${g.ay}): ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 180));
    }
  }
  return sonuc;
}

export async function fetchAksarayUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(AKSARAY_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-aksaray-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  let mevcutParti: string | null = null;
  $('.col-md-9.col-sm-9 > *').each((_, el) => {
    const $el = $(el);
    if ($el.hasClass('heading-title') && $el.hasClass('heading-border-bottom')) {
      mevcutParti = $el.find('h4').first().text().replace(/\s+/g, ' ').trim() || null;
      return;
    }
    if (!$el.hasClass('row') || !$el.hasClass('mb-30')) return;
    $el.find('.thumbnail').each((__, kart) => {
      const ad = $(kart).find('.caption small').first().text().replace(/\s+/g, ' ').trim();
      if (!ad || !mevcutParti) return;
      const kanonik = normParti(mevcutParti);
      sonuc.push({ belediye: 'Aksaray', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? mevcutParti : kanonik, ilce: null });
    });
  });
  return sonuc;
}
