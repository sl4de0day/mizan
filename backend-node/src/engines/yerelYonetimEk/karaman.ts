import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  pdfMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Karaman');

const KARAMAN_BASE = 'https://www.karaman.bel.tr';
const KARAMAN_KARARLAR_URL = `${KARAMAN_BASE}/Dokumanlar/27/Meclis-Kararlari.aspx`;
const KARAMAN_UYELER_URL = `${KARAMAN_BASE}/Menu/21/MeclisUyeleri.aspx`;

async function fetchDecodedHtml(
  url: string,
  ekOpts: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<string> {
  const { headers: ekHeaders, ...digerOpts } = ekOpts;
  const res = await fetchWithBackoff(url, { headers: { ...HEADERS, ...ekHeaders }, timeoutMs: 30000, ...digerOpts }, 3);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return new TextDecoder('windows-1254').decode(buf);
}

function gizliAlanlariCikar($: cheerio.CheerioAPI): Record<string, string> {
  const out: Record<string, string> = {};
  $('input[type=hidden]').each((_, el) => {
    const name = $(el).attr('name');
    if (name) out[name] = $(el).attr('value') || '';
  });
  return out;
}

interface KaramanSatirOzet { baslik: string; tarih: string | null; pdfUrl: string }

function satirlariCikar($: cheerio.CheerioAPI): KaramanSatirOzet[] {
  const sonuc: KaramanSatirOzet[] = [];
  $('#ctl00_cpmIcerik_gvListe tr').each((_, tr) => {
    const $tr = $(tr);
    const baslik = $tr.find('.post-media_title').first().text().replace(/\s+/g, ' ').trim();
    const onclick = $tr.find('a[onclick*="pdfGoster"]').first().attr('onclick') || '';
    const m = onclick.match(/pdfGoster\('([^']+)'\)/);
    if (!baslik || !m) return;
    const tarihHam = $tr.find('.post-date').first().text().replace(/\s+/g, ' ').trim();
    const tm = tarihHam.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    const tarih = tm ? `${tm[3]}-${tm[2]}-${tm[1]}` : null;
    const href = m[1];
    const pdfUrl = href.startsWith('http') ? href : `${KARAMAN_BASE}${href}`;
    sonuc.push({ baslik, tarih, pdfUrl });
  });
  return sonuc;
}

function toplantiBasliklariniBul(metin: string): { index: number; tarih: string }[] {
  const re = /TOPLANTI\s*TARİHİ\s*:?\s*(\d{2})\.(\d{2})\.(\d{4})/g;
  const sonuc: { index: number; tarih: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(metin))) {
    sonuc.push({ index: m.index, tarih: `${m[3]}-${m[2]}-${m[1]}` });
  }
  return sonuc;
}

interface KaramanMadde { no: string; startIndex: number; bodyStart: number }

function maddeleriBul(metin: string): KaramanMadde[] {
  const re = /(?:^|\s)(?:KARAR|BİLGİ)\s*-\s*(\d{1,4})\s*/g;
  const sonuc: KaramanMadde[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(metin))) {
    sonuc.push({ no: m[1], startIndex: m.index, bodyStart: m.index + m[0].length });
  }
  return sonuc;
}

function kararlariAyristir(metin: string, kaynakUrl: string): YerelKararSonucu[] {
  const basliklar = toplantiBasliklariniBul(metin);
  const maddeler = maddeleriBul(metin);
  const sonuc: YerelKararSonucu[] = [];
  for (let i = 0; i < maddeler.length; i++) {
    const madde = maddeler[i];
    const govdeSonu = i + 1 < maddeler.length ? maddeler[i + 1].startIndex : metin.length;
    const govde = metin.slice(madde.bodyStart, govdeSonu).replace(/\s+/g, ' ').trim();
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    let tarih: string | null = null;
    for (const b of basliklar) {
      if (b.index <= madde.startIndex) tarih = b.tarih; else break;
    }
    if (!tarih || tarih < BASLANGIC_TARIHI) continue;
    sonuc.push({
      belediye: 'Karaman', karar_no: madde.no, tarih, konu: null, metin: govde,
      oylama_sonucu: oylamaSonucuCikar(govde), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

const AZAMI_SAYFA = 30;

export async function fetchKaramanKararlar(): Promise<YerelKararSonucu[]> {
  const sonuc: YerelKararSonucu[] = [];
  let html = await fetchDecodedHtml(KARAMAN_KARARLAR_URL);
  let $ = cheerio.load(html);
  let sayfaNo = 1;
  let dur = false;

  let oncekiIlkBaslik: string | null = null;
  while (!dur && sayfaNo <= AZAMI_SAYFA) {
    const satirlar = satirlariCikar($);
    if (satirlar.length === 0) break;
    if (sayfaNo > 1 && satirlar[0].baslik === oncekiIlkBaslik) {
      logger.error(`[yerel-karaman] sayfa ${sayfaNo} bir öncekiyle AYNI (postback ilerlemedi) — durduruldu`);
      break;
    }
    oncekiIlkBaslik = satirlar[0].baslik;

    for (const satir of satirlar) {
      const sinirGecildiMi = satir.tarih !== null && satir.tarih < BASLANGIC_TARIHI;
      try {
        const pres = await fetchWithBackoff(satir.pdfUrl, { headers: HEADERS, timeoutMs: 45000 }, 3);
        if (!pres.ok) {
          logger.error(`[yerel-karaman] PDF indirilemedi (${satir.baslik}): HTTP ${pres.status}`);
        } else {
          const metin = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
          sonuc.push(...kararlariAyristir(metin, satir.pdfUrl));
        }
      } catch (e) {
        logger.error(`[yerel-karaman] (${satir.baslik}): ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 180));

      if (sinirGecildiMi) { dur = true; break; }
    }
    if (dur) break;

    sayfaNo++;
    const hidden = gizliAlanlariCikar($);
    const body = new URLSearchParams({
      ...hidden,
      __EVENTTARGET: 'ctl00$cpmIcerik$gvListe',
      __EVENTARGUMENT: `Page$${sayfaNo}`,
    });
    try {
      html = await fetchDecodedHtml(KARAMAN_KARARLAR_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: body.toString(),
      });
    } catch (e) {
      logger.error(`[yerel-karaman] sayfa ${sayfaNo} postback: ${(e as Error).message}`);
      break;
    }
    $ = cheerio.load(html);
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

export async function fetchKaramanUyeler(): Promise<YerelUyeSonucu[]> {
  const html = await fetchDecodedHtml(KARAMAN_UYELER_URL);
  const $ = cheerio.load(html);
  const sonuc: YerelUyeSonucu[] = [];
  $('.team').each((_, el) => {
    const $el = $(el);
    const ad = $el.find('.team-info h5 a').first().text().replace(/\s+/g, ' ').trim();
    const hamParti = $el.find('.team-info .text-dark').first().text().replace(/\s+/g, ' ').trim();
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Karaman', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
