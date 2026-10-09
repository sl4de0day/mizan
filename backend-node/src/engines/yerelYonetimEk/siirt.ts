import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK,
  pdfMetinCikar, docxMetinCikar, kararNoSiraDoldur,
  type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Siirt');

const SIIRT_BASE = 'https://www.siirt.bel.tr';
const SIIRT_KARARLAR_URL = `${SIIRT_BASE}/meclis-kararlarii`;
const SIIRT_UYELER_WAYBACK_URL = 'https://web.archive.org/web/20251108012041id_/https://www.siirt.bel.tr/meclis-uyelerimiz';

const NEZAKET_MS = 180;
function bekle(): Promise<void> {
  return new Promise((r) => setTimeout(r, NEZAKET_MS));
}

const AY_ADI_YIL: Record<string, string> = {
  ocak: '01', şubat: '02', mart: '03', nisan: '04', mayıs: '05', haziran: '06',
  temmuz: '07', ağustos: '08', eylül: '09', ekim: '10', kasım: '11', aralık: '12',
};

function ayCikar(metin: string): string | null {
  const duz = metin.toLocaleLowerCase('tr');
  for (const [ad, no] of Object.entries(AY_ADI_YIL)) {
    if (duz.includes(ad)) return no;
  }
  return null;
}

interface SiirtKararAday { tarih: string; url: string }

function adaylariCikar(html: string): SiirtKararAday[] {
  const $ = cheerio.load(html);
  const sonuc: SiirtKararAday[] = [];
  $('.custom-table-row').each((_, row) => {
    const wide = $(row).find('.custom-table-cell.wide').first();
    if (!wide.length) return;
    const yilM = (wide.attr('data-header') ?? '').match(/(\d{4})/);
    const ay = ayCikar(wide.text());
    const href = $(row).find('a[href]').first().attr('href');
    if (!yilM || !ay || !href) return;
    const url = href.startsWith('http') ? href : `${SIIRT_BASE}${href}`;
    sonuc.push({ tarih: `${yilM[1]}-${ay}-01`, url });
  });
  return sonuc;
}

async function belgeMetniCikar(url: string, buf: Buffer): Promise<string | null> {
  if (/\.docx(\?|$)/i.test(url)) return docxMetinCikar(buf);
  if (/\.pdf(\?|$)/i.test(url)) return pdfMetinCikar(new Uint8Array(buf));
  return null;
}

export async function fetchSiirtKararlar(): Promise<YerelKararSonucu[]> {
  const sonuc: YerelKararSonucu[] = [];
  const res = await fetchWithBackoff(SIIRT_KARARLAR_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-siirt] liste sayfası: HTTP ${res.status}`);
  const kapsamda = adaylariCikar(await res.text()).filter((a) => a.tarih >= BASLANGIC_TARIHI);
  const benzersiz = Array.from(new Map(kapsamda.map((a) => [a.url, a] as const)).values());
  if (benzersiz.length === 0) return kararNoSiraDoldur(sonuc);

  let kanaryaGercek = false;
  for (const aday of benzersiz.slice(0, 2)) {
    await bekle();
    try {
      const pres = await fetchWithBackoff(aday.url, { headers: HEADERS, timeoutMs: 45000 }, 2);
      if (pres.ok) {
        const metin = await belgeMetniCikar(aday.url, Buffer.from(await pres.arrayBuffer()));
        if (metin && metin.trim().length >= ASGARI_KARAR_UZUNLUK) { kanaryaGercek = true; break; }
      }
    } catch (e) {
      logger.error(`[yerel-siirt] kanarya belgesi (${aday.url}): ${(e as Error).message}`);
    }
  }

  if (!kanaryaGercek) {
    logger.warn(`[yerel-siirt] kanarya kontrolü GERÇEK DUVAR'ı doğruladı (aylık "Meclis Karar Özetleri" PDF'leri taranmış görüntü, metin katmanı yok) — ${benzersiz.length} aday belge indirilmeden atlandı, kararlar boş dönüyor. bkz. dosya başı notu.`);
    return kararNoSiraDoldur(sonuc);
  }

  logger.warn('[yerel-siirt] kanarya BEKLENMEDİK şekilde gerçek metin buldu ama karar-sınırı deseni bilinmediği (hiç gözlemlenmediği) için bulaşma riskiyle YAYIMLANMIYOR — bu motor gerçek bir metin örneği görüldükten sonra MANUEL güncelleme gerektiriyor.');
  return kararNoSiraDoldur(sonuc);
}

async function waybackHtmlGetir(url: string): Promise<string> {
  const MAX_DENEME = 6;
  let sonHata = '';
  for (let deneme = 1; deneme <= MAX_DENEME; deneme++) {
    try {
      const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 30000 }, 2);
      if (res.ok) return await res.text();
      sonHata = `HTTP ${res.status}`;
      if (res.status !== 498) break;
    } catch (e) {
      sonHata = (e as Error).message;
    }
    if (deneme < MAX_DENEME) {
      logger.warn(`[yerel-siirt-uye] Wayback isteği başarısız (deneme ${deneme}/${MAX_DENEME}, ${sonHata}) — IA'nın aralıklı robots-dışlama tetiklemesi olabilir (bkz. dosya başı notu), bekleyip tekrar deneniyor.`);
      await new Promise((r) => setTimeout(r, deneme * 5000));
    }
  }
  throw new Error(`[yerel-siirt-uye] Wayback anlık görüntüsü (${url}): ${sonHata} (${MAX_DENEME} denemede başarısız)`);
}

export async function fetchSiirtUyeler(): Promise<YerelUyeSonucu[]> {
  const html = await waybackHtmlGetir(SIIRT_UYELER_WAYBACK_URL);
  const $ = cheerio.load(html);
  const sonuc: YerelUyeSonucu[] = [];
  let tabloBulundu = false;
  $('table').each((_, tabloEl) => {
    const tabloMetni = $(tabloEl).text();
    if (!/ADI/.test(tabloMetni) || !/SOYADI/.test(tabloMetni) || !/PARTİSİ/.test(tabloMetni)) return;
    tabloBulundu = true;
    $(tabloEl).find('tr').each((_, tr) => {
      const hucreler = $(tr).find('td,th').map((_, td) => $(td).text().replace(/\s+/g, ' ').trim()).get();
      if (hucreler.length !== 3) return;
      const [ad, soyad, hamParti] = hucreler;
      if (!ad || !soyad || !hamParti) return;
      if (ad.toLocaleUpperCase('tr') === 'ADI') return;
      const kanonik = normParti(hamParti);
      sonuc.push({
        belediye: 'Siirt',
        ad_soyad: `${ad} ${soyad}`.replace(/\s+/g, ' ').trim(),
        parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik,
        ilce: null,
      });
    });
  });
  if (!tabloBulundu) throw new Error('[yerel-siirt-uye] ADI/SOYADI/PARTİSİ tablosu bulunamadı — Wayback anlık görüntüsü biçim değiştirmiş olabilir');
  return sonuc;
}
