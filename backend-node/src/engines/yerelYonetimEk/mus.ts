import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  pdfMetinCikar, kararNoSiraDoldur, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Mus');

const MUS_BASE = 'http://www.mus.bel.tr';
const MUS_KARARLAR_URL = `${MUS_BASE}/meclis-kararlarimiz`;
const MUS_UYELER_URL = `${MUS_BASE}/meclis-uyelerimiz`;

function esnekKelime(word: string): string {
  return [...word].map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s?');
}
const KARARW = esnekKelime('Karar');
const KARAR_ESNEK = esnekKelime('KARAR');
const OZETI = esnekKelime('Özeti');
const TARIHI = esnekKelime('Tarihi');
const NO = esnekKelime('No');

const DAMGA_RE = new RegExp(
  `Dönem\\(Yıl\\)\\s*:\\s*[\\d\\s]+?\\([\\d\\s]+?\\)\\s+${esnekKelime('Oturum')}\\s*:\\s*[\\d\\s]+?\\s+` +
    `${esnekKelime('Toplantı')}\\s*:\\s*[\\d\\s]+?\\s+${KARARW}\\s+${TARIHI}\\s*:\\s*([\\d\\s]+?)\\.\\s*([\\d\\s]+?)\\.\\s*([\\d\\s]+?)\\s+` +
    `${esnekKelime('Birleşim')}\\s*:\\s*(?:${KARARW}\\s+${OZETI}\\s*:\\s*)?[\\d\\s]*?\\s*${KARARW}\\s+${NO}\\s*:\\s*([\\d\\s]+?)\\s+` +
    `(?:${KARARW}\\s+${OZETI}\\s*:\\s*)?(.+?)\\s+${KARAR_ESNEK}\\b` +
    `(?:\\s+${esnekKelime('Başkan')}\\s+\\S+(?:\\s+\\S+){1,6}?\\s+${esnekKelime('Katip')}\\s+\\S+(?:\\s+\\S+){1,4}?\\s+` +
    `${esnekKelime('Katip')}\\s+\\S+(?:\\s+\\S+){1,4}?\\s+${esnekKelime('Belediye')}\\s+${esnekKelime('Meclisi')}\\s+${esnekKelime('Üyesi')})?`,
  'g',
);

function junkTemizle(duz: string): string {
  return duz
    .replace(/T\.C\.\s*MUŞ\s+İL\s+BELEDİYESİ\s+BELEDİYE\s+MECLİSİ/g, ' ')
    .replace(
      /Bu\s+belge,?\s*e-?Belediye\s+Bilgi\s+Sistemi'?nde\s+güvenli\s+elektronik\s+imza\s+ile\s+imzalanmıştır\.\s*(?:Doğrulama\s+kodu\s+ile\s+belgeyi\s+görüntüleyebilirsiniz\.\s*)?(?:Doğrulama\s+Kodu\s*:\s*\S+\s*)?(?:Doğrulama\s+Linki\s*:\s*\S+\s*)?\d*/g,
      ' ',
    )
    .replace(
      /Bu\s+belge\s+elektronik\s+olarak\s+imzalıdır\.\s*(?:İmzalı\s+suretinin\s+aslını\s+eDevlet\s+üzerinden\s+doğrulama\s+kodu\s+ile\s+görüntüleyebilirsiniz\.\s*)?(?:Doğrulama\s+Kodu\s*:\s*\S+\s*)?(?:Doğrulama\s+Linki\s*:\s*\S+\s*)?\d*/g,
      ' ',
    )
    .replace(/\bBaşkan\s+\S+(?:\s+\S+){1,6}?\s+Katip\s+\S+(?:\s+\S+){1,4}?\s+Katip\s+\S+(?:\s+\S+){1,4}?\s+Belediye\s+Meclisi\s+Üyesi/g, ' ');
}

const KIRLENME_RE = new RegExp(`Dönem\\s?\\(\\s?Yıl\\s?\\)|${KARARW}\\s+${NO}\\s*:`, 'i');
function govdeKirliMi(govde: string): boolean {
  return (
    KIRLENME_RE.test(govde) ||
    /\bKatip\b|imzalanmıştır|Doğrulama\s+Kodu|e-?Belediye\s+Bilgi\s+Sistemi|T\.C\.\s*MUŞ\s+İL\s+BELEDİYESİ/i.test(govde)
  );
}

interface DamgaEslesme {
  index: number;
  end: number;
  kararNo: string;
  tarih: string;
  konu: string;
  tip: 'full' | 'short';
}

function damgalariCikar(duz0: string): DamgaEslesme[] {
  const re = new RegExp(DAMGA_RE.source, 'g');
  const sonuc: DamgaEslesme[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(duz0))) {
    const gg = m[1]!.replace(/\s+/g, '').padStart(2, '0');
    const aa = m[2]!.replace(/\s+/g, '').padStart(2, '0');
    const yyyy = m[3]!.replace(/\s+/g, '');
    sonuc.push({
      index: m.index,
      end: m.index + m[0].length,
      kararNo: m[4]!.replace(/\s+/g, ''),
      tarih: `${yyyy}-${aa}-${gg}`,
      konu: m[5]!.trim(),
      tip: /\bBaşkan\b/.test(m[0]) ? 'full' : 'short',
    });
  }
  return sonuc;
}

function kararlariAyristir(hamMetin: string, kaynakUrl: string): YerelKararSonucu[] {
  const duz0 = hamMetin.replace(/\s+/g, ' ').trim();
  const eslesmeler = damgalariCikar(duz0);

  interface Run { key: string; kararNo: string; tarih: string; konu: string; matches: DamgaEslesme[] }
  const runlar: Run[] = [];
  let mevcut: Run | null = null;
  for (const e of eslesmeler) {
    const key = `${e.kararNo}|${e.tarih}`;
    if (mevcut && mevcut.key === key) {
      mevcut.matches.push(e);
    } else {
      mevcut = { key, kararNo: e.kararNo, tarih: e.tarih, konu: e.konu, matches: [e] };
      runlar.push(mevcut);
    }
  }

  const sonuc: YerelKararSonucu[] = [];
  for (let j = 0; j < runlar.length; j++) {
    const run = runlar[j]!;
    const ilk = run.matches[0]!;
    const son = run.matches[run.matches.length - 1]!;
    const parcalar: string[] = [];
    if (ilk.tip === 'full') {
      const oncekiRun = runlar[j - 1];
      const bosluklBaslangic = oncekiRun ? oncekiRun.matches[oncekiRun.matches.length - 1]!.end : 0;
      parcalar.push(duz0.slice(bosluklBaslangic, ilk.index));
    }
    for (let k = 0; k < run.matches.length - 1; k++) {
      parcalar.push(duz0.slice(run.matches[k]!.end, run.matches[k + 1]!.index));
    }
    if (son.tip === 'short') {
      const sonrakiRun = runlar[j + 1];
      const bosluklBitis = sonrakiRun ? sonrakiRun.matches[0]!.index : duz0.length;
      parcalar.push(duz0.slice(son.end, bosluklBitis));
    }
    const govde = junkTemizle(parcalar.join(' ')).replace(/\s+/g, ' ').trim();

    if (run.tarih < BASLANGIC_TARIHI) continue;
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    if (govdeKirliMi(govde)) {
      logger.warn(
        `[yerel-mus] kirlenme kapısı: karar_no=${run.kararNo} tarih=${run.tarih} gövdesinde komşu bir kararın damga kalıntısı tespit edildi, GÜVENSİZ sayılıp atlanıyor (kaynak: ${kaynakUrl})`,
      );
      continue;
    }
    sonuc.push({
      belediye: 'Muş',
      karar_no: run.kararNo,
      tarih: run.tarih,
      konu: run.konu || null,
      metin: govde,
      oylama_sonucu: oylamaSonucuCikar(govde),
      kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

interface MusSatir { baslik: string; href: string }

function satirlariCikar(html: string): MusSatir[] {
  const $ = cheerio.load(html);
  const sonuc: MusSatir[] = [];
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

export async function fetchMusKararlar(): Promise<YerelKararSonucu[]> {
  const listRes = await fetchWithBackoff(MUS_KARARLAR_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!listRes.ok) throw new Error(`[yerel-mus] liste sayfası: HTTP ${listRes.status}`);
  const satirlar = satirlariCikar(await listRes.text());

  const sonuc: YerelKararSonucu[] = [];
  const gorulenKarar = new Set<string>();
  for (const { baslik, href } of satirlar) {
    const pdfUrl = href.startsWith('http') ? href : `${MUS_BASE}${href}`;
    try {
      const pres = await fetchWithBackoff(pdfUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!pres.ok) { logger.error(`[yerel-mus] PDF indirilemedi (${baslik}): HTTP ${pres.status}`); continue; }
      const hamMetin = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
      if (hamMetin.replace(/\s+/g, '').length < 100) {
        logger.warn(`[yerel-mus] (${baslik}): metin katmanı yok/çok kısa — muhtemelen taranmış görüntü, OCR yapılmıyor, atlanıyor`);
        continue;
      }
      const kararlar = kararlariAyristir(hamMetin, pdfUrl);
      if (!kararlar.length) {
        logger.warn(`[yerel-mus] (${baslik}): beklenen karar damgası bulunamadı (kapsam dışı tarihli olabilir ya da format tanınmadı), atlanıyor`);
      }
      for (const k of kararlar) {
        const anahtar = `${k.karar_no}|${k.tarih}`;
        if (gorulenKarar.has(anahtar)) continue;
        gorulenKarar.add(anahtar);
        sonuc.push(k);
      }
    } catch (e) {
      logger.error(`[yerel-mus] (${baslik}): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return kararNoSiraDoldur(sonuc);
}

export async function fetchMusUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(MUS_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-mus-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.manager-vertical-card').each((_, kart) => {
    const ad = $(kart).find('.manager-name').first().text().replace(/\s+/g, ' ').trim();
    const hamParti = $(kart).find('p').first().text().replace(/\s+/g, ' ').trim();
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Muş', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
