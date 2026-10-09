import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  pdfMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Kirsehir');

const KIRSEHIR_BASE = 'https://www.kirsehir.bel.tr';
const KIRSEHIR_KARARLAR_URL = `${KIRSEHIR_BASE}/meclis/meclis-kararlari`;
const KIRSEHIR_UYELER_URL = `${KIRSEHIR_BASE}/meclis`;

interface KirsehirAy { baslik: string; pdfUrl: string }

function aylariCikar(html: string): KirsehirAy[] {
  const $ = cheerio.load(html);
  const sonuc: KirsehirAy[] = [];
  $('.meclis-karar-item').each((_, el) => {
    const baslik = $(el).find('.title').first().text().replace(/\s+/g, ' ').trim();
    const href = $(el).find('a[href$=".pdf"]').first().attr('href');
    if (!href) return;
    sonuc.push({ baslik, pdfUrl: href.startsWith('http') ? href : `${KIRSEHIR_BASE}${href}` });
  });
  return sonuc;
}

async function aylariTopla(): Promise<KirsehirAy[]> {
  const sonuc: KirsehirAy[] = [];
  const gorulenPdf = new Set<string>();
  for (let sayfa = 1; sayfa <= 30; sayfa++) {
    const url = sayfa === 1 ? KIRSEHIR_KARARLAR_URL : `${KIRSEHIR_KARARLAR_URL}?page=${sayfa}`;
    const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 30000 }, 3);
    if (!res.ok) throw new Error(`[yerel-kirsehir] liste sayfası ${sayfa}: HTTP ${res.status}`);
    const aySayfa = aylariCikar(await res.text());
    if (!aySayfa.length) break;
    let yeniVarMi = false;
    for (const a of aySayfa) {
      if (gorulenPdf.has(a.pdfUrl)) continue;
      gorulenPdf.add(a.pdfUrl);
      sonuc.push(a);
      yeniVarMi = true;
    }
    if (!yeniVarMi) break;
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

interface KirsehirKararBasligi { headerStart: number; headerEnd: number; kararNo: string; tarih: string }

const KARAR_BASLIK_RE = /KARAR\s*NO[….\s]*:\s*(\d+)\s*KARAR\s*TARİHİ[….\s]*:\s*(\d{2})\/(\d{2})\/(\d{4})/g;
const GOVDE_BASLANGIC_RE = /KARAR[….]{2,}\s*:/;
const KONU_RE = /KONUSU[….\s]*:\s*([\s\S]*?)\s*OTURUM/;

function basliklariBul(metin: string): KirsehirKararBasligi[] {
  const sonuc: KirsehirKararBasligi[] = [];
  let m: RegExpExecArray | null;
  KARAR_BASLIK_RE.lastIndex = 0;
  while ((m = KARAR_BASLIK_RE.exec(metin))) {
    sonuc.push({
      headerStart: m.index, headerEnd: m.index + m[0].length, kararNo: m[1],
      tarih: `${m[4]}-${m[3]}-${m[2]}`,
    });
  }
  return sonuc;
}

function oylamaSonucuKirsehirDuzelt(govde: string): 'oybirlik' | 'oycoklugu' | null {
  const dogrudan = oylamaSonucuCikar(govde);
  if (dogrudan) return dogrudan;
  const pencereRe = /[\s\S]{0,40}kabul edildi/gi;
  let m: RegExpExecArray | null;
  while ((m = pencereRe.exec(govde))) {
    const sikistirilmis = m[0].replace(/\s+/g, '').toLocaleLowerCase('tr');
    if (sikistirilmis.includes('oybirliği')) return 'oybirlik';
    if (sikistirilmis.includes('oyçokluğu')) return 'oycoklugu';
  }
  return null;
}

function kararlariAyristir(metin: string, kaynakUrl: string): YerelKararSonucu[] {
  const basliklar = basliklariBul(metin);
  const sonuc: YerelKararSonucu[] = [];
  for (let i = 0; i < basliklar.length; i++) {
    const b = basliklar[i];
    if (b.tarih < BASLANGIC_TARIHI) continue;
    const blokSonu = i + 1 < basliklar.length ? basliklar[i + 1].headerStart : metin.length;
    const blok = metin.slice(b.headerEnd, blokSonu);
    const konuM = blok.match(KONU_RE);
    const konu = konuM ? konuM[1].replace(/\s+/g, ' ').trim() || null : null;
    const govdeM = blok.match(GOVDE_BASLANGIC_RE);
    const govdeHam = govdeM ? blok.slice(govdeM.index! + govdeM[0].length) : blok;
    const govde = govdeHam.replace(/\s+/g, ' ').trim();
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({
      belediye: 'Kırşehir', karar_no: b.kararNo, tarih: b.tarih, konu, metin: govde,
      oylama_sonucu: oylamaSonucuKirsehirDuzelt(govde), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

export async function fetchKirsehirKararlar(): Promise<YerelKararSonucu[]> {
  const aylar = await aylariTopla();
  const sonuc: YerelKararSonucu[] = [];
  const gorulenKarar = new Set<string>();
  for (const { baslik, pdfUrl } of aylar) {
    try {
      const pres = await fetchWithBackoff(pdfUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!pres.ok) { logger.error(`[yerel-kirsehir] PDF indirilemedi (${baslik}): HTTP ${pres.status}`); continue; }
      const metin = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
      for (const k of kararlariAyristir(metin, pdfUrl)) {
        const anahtar = `${k.tarih}|${k.karar_no}`;
        if (gorulenKarar.has(anahtar)) continue;
        gorulenKarar.add(anahtar);
        sonuc.push(k);
      }
    } catch (e) {
      logger.error(`[yerel-kirsehir] (${baslik}): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

export async function fetchKirsehirUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(KIRSEHIR_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-kirsehir-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.meclis-uye-item').each((_, kart) => {
    const ad = $(kart).find('.fs-4.text-primary').first().text().replace(/\s+/g, ' ').trim();
    const hamParti = '';
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Kırşehir', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
