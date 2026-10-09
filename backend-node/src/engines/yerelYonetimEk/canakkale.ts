import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Canakkale');

const CANAKKALE_KARARLAR_URL = 'https://canakkale.bel.tr/tr/sayfa/1192-meclis-karar-ozetleri';
const CANAKKALE_UYELER_URL = 'https://canakkale.bel.tr/tr/sayfa/1189-belediye-meclis-uyeleri';

const AY_ISIMLERI: Record<string, number> = {
  ocak: 1, şubat: 2, mart: 3, nisan: 4, mayıs: 5, haziran: 6,
  temmuz: 7, ağustos: 8, eylül: 9, ekim: 10, kasım: 11, aralık: 12,
};

function baslikYilAy(baslik: string): { yil: number; ay: number } | null {
  const yilM = baslik.match(/\b(20\d{2})\b/);
  if (!yilM) return null;
  const duz = baslik.toLocaleLowerCase('tr');
  for (const [ad, ay] of Object.entries(AY_ISIMLERI)) {
    if (duz.includes(ad)) return { yil: Number(yilM[1]), ay };
  }
  return null;
}

function tarihCikar(girisMetni: string): string | null {
  const m = girisMetni.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

const KARAR_MARKER_RE = /^(?:\s|&nbsp;)*<strong[^>]*>(?:\s|&nbsp;)*(?:KARAR(?:\s|&nbsp;)*NO)?(?:\s|&nbsp;)*:?(?:\s|&nbsp;)*(\d{1,4})\b/i;
const KARAR_ONEK_RE = /^(?:KARAR\s*NO)?\s*:?\s*\d{1,4}\b[.:]?\s*/i;

interface AcikKarar { sira: string; parcalar: string[] }

function kararlariAyristir(
  $: cheerio.CheerioAPI, icerik: ReturnType<cheerio.CheerioAPI>, kaynakUrl: string,
  baslikYilAy: { yil: number; ay: number },
): YerelKararSonucu[] {
  const girisParcalari: string[] = [];
  const kararlar: AcikKarar[] = [];
  let acik: AcikKarar | null = null;

  icerik.find('p').each((_, p) => {
    const $p = $(p);
    const ph = $p.html() || '';
    const marker = KARAR_MARKER_RE.exec(ph);
    const metin = $p.text().replace(/\s+/g, ' ').trim();
    if (marker) {
      acik = { sira: marker[1], parcalar: [metin.replace(KARAR_ONEK_RE, '')] };
      kararlar.push(acik);
    } else if (metin) {
      if (acik) acik.parcalar.push(metin); else girisParcalari.push(metin);
    }
  });

  const tarih = tarihCikar(girisParcalari.join(' '))
    ?? `${baslikYilAy.yil}-${String(baslikYilAy.ay).padStart(2, '0')}-01`;
  if (tarih < BASLANGIC_TARIHI) return [];

  const sonuc: YerelKararSonucu[] = [];
  for (let i = 0; i < kararlar.length; i++) {
    let govde = kararlar[i].parcalar.join(' ').replace(/\s+/g, ' ').trim();
    if (i === kararlar.length - 1) {
      const isaretler = ['Belediye Başkanı', 'Meclis Birinci Başkan Vekili', 'Meclis İkinci Başkan Vekili', 'Meclis I. Başkan Vekili', 'Meclis II. Başkan Vekili', 'Başkan Vekili'];
      let kesIdx = -1;
      for (const im of isaretler) { const idx = govde.lastIndexOf(im); if (idx > kesIdx) kesIdx = idx; }
      if (kesIdx >= 0) govde = govde.slice(0, kesIdx).trim();
    }
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({
      belediye: 'Çanakkale', karar_no: `${tarih.slice(0, 4)}/${kararlar[i].sira}`, tarih, konu: null,
      metin: govde, oylama_sonucu: oylamaSonucuCikar(govde), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

export async function fetchCanakkaleKararlar(): Promise<YerelKararSonucu[]> {
  const listRes = await fetchWithBackoff(CANAKKALE_KARARLAR_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!listRes.ok) throw new Error(`[yerel-canakkale] liste sayfası: HTTP ${listRes.status}`);
  const $liste = cheerio.load(await listRes.text());
  const baslangicYil = Number(BASLANGIC_TARIHI.slice(0, 4));
  const baslangicAy = Number(BASLANGIC_TARIHI.slice(5, 7));

  const girdiler: { href: string; baslik: string }[] = [];
  const gorulenHref = new Set<string>();
  $liste('a[href*="/1192-meclis-karar-ozetleri/"]').each((_, el) => {
    const href = $liste(el).attr('href');
    const baslik = $liste(el).find('h2').first().text().replace(/\s+/g, ' ').trim();
    if (!href || !baslik || gorulenHref.has(href)) return;
    gorulenHref.add(href);
    girdiler.push({ href, baslik });
  });

  const sonuc: YerelKararSonucu[] = [];
  const gorulenKarar = new Set<string>();
  for (const { href, baslik } of girdiler) {
    const ya = baslikYilAy(baslik);
    if (!ya) { logger.error(`[yerel-canakkale] başlıktan yıl/ay çıkarılamadı, atlanıyor: "${baslik}"`); continue; }
    if (ya.yil < baslangicYil || (ya.yil === baslangicYil && ya.ay < baslangicAy)) continue;

    const detayUrl = href.startsWith('http') ? href : `https://canakkale.bel.tr/${href}`;
    try {
      const dres = await fetchWithBackoff(detayUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!dres.ok) { logger.error(`[yerel-canakkale] detay (${baslik}): HTTP ${dres.status}`); continue; }
      const $ = cheerio.load(await dres.text());
      const icerik = $('.sayfa_yazi_alani').first();
      if (icerik.length === 0) { logger.error(`[yerel-canakkale] içerik alanı (.sayfa_yazi_alani) bulunamadı: "${baslik}"`); continue; }
      const kararlar = kararlariAyristir($, icerik, detayUrl, ya);
      for (const k of kararlar) {
        const anahtar = `${k.karar_no}|${k.tarih}`;
        if (gorulenKarar.has(anahtar)) continue;
        gorulenKarar.add(anahtar);
        sonuc.push(k);
      }
    } catch (e) {
      logger.error(`[yerel-canakkale] (${baslik}): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

export async function fetchCanakkaleUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(CANAKKALE_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-canakkale-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.link_baslik .proje_tab_link[id$="-tab"]').each((_, sekme) => {
    const id = ($(sekme).attr('id') || '').replace(/-tab$/, '');
    const partiAdi = $(sekme).text().replace(/\s+/g, ' ').trim();
    if (!id || !partiAdi) return;
    const kanonik = normParti(partiAdi);
    $(`.proje_tab#${id} .meclis_uye_kapsayici`).each((__, kart) => {
      const ad = $(kart).find('h3').first().text().replace(/\s+/g, ' ').trim();
      if (!ad) return;
      sonuc.push({ belediye: 'Çanakkale', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? partiAdi : kanonik, ilce: null });
    });
  });
  return sonuc;
}
