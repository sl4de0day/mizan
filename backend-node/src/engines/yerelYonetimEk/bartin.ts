import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  pdfMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Bartin');

const BARTIN_BASE = 'https://bartin.bel.tr';
const BARTIN_KARARLAR_SAYFA = `${BARTIN_BASE}/meclis-karar-ozetleri`;
const BARTIN_ANNOUNCEMENT_AJAX = `${BARTIN_BASE}/ISAYWebPart/Announcement/AnnouncementDahaFazlaYukle`;
const BARTIN_KARAR_CONTENT_TYPE_ID = 'YVOXB+eMhh24Q7/MNzRjAQ==';
const BARTIN_UYELER_URL = `${BARTIN_BASE}/belediye-meclis-uyeleri`;

const AY_KISALTMA: Record<string, string> = {
  'OCAK': '01', 'ŞUBAT': '02', 'MART': '03', 'NİSAN': '04', 'MAYIS': '05', 'HAZİRAN': '06',
  'TEMMUZ': '07', 'AĞUSTOS': '08', 'EYLÜL': '09', 'EKİM': '10', 'KASIM': '11', 'ARALIK': '12',
};

interface BartinTarihParcasi { gun: string; ay: string; yil: string | null }
function baslikTarihiAyristir(baslik: string): BartinTarihParcasi | null {
  const m = baslik.match(/(\d{1,2})\s+([A-ZÇĞİÖŞÜ]+)(?:\s+(\d{4}))?/);
  if (!m) return null;
  const ay = AY_KISALTMA[m[2]];
  if (!ay) return null;
  return { gun: m[1].padStart(2, '0'), ay, yil: m[3] ?? null };
}

interface BartinSatir { href: string; gun: string; ay: string; tarih: string | null }

function satirlariCikar(html: string): BartinSatir[] {
  const $ = cheerio.load(html);
  const sonuc: BartinSatir[] = [];
  $('a.announce-text[href]').each((_, el) => {
    const href = $(el).attr('href');
    const baslik = $(el).text().replace(/\s+/g, ' ').trim();
    if (!href) return;
    const parca = baslikTarihiAyristir(baslik);
    if (!parca) return;
    const tarih = parca.yil ? `${parca.yil}-${parca.ay}-${parca.gun}` : null;
    sonuc.push({ href, gun: parca.gun, ay: parca.ay, tarih });
  });
  return sonuc;
}

function pdfUrlCikar(detayHtml: string): string | null {
  const scriptM = detayHtml.match(/var\s+url\s*=\s*'([^']+\.pdf)'/);
  if (scriptM) return scriptM[1];
  const $ = cheerio.load(detayHtml);
  return $('.icerik a[href$=".pdf"]').first().attr('href') ?? null;
}

function kararlariAyristir(metinHam: string, tarih: string, kaynakUrl: string): YerelKararSonucu[] {
  const duz = metinHam.replace(/\s+/g, ' ').trim();
  const lower = duz.toLocaleLowerCase('tr');
  const re = /oy\s*(birliği\w*|çokluğu\w*)/g;
  const bitisler: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower))) {
    const noktaIdx = duz.indexOf('.', m.index);
    if (noktaIdx === -1) continue;
    const bitis = noktaIdx + 1;
    if (bitisler.length === 0 || bitisler[bitisler.length - 1] !== bitis) bitisler.push(bitis);
  }
  if (!bitisler.length) return [];

  const basliklaBaslar = duz.slice(0, 400).match(/(?:^|\s)(1\.\s)/);
  let baslangic = basliklaBaslar ? basliklaBaslar.index! + (basliklaBaslar[0].length - basliklaBaslar[1].length) : 0;

  const sonuc: YerelKararSonucu[] = [];
  let sira = 1;
  for (const bitis of bitisler) {
    if (bitis <= baslangic) continue;
    const parca = duz.slice(baslangic, bitis).trim();
    baslangic = bitis;
    if (parca.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({
      belediye: 'Bartın', karar_no: String(sira), tarih, konu: null, metin: parca,
      oylama_sonucu: oylamaSonucuCikar(parca), kaynak_url: kaynakUrl,
    });
    sira++;
  }
  return sonuc;
}

export async function fetchBartinKararlar(): Promise<YerelKararSonucu[]> {
  const sonuc: YerelKararSonucu[] = [];
  let page = 1;
  let dur = false;
  while (!dur) {
    const body = JSON.stringify({
      page, ContentTypeId: BARTIN_KARAR_CONTENT_TYPE_ID, OrderByAsc: 'true',
      ContentCount: '10', GosterimSekli: '3',
    });
    const res = await fetchWithBackoff(BARTIN_ANNOUNCEMENT_AJAX, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json', Referer: BARTIN_KARARLAR_SAYFA },
      body, timeoutMs: 30000,
    }, 3);
    if (!res.ok) { logger.error(`[yerel-bartin] liste sayfa ${page}: HTTP ${res.status}`); break; }
    const satirlar = satirlariCikar(await res.text());
    if (!satirlar.length) break;

    for (const satir of satirlar) {
      if (satir.tarih && satir.tarih < BASLANGIC_TARIHI) { dur = true; continue; }
      let tarih = satir.tarih;
      const gosterimEtiketi = tarih ?? `${satir.gun}-${satir.ay} (yıl PDF url'inden çözülecek)`;
      const detayUrl = satir.href.startsWith('http') ? satir.href : `${BARTIN_BASE}${satir.href}`;
      try {
        const dres = await fetchWithBackoff(detayUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
        if (!dres.ok) { logger.error(`[yerel-bartin] detay (${gosterimEtiketi}): HTTP ${dres.status} (${detayUrl})`); continue; }
        const detayHtml = await dres.text();
        const pdfHref = pdfUrlCikar(detayHtml);
        if (!pdfHref) { logger.error(`[yerel-bartin] PDF linki bulunamadı (${gosterimEtiketi}, ${detayUrl})`); continue; }
        const pdfUrl = pdfHref.startsWith('http') ? pdfHref : `${BARTIN_BASE}${pdfHref}`;
        if (!tarih) {
          const yilM = pdfUrl.match(/(20\d{2})/);
          if (!yilM) { logger.error(`[yerel-bartin] yıl çözülemedi (${satir.gun}-${satir.ay}, ${pdfUrl}) — başlıkta ve PDF adında yıl yok, satır atlanıyor`); continue; }
          tarih = `${yilM[1]}-${satir.ay}-${satir.gun}`;
          if (tarih < BASLANGIC_TARIHI) continue;
        }
        const pres = await fetchWithBackoff(pdfUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
        if (!pres.ok) { logger.error(`[yerel-bartin] PDF indirilemedi (${tarih}): HTTP ${pres.status} (${pdfUrl})`); continue; }
        const metinHam = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
        if (metinHam.replace(/\s+/g, '').length < 200) {
          logger.error(`[yerel-bartin] PDF metni neredeyse boş (${tarih}, ${pdfUrl}) — taranmış görüntü olabilir, OCR yapılmıyor`);
          continue;
        }
        const kararlar = kararlariAyristir(metinHam, tarih, pdfUrl);
        if (!kararlar.length) {
          logger.error(`[yerel-bartin] ${tarih}: metin var ama hiç oylama beyanı bulunamadı (muhtemelen dönük/bozuk OCR) — karar ayrıştırılamadı (${pdfUrl})`);
        }
        sonuc.push(...kararlar);
      } catch (e) {
        logger.error(`[yerel-bartin] (${tarih ?? gosterimEtiketi}): ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 180));
    }
    if (dur) break;
    page++;
  }
  return sonuc;
}

export async function fetchBartinUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(BARTIN_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-bartin-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.manager-vertical-card').each((_, kart) => {
    const ad = $(kart).find('.manager-name').first().text().replace(/\s+/g, ' ').trim();
    const pMetni = $(kart).find('p').first().text();
    const hamParti = pMetni.split(/Mesleği\s*:/)[0].replace(/Partisi\s*:/, '').replace(/ㅤ/g, '').replace(/\s+/g, ' ').trim();
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Bartın', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
