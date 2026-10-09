import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Nigde');

const NIGDE_BASE = 'https://nigde.bel.tr';
const NIGDE_DUYURU_AJAX = `${NIGDE_BASE}/ISAYWebPart/BAnouncement/BAnnouncementDahaFazlaYukle`;
const NIGDE_DUYURU_CONTENT_TYPE_ID = 'mQfTU6uZRtdkon1JHePP/A==';
const NIGDE_UYELER_URL = `${NIGDE_BASE}/belediye-meclis-uyeleri`;

interface NigdeDuyuruSatiri { href: string; baslik: string }

function duyuruHrefTamla(href: string): string {
  if (href.startsWith('http')) return href;
  if (href.startsWith('//')) return `https:${href}`;
  return `${NIGDE_BASE}${href.startsWith('/') ? '' : '/'}${href}`;
}

function meclisKararOzetiMi(href: string): boolean {
  const h = href.toLowerCase();
  return h.includes('meclis') && /ozeti\/?$/.test(h) && !h.includes('gundem');
}

async function meclisKararOzetiAdaylariniTopla(): Promise<NigdeDuyuruSatiri[]> {
  const sonuc: NigdeDuyuruSatiri[] = [];
  for (let page = 1; page <= 100; page++) {
    const res = await fetchWithBackoff(NIGDE_DUYURU_AJAX, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        page, ContentTypeId: NIGDE_DUYURU_CONTENT_TYPE_ID, OrderByAsc: 'true', ContentCount: '10', altClass: '',
      }),
      timeoutMs: 30000,
    }, 3);
    if (!res.ok) throw new Error(`[yerel-nigde] duyuru sayfası ${page}: HTTP ${res.status}`);
    const html = await res.text();
    if (!html.trim()) break;
    const $ = cheerio.load(html);
    const satirlar = $('li a[href]').toArray().map((el) => ({
      href: duyuruHrefTamla($(el).attr('href') ?? ''),
      baslik: $(el).text().replace(/\s+/g, ' ').trim(),
    }));
    if (!satirlar.length) break;
    for (const s of satirlar) if (meclisKararOzetiMi(s.href)) sonuc.push(s);
    await new Promise((r) => setTimeout(r, 150));
  }
  return sonuc;
}

const KARAR_BASLIK_RE = /Karar\s*Tarihi\s*:?\s*(\d{2})\.(\d{2})\.(\d{4})\s*Karar\s*No\s*:?\s*(\d+)/g;

function kararlariAyristir(metin: string, kaynakUrl: string): YerelKararSonucu[] {
  const basliklar: { index: number; matchEnd: number; tarih: string; kararNo: string }[] = [];
  let m: RegExpExecArray | null;
  KARAR_BASLIK_RE.lastIndex = 0;
  while ((m = KARAR_BASLIK_RE.exec(metin))) {
    const [, gg, aa, yyyy, kararNo] = m;
    basliklar.push({ index: m.index, matchEnd: m.index + m[0].length, tarih: `${yyyy}-${aa}-${gg}`, kararNo });
  }
  const sonuc: YerelKararSonucu[] = [];
  for (let i = 0; i < basliklar.length; i++) {
    const b = basliklar[i];
    if (b.tarih < BASLANGIC_TARIHI) continue;
    const govdeSonu = i + 1 < basliklar.length ? basliklar[i + 1].index : metin.length;
    const govde = metin.slice(b.matchEnd, govdeSonu).replace(/\s+/g, ' ').trim();
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({
      belediye: 'Niğde', karar_no: b.kararNo, tarih: b.tarih, konu: null, metin: govde,
      oylama_sonucu: oylamaSonucuCikar(govde), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

export async function fetchNigdeKararlar(): Promise<YerelKararSonucu[]> {
  const adaylar = await meclisKararOzetiAdaylariniTopla();
  const sonuc: YerelKararSonucu[] = [];
  for (const { href, baslik } of adaylar) {
    try {
      const res = await fetchWithBackoff(href, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!res.ok) { logger.error(`[yerel-nigde] duyuru (${baslik}): HTTP ${res.status}`); continue; }
      const $ = cheerio.load(await res.text());
      const metin = $('.icerik').text();
      if (!metin || !metin.trim()) { logger.error(`[yerel-nigde] duyuru (${baslik}): .icerik boş`); continue; }
      sonuc.push(...kararlariAyristir(metin, href));
    } catch (e) {
      logger.error(`[yerel-nigde] duyuru (${baslik}): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

export async function fetchNigdeUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(NIGDE_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-nigde-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.manager-vertical-card').each((_, kart) => {
    const ad = $(kart).find('.manager-name').first().text().replace(/\s+/g, ' ').trim();
    const pMetin = $(kart).find('p').first().text().replace(/\s+/g, ' ').trim();
    const partiMatch = pMetin.match(/^(.+?)\s+\d{4}\s+/);
    if (!ad || !partiMatch) return;
    const hamParti = partiMatch[1].trim();
    if (!hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Niğde', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
