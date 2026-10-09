import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Aydin');

const AYDIN_BASE = 'https://aydin.bel.tr';
const AYDIN_LISTE_URL = `${AYDIN_BASE}/mobil/MeclisKararlari`;
const AYDIN_UYELER_URL = `${AYDIN_BASE}/mobil/detail/5118/meclis-uyeleri`;

const BASLIK_RE = /(\d{2})\.(\d{2})\.(\d{4})\s+TARİHLİ/g;
const KARAR_NO_RE = /Karar\s*No\s*:?\s*(\d+)/gi;

interface AydinBaslik { index: number; tarih: string }
interface AydinKararSatiri { kararNo: string; startIndex: number; endIndex: number }

function kararlariAyristir(duzMetin: string, kaynakUrl: string): YerelKararSonucu[] {
  const basliklar: AydinBaslik[] = [];
  let m: RegExpExecArray | null;
  BASLIK_RE.lastIndex = 0;
  while ((m = BASLIK_RE.exec(duzMetin))) basliklar.push({ index: m.index, tarih: `${m[3]}-${m[2]}-${m[1]}` });

  const satirlar: AydinKararSatiri[] = [];
  KARAR_NO_RE.lastIndex = 0;
  while ((m = KARAR_NO_RE.exec(duzMetin))) {
    satirlar.push({ kararNo: m[1], startIndex: m.index, endIndex: m.index + m[0].length });
  }

  const kesimNoktalari = [...satirlar.map((s) => s.startIndex), ...basliklar.map((b) => b.index)].sort((a, b) => a - b);
  function sinirdanSonra(pos: number): number {
    for (const kp of kesimNoktalari) if (kp > pos) return kp;
    return duzMetin.length;
  }

  const sonuc: YerelKararSonucu[] = [];
  for (const satir of satirlar) {
    let tarih: string | null = null;
    for (const b of basliklar) { if (b.index <= satir.startIndex) tarih = b.tarih; else break; }
    if (!tarih) continue;
    const govde = duzMetin.slice(satir.endIndex, sinirdanSonra(satir.endIndex)).replace(/\s+/g, ' ').trim();
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({
      belediye: 'Aydın', karar_no: satir.kararNo, tarih, konu: null, metin: govde,
      oylama_sonucu: oylamaSonucuCikar(govde), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

export async function fetchAydinKararlar(): Promise<YerelKararSonucu[]> {
  const sonuc: YerelKararSonucu[] = [];
  for (let page = 1; page <= 40; page++) {
    const listeUrl = page === 1 ? AYDIN_LISTE_URL : `${AYDIN_LISTE_URL}?page=${page}`;
    const listRes = await fetchWithBackoff(listeUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
    if (!listRes.ok) throw new Error(`[yerel-aydin] liste sayfası ${page}: HTTP ${listRes.status}`);
    const $ = cheerio.load(await listRes.text());
    const hrefler = new Set<string>();
    $('.kararListesi .list-group-item a[href^="detail/"]').each((_, el) => {
      const href = $(el).attr('href');
      if (href) hrefler.add(href);
    });
    if (!hrefler.size) break;
    await new Promise((r) => setTimeout(r, 180));

    let sayfadaGuncel = false;
    for (const href of hrefler) {
      const detayUrl = `${AYDIN_BASE}/mobil/${href}`;
      try {
        const dres = await fetchWithBackoff(detayUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
        if (!dres.ok) { logger.error(`[yerel-aydin] detay: HTTP ${dres.status} — ${detayUrl}`); continue; }
        const $$ = cheerio.load(await dres.text());
        const duzMetin = $$('#icerik').text().replace(/\s+/g, ' ').trim();
        if (!duzMetin) continue;
        const kararlar = kararlariAyristir(duzMetin, detayUrl);
        for (const k of kararlar) {
          if (k.tarih < BASLANGIC_TARIHI) continue;
          sayfadaGuncel = true;
          sonuc.push(k);
        }
      } catch (e) {
        logger.error(`[yerel-aydin] detay hata (${detayUrl}): ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 180));
    }
    if (!sayfadaGuncel) break;
  }
  return sonuc;
}

function unvanKirp(ad: string): string {
  return ad.replace(/\s*BELEDİYE BAŞKANI(\s+VEKİLİ)?\s*$/i, '').trim();
}

export async function fetchAydinUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(AYDIN_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-aydin-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.meclisBolum').each((_, bolum) => {
    const ilceHam = $(bolum).find('.bolumAdi').first().text().replace(/\s+/g, ' ').trim();
    const ilce = ilceHam.replace(/\s*BELED[İI]YES[İI]\s*$/i, '').trim() || null;
    $(bolum).find('td').each((_, td) => {
      const $td = $(td);
      if ($td.find('table').length) return;
      const tamMetin = $td.text().replace(/\s+/g, ' ').trim();
      if (!/Parti\s*:/.test(tamMetin)) return;
      const hamParti = tamMetin.replace(/^.*Parti\s*:\s*/i, '').trim();
      const ad = unvanKirp(tamMetin.replace(/Parti\s*:.*/i, '').trim());
      if (!ad || !hamParti) return;
      const kanonik = normParti(hamParti);
      sonuc.push({ belediye: 'Aydın', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce });
    });
  });
  return sonuc;
}
