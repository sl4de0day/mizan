import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar, kararNoSiraDoldur,
  type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Bitlis');

const BITLIS_BASE = 'https://bitlis.bel.tr';
const BITLIS_KARARLAR_URL = `${BITLIS_BASE}/tum-meclis-kararlari/`;
const BITLIS_UYELER_URL = `${BITLIS_BASE}/meclis-uyeleri/`;
const NEZAKET_MS = 180;
const AZAMI_SAYFA = 100;

function bekle(): Promise<void> {
  return new Promise((r) => setTimeout(r, NEZAKET_MS));
}

const TR_AY_TAM: Record<string, string> = {
  ocak: '01', şubat: '02', mart: '03', nisan: '04', mayıs: '05', haziran: '06',
  temmuz: '07', ağustos: '08', eylül: '09', ekim: '10', kasım: '11', aralık: '12',
};

function yayinTarihiCikar(etiket: string): string | null {
  const m = etiket.trim().match(/^(\d{1,2})\s+(\S+)\s+(\d{4})$/);
  if (!m) return null;
  const ay = TR_AY_TAM[m[2].toLocaleLowerCase('tr')];
  if (!ay) return null;
  return `${m[3]}-${ay}-${m[1].padStart(2, '0')}`;
}

function gunEksilt(tarihISO: string, gun: number): string {
  const d = new Date(`${tarihISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - gun);
  return d.toISOString().slice(0, 10);
}

const YAYIN_ESIGI = gunEksilt(BASLANGIC_TARIHI, 60);

interface BitlisYazi { url: string; yayinTarihi: string | null }

function yaziListesiCikar($: cheerio.CheerioAPI): BitlisYazi[] {
  const sonuc: BitlisYazi[] = [];
  $('article.post-item').each((_, el) => {
    const href = $(el).find('.post-title a[href]').first().attr('href');
    if (!href) return;
    const etiket = $(el).find('.date_label').first().text();
    sonuc.push({ url: href, yayinTarihi: yayinTarihiCikar(etiket) });
  });
  return sonuc;
}

interface BitlisSatir { tarih: string; kararNo: string; metin: string }

const TARIH_RE = /^(\d{2})\.(\d{2})\.(\d{4})$/;

function kararSatirlariCikar($: cheerio.CheerioAPI): BitlisSatir[] {
  const sonuc: BitlisSatir[] = [];
  const govdeTablo = $('.post-wrapper-content table').first();
  const tablo = govdeTablo.length ? govdeTablo : $('table').first();
  tablo.find('tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 3) return;
    const tarihHam = $(tds[0]).text().replace(/\s+/g, ' ').trim();
    const tm = tarihHam.match(TARIH_RE);
    if (!tm) return;
    const kararNo = $(tds[1]).text().replace(/\s+/g, ' ').trim();
    const metin = $(tds[2]).text().replace(/\s+/g, ' ').trim();
    if (!kararNo || !metin) return;
    sonuc.push({ tarih: `${tm[3]}-${tm[2]}-${tm[1]}`, kararNo, metin });
  });
  return sonuc;
}

export async function fetchBitlisKararlar(): Promise<YerelKararSonucu[]> {
  const sonuc: YerelKararSonucu[] = [];
  const gorulenAnahtar = new Set<string>();
  let dur = false;

  for (let sayfa = 1; sayfa <= AZAMI_SAYFA && !dur; sayfa++) {
    const url = sayfa === 1 ? BITLIS_KARARLAR_URL : `${BITLIS_KARARLAR_URL}page/${sayfa}/`;
    let html: string;
    try {
      const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } catch (e) {
      logger.error(`[yerel-bitlis] liste sayfası ${sayfa}: ${(e as Error).message}`);
      break;
    }
    const $ = cheerio.load(html);
    const yazilar = yaziListesiCikar($);
    if (yazilar.length === 0) break;

    let sayfadaEski = false;
    for (const { url: yaziUrl, yayinTarihi } of yazilar) {
      const tamUrl = yaziUrl.startsWith('http') ? yaziUrl : `${BITLIS_BASE}${yaziUrl}`;
      if (yayinTarihi && yayinTarihi < YAYIN_ESIGI) { sayfadaEski = true; continue; }
      try {
        const yres = await fetchWithBackoff(tamUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
        if (!yres.ok) { logger.error(`[yerel-bitlis] yazı (${tamUrl}): HTTP ${yres.status}`); await bekle(); continue; }
        const y$ = cheerio.load(await yres.text());
        for (const satir of kararSatirlariCikar(y$)) {
          if (satir.tarih < BASLANGIC_TARIHI || satir.metin.length < ASGARI_KARAR_UZUNLUK) continue;
          const anahtar = `${satir.kararNo}|${satir.tarih}`;
          if (gorulenAnahtar.has(anahtar)) continue;
          gorulenAnahtar.add(anahtar);
          sonuc.push({
            belediye: 'Bitlis', karar_no: satir.kararNo, tarih: satir.tarih, konu: null,
            metin: satir.metin, oylama_sonucu: oylamaSonucuCikar(satir.metin), kaynak_url: tamUrl,
          });
        }
      } catch (e) {
        logger.error(`[yerel-bitlis] yazı (${tamUrl}): ${(e as Error).message}`);
      }
      await bekle();
    }
    if (sayfadaEski) dur = true;
    await bekle();
  }
  return kararNoSiraDoldur(sonuc);
}

const ROL_ETIKETLERI = new Set(['BAŞKAN', 'BAŞKAN VEKİLİ', 'MECLİS BAŞKANI', 'EŞ BAŞKAN', 'KÂTİP', 'KATİP', 'DİVAN KÂTİBİ']);

export async function fetchBitlisUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(BITLIS_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-bitlis-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  const gorulen = new Set<string>();
  $('.uc_special_layout_team_member').each((_, el) => {
    const $el = $(el);
    const hamParti = $el.find('.uc_member_profile span').first().text().replace(/\s+/g, ' ').trim();
    const ad = $el.find('.uc_name_block h4').first().text().replace(/\s+/g, ' ').trim();
    if (!ad || !hamParti) return;
    if (ROL_ETIKETLERI.has(hamParti.toLocaleUpperCase('tr'))) return;
    const anahtar = `${ad}|${hamParti}`;
    if (gorulen.has(anahtar)) return;
    gorulen.add(anahtar);
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Bitlis', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
