import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  docxMetinCikar, pdfMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Mersin');

const MERSIN_KARARLAR_URL = 'https://www.mersin.bel.tr/dokumanlar/meclis-kararlari';
const MERSIN_UYELER_URL = 'https://www.mersin.bel.tr/kurumsal/belediye-meclisi';
const NEZAKET_MS = 180;

const TR_AYLAR: Record<string, string> = {
  ocak: '01', subat: '02', mart: '03', nisan: '04', mayis: '05', haziran: '06',
  temmuz: '07', agustos: '08', eylul: '09', ekim: '10', kasim: '11', aralik: '12',
};

const MERSIN_ILCELERI = [
  'Akdeniz', 'Anamur', 'Aydıncık', 'Bozyazı', 'Çamlıyayla', 'Erdemli', 'Gülnar',
  'Mezitli', 'Mut', 'Silifke', 'Tarsus', 'Toroslar', 'Yenişehir',
] as const;

function bekle(): Promise<void> {
  return new Promise((r) => setTimeout(r, NEZAKET_MS));
}

function yilLinkleriniCikar(html: string): string[] {
  const $ = cheerio.load(html);
  const esikYil = Number(BASLANGIC_TARIHI.slice(0, 4));
  const sonuc: string[] = [];
  const gorulen = new Set<string>();
  $('a[href*="-yili-mbb-meclis-kararlari"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || gorulen.has(href)) return;
    const m = href.match(/\/dokumanlar\/(\d{4})-yili-mbb-meclis-kararlari/);
    if (!m) return;
    if (Number(m[1]) < esikYil) return;
    gorulen.add(href);
    sonuc.push(href);
  });
  return sonuc;
}

function oturumlariCikar(html: string): { url: string; tarih: string }[] {
  const $ = cheerio.load(html);
  const sonuc: { url: string; tarih: string }[] = [];
  const gorulen = new Set<string>();
  $('a[href*="/dokumanlar/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || gorulen.has(href)) return;
    const m = href.match(/\/dokumanlar\/(\d{1,2})-([a-z]+)-(\d{4})-meclis-kararlari-\d+/);
    if (!m) return;
    const ay = TR_AYLAR[m[2]];
    if (!ay) return;
    gorulen.add(href);
    sonuc.push({ url: href, tarih: `${m[3]}-${ay}-${m[1]!.padStart(2, '0')}` });
  });
  return sonuc;
}

function kararLinkleriniCikar(html: string): string[] {
  const $ = cheerio.load(html);
  const sonuc: string[] = [];
  const gorulen = new Set<string>();
  $('a.flex-grow-1[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || gorulen.has(href)) return;
    gorulen.add(href);
    sonuc.push(href);
  });
  return sonuc;
}

export async function fetchMersinKararlar(): Promise<YerelKararSonucu[]> {
  const indexRes = await fetchWithBackoff(MERSIN_KARARLAR_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!indexRes.ok) throw new Error(`[yerel-mersin] ana sayfa: HTTP ${indexRes.status}`);
  const yilLinkleri = yilLinkleriniCikar(await indexRes.text());

  const sonuc: YerelKararSonucu[] = [];
  let atlananDoc = 0;
  for (const yilUrl of yilLinkleri) {
    await bekle();
    let yilHtml: string;
    try {
      const yres = await fetchWithBackoff(yilUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!yres.ok) { logger.error(`[yerel-mersin] yıl sayfası (${yilUrl}): HTTP ${yres.status}`); continue; }
      yilHtml = await yres.text();
    } catch (e) { logger.error(`[yerel-mersin] yıl sayfası (${yilUrl}): ${(e as Error).message}`); continue; }

    for (const oturum of oturumlariCikar(yilHtml)) {
      if (oturum.tarih < BASLANGIC_TARIHI) continue;
      await bekle();
      let oturumHtml: string;
      try {
        const ores = await fetchWithBackoff(oturum.url, { headers: HEADERS, timeoutMs: 30000 }, 3);
        if (!ores.ok) { logger.error(`[yerel-mersin] oturum (${oturum.url}): HTTP ${ores.status}`); continue; }
        oturumHtml = await ores.text();
      } catch (e) { logger.error(`[yerel-mersin] oturum (${oturum.url}): ${(e as Error).message}`); continue; }

      for (const kararUrl of kararLinkleriniCikar(oturumHtml)) {
        await bekle();
        try {
          const kres = await fetchWithBackoff(kararUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
          if (!kres.ok) { logger.error(`[yerel-mersin] karar (${kararUrl}): HTTP ${kres.status}`); continue; }
          const $ = cheerio.load(await kres.text());
          const baslik = $('h1.new-page-title').first().text().replace(/\s+/g, ' ').trim();
          const kararNoM = kararUrl.match(/\/dokumanlar\/(\d+)-/);
          const kararNo = kararNoM ? kararNoM[1]! : null;
          const konu = baslik.replace(/^\d+-\s*MEC\.?\s*KAR\.?\s*/i, '').trim() || null;

          const dosyaHref = $('a[href*="/uploads/files/"]').first().attr('href');
          if (!dosyaHref) continue;
          const dosyaUrl = dosyaHref.startsWith('http') ? dosyaHref : `https://www.mersin.bel.tr${dosyaHref}`;

          let metin: string | null = null;
          if (/\.docx(\?|$)/i.test(dosyaUrl)) {
            const fres = await fetchWithBackoff(dosyaUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
            if (fres.ok) metin = docxMetinCikar(Buffer.from(await fres.arrayBuffer()));
          } else if (/\.pdf(\?|$)/i.test(dosyaUrl)) {
            const fres = await fetchWithBackoff(dosyaUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
            if (fres.ok) metin = await pdfMetinCikar(new Uint8Array(await fres.arrayBuffer()));
          } else if (/\.doc(\?|$)/i.test(dosyaUrl)) {
            atlananDoc++;
            continue;
          } else {
            continue;
          }
          if (!metin || metin.trim().length < ASGARI_KARAR_UZUNLUK) continue;

          sonuc.push({
            belediye: 'Mersin', karar_no: kararNo, tarih: oturum.tarih, konu,
            metin: metin.trim(), oylama_sonucu: oylamaSonucuCikar(metin), kaynak_url: dosyaUrl,
          });
        } catch (e) {
          logger.error(`[yerel-mersin] karar (${kararUrl}): ${(e as Error).message}`);
        }
      }
    }
  }
  if (atlananDoc > 0) {
    logger.warn(`[yerel-mersin] ${atlananDoc} karar eski ikili .doc formatında olduğu için atlandı (yalnız .docx destekleniyor, bkz. dosya başı notu) — kaynak, kararların metnini BAŞKA hiçbir formatta sunmuyor.`);
  }
  return sonuc;
}

function ilceCikar(metin: string): string | null {
  for (const ilce of MERSIN_ILCELERI) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${ilce}(?![\\p{L}\\p{N}])`, 'iu');
    if (re.test(metin)) return ilce;
  }
  return null;
}

export async function fetchMersinUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(MERSIN_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-mersin-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.card.h-100').each((_, kart) => {
    const ad = $(kart).find('.card-title').first().text().replace(/\s+/g, ' ').trim();
    const rolHtml = $(kart).find('p.text-center').first().html() ?? '';
    const rolDuz = rolHtml.replace(/<br\s*\/?>/gi, ' | ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!ad || !rolDuz) return;
    const parcalar = rolDuz.split(/\s*-\s*/);
    if (parcalar.length < 2) return;
    const hamParti = parcalar[parcalar.length - 1]!.trim();
    if (!hamParti) return;
    const oncesi = parcalar.slice(0, -1).join(' ');
    const ilce = ilceCikar(oncesi);
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Mersin', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce });
  });
  return sonuc;
}
