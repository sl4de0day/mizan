import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar, kararNoSiraDoldur,
  type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Bingol');

const SERVICE_BASE = 'https://online.bingol.bel.tr/service/api';
const RESOLUTION_LIST_URL = `${SERVICE_BASE}/GetResolutionList`;
const RESOLUTION_URL = `${SERVICE_BASE}/GetResolution`;
const RESOLUTION_TYPE_MECLIS_KARARLARI = 2;
const KARARLAR_SAYFA_URL = 'https://online.bingol.bel.tr/resolution-council-observation';

const UYELER_URL = 'https://www.bingol.bel.tr/tr/kurumsal/belediye-meclisi';

const NEZAKET_MS = 180;
function bekle(): Promise<void> {
  return new Promise((r) => setTimeout(r, NEZAKET_MS));
}

interface BingolResolutionListKaydi {
  Oid: number;
  ResolutionDate: string;
}

interface BingolResolutionTam {
  Oid: number;
  ResolutionDate: string;
  No: number | null;
  Subject: string | null;
  Body: string | null;
}

async function resolutionListGetir(): Promise<BingolResolutionListKaydi[]> {
  const simdi = new Date();
  const body = JSON.stringify({
    criteria: {
      StartDate: `${BASLANGIC_TARIHI}T00:00:00`,
      FinishDate: `${simdi.getUTCFullYear()}-12-31T23:59:59`,
      ResolutionTypeOid: RESOLUTION_TYPE_MECLIS_KARARLARI,
    },
  });
  const res = await fetchWithBackoff(RESOLUTION_LIST_URL, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body,
    timeoutMs: 30000,
  }, 3);
  if (!res.ok) throw new Error(`[yerel-bingol] GetResolutionList: HTTP ${res.status}`);
  const ham = (await res.json()) as BingolResolutionListKaydi[];
  const gorulen = new Map<number, BingolResolutionListKaydi>();
  for (const k of ham) if (!gorulen.has(k.Oid)) gorulen.set(k.Oid, k);
  return [...gorulen.values()];
}

async function resolutionTamGetir(oid: number): Promise<BingolResolutionTam | null> {
  const res = await fetchWithBackoff(RESOLUTION_URL, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolutionOid: oid }),
    timeoutMs: 30000,
  }, 3);
  if (!res.ok) { logger.error(`[yerel-bingol] GetResolution (Oid ${oid}): HTTP ${res.status}`); return null; }
  return (await res.json()) as BingolResolutionTam;
}

export async function fetchBingolKararlar(): Promise<YerelKararSonucu[]> {
  const liste = await resolutionListGetir();
  const kapsamdaki = liste.filter((k) => k.ResolutionDate.slice(0, 10) >= BASLANGIC_TARIHI);

  const sonuc: YerelKararSonucu[] = [];
  for (const kayit of kapsamdaki) {
    await bekle();
    try {
      const tam = await resolutionTamGetir(kayit.Oid);
      if (!tam || !tam.Body) { logger.error(`[yerel-bingol] Oid ${kayit.Oid}: gövde yok, atlanıyor`); continue; }
      const metin = cheerio.load(tam.Body).root().text().replace(/\s+/g, ' ').trim();
      if (metin.length < ASGARI_KARAR_UZUNLUK) continue;
      const tarih = tam.ResolutionDate.slice(0, 10);
      const karar_no = tam.No != null ? String(tam.No) : null;
      sonuc.push({
        belediye: 'Bingöl', karar_no, tarih,
        konu: tam.Subject?.trim() || null,
        metin, oylama_sonucu: oylamaSonucuCikar(metin),
        kaynak_url: KARARLAR_SAYFA_URL,
      });
    } catch (e) {
      logger.error(`[yerel-bingol] Oid ${kayit.Oid}: ${(e as Error).message}`);
    }
  }
  return kararNoSiraDoldur(sonuc);
}

export async function fetchBingolUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-bingol-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());

  const partiBasligi = $('div').filter((_, el) => {
    const siniflar = ($(el).attr('class') ?? '').split(/\s+/);
    return siniflar.includes('col-span-full') && $(el).find('h3').length > 0;
  }).first();
  if (!partiBasligi.length) throw new Error('[yerel-bingol-uye] parti başlık satırı bulunamadı — sayfa yapısı değişmiş olabilir');
  const grid = partiBasligi.parent();

  const sonuc: YerelUyeSonucu[] = [];
  grid.children().each((_, el) => {
    const $el = $(el);
    const siniflar = ($el.attr('class') ?? '').split(/\s+/);
    if (siniflar.includes('col-span-full')) return;
    const ad = $el.find('img[alt]').first().attr('alt')?.replace(/\s+/g, ' ').trim();
    const hamParti = $el.find('small').first().text().replace(/\s+/g, ' ').trim();
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Bingöl', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  if (sonuc.length === 0) throw new Error('[yerel-bingol-uye] hiç üye bulunamadı — sayfa yapısı değişmiş olabilir');
  return sonuc;
}
