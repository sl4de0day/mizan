import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  pdfMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Isparta');

const ISPARTA_BASE = 'https://www.isparta.bel.tr';
const ISPARTA_KARARLAR_URL = `${ISPARTA_BASE}/meclis-kararlari`;
const ISPARTA_UYELER_URL = `${ISPARTA_BASE}/belediye-meclisi-2024`;

const PRIMARY_RE = /(\d{2})\.(\d{2})\.(\d{4})\s*[/-]\s*(\d{1,4})\b(?!\.\d{2}\.\d{4})/g;

const FALLBACK_RE = /(\d{2})\.(\d{2})\.(\d{4})\s+TARİHLİ\s+(\d{1,4})\s+NOLU\s+MECLİS\s+(?:ÖZETİ|KARARI)/i;

const ROLLCALL_RE = /ad\s+okunarak[\s\S]{0,40}?oylamada[\s\S]*?oyu\s+kullan[\s\S]{0,15}?ak/gi;
const ROLLCALL_REDAKTE_METNI = 'ad okunarak yapılan oylamada [üye bazlı oy listesi burada yayımlanmıyor] oyu kullanılarak';

function oyListesiRedakteEt(govde: string): string {
  return govde.replace(ROLLCALL_RE, ROLLCALL_REDAKTE_METNI);
}

interface IspartaSatir { baslik: string; href: string }

function satirlariCikar(html: string): IspartaSatir[] {
  const $ = cheerio.load(html);
  const sonuc: IspartaSatir[] = [];
  const gorulen = new Set<string>();
  $('.custom-table-row').each((_, el) => {
    const baslik = $(el).find('.custom-table-cell.wide').first().text().replace(/\s+/g, ' ').trim();
    const href = $(el).find('a[href$=".pdf"]').first().attr('href');
    if (!href || gorulen.has(href)) return;
    gorulen.add(href);
    sonuc.push({ baslik, href });
  });
  return sonuc;
}

function kararlariAyristir(metinHam: string, kaynakUrl: string, dosyaAdi: string): YerelKararSonucu[] {
  const duz = metinHam.replace(/\s+/g, ' ').trim();
  const eslesmeler = [...duz.matchAll(PRIMARY_RE)];

  if (eslesmeler.length > 0) {
    const sonuc: YerelKararSonucu[] = [];
    for (let i = 0; i < eslesmeler.length; i++) {
      const m = eslesmeler[i];
      const baslangic = (m.index ?? 0) + m[0].length;
      const bitis = i + 1 < eslesmeler.length ? eslesmeler[i + 1].index! : duz.length;
      const govde = oyListesiRedakteEt(duz.slice(baslangic, bitis).trim());
      if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
      const [, gg, aa, yyyy, kararNoRaw] = m;
      const tarih = `${yyyy}-${aa}-${gg}`;
      if (tarih < BASLANGIC_TARIHI) continue;
      sonuc.push({
        belediye: 'Isparta', karar_no: kararNoRaw.trim(), tarih, konu: null, metin: govde,
        oylama_sonucu: oylamaSonucuCikar(govde), kaynak_url: kaynakUrl,
      });
    }
    return sonuc;
  }

  const fm = FALLBACK_RE.exec(duz);
  if (!fm) {
    logger.error(`[yerel-isparta] tarih/karar-no metinde bulunamadı (ne tablo ne 'TARİHLİ...NOLU' başlığı), atlanıyor: ${dosyaAdi}`);
    return [];
  }
  const [, gg, aa, yyyy, kararNoRaw] = fm;
  const tarih = `${yyyy}-${aa}-${gg}`;
  if (tarih < BASLANGIC_TARIHI) return [];
  const govde = oyListesiRedakteEt(duz.slice((fm.index ?? 0) + fm[0].length).trim());
  if (govde.length < ASGARI_KARAR_UZUNLUK) return [];
  return [{
    belediye: 'Isparta', karar_no: kararNoRaw.trim(), tarih, konu: null, metin: govde,
    oylama_sonucu: oylamaSonucuCikar(govde), kaynak_url: kaynakUrl,
  }];
}

export async function fetchIspartaKararlar(): Promise<YerelKararSonucu[]> {
  const listRes = await fetchWithBackoff(ISPARTA_KARARLAR_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!listRes.ok) throw new Error(`[yerel-isparta] liste sayfası: HTTP ${listRes.status}`);
  const satirlar = satirlariCikar(await listRes.text());

  const sonuc: YerelKararSonucu[] = [];
  const gorulenKarar = new Set<string>();
  for (const { baslik, href } of satirlar) {
    const pdfUrl = href.startsWith('http') ? href : `${ISPARTA_BASE}${href}`;
    try {
      const pres = await fetchWithBackoff(pdfUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!pres.ok) { logger.error(`[yerel-isparta] PDF indirilemedi (${baslik}): HTTP ${pres.status}`); continue; }
      const metin = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
      if (metin.replace(/\s+/g, '').length < 100) {
        logger.error(`[yerel-isparta] neredeyse boş metin (muhtemelen taranmış görüntü), atlanıyor: ${baslik}`);
        continue;
      }
      const kararlar = kararlariAyristir(metin, pdfUrl, baslik);
      for (const k of kararlar) {
        const anahtar = `${k.karar_no}|${k.tarih}`;
        if (gorulenKarar.has(anahtar)) continue;
        gorulenKarar.add(anahtar);
        sonuc.push(k);
      }
    } catch (e) {
      logger.error(`[yerel-isparta] (${baslik}): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

export async function fetchIspartaUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(ISPARTA_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-isparta-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.manager-vertical-card').each((_, kart) => {
    const ad = $(kart).find('.manager-name').first().text().replace(/\s+/g, ' ').trim();
    const hamParti = $(kart).find('p').first().text().replace(/\s+/g, ' ').trim();
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Isparta', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
