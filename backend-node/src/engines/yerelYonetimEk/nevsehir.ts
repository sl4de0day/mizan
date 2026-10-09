import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Nevsehir');

const NEZAKET_MS = 180;
function bekle(): Promise<void> {
  return new Promise((r) => setTimeout(r, NEZAKET_MS));
}

interface NevsehirKararOzetKaynagi {
  yil: number;
  ay: string;
  ayAdi: string;
  waybackUrl: string;
}
const NEVSEHIR_KARAR_OZET_KAYNAKLARI: readonly NevsehirKararOzetKaynagi[] = [
  {
    yil: 2024, ay: '08', ayAdi: 'Ağustos',
    waybackUrl: 'https://web.archive.org/web/20240909202128/https://nevsehir.bel.tr/makale-detay/9586/2024-agustos-ayi-meclis-karar-ozetleri',
  },
  {
    yil: 2024, ay: '09', ayAdi: 'Eylül',
    waybackUrl: 'https://web.archive.org/web/20241103193333/https://nevsehir.bel.tr/makale-detay/9662/2024-eylul-ayi-meclis-karar-ozetleri',
  },
];

const BIR_SONRAKI_TOPLANTI_RE = /bir\s+sonraki\s+meclis\s+toplant/iu;
const TOPLANTI_KAPANIS_RE = /toplant[ıi]ya\s+son\s+verildi/iu;
const GUNDEM_RE = /G[üu]ndem\s*:\s*(\d+)/giu;

function kararlaraBol(duzMetin: string): { kararNo: string; metin: string }[] {
  let kapanisIdx = duzMetin.length;
  const m1 = BIR_SONRAKI_TOPLANTI_RE.exec(duzMetin);
  const m2 = TOPLANTI_KAPANIS_RE.exec(duzMetin);
  if (m1) kapanisIdx = Math.min(kapanisIdx, m1.index);
  if (m2) kapanisIdx = Math.min(kapanisIdx, m2.index);
  const govde = duzMetin.slice(0, kapanisIdx);

  const eslesmeler = [...govde.matchAll(GUNDEM_RE)];
  const sonuc: { kararNo: string; metin: string }[] = [];
  for (let i = 0; i < eslesmeler.length; i++) {
    const m = eslesmeler[i]!;
    const baslangic = m.index + m[0].length;
    const bitis = i + 1 < eslesmeler.length ? eslesmeler[i + 1]!.index : govde.length;
    const metin = govde.slice(baslangic, bitis).trim();
    sonuc.push({ kararNo: m[1]!, metin });
  }
  return sonuc;
}

async function waybackGetir(url: string, deneme = 6): Promise<string | null> {
  for (let i = 0; i < deneme; i++) {
    try {
      const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (res.ok) return res.text();
      if (i === deneme - 1) logger.error(`[yerel-nevsehir] Wayback kalıcı hata: HTTP ${res.status} — ${url}`);
    } catch (e) {
      if (i === deneme - 1) logger.error(`[yerel-nevsehir] Wayback kalıcı hata: ${(e as Error).message} — ${url}`);
    }
    if (i < deneme - 1) await new Promise((r) => setTimeout(r, 8000 * (i + 1)));
  }
  return null;
}

export async function fetchNevsehirKararlar(): Promise<YerelKararSonucu[]> {
  const sonuc: YerelKararSonucu[] = [];
  for (const kaynak of NEVSEHIR_KARAR_OZET_KAYNAKLARI) {
    const tarih = `${kaynak.yil}-${kaynak.ay}-01`;
    if (tarih < BASLANGIC_TARIHI) continue;
    await bekle();
    try {
      const html = await waybackGetir(kaynak.waybackUrl);
      if (!html) continue;
      const $ = cheerio.load(html);
      const gövdeMetni = $('.news-details .new-txt').first().text().replace(/\s+/g, ' ').trim();
      if (!gövdeMetni) { logger.error(`[yerel-nevsehir] ${kaynak.ayAdi} ${kaynak.yil}: gövde boş (.news-details .new-txt bulunamadı)`); continue; }
      for (const { kararNo, metin } of kararlaraBol(gövdeMetni)) {
        if (metin.length < ASGARI_KARAR_UZUNLUK) continue;
        sonuc.push({
          belediye: 'Nevşehir', karar_no: kararNo, tarih, konu: null, metin,
          oylama_sonucu: oylamaSonucuCikar(metin), kaynak_url: kaynak.waybackUrl,
        });
      }
    } catch (e) {
      logger.error(`[yerel-nevsehir] ${kaynak.ayAdi} ${kaynak.yil}: ${(e as Error).message}`);
    }
  }
  return sonuc;
}

const NEVSEHIR_UYELER_URL = 'https://www.nevsehir.bel.tr/nevsehir-belediyesi-meclis-uyeleri';

const NEVSEHIR_PARTI_LOGO: Record<string, string> = {
  akparti: 'AK Parti', iyiparti: 'İYİ Parti', mhp: 'MHP',
};

export async function fetchNevsehirUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(NEVSEHIR_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-nevsehir-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('div.team-box').each((_, kart) => {
    const ad = $(kart).find('h5').first().text().replace(/\s+/g, ' ').trim();
    const imgSrc = $(kart).find('.team-social img').first().attr('src');
    let hamParti: string | null = null;
    if (imgSrc) {
      const m = imgSrc.match(/([a-z0-9_]+)\.(?:png|jpe?g)(?:$|\?)/i);
      hamParti = (m && NEVSEHIR_PARTI_LOGO[m[1]!.toLowerCase()]) || null;
    }
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({
      belediye: 'Nevşehir', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null,
    });
  });
  return sonuc;
}
