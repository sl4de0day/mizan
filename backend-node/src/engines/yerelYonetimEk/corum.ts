import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  pdfMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Corum');

const CORUM_BASE = 'https://www.corum.bel.tr';
const CORUM_KARARLAR_URL = `${CORUM_BASE}/meclis-kararlari`;
const CORUM_UYELER_URL = `${CORUM_BASE}/kurumsal/meclis/meclis-uyeleri`;

interface CorumSatir { tarih: string; kararNo: string | null; konu: string | null; pdfUrl: string }

function satirlariCikar($: cheerio.CheerioAPI): CorumSatir[] {
  const sonuc: CorumSatir[] = [];
  $('table.tbl-meclis-kararlari tbody tr').each((_, tr) => {
    const $tr = $(tr);
    const cells = $tr.find('td');
    if (cells.length < 4) return;
    const tarihHam = $(cells[0]).text().replace(/\s+/g, ' ').trim();
    const tm = tarihHam.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!tm) return;
    const tarih = `${tm[3]}-${tm[2]}-${tm[1]}`;
    const kararNo = $(cells[1]).text().replace(/\s+/g, ' ').trim() || null;
    const konu = $(cells[2]).find('.ozet-metin').first().text().replace(/\s+/g, ' ').trim() || null;
    const href = $(cells[3]).find('a.btn-indir[href]').attr('href');
    if (!href) return;
    const pdfUrl = href.startsWith('http') ? href : `${CORUM_BASE}${href}`;
    sonuc.push({ tarih, kararNo, konu, pdfUrl });
  });
  return sonuc;
}

const AZAMI_SAYFA = 40;

export async function fetchCorumKararlar(): Promise<YerelKararSonucu[]> {
  const sonuc: YerelKararSonucu[] = [];
  let dur = false;

  for (let sayfa = 1; sayfa <= AZAMI_SAYFA && !dur; sayfa++) {
    const url = sayfa === 1 ? CORUM_KARARLAR_URL : `${CORUM_KARARLAR_URL}?sayfa=${sayfa}`;
    const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 30000 }, 3);
    if (!res.ok) throw new Error(`[yerel-corum] sayfa ${sayfa}: HTTP ${res.status}`);
    const $ = cheerio.load(await res.text());
    const satirlar = satirlariCikar($);
    if (satirlar.length === 0) break;

    let sayfadaEski = false;
    for (const satir of satirlar) {
      if (satir.tarih < BASLANGIC_TARIHI) { sayfadaEski = true; continue; }
      try {
        const pres = await fetchWithBackoff(satir.pdfUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
        if (!pres.ok) {
          logger.error(`[yerel-corum] PDF indirilemedi (karar ${satir.kararNo}, ${satir.tarih}): HTTP ${pres.status}`);
        } else {
          const metinHam = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
          const metin = metinHam.replace(/\s+/g, ' ').trim();
          if (metin.length >= ASGARI_KARAR_UZUNLUK) {
            sonuc.push({
              belediye: 'Çorum', karar_no: satir.kararNo, tarih: satir.tarih, konu: satir.konu,
              metin, oylama_sonucu: oylamaSonucuCikar(metin), kaynak_url: satir.pdfUrl,
            });
          }
        }
      } catch (e) {
        logger.error(`[yerel-corum] karar ${satir.kararNo} (${satir.tarih}): ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 180));
    }
    if (sayfadaEski) { dur = true; break; }
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

export async function fetchCorumUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(CORUM_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-corum-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('a.meclis-uyesi').each((_, el) => {
    const $el = $(el);
    const ad = $el.find('.kisi-isim').first().text().replace(/\s+/g, ' ').trim();
    const hamParti = $el.find('.kisi-unvan').first().text().replace(/\s+/g, ' ').trim();
    if (!ad || !hamParti) return;
    if (hamParti.toLocaleLowerCase('tr').includes('ittifak')) {
      sonuc.push({ belediye: 'Çorum', ad_soyad: ad, parti: hamParti, ilce: null });
      return;
    }
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Çorum', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
