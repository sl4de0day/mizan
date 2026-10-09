import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, getJson, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  pdfMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Hatay');

const HATAY_ORIGIN = 'https://www.hatay.bel.tr';
const HATAY_KARARLAR_API = 'https://www.hatay.bel.tr/api/documents?menuItemId=bbc57955-f40b-40e1-8097-3396c2320e15';
const HATAY_UYELER_URL = 'https://www.hatay.bel.tr/buyuksehir-belediye-meclisi';

interface HatayBelgeKaydi { date: string; title: string; path: string; fileName: string }
interface HatayBelgeListYaniti {
  success: boolean;
  data: HatayBelgeKaydi[];
  pagination: { currentPage: number; pageSize: number; totalCount: number; totalPages: number; hasNextPage: boolean; hasPreviousPage: boolean };
}

function tarihNormallestir(ddmmyyyy: string): string | null {
  const m = ddmmyyyy.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

async function belgeKayitlariniCek(): Promise<HatayBelgeKaydi[]> {
  const sonuc: HatayBelgeKaydi[] = [];
  let sayfa = 1;
  for (;;) {
    const j = await getJson<HatayBelgeListYaniti>(
      `${HATAY_KARARLAR_API}&page=${sayfa}&pageSize=50&search=`, { headers: HEADERS, timeoutMs: 30000 },
    );
    let eskiyeDustuk = false;
    for (const kayit of j.data) {
      const tarih = tarihNormallestir(kayit.date);
      if (!tarih || tarih < BASLANGIC_TARIHI) { eskiyeDustuk = true; continue; }
      sonuc.push(kayit);
    }
    if (eskiyeDustuk || !j.pagination.hasNextPage || j.data.length === 0) break;
    sayfa++;
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

interface HatayKararSatiri { sira: string; kararNo: string; startIndex: number; endIndex: number }

const KARAR_SATIRI_RE = /(\d{1,3})\s*-\s+(?:\d{1,2}\s+[A-Za-zÇĞİÖŞÜçğıöşü]+\s+\d{4}\s+tarihli\s+)?(\d{1,5})\s*nolu\s+kararda\s*[;:]/g;

function kararlariAyristir(metin: string, tarih: string, kaynakUrl: string): YerelKararSonucu[] {
  const satirlar: HatayKararSatiri[] = [];
  let m: RegExpExecArray | null;
  KARAR_SATIRI_RE.lastIndex = 0;
  while ((m = KARAR_SATIRI_RE.exec(metin))) {
    satirlar.push({ sira: m[1], kararNo: m[2], startIndex: m.index, endIndex: m.index + m[0].length });
  }
  const yil = tarih.slice(0, 4);
  const sonuc: YerelKararSonucu[] = [];
  for (let i = 0; i < satirlar.length; i++) {
    const satir = satirlar[i];
    const govdeSonu = i + 1 < satirlar.length ? satirlar[i + 1].startIndex : metin.length;
    const govde = metin.slice(satir.endIndex, govdeSonu).replace(/\s+/g, ' ').trim();
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({
      belediye: 'Hatay', karar_no: `${yil}/${satir.kararNo}`, tarih, konu: null, metin: govde,
      oylama_sonucu: oylamaSonucuCikar(govde), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

export async function fetchHatayKararlar(): Promise<YerelKararSonucu[]> {
  const kayitlar = await belgeKayitlariniCek();
  const sonuc: YerelKararSonucu[] = [];
  for (const kayit of kayitlar) {
    const tarih = tarihNormallestir(kayit.date);
    if (!tarih) continue;
    const pdfUrl = kayit.path.startsWith('http') ? kayit.path : `${HATAY_ORIGIN}${kayit.path}`;
    try {
      const pres = await fetchWithBackoff(pdfUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!pres.ok) { logger.error(`[yerel-hatay] PDF indirilemedi (${kayit.title}): HTTP ${pres.status}`); continue; }
      const metin = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
      if (metin.trim().length < ASGARI_KARAR_UZUNLUK) continue;
      const kararlar = kararlariAyristir(metin, tarih, pdfUrl);
      sonuc.push(...kararlar);
    } catch (e) {
      logger.error(`[yerel-hatay] (${kayit.title}): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

export async function fetchHatayUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(HATAY_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-hatay-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());

  const sonuc: YerelUyeSonucu[] = [];
  let guncelParti: string | null = null;
  $('p.fs-3.fw-bold.text-dark, div.col-8.d-flex.flex-column.justify-content-center').each((_, el) => {
    const $el = $(el);
    if ($el.is('p')) {
      guncelParti = $el.text().replace(/\s+/g, ' ').trim();
      return;
    }
    const ad = $el.find('p.fs-5').first().text().replace(/\s+/g, ' ').trim();
    if (!ad || !guncelParti) return;
    let ilce: string | null = null;
    $el.find('p').not('.fs-5').each((__, p) => {
      const style = $(p).attr('style') || '';
      if (style.includes('#036')) ilce = $(p).text().replace(/\s+/g, ' ').trim() || null;
    });
    const kanonik = normParti(guncelParti);
    sonuc.push({ belediye: 'Hatay', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? guncelParti : kanonik, ilce });
  });
  return sonuc;
}
