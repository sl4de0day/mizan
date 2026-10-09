import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  pdfMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Sinop');

const SINOP_BASE = 'https://sinop.bel.tr';
const SINOP_KARARLAR_URL = `${SINOP_BASE}/meclis-kararlari/`;
const SINOP_UYELER_URL = `${SINOP_BASE}/meclis-uyeleri/`;
const SINOP_MAX_SAYFA = 60;

const TURKCE_AYLAR: Record<string, number> = {
  OCAK: 1, ŞUBAT: 2, MART: 3, NİSAN: 4, MAYIS: 5, HAZİRAN: 6,
  TEMMUZ: 7, AĞUSTOS: 8, EYLÜL: 9, EKİM: 10, KASIM: 11, ARALIK: 12,
};

interface SinopKart { tip: 'karar' | 'gundem'; yil: number; ay: number; href: string }

function rozetCoz(metin: string): { yil: number; ay: number } | null {
  const parcalar = metin.replace(/\s+/g, ' ').trim().split(' ');
  if (parcalar.length < 3) return null;
  const ay = TURKCE_AYLAR[parcalar[1]?.toLocaleUpperCase('tr')];
  const yil = Number(parcalar[2]);
  if (!ay || !Number.isFinite(yil)) return null;
  return { yil, ay };
}

function sayfaKartlariniCikar(html: string): SinopKart[] {
  const $ = cheerio.load(html);
  const sonuc: SinopKart[] = [];
  $('.mkr-card').each((_, el) => {
    const tipClass = $(el).find('.mkr-tip').attr('class') ?? '';
    const tip: SinopKart['tip'] = tipClass.includes('mkr-tip-gundem') ? 'gundem' : 'karar';
    const rozet = rozetCoz($(el).find('.mkr-tarih').text());
    const href = $(el).find('.mkr-btn-indir').attr('href');
    if (!rozet || !href) return;
    if (!/\.pdf$/i.test(href)) return;
    sonuc.push({ tip, yil: rozet.yil, ay: rozet.ay, href });
  });
  return sonuc;
}

const KARAR_BASLIK_RE = /MECLİS KARAR KAĞIDI\s*Karar Tarihi\s*:\s*(\d{2})\/(\d{2})\/(\d{4})\s*Karar Numarası\s*:\s*(\d+)/g;

function kararlaraBol(ham: string, kaynakUrl: string): YerelKararSonucu[] {
  const duz = ham.replace(/\s+/g, ' ').trim();
  const eslesmeler = [...duz.matchAll(KARAR_BASLIK_RE)];
  const sonuc: YerelKararSonucu[] = [];
  for (let i = 0; i < eslesmeler.length; i++) {
    const m = eslesmeler[i];
    const baslangic = (m.index ?? 0) + m[0].length;
    const bitis = i + 1 < eslesmeler.length ? eslesmeler[i + 1].index! : duz.length;
    const govde = duz.slice(baslangic, bitis).trim();
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    const [, gg, ay, yyyy, kararNo] = m;
    const tarih = `${yyyy}-${ay}-${gg}`;
    if (tarih < BASLANGIC_TARIHI) continue;
    sonuc.push({
      belediye: 'Sinop', karar_no: kararNo, tarih, konu: null, metin: govde,
      oylama_sonucu: oylamaSonucuCikar(govde), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

export async function fetchSinopKararlar(): Promise<YerelKararSonucu[]> {
  const [baslangicYil, baslangicAy] = BASLANGIC_TARIHI.split('-').map(Number);
  const baslangicSira = baslangicYil * 12 + baslangicAy;
  const sonuc: YerelKararSonucu[] = [];

  for (let sayfa = 1; sayfa <= SINOP_MAX_SAYFA; sayfa++) {
    const url = sayfa === 1 ? SINOP_KARARLAR_URL : `${SINOP_KARARLAR_URL}?p=${sayfa}`;
    const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 30000 }, 3);
    if (!res.ok) { logger.error(`[yerel-sinop] liste sayfası ${sayfa}: HTTP ${res.status}`); break; }
    const kartlar = sayfaKartlariniCikar(await res.text());
    if (kartlar.length === 0) break;

    let sayfaEnEskiSira = Infinity;
    for (const kart of kartlar) {
      sayfaEnEskiSira = Math.min(sayfaEnEskiSira, kart.yil * 12 + kart.ay);
      if (kart.tip === 'gundem') continue;

      const pdfUrl = kart.href.startsWith('http') ? kart.href : `${SINOP_BASE}${kart.href}`;
      try {
        const pres = await fetchWithBackoff(pdfUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
        if (!pres.ok) { logger.error(`[yerel-sinop] PDF indirilemedi: HTTP ${pres.status} — ${pdfUrl}`); continue; }
        const metin = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
        sonuc.push(...kararlaraBol(metin, pdfUrl));
      } catch (e) {
        logger.error(`[yerel-sinop] PDF hata (${pdfUrl}): ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 180));
    }

    if (sayfaEnEskiSira < baslangicSira) break;
  }

  return sonuc;
}

export async function fetchSinopUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(SINOP_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-sinop-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.mu-card').each((_, kart) => {
    const ad = $(kart).find('.mu-isim').text().replace(/\s+/g, ' ').trim();
    const hamParti = $(kart).find('.mu-rozet').text().replace(/\s+/g, ' ').trim();
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Sinop', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
