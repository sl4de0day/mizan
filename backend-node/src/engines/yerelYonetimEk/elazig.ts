import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  docxMetinCikar, type YerelKararSonucu, type YerelUyeSonucu,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Elazig');

const ELAZIG_BASE = 'https://www.elazig.bel.tr';
const ELAZIG_KARARLAR_URL = `${ELAZIG_BASE}/meclis-kararlari/`;
const elazigKararlarSayfa = (n: number) => `${ELAZIG_BASE}/meclis-kararlari/sayfa/${n}/`;
const ELAZIG_UYELER_URL = `${ELAZIG_BASE}/belediye-meclisi/`;

const AYLAR: Record<string, string> = {
  ocak: '01', şubat: '02', mart: '03', nisan: '04', mayıs: '05', haziran: '06',
  temmuz: '07', ağustos: '08', eylül: '09', ekim: '10', kasım: '11', aralık: '12',
};

function baslikYilAy(baslik: string): { yil: number; ay: string | null } | null {
  const duz = baslik.toLocaleLowerCase('tr');
  const yilM = duz.match(/(20\d{2})/);
  if (!yilM) return null;
  const yil = Number(yilM[1]);
  for (const [ad, no] of Object.entries(AYLAR)) {
    if (duz.includes(ad)) return { yil, ay: no };
  }
  return { yil, ay: null };
}

function kararBasligiMi(baslik: string): boolean {
  const duz = baslik.toLocaleLowerCase('tr');
  if (!duz.includes('karar')) return false;
  if (duz.includes('gündem') || duz.includes('ilan') || duz.includes('sunum') || duz.includes('durumu')) return false;
  return true;
}

interface ElazigSatir { baslik: string; href: string }

function satirlariCikar(html: string): ElazigSatir[] {
  const $ = cheerio.load(html);
  const sonuc: ElazigSatir[] = [];
  $('.default-wrapper').each((_, el) => {
    const baslik = $(el).find('.default-title').first().text().trim();
    const href = $(el).find('a[href^="/karar/"]').first().attr('href');
    if (baslik && href) sonuc.push({ baslik, href });
  });
  return sonuc;
}

function oylamaSonucuKararBazli(metin: string): 'oybirlik' | 'oycoklugu' | null {
  const duz = metin.toLocaleLowerCase('tr').replace(/\s+/g, ' ');
  const birlik = /oy\s*birliği/.test(duz);
  const coklu = /oy\s*çokluğu/.test(duz);
  if (birlik && coklu) return null;
  return oylamaSonucuCikar(metin);
}

const KARAR_MARKER = /Karar\s*Tarihi\s*Karar\s*No\s*ÖZÜ/g;

function kararlariCikar(buf: Buffer, kaynakUrl: string): YerelKararSonucu[] {
  const metinTum = docxMetinCikar(buf);
  if (!metinTum) return [];
  const idxs = [...metinTum.matchAll(KARAR_MARKER)].map((m) => m.index!);
  if (!idxs.length) return [];
  idxs.push(metinTum.length);
  const parts: string[] = [];
  for (let i = 0; i < idxs.length - 1; i++) parts.push(metinTum.slice(idxs[i], idxs[i + 1]));

  type Gecici = { tarih: string; kararNo: string; metin: string };
  const gecici: Gecici[] = [];
  let sonYil: number | null = null;
  let sonNo: number | null = null;
  for (const part of parts) {
    const baslikM = part.match(/^Karar\s*Tarihi\s*Karar\s*No\s*ÖZÜ\s*(\d{2})\/(\d{2})\/(\d{4})/);
    if (!baslikM) { logger.error(`[yerel-elazig] beklenmeyen parça biçimi — ${kaynakUrl}: ${part.slice(0, 60)}`); continue; }
    const [, gg, aa, yyyy] = baslikM;
    const tarih = `${yyyy}-${aa}-${gg}`;
    let rest = part.slice(baslikM[0].length);
    const yilSlashM = rest.match(/^(\d{4})\//);
    if (!yilSlashM) { logger.error(`[yerel-elazig] karar no biçimi tanınmadı — ${kaynakUrl}: ${rest.slice(0, 40)}`); continue; }
    const kararYil = yilSlashM[1];
    rest = rest.slice(yilSlashM[0].length);
    const digitsM = rest.match(/^\d+/);
    const digitsAll = digitsM ? digitsM[0] : '';
    let secilenL = digitsAll.length;
    if (digitsAll.length > 0) {
      const yil = Number(kararYil);
      const beklenen = (sonYil === yil && sonNo !== null) ? sonNo + 1 : null;
      if (beklenen !== null) {
        for (let L = 1; L <= digitsAll.length; L++) {
          if (Number(digitsAll.slice(0, L)) === beklenen) { secilenL = L; break; }
        }
      }
    }
    const noStr = digitsAll.slice(0, secilenL);
    const kararNo = `${kararYil}/${noStr}`;
    const govde = rest.slice(secilenL);
    sonYil = Number(kararYil);
    if (noStr) sonNo = Number(noStr);

    const son = gecici[gecici.length - 1];
    if (son && son.tarih === tarih && son.kararNo === kararNo) son.metin += ' ' + govde;
    else gecici.push({ tarih, kararNo, metin: govde });
  }

  const sonuc: YerelKararSonucu[] = [];
  for (const g of gecici) {
    if (g.tarih < BASLANGIC_TARIHI) continue;
    const metin = g.metin.replace(/\s+/g, ' ').trim();
    if (metin.length < ASGARI_KARAR_UZUNLUK) continue;
    const konuM = metin.match(/^(.*?)Elazığ Belediye Meclisi/);
    const konu = konuM ? (konuM[1].trim() || null) : null;
    sonuc.push({
      belediye: 'Elazığ', karar_no: g.kararNo, tarih: g.tarih, konu, metin,
      oylama_sonucu: oylamaSonucuKararBazli(metin), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

export async function fetchElazigKararlar(): Promise<YerelKararSonucu[]> {
  const sonuc: YerelKararSonucu[] = [];
  const basTarihYil = Number(BASLANGIC_TARIHI.slice(0, 4));
  const basTarihYilAy = BASLANGIC_TARIHI.slice(0, 7);
  for (let sayfa = 1; sayfa <= 20; sayfa++) {
    const url = sayfa === 1 ? ELAZIG_KARARLAR_URL : elazigKararlarSayfa(sayfa);
    const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 30000 }, 3);
    if (!res.ok) throw new Error(`[yerel-elazig] liste sayfası ${sayfa}: HTTP ${res.status}`);
    const satirlar = satirlariCikar(await res.text());
    if (!satirlar.length) break;

    let sayfadaGuncelVarMi = false;
    for (const { baslik, href } of satirlar) {
      if (!kararBasligiMi(baslik)) continue;
      const ya = baslikYilAy(baslik);
      if (!ya || ya.yil < basTarihYil) continue;
      if (ya.ay && `${ya.yil}-${ya.ay}` < basTarihYilAy) continue;
      sayfadaGuncelVarMi = true;

      const detayUrl = href.startsWith('http') ? href : `${ELAZIG_BASE}${href}`;
      try {
        const dres = await fetchWithBackoff(detayUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
        if (!dres.ok) { logger.error(`[yerel-elazig] detay (${baslik}): HTTP ${dres.status}`); continue; }
        const $ = cheerio.load(await dres.text());
        const dosyaHref = $('a:contains("DOSYAYI İNDİR")').first().attr('href');
        if (!dosyaHref) { logger.error(`[yerel-elazig] indirme linki yok (${baslik})`); continue; }
        if (!dosyaHref.toLowerCase().endsWith('.docx')) {
          logger.error(`[yerel-elazig] desteklenmeyen dosya biçimi (${baslik}): ${dosyaHref}`);
          continue;
        }
        const dosyaUrl = dosyaHref.startsWith('http') ? dosyaHref : `${ELAZIG_BASE}${dosyaHref}`;
        const fres = await fetchWithBackoff(dosyaUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
        if (!fres.ok) { logger.error(`[yerel-elazig] docx indirilemedi (${baslik}): HTTP ${fres.status}`); continue; }
        const buf = Buffer.from(await fres.arrayBuffer());
        sonuc.push(...kararlariCikar(buf, detayUrl));
      } catch (e) {
        logger.error(`[yerel-elazig] ${baslik}: ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 180));
    }
    if (!sayfadaGuncelVarMi) break;
  }
  return sonuc;
}

const ELAZIG_PARTI_DUZELT: Record<string, string> = {
  'Milliyetçi Harekat Partisi': 'Milliyetçi Hareket Partisi',
};

export async function fetchElazigUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(ELAZIG_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-elazig-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.directorate-wrapper').each((_, el) => {
    const ad = $(el).find('.manager-name').first().text().replace(/\s+/g, ' ').trim();
    let hamParti = $(el).find('.directorate-name').first().text().replace(/\s+/g, ' ').trim();
    if (!ad || !hamParti) return;
    hamParti = ELAZIG_PARTI_DUZELT[hamParti] ?? hamParti;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Elazığ', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
