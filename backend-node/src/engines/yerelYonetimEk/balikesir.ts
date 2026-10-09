import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  pdfMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Balikesir');

const BALIKESIR_BASE = 'https://balikesir.bel.tr';
const KARARLAR_LISTE_URL = `${BALIKESIR_BASE}/meclis-kararlari`;
const UYELER_URL = `${BALIKESIR_BASE}/meclis-uyeleri`;

const NEZAKET_MS = 180;
function bekle(): Promise<void> {
  return new Promise((r) => setTimeout(r, NEZAKET_MS));
}

const AZAMI_LISTE_SAYFA = 10;

const AY_KISALTMA: Record<string, string> = {
  ocak: '01', subat: '02', mart: '03', nisan: '04', mayis: '05', haziran: '06',
  temmuz: '07', agustos: '08', eylul: '09', ekim: '10', kasim: '11', aralik: '12',
};

interface ListeSatiri { href: string }

function listeSatirlariniCikar(html: string): ListeSatiri[] {
  const $ = cheerio.load(html);
  const sonuc: ListeSatiri[] = [];
  const gorulen = new Set<string>();
  $('a[href^="/meclis-kararlari/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || gorulen.has(href)) return;
    gorulen.add(href);
    sonuc.push({ href });
  });
  return sonuc;
}

function maksSayfaCikar(html: string): number {
  const $ = cheerio.load(html);
  let maks = 1;
  $('.pagination a[href*="sayfa="]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const m = href.match(/sayfa=(\d+)/);
    if (m) {
      const n = Number(m[1]);
      if (n > maks) maks = n;
    }
  });
  return maks;
}

function slugdanAyBasi(slug: string): string | null {
  const m = slug.match(/^(\d{4})-yili-([a-zçğıöşü]+)-ay/);
  if (!m) return null;
  const ay = AY_KISALTMA[m[2]!];
  if (!ay) return null;
  return `${m[1]}-${ay}-01`;
}

const KARAR_BASLIK_RE =
  /T\.C\.\s*BALIKESİR\s*BÜYÜKŞEHİR\s*BELEDİYE\s*BAŞKANLIĞI\s*MECLİS\s*KARARI\s*Karar\s+Tarihi\s*:?\s*([\d\s]+?)\.([\d\s]+?)\.([\d\s]+?)\s*Karar\s+Numaras[ıi]\s*:?\s*([\d\s]+?)\s*Konu\b/g;

const SONRAKI_ETIKET_RE = /(DA[İI]RE\s*TEKL[İI]F[İI]|KOM[İI]SYON\s*GÖRÜŞ\s*Ü?|ÖNERGE(?:\s*-?\s*\d+)?|DÜZELTME\s*KARARI|KARAR)\s*:/;

const KARAR_ETIKET_RE = /\bKARAR\s*:/gi;

function esasOylamaSonucu(govde: string): 'oybirlik' | 'oycoklugu' | null {
  const etiketler = [...govde.matchAll(new RegExp(KARAR_ETIKET_RE.source, 'gi'))];
  const sonKisim = etiketler.length > 0 ? govde.slice(etiketler[etiketler.length - 1]!.index!) : govde;
  const onarilmis = sonKisim
    .replace(/o\s*y\s*b\s*i\s*r\s*l\s*i\s*ğ\s*i/gi, 'oybirliği')
    .replace(/o\s*y\s*ç\s*o\s*k\s*l\s*u\s*ğ\s*u/gi, 'oyçokluğu');
  return oylamaSonucuCikar(onarilmis);
}

function kararlaraAyir(hamMetin: string, kaynakUrl: string): YerelKararSonucu[] {
  const tumEslesmeler = [...hamMetin.matchAll(new RegExp(KARAR_BASLIK_RE.source, 'g'))];
  const ilkGorulme = new Map<string, number>();
  const sira: string[] = [];
  for (const m of tumEslesmeler) {
    const gg = m[1]!.replace(/\s+/g, '').padStart(2, '0');
    const aa = m[2]!.replace(/\s+/g, '').padStart(2, '0');
    const yyyy = m[3]!.replace(/\s+/g, '');
    const no = m[4]!.replace(/\s+/g, '');
    const anahtar = `${yyyy}-${aa}-${gg}|${no}`;
    if (!ilkGorulme.has(anahtar)) {
      ilkGorulme.set(anahtar, m.index!);
      sira.push(anahtar);
    }
  }
  const baslangiclar = sira.map((k) => ilkGorulme.get(k)!);

  const sonuc: YerelKararSonucu[] = [];
  for (let i = 0; i < sira.length; i++) {
    const [tarih, kararNo] = sira[i]!.split('|') as [string, string];
    if (tarih < BASLANGIC_TARIHI) continue;
    const baslangic = baslangiclar[i]!;
    const bitis = i + 1 < sira.length ? baslangiclar[i + 1]! : hamMetin.length;
    const govde = hamMetin.slice(baslangic, bitis).replace(/\s+/g, ' ').trim();
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;

    let konu: string | null = null;
    const konuM = govde.match(/\bKONU\s*:/);
    if (konuM) {
      const sonrasi = govde.slice(konuM.index! + konuM[0].length);
      const sinirM = sonrasi.match(SONRAKI_ETIKET_RE);
      konu = sinirM ? sonrasi.slice(0, sinirM.index).trim() || null : null;
    }

    sonuc.push({
      belediye: 'Balıkesir', karar_no: kararNo, tarih, konu, metin: govde,
      oylama_sonucu: esasOylamaSonucu(govde), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

export async function fetchBalikesirKararlar(): Promise<YerelKararSonucu[]> {
  const ilkRes = await fetchWithBackoff(KARARLAR_LISTE_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!ilkRes.ok) throw new Error(`[yerel-balikesir] liste sayfa 1: HTTP ${ilkRes.status}`);
  const ilkHtml = await ilkRes.text();
  const tumSatirlar: ListeSatiri[] = [...listeSatirlariniCikar(ilkHtml)];
  const maksSayfa = Math.min(maksSayfaCikar(ilkHtml), AZAMI_LISTE_SAYFA);

  for (let sayfa = 2; sayfa <= maksSayfa; sayfa++) {
    await bekle();
    try {
      const res = await fetchWithBackoff(`${KARARLAR_LISTE_URL}?sayfa=${sayfa}`, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!res.ok) { logger.error(`[yerel-balikesir] liste sayfa ${sayfa}: HTTP ${res.status}`); continue; }
      tumSatirlar.push(...listeSatirlariniCikar(await res.text()));
    } catch (e) {
      logger.error(`[yerel-balikesir] liste sayfa ${sayfa}: ${(e as Error).message}`);
    }
  }

  const gorulenHref = new Set<string>();
  const adaylar = tumSatirlar.filter(({ href }) => {
    if (gorulenHref.has(href)) return false;
    gorulenHref.add(href);
    if (href === '/meclis-kararlari') return false;
    if (/ozet/i.test(href)) return false;
    if (!href.endsWith('-meclis-kararlari')) return false;
    const slug = href.replace('/meclis-kararlari/', '');
    const ayBasi = slugdanAyBasi(slug);
    if (ayBasi === null) return false;
    return ayBasi >= BASLANGIC_TARIHI;
  });

  const sonuc: YerelKararSonucu[] = [];
  for (const { href } of adaylar) {
    const detayUrl = `${BALIKESIR_BASE}${href}`;
    try {
      const dres = await fetchWithBackoff(detayUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!dres.ok) { logger.error(`[yerel-balikesir] detay: HTTP ${dres.status} — ${detayUrl}`); continue; }
      const $ = cheerio.load(await dres.text());
      const pdfHref = $('a[href*="/Dosyalar/MeclisKararlari/"]').first().attr('href');
      if (!pdfHref) { logger.error(`[yerel-balikesir] PDF linki yok: ${detayUrl}`); continue; }
      const pdfUrl = pdfHref.startsWith('http') ? pdfHref : `${BALIKESIR_BASE}${pdfHref}`;

      await bekle();
      const pres = await fetchWithBackoff(pdfUrl, { headers: HEADERS, timeoutMs: 45000 }, 3);
      if (!pres.ok) { logger.error(`[yerel-balikesir] PDF indirilemedi: HTTP ${pres.status} — ${pdfUrl}`); continue; }
      const hamMetin = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
      if (hamMetin.trim().length < ASGARI_KARAR_UZUNLUK) {
        logger.error(`[yerel-balikesir] metin katmanı yok/çok kısa (${hamMetin.trim().length} krk), atlanıyor: ${pdfUrl}`);
        continue;
      }
      const kararlar = kararlaraAyir(hamMetin, pdfUrl);
      if (kararlar.length === 0) {
        logger.error(`[yerel-balikesir] belge indirildi ama beklenen karar başlığı bulunamadı: ${pdfUrl}`);
      }
      sonuc.push(...kararlar);
    } catch (e) {
      logger.error(`[yerel-balikesir] (${detayUrl}): ${(e as Error).message}`);
    }
    await bekle();
  }
  return sonuc;
}

const AZAMI_UYE_SAYFA = 10;

function formAlanlariniCikar($: cheerio.CheerioAPI): URLSearchParams {
  const form = $('form#form');
  const params = new URLSearchParams();
  form.find('input[name]').each((_, el) => {
    const name = $(el).attr('name');
    if (!name || name === 'sayfa') return;
    params.append(name, $(el).attr('value') ?? '');
  });
  form.find('select[name]').each((_, el) => {
    const name = $(el).attr('name');
    if (!name) return;
    const secili = $(el).find('option[selected]').attr('value') ?? $(el).find('option').first().attr('value') ?? '';
    params.append(name, secili);
  });
  return params;
}

interface UyeSatiri { adSoyad: string; hamParti: string; href: string }

function uyeSatirlariniCikar(html: string): UyeSatiri[] {
  const $ = cheerio.load(html);
  const sonuc: UyeSatiri[] = [];
  $('.card.h-100').each((_, el) => {
    const $el = $(el);
    const href = $el.closest('a[href]').attr('href');
    const adSoyad = $el.find('.card-title').first().text().replace(/\s+/g, ' ').trim();
    const hamParti = $el.find('.card-text').first().text().replace(/\s+/g, ' ').trim();
    if (href && adSoyad) sonuc.push({ adSoyad, hamParti, href });
  });
  return sonuc;
}

export async function fetchBalikesirUyeler(): Promise<YerelUyeSonucu[]> {
  const ilkRes = await fetchWithBackoff(UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!ilkRes.ok) throw new Error(`[yerel-balikesir-uye] HTTP ${ilkRes.status}`);
  const ilkHtml = await ilkRes.text();
  const $ilk = cheerio.load(ilkHtml);
  const cerezler = (ilkRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

  const tumSatirlar: UyeSatiri[] = [];
  const gorulenHref = new Set<string>();
  for (let sayfa = 1; sayfa <= AZAMI_UYE_SAYFA; sayfa++) {
    const govde = formAlanlariniCikar($ilk);
    govde.append('sayfa', String(sayfa));
    const res = await fetchWithBackoff(UYELER_URL, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cerezler, Referer: UYELER_URL },
      body: govde.toString(),
      timeoutMs: 30000,
    }, 3);
    if (!res.ok) { logger.error(`[yerel-balikesir-uye] sayfa ${sayfa}: HTTP ${res.status}`); break; }
    const satirlar = uyeSatirlariniCikar(await res.text());
    if (satirlar.length === 0) break;
    let yeniVarMi = false;
    for (const s of satirlar) {
      if (gorulenHref.has(s.href)) continue;
      gorulenHref.add(s.href);
      tumSatirlar.push(s);
      yeniVarMi = true;
    }
    if (!yeniVarMi) break;
    await bekle();
  }

  const sonuc: YerelUyeSonucu[] = [];
  for (const satir of tumSatirlar) {
    if (!satir.hamParti) continue;
    const kanonik = normParti(satir.hamParti);
    const parti = kanonik === 'Bilinmiyor' ? satir.hamParti : kanonik;

    let ilce: string | null = null;
    const detayUrl = satir.href.startsWith('http') ? satir.href : `${BALIKESIR_BASE}${satir.href}`;
    try {
      await bekle();
      const dres = await fetchWithBackoff(detayUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (dres.ok) {
        const $d = cheerio.load(await dres.text());
        $d('.divrightside li, .divrightside p').each((_, el) => {
          const $el = $d(el);
          const etiket = $el.find('strong').first().text().replace(/\s+/g, ' ').trim().replace(/[:\s]+$/, '');
          if (!etiket || !etiket.toLocaleLowerCase('tr').includes('ilçe')) return;
          const tam = $el.text().replace(/\s+/g, ' ').trim();
          const deger = tam.slice(etiket.length).replace(/^[:\s]+/, '').trim();
          if (deger) ilce = deger;
        });
      } else {
        logger.error(`[yerel-balikesir-uye] detay: HTTP ${dres.status} — ${detayUrl}`);
      }
    } catch (e) {
      logger.error(`[yerel-balikesir-uye] (${detayUrl}): ${(e as Error).message}`);
    }

    sonuc.push({ belediye: 'Balıkesir', ad_soyad: satir.adSoyad, parti, ilce });
  }
  return sonuc;
}
