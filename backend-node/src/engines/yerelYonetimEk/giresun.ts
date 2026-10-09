import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  pdfMetinCikar, docxMetinCikar, type YerelKararSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Giresun');

const GIRESUN_BASE = 'https://giresun.bel.tr';
const KARARLAR_KATEGORI_SLUG = 'meclis-kararlari';

const NEZAKET_MS = 180;
function bekle(): Promise<void> {
  return new Promise((r) => setTimeout(r, NEZAKET_MS));
}

async function kategoriIdGetir(slug: string): Promise<number> {
  const url = `${GIRESUN_BASE}/wp-json/wp/v2/categories?slug=${encodeURIComponent(slug)}`;
  const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 20000 }, 3);
  if (!res.ok) throw new Error(`[yerel-giresun] kategori (${slug}): HTTP ${res.status}`);
  const j = (await res.json()) as { id: number }[];
  if (!j[0]) throw new Error(`[yerel-giresun] kategori (${slug}): bulunamadı`);
  return j[0].id;
}

interface GiresunYazi { id: number; baslik: string; link: string; wpTarih: string; icerikHtml: string }

async function tumYazilariGetir(kategoriId: number): Promise<GiresunYazi[]> {
  const sonuc: GiresunYazi[] = [];
  for (let sayfa = 1; ; sayfa++) {
    const url = `${GIRESUN_BASE}/wp-json/wp/v2/posts?categories=${kategoriId}&per_page=100&page=${sayfa}&_fields=id,date,link,title,content`;
    const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 20000 }, 3);
    if (!res.ok) {
      if (res.status === 400) break;
      throw new Error(`[yerel-giresun] yazı listesi (sayfa ${sayfa}): HTTP ${res.status}`);
    }
    const j = (await res.json()) as { id: number; date: string; link: string; title: { rendered: string }; content: { rendered: string } }[];
    if (j.length === 0) break;
    for (const p of j) {
      sonuc.push({ id: p.id, baslik: p.title.rendered.replace(/&#8217;/g, '’').replace(/&#8211;/g, '–').trim(), link: p.link, wpTarih: p.date.slice(0, 10), icerikHtml: p.content.rendered });
    }
    await bekle();
  }
  return sonuc;
}

const TOPLU_AKTARIM_ESIGI = 10;
function topluIceAktarimGunleriBul(yazilar: GiresunYazi[]): Set<string> {
  const sayim = new Map<string, number>();
  for (const y of yazilar) sayim.set(y.wpTarih, (sayim.get(y.wpTarih) ?? 0) + 1);
  const gunler = new Set<string>();
  for (const [gun, adet] of sayim) if (adet >= TOPLU_AKTARIM_ESIGI) gunler.add(gun);
  return gunler;
}

function baslikTarihiCikar(baslik: string): string | null {
  const m = baslik.match(/(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
}

function ajandaCagrisiMi(baslik: string): boolean {
  const duz = baslik.toLocaleLowerCase('tr');
  return /toplant.*çağrı/.test(duz) || /çağrısı ve gündem/.test(duz);
}

function cokluKararBelgesiMi(baslik: string): boolean {
  return /karar özet/.test(baslik.toLocaleLowerCase('tr'));
}

function ekBelgeMi(dosyaAdi: string): boolean {
  return /eki\.(pdf|docx?)$/i.test(dosyaAdi.toLowerCase());
}

function gundemDosyasiMi(dosyaAdi: string): boolean {
  return /gundem/i.test(dosyaAdi);
}

function dosyaAdindanKararNo(dosyaAdi: string): string | null {
  const m1 = dosyaAdi.match(/_(\d{1,4})_KARAR/i);
  if (m1) return m1[1]!;
  const sade = dosyaAdi.toLocaleLowerCase('tr').replace(/ı/g, 'i');
  const m2 = sade.match(/(\d{1,4})\s*sayili\s*karar/);
  return m2 ? m2[1]! : null;
}

const BOZUK_METIN_ESIGI_1000 = 0.5;
function metinBozukMu(metin: string): boolean {
  const geciSayisi = (metin.match(/\p{Ll}\p{Lu}/gu) ?? []).length;
  return (geciSayisi / metin.length) * 1000 > BOZUK_METIN_ESIGI_1000;
}

interface Belge { url: string; dosyaAdi: string }

function belgeleriCikar(html: string): Belge[] {
  const $ = cheerio.load(html);
  const sonuc: Belge[] = [];
  const gorulen = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    if (!/\.(pdf|docx?|rar|zip)(\?|$)/i.test(href)) return;
    if (gorulen.has(href)) return;
    gorulen.add(href);
    const dosyaAdi = href.split('/').pop() ?? href;
    sonuc.push({ url: href, dosyaAdi });
  });
  return sonuc;
}

export async function fetchGiresunKararlar(): Promise<YerelKararSonucu[]> {
  let kategoriId: number;
  try {
    kategoriId = await kategoriIdGetir(KARARLAR_KATEGORI_SLUG);
  } catch (e) {
    logger.error(`[yerel-giresun] kategori id çözülemedi: ${(e as Error).message}`);
    return [];
  }

  const tumYazilar = await tumYazilariGetir(kategoriId);
  const topluGunler = topluIceAktarimGunleriBul(tumYazilar);
  logger.info(`[yerel-giresun] ${tumYazilar.length} yazı, ${topluGunler.size} toplu-aktarım günü tespit edildi (dinamik eşik ≥${TOPLU_AKTARIM_ESIGI})`);

  const sonuc: YerelKararSonucu[] = [];
  const gorulenKarar = new Set<string>();
  let atlananDocEski = 0;
  let atlananArsiv = 0;
  let atlananTaranmis = 0;
  let atlananBelirsizTarih = 0;
  let atlananCokluBulasma = 0;

  for (const yazi of tumYazilar) {
    if (ajandaCagrisiMi(yazi.baslik)) continue;

    const baslikTarih = baslikTarihiCikar(yazi.baslik);
    let meclisTarihi: string | null;
    if (baslikTarih) {
      meclisTarihi = baslikTarih;
    } else if (!topluGunler.has(yazi.wpTarih)) {
      meclisTarihi = yazi.wpTarih;
    } else {
      meclisTarihi = null;
    }
    if (!meclisTarihi || meclisTarihi < BASLANGIC_TARIHI) {
      if (meclisTarihi === null) atlananBelirsizTarih++;
      continue;
    }

    const cokluKarar = cokluKararBelgesiMi(yazi.baslik);
    const belgeler = belgeleriCikar(yazi.icerikHtml).filter((b) => !ekBelgeMi(b.dosyaAdi) && !gundemDosyasiMi(b.dosyaAdi));

    for (const belge of belgeler) {
      await bekle();
      const dosyaAdiKucuk = belge.dosyaAdi.toLowerCase();
      if (/\.doc$/i.test(dosyaAdiKucuk)) {
        logger.warn(`[yerel-giresun] eski .doc formatı desteklenmiyor, atlanıyor: ${belge.url}`);
        atlananDocEski++;
        continue;
      }
      if (/\.(rar|zip)$/i.test(dosyaAdiKucuk)) {
        logger.warn(`[yerel-giresun] .rar/.zip desteklenmiyor, atlanıyor: ${belge.url}`);
        atlananArsiv++;
        continue;
      }
      let metin: string | null = null;
      try {
        const res = await fetchWithBackoff(belge.url, { headers: HEADERS, timeoutMs: 60000 }, 3);
        if (!res.ok) { logger.error(`[yerel-giresun] belge indirilemedi (${belge.url}): HTTP ${res.status}`); continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        if (/\.docx$/i.test(dosyaAdiKucuk)) {
          metin = docxMetinCikar(buf);
        } else {
          metin = await pdfMetinCikar(new Uint8Array(buf));
        }
      } catch (e) {
        logger.error(`[yerel-giresun] belge (${belge.url}): ${(e as Error).message}`);
        continue;
      }
      if (!metin || metin.trim().length < ASGARI_KARAR_UZUNLUK) {
        logger.warn(`[yerel-giresun] belge metni yok/çok kısa (muhtemelen taranmış görüntü), atlanıyor: ${belge.url}`);
        atlananTaranmis++;
        continue;
      }
      if (metinBozukMu(metin)) {
        logger.warn(`[yerel-giresun] belge metni BOZUK (muhtemelen kaynağın kendi hatalı OCR'ı), güvenilmediği için atlanıyor: ${belge.url}`);
        atlananTaranmis++;
        continue;
      }
      const govde = metin.replace(/\s+/g, ' ').trim();
      if (cokluKarar) {
        logger.warn(`[yerel-giresun] çoklu-karar belgesinde BEKLENMEDİK metin bulundu (${govde.length} karakter) — karar-sınırı belirlenemediği için bulaşma riskiyle YAYIMLANMIYOR: ${belge.url}`);
        atlananCokluBulasma++;
        continue;
      }
      const kararNo = dosyaAdindanKararNo(belge.dosyaAdi);
      const anahtar = `${kararNo}|${meclisTarihi}|${belge.url}`;
      if (gorulenKarar.has(anahtar)) continue;
      gorulenKarar.add(anahtar);
      sonuc.push({
        belediye: 'Giresun', karar_no: kararNo, tarih: meclisTarihi, konu: null, metin: govde,
        oylama_sonucu: oylamaSonucuCikar(govde), kaynak_url: belge.url,
      });
    }
  }

  logger.info(`[yerel-giresun] tamamlandı: ${sonuc.length} karar; atlanan: ${atlananTaranmis} taranmış-görüntü, ${atlananDocEski} eski-.doc, ${atlananArsiv} arşiv, ${atlananBelirsizTarih} belirsiz-tarih, ${atlananCokluBulasma} çoklu-karar-bulaşma-riski`);
  return sonuc;
}
