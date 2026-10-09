import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Malatya');

const MALATYA_DIZIN_URL = 'https://www.malatya.bel.tr/sayfalar/meclis-karar-ozetleri';
const MALATYA_UYELER_URL = 'https://www.malatya.bel.tr/meclis-uyeleri';

interface YilSayfa { yil: number; url: string }

async function yilSayfalariniBul(): Promise<YilSayfa[]> {
  const res = await fetchWithBackoff(MALATYA_DIZIN_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-malatya] yıl dizini: HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const baslangicYil = Number(BASLANGIC_TARIHI.slice(0, 4));
  const gorulen = new Map<number, string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const m = href.match(/\/sayfa\/(\d{4})[a-z0-9-]*meclis-karar[a-z0-9-]*/i);
    if (!m) return;
    const yil = Number(m[1]);
    if (yil < baslangicYil) return;
    const url = href.startsWith('http') ? href : `https://www.malatya.bel.tr${href}`;
    gorulen.set(yil, url);
  });
  return [...gorulen.entries()].map(([yil, url]) => ({ yil, url })).sort((a, b) => a.yil - b.yil);
}

const OTURUM_BASLIK = /(?:MALATYA\s+B[Üü]Y[Üü]KŞEHİR\s+BELEDİYE\s+MECLİSİ\s*)?(\d{2})\.(\d{2})\.(\d{4})\s*TARİHLİ[^0-9]{0,30}KARAR\s*(?:[ÖO]ZET[İI])?/gi;

const KARAR_BASLA = /(?:^|\s)(\d{1,4})[-)]\s*(?=[A-ZÇĞİÖŞÜ])/g;

interface Oturum { tarih: string; icerikBaslangic: number; basliklarSonu: number }

function kararlariAyristir(metin: string, kaynakUrl: string): YerelKararSonucu[] {
  const sonuc: YerelKararSonucu[] = [];
  const oturumlar: Oturum[] = [];
  OTURUM_BASLIK.lastIndex = 0;
  let hm: RegExpExecArray | null;
  while ((hm = OTURUM_BASLIK.exec(metin))) {
    oturumlar.push({
      tarih: `${hm[3]}-${hm[2]}-${hm[1]}`,
      icerikBaslangic: hm.index + hm[0].length,
      basliklarSonu: hm.index,
    });
  }
  for (let i = 0; i < oturumlar.length; i++) {
    const { tarih, icerikBaslangic } = oturumlar[i];
    if (tarih < BASLANGIC_TARIHI) continue;
    const govdeSonu = i + 1 < oturumlar.length ? oturumlar[i + 1].basliklarSonu : metin.length;
    const govde = metin.slice(icerikBaslangic, govdeSonu);

    const kararlar: { no: string; esesBaslangic: number; icerikBaslangic: number }[] = [];
    KARAR_BASLA.lastIndex = 0;
    let km: RegExpExecArray | null;
    while ((km = KARAR_BASLA.exec(govde))) {
      kararlar.push({ no: km[1], esesBaslangic: km.index, icerikBaslangic: km.index + km[0].length });
    }
    for (let k = 0; k < kararlar.length; k++) {
      const bitis = k + 1 < kararlar.length ? kararlar[k + 1].esesBaslangic : govde.length;
      const kararMetni = govde.slice(kararlar[k].icerikBaslangic, bitis).replace(/\s+/g, ' ').trim();
      if (kararMetni.length < ASGARI_KARAR_UZUNLUK) continue;
      sonuc.push({
        belediye: 'Malatya', karar_no: kararlar[k].no, tarih, konu: null, metin: kararMetni,
        oylama_sonucu: oylamaSonucuCikar(kararMetni), kaynak_url: kaynakUrl,
      });
    }
  }
  return sonuc;
}

export async function fetchMalatyaKararlar(): Promise<YerelKararSonucu[]> {
  const sonuc: YerelKararSonucu[] = [];
  const yilSayfalar = await yilSayfalariniBul();
  for (const { yil, url } of yilSayfalar) {
    try {
      const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!res.ok) { logger.error(`[yerel-malatya] yıl sayfası ${yil} (${url}): HTTP ${res.status}`); continue; }
      const $ = cheerio.load(await res.text());
      const aylikMetinler = $('.page-content__description').toArray().map((el) => $(el).text());
      if (!aylikMetinler.length) { logger.error(`[yerel-malatya] yıl sayfası ${yil}: içerik bloğu bulunamadı`); continue; }
      const tamMetin = aylikMetinler.join('\n');
      sonuc.push(...kararlariAyristir(tamMetin, url));
    } catch (e) {
      logger.error(`[yerel-malatya] yıl sayfası ${yil}: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

export async function fetchMalatyaUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(MALATYA_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-malatya-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.personnel-card').each((_, kart) => {
    const ad = $(kart).find('.title').first().text().replace(/\s+/g, ' ').trim();
    const rank = $(kart).find('.rank').first().text().replace(/\s+/g, ' ').trim();
    const hamParti = $(kart).find('.party-info').first().text().replace(/\s+/g, ' ').trim();
    if (!ad || !hamParti) return;
    const ilce = rank.match(/^(\S+)\s+Belediye/)?.[1] ?? null;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Malatya', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce });
  });
  return sonuc;
}
