import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  kararNoSiraDoldur, type YerelKararSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Van');

const TUSBA_BASE = 'https://tusba.bel.tr';
const TUSBA_KARARLAR_LISTE_URL = `${TUSBA_BASE}/meclis-kararlari`;

const NEZAKET_MS = 180;
function bekle(): Promise<void> {
  return new Promise((r) => setTimeout(r, NEZAKET_MS));
}

function esikTarihiHesapla(): string {
  const d = new Date(`${BASLANGIC_TARIHI}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 45);
  return d.toISOString().slice(0, 10);
}
const ESIK_TARIHI = esikTarihiHesapla();

const HARD_SAYFA_LIMITI = 40;

interface TusbaListeOgesi { href: string; baslik: string; listeTarihi: string | null }

function listeTarihiCikar(metin: string): string | null {
  const m = metin.match(/(\d{2})-(\d{2})-(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function sayfaOgeleriniCikar(html: string): TusbaListeOgesi[] {
  const $ = cheerio.load(html);
  const sonuc: TusbaListeOgesi[] = [];
  $('.page-content .documents li a[href^="karar/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const baslik = $(el).find('h3.text').first().text().replace(/\s+/g, ' ').trim();
    const tarihMetni = $(el).find('.date').first().text().trim();
    sonuc.push({ href, baslik, listeTarihi: listeTarihiCikar(tarihMetni) });
  });
  return sonuc;
}

function kararOzetiMi(o: TusbaListeOgesi): boolean {
  const duz = `${o.baslik} ${o.href}`.toLocaleLowerCase('tr');
  return duz.includes('karar') && duz.includes('özet');
}

interface TusbaKararBlogu { tarih: string; kararNo: string | null; metinParcalari: string[] }

function detaySayfasiniKararlaraBol(html: string, kaynakUrl: string): YerelKararSonucu[] {
  const $ = cheerio.load(html);
  const paragraflar = $('.detay p');
  const bloklar: TusbaKararBlogu[] = [];
  let aktif: TusbaKararBlogu | null = null;

  paragraflar.each((_, el) => {
    const ham = $(el).text().replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
    if (!ham) return;
    const duz = ham.toLocaleLowerCase('tr');

    if (duz.startsWith('karar tarihi')) {
      const tm = ham.match(/(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/);
      if (!tm) return;
      aktif = {
        tarih: `${tm[3]}-${tm[2]!.padStart(2, '0')}-${tm[1]!.padStart(2, '0')}`,
        kararNo: null,
        metinParcalari: [],
      };
      bloklar.push(aktif);
      return;
    }
    if (!aktif) return;
    if (duz.startsWith('karar no')) {
      const nm = ham.match(/(\d+)/);
      aktif.kararNo = nm ? nm[1]! : null;
      return;
    }
    aktif.metinParcalari.push(ham);
  });

  const sonuc: YerelKararSonucu[] = [];
  for (const b of bloklar) {
    if (b.tarih < BASLANGIC_TARIHI) continue;
    const metin = b.metinParcalari.join(' ').replace(/\s+/g, ' ').trim();
    if (metin.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({
      belediye: 'Van (Tuşba)', karar_no: b.kararNo, tarih: b.tarih, konu: null, metin,
      oylama_sonucu: oylamaSonucuCikar(metin), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

function tekillestirKararNoTarihCakismalarini(kararlar: YerelKararSonucu[]): YerelKararSonucu[] {
  const sayac = new Map<string, number>();
  let cakismaSayisi = 0;
  for (const k of kararlar) {
    if (k.karar_no === null) continue;
    const anahtar = `${k.karar_no}|${k.tarih}`;
    const n = (sayac.get(anahtar) ?? 0) + 1;
    sayac.set(anahtar, n);
    if (n > 1) {
      cakismaSayisi++;
      k.karar_no = `${k.karar_no}-${n}`;
    }
  }
  if (cakismaSayisi > 0) {
    logger.warn(`[yerel-van] ${cakismaSayisi} karar, kaynağın KENDİ numaralandırma çakışması yüzünden (aynı karar_no+tarih, FARKLI içerik) "-N" son ekiyle tekilleştirildi — bkz. dosya başı notu.`);
  }
  return kararlar;
}

export async function fetchVanKararlar(): Promise<YerelKararSonucu[]> {
  const adaylar: TusbaListeOgesi[] = [];
  const gorulenHref = new Set<string>();

  for (let sayfa = 1; sayfa <= HARD_SAYFA_LIMITI; sayfa++) {
    const url = sayfa === 1 ? TUSBA_KARARLAR_LISTE_URL : `${TUSBA_KARARLAR_LISTE_URL}/${sayfa}`;
    let html: string;
    try {
      const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!res.ok) { logger.error(`[yerel-van] liste sayfası ${sayfa}: HTTP ${res.status}`); break; }
      html = await res.text();
    } catch (e) { logger.error(`[yerel-van] liste sayfası ${sayfa}: ${(e as Error).message}`); break; }

    const ogeler = sayfaOgeleriniCikar(html);
    if (ogeler.length === 0) { logger.error(`[yerel-van] liste sayfası ${sayfa}: hiç öğe yok, duruyor`); break; }

    let yeniHrefSayisi = 0;
    let sayfaMinTarih: string | null = null;
    for (const o of ogeler) {
      if (!gorulenHref.has(o.href)) {
        gorulenHref.add(o.href);
        yeniHrefSayisi++;
        if (kararOzetiMi(o)) adaylar.push(o);
      }
      if (o.listeTarihi && (sayfaMinTarih === null || o.listeTarihi < sayfaMinTarih)) sayfaMinTarih = o.listeTarihi;
    }

    if (yeniHrefSayisi === 0) break;
    if (sayfaMinTarih !== null && sayfaMinTarih < ESIK_TARIHI) break;

    await bekle();
  }

  const sonuc: YerelKararSonucu[] = [];
  for (const aday of adaylar) {
    const detayUrl = `${TUSBA_BASE}/${aday.href}`;
    try {
      const dres = await fetchWithBackoff(detayUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!dres.ok) { logger.error(`[yerel-van] detay (${aday.baslik}): HTTP ${dres.status}`); continue; }
      const html = await dres.text();
      sonuc.push(...detaySayfasiniKararlaraBol(html, detayUrl));
    } catch (e) {
      logger.error(`[yerel-van] detay (${aday.baslik}): ${(e as Error).message}`);
    }
    await bekle();
  }

  return kararNoSiraDoldur(tekillestirKararNoTarihCakismalarini(sonuc));
}
