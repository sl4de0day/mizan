import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Kutahya');

const KUTAHYA_LISTE_URL = 'https://kutahya.bel.tr/mecliskarar.asp';
const KUTAHYA_UYELER_URL = 'https://kutahya.bel.tr/meclis.asp';
function kutahyaKararUrl(id: number): string {
  return `https://kutahya.bel.tr/mecliskarar2.asp?islem=karar&id=${id}`;
}

interface KutahyaListeGirdisi { id: number; tarih: string  }

function baslikTarihiCikar(baslik: string): string | null {
  const m = baslik.match(/(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function listeGirdileriniCikar(html: string): KutahyaListeGirdisi[] {
  const $ = cheerio.load(html);
  const sonuc: KutahyaListeGirdisi[] = [];
  const gorulenId = new Set<number>();
  $('a[href*="islem=karar&id="]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const idM = href.match(/id=(\d+)/);
    if (!idM) return;
    const id = Number(idM[1]);
    if (gorulenId.has(id)) return;
    gorulenId.add(id);
    const baslik = $(el).closest('tr').find('td').first().text().replace(/\s+/g, ' ').trim();
    const tarih = baslikTarihiCikar(baslik);
    if (!tarih) return;
    sonuc.push({ id, tarih });
  });
  return sonuc;
}

function icerikMetniAl(html: string): string {
  const $ = cheerio.load(html);
  const parcalar: string[] = [];
  $('article.content > p').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t) parcalar.push(t);
  });
  let metin = parcalar.join('\n');
  const kapanisIdx = metin.indexOf('Gündem maddelerinin');
  if (kapanisIdx >= 0) metin = metin.slice(0, kapanisIdx);
  return metin;
}

function konuCikar(govde: string): string | null {
  const m = govde.match(/^(.*?)\s*konusunun\s*müzakeresi olduğunu belirten meclis başkanı/);
  const konu = m?.[1]?.trim();
  return konu || null;
}

interface KararMarker { sira: string; start: number; end: number }

function kararMarkerleriniBul(metin: string): KararMarker[] {
  const re = /Karar No:\s*(\d+)/g;
  const sonuc: KararMarker[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(metin))) {
    sonuc.push({ sira: m[1], start: m.index, end: m.index + m[0].length });
  }
  return sonuc;
}

function gundeminSizintisiKirp(govde: string): string {
  return govde.replace(/\s*GÜNDEMİN\s*\d+\s*\.?\s*MADDESİ\s*:?\s*(\([^)]*\))?\s*$/, '').trim();
}

function kararlariAyristir(icerikMetni: string, tarih: string, kaynakUrl: string): YerelKararSonucu[] {
  const yil = tarih.slice(0, 4);
  const markerlar = kararMarkerleriniBul(icerikMetni);
  const sonuc: YerelKararSonucu[] = [];
  for (let i = 0; i < markerlar.length; i++) {
    const marker = markerlar[i];
    const govdeSonu = i + 1 < markerlar.length ? markerlar[i + 1].start : icerikMetni.length;
    const govdeHam = icerikMetni.slice(marker.end, govdeSonu).replace(/\s+/g, ' ').trim();
    const govde = gundeminSizintisiKirp(govdeHam);
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({
      belediye: 'Kütahya',
      karar_no: `${yil}-${marker.sira}`,
      tarih,
      konu: konuCikar(govde),
      metin: govde,
      oylama_sonucu: oylamaSonucuCikar(govde),
      kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

export async function fetchKutahyaKararlar(): Promise<YerelKararSonucu[]> {
  const sonuc: YerelKararSonucu[] = [];
  let listeHtml: string;
  try {
    const res = await fetchWithBackoff(KUTAHYA_LISTE_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
    if (!res.ok) { logger.error(`[yerel-kutahya] liste: HTTP ${res.status}`); return sonuc; }
    listeHtml = await res.text();
  } catch (e) {
    logger.error(`[yerel-kutahya] liste: ${(e as Error).message}`);
    return sonuc;
  }

  const girdiler = listeGirdileriniCikar(listeHtml).filter((g) => g.tarih >= BASLANGIC_TARIHI);
  for (const g of girdiler) {
    const url = kutahyaKararUrl(g.id);
    try {
      const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!res.ok) { logger.error(`[yerel-kutahya] karar id=${g.id}: HTTP ${res.status}`); continue; }
      const icerik = icerikMetniAl(await res.text());
      sonuc.push(...kararlariAyristir(icerik, g.tarih, url));
    } catch (e) {
      logger.error(`[yerel-kutahya] karar id=${g.id}: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

export async function fetchKutahyaUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(KUTAHYA_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-kutahya-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.employee .default').each((_, el) => {
    const ad = $(el).find('.name').first().text().replace(/\s+/g, ' ').trim();
    const partiHam = $(el).find('.role').first().text().replace(/\s+/g, ' ').trim();
    if (!ad || !partiHam) return;
    const kanonik = normParti(partiHam);
    sonuc.push({ belediye: 'Kütahya', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? partiHam : kanonik, ilce: null });
  });
  return sonuc;
}
