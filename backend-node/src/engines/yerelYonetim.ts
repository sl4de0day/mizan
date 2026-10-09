import * as cheerio from 'cheerio';
import { normParti } from '../lib/partyResolve.js';
import { getLogger } from '../lib/logger.js';
export {
  fetchWithBackoff, getJson, BASLANGIC_TARIHI, YEREL_YONETIM_BELEDIYELERI, HEADERS,
  oylamaSonucuCikar, ASGARI_KARAR_UZUNLUK, gunAy, docxMetinCikar, pdfMetinCikar,
  type Belediye, type YerelKararSonucu, type YerelUyeSonucu,
} from './yerelYonetimOrtak.js';
import {
  fetchWithBackoff, getJson, BASLANGIC_TARIHI, HEADERS,
  oylamaSonucuCikar, ASGARI_KARAR_UZUNLUK, gunAy, docxMetinCikar, pdfMetinCikar,
  type Belediye, type YerelKararSonucu, type YerelUyeSonucu,
} from './yerelYonetimOrtak.js';

const logger = getLogger('PoliticalInsight.YerelYonetim');

const IBB_API = 'https://webapi.ibb.istanbul/api';
const IBB_KAYNAK_SAYFA = 'https://ibb.istanbul/ibb/buyuksehir-belediye-meclisi/meclis-kararlari-ve-karar-ozetleri/';

interface IbbKararAttrs { tarih: string; ozet: string; detay: string; kararNo: string | number | null; }
interface IbbListResponse<T> { data: { id: number; attributes: T }[]; meta: { pagination: { page: number; pageCount: number; total: number } } }

export async function fetchIstanbulKararlar(): Promise<YerelKararSonucu[]> {
  const sonuc: YerelKararSonucu[] = [];
  let page = 1, pageCount = 1;
  do {
    const url = `${IBB_API}/meclis-kararlari?filters%5Btarih%5D%5B%24gte%5D=${BASLANGIC_TARIHI}` +
      `&sort=tarih:asc&pagination%5Bpage%5D=${page}&pagination%5BpageSize%5D=100`;
    const j = await getJson<IbbListResponse<IbbKararAttrs>>(url, { headers: HEADERS, timeoutMs: 30000 });
    pageCount = j.meta.pagination.pageCount;
    for (const row of j.data) {
      const metinDuz = row.attributes.detay.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (metinDuz.length < ASGARI_KARAR_UZUNLUK) continue;
      sonuc.push({
        belediye: 'İstanbul', karar_no: row.attributes.kararNo != null ? String(row.attributes.kararNo) : null,
        tarih: row.attributes.tarih, konu: row.attributes.ozet || null, metin: metinDuz,
        oylama_sonucu: oylamaSonucuCikar(metinDuz), kaynak_url: IBB_KAYNAK_SAYFA,
      });
    }
    page++;
  } while (page <= pageCount);
  return sonuc;
}

export async function fetchIstanbulUyeler(): Promise<YerelUyeSonucu[]> {
  const sonuc: YerelUyeSonucu[] = [];
  let page = 1, pageCount = 1;
  do {
    const url = `${IBB_API}/kisiler?filters%5Bmeclis%5D%5B%24eq%5D=true` +
      `&pagination%5Bpage%5D=${page}&pagination%5BpageSize%5D=100` +
      `&populate%5BcardPerson%5D%5Bpopulate%5D%5Bparti%5D=true&populate%5BcardPerson%5D%5Bpopulate%5D%5Bilce%5D=true`;
    interface Kisi { title: string; cardPerson?: { parti?: { data?: { attributes?: { short?: string; title?: string } } }; ilce?: { data?: { attributes?: { title?: string } } } } }
    const j = await getJson<IbbListResponse<Kisi>>(url, { headers: HEADERS, timeoutMs: 30000 });
    pageCount = j.meta.pagination.pageCount;
    for (const row of j.data) {
      const cp = row.attributes.cardPerson;
      const hamParti = cp?.parti?.data?.attributes?.short || cp?.parti?.data?.attributes?.title;
      if (!row.attributes.title || !hamParti) continue;
      const kanonik = normParti(hamParti);
      sonuc.push({
        belediye: 'İstanbul', ad_soyad: row.attributes.title,
        parti: kanonik === 'Bilinmiyor' ? hamParti.trim() : kanonik,
        ilce: cp?.ilce?.data?.attributes?.title || null,
      });
    }
    page++;
  } while (page <= pageCount);
  return sonuc;
}

const ANKARA_KARARLAR_URL = 'https://www.ankara.bel.tr/meclis/kararlar';
const ANKARA_UYELER_URL = 'https://www.ankara.bel.tr/meclis/uyeler';

export async function fetchAnkaraKararlar(): Promise<YerelKararSonucu[]> {
  const sonuc: YerelKararSonucu[] = [];
  for (let page = 1; page <= 300; page++) {
    const res = await fetchWithBackoff(`${ANKARA_KARARLAR_URL}?page=${page}`, { headers: HEADERS, timeoutMs: 30000 }, 3);
    if (!res.ok) throw new Error(`[yerel-ankara] sayfa ${page}: HTTP ${res.status}`);
    const $ = cheerio.load(await res.text());
    const rows = $('table tbody tr');
    if (!rows.length) break;
    let sayfadaEski = false;
    for (const el of rows.toArray()) {
      const $row = $(el);
      const cells = $row.find('td');
      const tarihHam = $(cells[0]).text().trim();
      const [gg, aa, yyyy] = tarihHam.split('.');
      const tarih = gg && aa && yyyy ? `${yyyy}-${aa}-${gg}` : null;
      if (!tarih) continue;
      if (tarih < BASLANGIC_TARIHI) { sayfadaEski = true; continue; }
      const kararNo = $(cells[1]).text().trim() || null;
      const ozet = $row.find('td').eq(2).text().trim();
      const href = $row.find('a[href]').attr('href');
      if (!href) continue;
      try {
        const dres = await fetchWithBackoff(href, { headers: HEADERS, timeoutMs: 30000 }, 3);
        if (!dres.ok) { logger.error(`[yerel-ankara] belge indirilemedi (${kararNo}): HTTP ${dres.status}`); continue; }
        const buf = Buffer.from(await dres.arrayBuffer());
        const metin = href.endsWith('.docx') ? docxMetinCikar(buf) : null;
        if (!metin || metin.length < ASGARI_KARAR_UZUNLUK) continue;
        sonuc.push({
          belediye: 'Ankara', karar_no: kararNo, tarih, konu: ozet.replace(/İndir$/, '').trim() || null,
          metin, oylama_sonucu: oylamaSonucuCikar(metin), kaynak_url: href,
        });
      } catch (e) {
        logger.error(`[yerel-ankara] karar ${kararNo}: ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    if (sayfadaEski) break;
  }
  return sonuc;
}

export async function fetchAnkaraUyeler(): Promise<YerelUyeSonucu[]> {
  const sonuc: YerelUyeSonucu[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetchWithBackoff(`${ANKARA_UYELER_URL}?page=${page}`, { headers: HEADERS, timeoutMs: 30000 }, 3);
    if (!res.ok) throw new Error(`[yerel-ankara-uye] sayfa ${page}: HTTP ${res.status}`);
    const $ = cheerio.load(await res.text());
    const kartlar = $('.party').toArray();
    if (!kartlar.length) break;
    for (const el of kartlar) {
      const info = $(el).closest('.info');
      const ad = info.find('strong').first().text().trim();
      const hamParti = $(el).text().trim();
      if (!ad || !hamParti) continue;
      const spans = info.find('span');
      const ilce = spans.length ? spans.last().text().trim() || null : null;
      const kanonik = normParti(hamParti);
      sonuc.push({ belediye: 'Ankara', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce });
    }
  }
  return sonuc;
}

const IZMIR_KARAR_SAYFA = 'https://www.izmir.bel.tr/tr/MeclisKararOzetleri/57';
const IZMIR_OZET_AJAX = 'https://www.izmir.bel.tr/tr/IbbMeclisi/TariheGoreKararOzetiGetir';

export async function fetchIzmirKararlar(): Promise<YerelKararSonucu[]> {
  const res = await fetchWithBackoff(IZMIR_KARAR_SAYFA, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-izmir] liste sayfası: HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const secenekler = $('#kararOzetiDrp option').toArray()
    .map((el) => ({ id: $(el).attr('value'), etiket: $(el).text().trim() }))
    .filter((o): o is { id: string; etiket: string } => !!o.id && /^\d+$/.test(o.id));

  const sonuc: YerelKararSonucu[] = [];
  for (const { id, etiket } of secenekler) {
    const m = etiket.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    if (!m) continue;
    const tarih = `${m[3]}-${m[2]}-${m[1]}`;
    if (tarih < BASLANGIC_TARIHI) continue;
    try {
      interface OzetYanit { sonucKodu: number; sonuc?: { OzetDetay?: string } }
      const j = await getJson<OzetYanit>(`${IZMIR_OZET_AJAX}?kararOzetId=${id}`, { headers: HEADERS, timeoutMs: 20000 });
      const detayHtml = j.sonuc?.OzetDetay ?? '';
      const $$ = cheerio.load(detayHtml);
      const pdfHref = $$('a[href$=".pdf"]').first().attr('href');
      let metinTemiz: string, kaynakUrl: string;
      if (pdfHref) {
        const pdfUrl = pdfHref.startsWith('http') ? pdfHref : `https://www.izmir.bel.tr${pdfHref}`;
        const pres = await fetchWithBackoff(pdfUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
        if (!pres.ok) { logger.error(`[yerel-izmir] PDF indirilemedi (${tarih}): HTTP ${pres.status}`); continue; }
        const metin = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
        metinTemiz = metin.replace(/\s+/g, ' ').trim();
        kaynakUrl = pdfUrl;
      } else {
        $$('script,style').remove();
        metinTemiz = $$.root().text().replace(/\s+/g, ' ').trim();
        kaynakUrl = `${IZMIR_OZET_AJAX}?kararOzetId=${id}`;
      }
      if (metinTemiz.length < ASGARI_KARAR_UZUNLUK) continue;
      sonuc.push({
        belediye: 'İzmir', karar_no: null, tarih, konu: `${etiket}`, metin: metinTemiz,
        oylama_sonucu: oylamaSonucuCikar(metinTemiz), kaynak_url: kaynakUrl,
      });
    } catch (e) {
      logger.error(`[yerel-izmir] ${tarih}: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return sonuc;
}

export async function fetchIzmirUyeler(): Promise<YerelUyeSonucu[]> {
  const sonuc: YerelUyeSonucu[] = [];
  for (let page = 1; page <= 25; page++) {
    const url = page === 1 ? 'https://www.izmir.bel.tr/tr/MeclisUyeleri/52' : `https://www.izmir.bel.tr/tr/MeclisUyeleri/52?page=${page}`;
    const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 30000 }, 3);
    if (!res.ok) throw new Error(`[yerel-izmir-uye] sayfa ${page}: HTTP ${res.status}`);
    const $ = cheerio.load(await res.text());
    const rows = $('table tbody tr, table tr').toArray().filter((el) => $(el).find('td').length >= 4);
    if (!rows.length) break;
    for (const el of rows) {
      const cells = $(el).find('td');
      const ad = `${$(cells[0]).text().trim()} ${$(cells[1]).text().trim()}`.trim();
      const hamParti = $(cells[3]).text().trim();
      if (!ad.trim() || !hamParti || ad === 'Adı Soyadı') continue;
      const kanonik = normParti(hamParti);
      sonuc.push({ belediye: 'İzmir', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
    }
  }
  return sonuc;
}

const BURSA_KARARLAR_URL = 'https://www.bursa.bel.tr/meclis-kararlari';
const BURSA_UYELER_URL = 'https://www.bursa.bel.tr/meclis-uyeleri';

export async function fetchBursaKararlar(): Promise<YerelKararSonucu[]> {
  const sonuc: YerelKararSonucu[] = [];
  const baslangicYil = Number(BASLANGIC_TARIHI.slice(0, 4));
  const suankiYil = new Date().getUTCFullYear();
  for (let yil = baslangicYil; yil <= suankiYil; yil++) {
    const res = await fetchWithBackoff(`${BURSA_KARARLAR_URL}?yil=${yil}`, { headers: HEADERS, timeoutMs: 30000 }, 3);
    if (!res.ok) { logger.error(`[yerel-bursa] yıl ${yil}: HTTP ${res.status}`); continue; }
    const $ = cheerio.load(await res.text());
    const rows = $('table tr').toArray().filter((el) => $(el).find('td').length >= 3);
    for (const el of rows) {
      const cells = $(el).find('td');
      const kararNo = $(cells[0]).text().trim() || null;
      const tarihHam = $(cells[1]).text().trim();
      const [gg, aa, yyyy] = tarihHam.split('.');
      const tarih = gg && aa && yyyy ? `${yyyy}-${aa}-${gg}` : null;
      if (!tarih || tarih < BASLANGIC_TARIHI) continue;
      const konu = $(cells[2]).text().trim() || null;
      const href = $(el).find('a[href$=".pdf"]').attr('href');
      if (!href) continue;
      const pdfUrl = href.startsWith('http') ? href : `https://www.bursa.bel.tr${href}`;
      try {
        const pres = await fetchWithBackoff(pdfUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
        if (!pres.ok) { logger.error(`[yerel-bursa] PDF indirilemedi (${kararNo}): HTTP ${pres.status}`); continue; }
        const metin = (await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()))).replace(/\s+/g, ' ').trim();
        if (metin.length < ASGARI_KARAR_UZUNLUK) continue;
        sonuc.push({ belediye: 'Bursa', karar_no: kararNo, tarih, konu, metin, oylama_sonucu: oylamaSonucuCikar(metin), kaynak_url: pdfUrl });
      } catch (e) {
        logger.error(`[yerel-bursa] karar ${kararNo}: ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return sonuc;
}

export async function fetchBursaUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(BURSA_UYELER_URL, { headers: HEADERS, timeoutMs: 30000, followRedirects: true }, 3);
  if (!res.ok) throw new Error(`[yerel-bursa-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  const rows = $('table tr').toArray().filter((el) => $(el).find('td').length >= 3);
  for (const el of rows) {
    const cells = $(el).find('td');
    const ad = $(cells[1]).text().trim();
    const hamParti = $(cells[2]).text().trim();
    if (!ad || !hamParti || ad === 'Adı Soyadı') continue;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Bursa', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  }
  return sonuc;
}

const KONYA_ICERIK_GETIR = 'https://www.konya.bel.tr/meclis/icerik-getir';
const KONYA_UYELER_URL = 'https://www.konya.bel.tr/meclis-encumen/meclis-uyeleri';
const KONYA_PARTI_LOGO: Record<string, string> = {
  ak_parti: 'AK PARTİ', chp: 'CHP', mhp: 'MHP', bagimsiz: 'BAĞIMSIZ', a_parti: 'A PARTİ',
  bbp: 'BBP', yeniden_refah: 'YENİDEN REFAH', dem_parti: 'DEM PARTİ', iyi_parti: 'İYİ PARTİ',
};

export async function fetchKonyaKararlar(): Promise<YerelKararSonucu[]> {
  const sonuc: YerelKararSonucu[] = [];
  const gorulenId = new Set<number>();
  const bas = new Date(BASLANGIC_TARIHI + 'T00:00:00Z');
  const simdi = new Date();
  for (let d = new Date(Date.UTC(bas.getUTCFullYear(), bas.getUTCMonth(), 1)); d <= simdi; d.setUTCMonth(d.getUTCMonth() + 1)) {
    const sorguTarihi = gunAy(d);
    try {
      interface KonyaIcerik { id: number; baslik: string; aciklama: string; toplanti_tarihi?: string }
      const j = await getJson<KonyaIcerik | ''>(`${KONYA_ICERIK_GETIR}?tarih=${sorguTarihi}&tur=2`, { headers: HEADERS, timeoutMs: 20000 });
      if (!j || typeof j !== 'object' || !j.aciklama || gorulenId.has(j.id)) continue;
      gorulenId.add(j.id);
      const gercekTarih = j.toplanti_tarihi ? j.toplanti_tarihi.slice(0, 10) : sorguTarihi;
      if (gercekTarih < BASLANGIC_TARIHI) continue;
      const metin = j.aciklama.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      if (metin.length < ASGARI_KARAR_UZUNLUK) continue;
      sonuc.push({
        belediye: 'Konya', karar_no: null, tarih: gercekTarih, konu: j.baslik || null, metin,
        oylama_sonucu: null,
        kaynak_url: 'https://www.konya.bel.tr/meclis-encumen/meclis-gundemi-ve-kararlari',
      });
    } catch {  }
  }
  return sonuc;
}

export async function fetchKonyaUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(KONYA_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-konya-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('img.parti-logo, img[src*="/meclis/partiler/"]').each((_, el) => {
    const src = $(el).attr('src') ?? '';
    const slug = src.match(/partiler\/([a-z_0-9]+)\.svg/)?.[1];
    const hamParti = slug ? KONYA_PARTI_LOGO[slug] : undefined;
    if (!hamParti) return;
    const kart = $(el).closest('.d-flex.flex-wrap');
    const ad = kart.find('.h4').first().text().replace(/\s+/g, ' ').trim();
    if (!ad) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Konya', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}

const DBB_LIST_URL = 'https://mecliskararlari.diyarbakir.bel.tr/Default/MeclisKararlariList';
const DBB_KAYNAK_SAYFA = 'https://mecliskararlari.diyarbakir.bel.tr/';

function dbbDataTablesGovde(yil: number, start: number, length: number): string {
  const p = new URLSearchParams();
  p.set('draw', '1'); p.set('start', String(start)); p.set('length', String(length)); p.set('Yil', String(yil));
  p.set('columns[0][data]', 'KararNo'); p.set('columns[0][name]', ''); p.set('columns[0][searchable]', 'true');
  p.set('columns[0][orderable]', 'true'); p.set('columns[0][search][value]', ''); p.set('columns[0][search][regex]', 'false');
  p.set('order[0][column]', '0'); p.set('order[0][dir]', 'desc');
  p.set('search[value]', ''); p.set('search[regex]', 'false');
  return p.toString();
}

interface DbbKarar { Yil: number; KararNo: number; KararTarihi: string; KararinOzu: string; KararMetni: string }
export async function fetchDiyarbakirKararlar(): Promise<YerelKararSonucu[]> {
  const sonuc: YerelKararSonucu[] = [];
  const baslangicYil = Number(BASLANGIC_TARIHI.slice(0, 4));
  const suankiYil = new Date().getUTCFullYear();
  for (let yil = baslangicYil; yil <= suankiYil; yil++) {
    let start = 0;
    const length = 50;
    for (;;) {
      const res = await fetchWithBackoff(DBB_LIST_URL, {
        method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: dbbDataTablesGovde(yil, start, length), timeoutMs: 30000,
      }, 3);
      if (!res.ok) { logger.error(`[yerel-diyarbakir] yıl ${yil} start ${start}: HTTP ${res.status}`); break; }
      const j = await res.json() as { data: { Items: DbbKarar[] } };
      const items = j.data?.Items ?? [];
      if (!items.length) break;
      for (const it of items) {
        const ms = Number(it.KararTarihi.match(/\/Date\((\d+)\)\//)?.[1]);
        if (!Number.isFinite(ms)) continue;
        const tarih = new Date(ms).toISOString().slice(0, 10);
        if (tarih < BASLANGIC_TARIHI) continue;
        const metin = it.KararMetni.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
        if (metin.length < ASGARI_KARAR_UZUNLUK) continue;
        sonuc.push({
          belediye: 'Diyarbakır', karar_no: String(it.KararNo), tarih, konu: it.KararinOzu?.trim() || null,
          metin, oylama_sonucu: oylamaSonucuCikar(metin), kaynak_url: DBB_KAYNAK_SAYFA,
        });
      }
      if (items.length < length) break;
      start += length;
    }
  }
  return sonuc;
}

import { fetchMuglaKararlar, fetchMuglaUyeler } from './yerelYonetimEk/mugla.js';
import { fetchSanliurfaKararlar, fetchSanliurfaUyeler } from './yerelYonetimEk/sanliurfa.js';
import { fetchKayseriKararlar, fetchKayseriUyeler } from './yerelYonetimEk/kayseri.js';
import { fetchKocaeliKararlar, fetchKocaeliUyeler } from './yerelYonetimEk/kocaeli.js';
import { fetchErzurumKararlar, fetchErzurumUyeler } from './yerelYonetimEk/erzurum.js';
import { fetchOrduKararlar, fetchOrduUyeler } from './yerelYonetimEk/ordu.js';
import { fetchEskisehirKararlar, fetchEskisehirUyeler } from './yerelYonetimEk/eskisehir.js';
import { fetchMardinKararlar } from './yerelYonetimEk/mardin.js';
import { fetchAydinKararlar, fetchAydinUyeler } from './yerelYonetimEk/aydin.js';
import { fetchMersinKararlar, fetchMersinUyeler } from './yerelYonetimEk/mersin.js';
import { fetchTekirdagKararlar, fetchTekirdagUyeler } from './yerelYonetimEk/tekirdag.js';
import { fetchAdanaKararlar } from './yerelYonetimEk/adana.js';
import { fetchDenizliKararlar } from './yerelYonetimEk/denizli.js';
import { fetchZonguldakKararlar, fetchZonguldakUyeler } from './yerelYonetimEk/zonguldak.js';
import { fetchElazigKararlar, fetchElazigUyeler } from './yerelYonetimEk/elazig.js';
import { fetchMalatyaKararlar, fetchMalatyaUyeler } from './yerelYonetimEk/malatya.js';
import { fetchSamsunKararlar, fetchSamsunUyeler } from './yerelYonetimEk/samsun.js';
import { fetchManisaKararlar, fetchManisaUyeler } from './yerelYonetimEk/manisa.js';
import { fetchSakaryaKararlar } from './yerelYonetimEk/sakarya.js';
import { fetchAntalyaKararlar, fetchAntalyaUyeler } from './yerelYonetimEk/antalya.js';
import { fetchGaziantepKararlar } from './yerelYonetimEk/gaziantep.js';
import { fetchHatayKararlar, fetchHatayUyeler } from './yerelYonetimEk/hatay.js';
import { fetchTrabzonKararlar, fetchTrabzonUyeler } from './yerelYonetimEk/trabzon.js';
import { fetchKahramanmarasKararlar } from './yerelYonetimEk/kahramanmaras.js';
import { fetchSinopKararlar, fetchSinopUyeler } from './yerelYonetimEk/sinop.js';
import { fetchTokatKararlar, fetchTokatUyeler } from './yerelYonetimEk/tokat.js';
import { fetchUsakKararlar, fetchUsakUyeler } from './yerelYonetimEk/usak.js';
import { fetchSirnakKararlar, fetchSirnakUyeler } from './yerelYonetimEk/sirnak.js';
import { fetchBartinKararlar, fetchBartinUyeler } from './yerelYonetimEk/bartin.js';
import { fetchArdahanKararlar, fetchArdahanUyeler } from './yerelYonetimEk/ardahan.js';
import { fetchIgdirKararlar, fetchIgdirUyeler } from './yerelYonetimEk/igdir.js';
import { fetchKarabukKararlar, fetchKarabukUyeler } from './yerelYonetimEk/karabuk.js';
import { fetchOsmaniyeKararlar } from './yerelYonetimEk/osmaniye.js';
import { fetchDuzceKararlar, fetchDuzceUyeler } from './yerelYonetimEk/duzce.js';
import { fetchAksarayKararlar, fetchAksarayUyeler } from './yerelYonetimEk/aksaray.js';
import { fetchKaramanKararlar, fetchKaramanUyeler } from './yerelYonetimEk/karaman.js';
import { fetchYozgatKararlar, fetchYozgatUyeler } from './yerelYonetimEk/yozgat.js';
import { fetchBayburtKararlar, fetchBayburtUyeler } from './yerelYonetimEk/bayburt.js';
import { fetchKirikkaleKararlar, fetchKirikkaleUyeler } from './yerelYonetimEk/kirikkale.js';
import { fetchNigdeKararlar, fetchNigdeUyeler } from './yerelYonetimEk/nigde.js';
import { fetchBatmanKararlar } from './yerelYonetimEk/batman.js';
import { fetchAfyonkarahisarKararlar, fetchAfyonkarahisarUyeler } from './yerelYonetimEk/afyonkarahisar.js';
import { fetchAgriKararlar, fetchAgriUyeler } from './yerelYonetimEk/agri.js';
import { fetchAmasyaKararlar } from './yerelYonetimEk/amasya.js';
import { fetchArtvinKararlar, fetchArtvinUyeler } from './yerelYonetimEk/artvin.js';
import { fetchBilecikKararlar, fetchBilecikUyeler } from './yerelYonetimEk/bilecik.js';
import { fetchBoluKararlar, fetchBoluUyeler } from './yerelYonetimEk/bolu.js';
import { fetchBurdurKararlar, fetchBurdurUyeler } from './yerelYonetimEk/burdur.js';
import { fetchCanakkaleKararlar, fetchCanakkaleUyeler } from './yerelYonetimEk/canakkale.js';
import { fetchCorumKararlar, fetchCorumUyeler } from './yerelYonetimEk/corum.js';
import { fetchEdirneKararlar, fetchEdirneUyeler } from './yerelYonetimEk/edirne.js';
import { fetchErzincanKararlar, fetchErzincanUyeler } from './yerelYonetimEk/erzincan.js';
import { fetchGiresunKararlar } from './yerelYonetimEk/giresun.js';
import { fetchIspartaKararlar, fetchIspartaUyeler } from './yerelYonetimEk/isparta.js';
import { fetchKarsKararlar } from './yerelYonetimEk/kars.js';
import { fetchKastamonuKararlar } from './yerelYonetimEk/kastamonu.js';
import { fetchKirklareliKararlar, fetchKirklareliUyeler } from './yerelYonetimEk/kirklareli.js';
import { fetchKirsehirKararlar } from './yerelYonetimEk/kirsehir.js';
import { fetchKutahyaKararlar, fetchKutahyaUyeler } from './yerelYonetimEk/kutahya.js';
import { fetchRizeKararlar } from './yerelYonetimEk/rize.js';
import { fetchSivasKararlar, fetchSivasUyeler } from './yerelYonetimEk/sivas.js';
import { fetchBitlisKararlar, fetchBitlisUyeler } from './yerelYonetimEk/bitlis.js';
import { fetchAdiyamanKararlar } from './yerelYonetimEk/adiyaman.js';
import { fetchBalikesirKararlar, fetchBalikesirUyeler } from './yerelYonetimEk/balikesir.js';
import { fetchCankiriKararlar, fetchCankiriUyeler } from './yerelYonetimEk/cankiri.js';
import { fetchMusKararlar, fetchMusUyeler } from './yerelYonetimEk/mus.js';
import { fetchTunceliKararlar } from './yerelYonetimEk/tunceli.js';
import { fetchSiirtKararlar, fetchSiirtUyeler } from './yerelYonetimEk/siirt.js';
import { fetchBingolKararlar, fetchBingolUyeler } from './yerelYonetimEk/bingol.js';
import { fetchNevsehirKararlar, fetchNevsehirUyeler } from './yerelYonetimEk/nevsehir.js';
import { fetchGumushaneKararlar } from './yerelYonetimEk/gumushane.js';
import { fetchYalovaKararlar, fetchYalovaUyeler } from './yerelYonetimEk/yalova.js';
import { fetchVanKararlar } from './yerelYonetimEk/van.js';

const KARAR_CEKICI: Record<Belediye, () => Promise<YerelKararSonucu[]>> = {
  'İstanbul': fetchIstanbulKararlar, 'Ankara': fetchAnkaraKararlar, 'İzmir': fetchIzmirKararlar,
  'Bursa': fetchBursaKararlar, 'Konya': fetchKonyaKararlar, 'Diyarbakır': fetchDiyarbakirKararlar,
  'Muğla': fetchMuglaKararlar, 'Şanlıurfa': fetchSanliurfaKararlar,
  'Kayseri': fetchKayseriKararlar, 'Kocaeli': fetchKocaeliKararlar,
  'Erzurum': fetchErzurumKararlar, 'Ordu': fetchOrduKararlar,
  'Eskişehir': fetchEskisehirKararlar, 'Mardin': fetchMardinKararlar,
  'Aydın': fetchAydinKararlar,
  'Mersin': fetchMersinKararlar, 'Tekirdağ': fetchTekirdagKararlar,
  'Adana': fetchAdanaKararlar, 'Denizli': fetchDenizliKararlar,
  'Zonguldak': fetchZonguldakKararlar, 'Elazığ': fetchElazigKararlar,
  'Malatya': fetchMalatyaKararlar, 'Samsun': fetchSamsunKararlar,
  'Manisa': fetchManisaKararlar, 'Sakarya': fetchSakaryaKararlar,
  'Antalya': fetchAntalyaKararlar, 'Gaziantep': fetchGaziantepKararlar,
  'Hatay': fetchHatayKararlar, 'Trabzon': fetchTrabzonKararlar,
  'Kahramanmaraş': fetchKahramanmarasKararlar,
  'Sinop': fetchSinopKararlar, 'Tokat': fetchTokatKararlar, 'Uşak': fetchUsakKararlar,
  'Şırnak': fetchSirnakKararlar, 'Bartın': fetchBartinKararlar, 'Ardahan': fetchArdahanKararlar,
  'Iğdır': fetchIgdirKararlar, 'Karabük': fetchKarabukKararlar, 'Osmaniye': fetchOsmaniyeKararlar,
  'Düzce': fetchDuzceKararlar, 'Aksaray': fetchAksarayKararlar, 'Karaman': fetchKaramanKararlar,
  'Yozgat': fetchYozgatKararlar, 'Bayburt': fetchBayburtKararlar,
  'Kırıkkale': fetchKirikkaleKararlar, 'Niğde': fetchNigdeKararlar, 'Batman': fetchBatmanKararlar,
  'Afyonkarahisar': fetchAfyonkarahisarKararlar, 'Ağrı': fetchAgriKararlar,
  'Amasya': fetchAmasyaKararlar, 'Artvin': fetchArtvinKararlar, 'Bilecik': fetchBilecikKararlar,
  'Bolu': fetchBoluKararlar, 'Burdur': fetchBurdurKararlar, 'Çanakkale': fetchCanakkaleKararlar,
  'Çorum': fetchCorumKararlar, 'Edirne': fetchEdirneKararlar, 'Erzincan': fetchErzincanKararlar,
  'Giresun': fetchGiresunKararlar, 'Isparta': fetchIspartaKararlar, 'Kars': fetchKarsKararlar,
  'Kastamonu': fetchKastamonuKararlar, 'Kırklareli': fetchKirklareliKararlar,
  'Kırşehir': fetchKirsehirKararlar, 'Kütahya': fetchKutahyaKararlar, 'Rize': fetchRizeKararlar,
  'Sivas': fetchSivasKararlar, 'Bitlis': fetchBitlisKararlar, 'Adıyaman': fetchAdiyamanKararlar,
  'Balıkesir': fetchBalikesirKararlar, 'Çankırı': fetchCankiriKararlar, 'Muş': fetchMusKararlar,
  'Tunceli': fetchTunceliKararlar, 'Siirt': fetchSiirtKararlar, 'Bingöl': fetchBingolKararlar,
  'Nevşehir': fetchNevsehirKararlar, 'Gümüşhane': fetchGumushaneKararlar,
  'Yalova': fetchYalovaKararlar,
  'Van (Tuşba)': fetchVanKararlar,
};
const UYE_CEKICI: Partial<Record<Belediye, () => Promise<YerelUyeSonucu[]>>> = {
  'İstanbul': fetchIstanbulUyeler, 'Ankara': fetchAnkaraUyeler, 'İzmir': fetchIzmirUyeler,
  'Bursa': fetchBursaUyeler, 'Konya': fetchKonyaUyeler,
  'Muğla': fetchMuglaUyeler, 'Şanlıurfa': fetchSanliurfaUyeler,
  'Kayseri': fetchKayseriUyeler, 'Kocaeli': fetchKocaeliUyeler,
  'Erzurum': fetchErzurumUyeler, 'Ordu': fetchOrduUyeler, 'Eskişehir': fetchEskisehirUyeler,
  'Aydın': fetchAydinUyeler, 'Mersin': fetchMersinUyeler, 'Tekirdağ': fetchTekirdagUyeler,
  'Zonguldak': fetchZonguldakUyeler, 'Elazığ': fetchElazigUyeler,
  'Malatya': fetchMalatyaUyeler, 'Samsun': fetchSamsunUyeler, 'Manisa': fetchManisaUyeler,
  'Antalya': fetchAntalyaUyeler, 'Hatay': fetchHatayUyeler, 'Trabzon': fetchTrabzonUyeler,
  'Sinop': fetchSinopUyeler, 'Tokat': fetchTokatUyeler, 'Uşak': fetchUsakUyeler,
  'Şırnak': fetchSirnakUyeler, 'Bartın': fetchBartinUyeler, 'Ardahan': fetchArdahanUyeler,
  'Iğdır': fetchIgdirUyeler, 'Karabük': fetchKarabukUyeler,
  'Düzce': fetchDuzceUyeler, 'Aksaray': fetchAksarayUyeler, 'Karaman': fetchKaramanUyeler,
  'Yozgat': fetchYozgatUyeler, 'Bayburt': fetchBayburtUyeler,
  'Kırıkkale': fetchKirikkaleUyeler, 'Niğde': fetchNigdeUyeler,
  'Afyonkarahisar': fetchAfyonkarahisarUyeler, 'Ağrı': fetchAgriUyeler,
  'Artvin': fetchArtvinUyeler, 'Bilecik': fetchBilecikUyeler, 'Bolu': fetchBoluUyeler,
  'Burdur': fetchBurdurUyeler, 'Çanakkale': fetchCanakkaleUyeler, 'Çorum': fetchCorumUyeler,
  'Edirne': fetchEdirneUyeler, 'Erzincan': fetchErzincanUyeler, 'Isparta': fetchIspartaUyeler,
  'Kırklareli': fetchKirklareliUyeler,
  'Kütahya': fetchKutahyaUyeler,
  'Sivas': fetchSivasUyeler, 'Bitlis': fetchBitlisUyeler, 'Balıkesir': fetchBalikesirUyeler,
  'Çankırı': fetchCankiriUyeler, 'Muş': fetchMusUyeler, 'Siirt': fetchSiirtUyeler,
  'Bingöl': fetchBingolUyeler, 'Nevşehir': fetchNevsehirUyeler, 'Yalova': fetchYalovaUyeler,
};

export async function fetchYerelKararlar(belediye: Belediye): Promise<YerelKararSonucu[]> {
  return KARAR_CEKICI[belediye]();
}
export async function fetchYerelUyeler(belediye: Belediye): Promise<YerelUyeSonucu[] | null> {
  const fn = UYE_CEKICI[belediye];
  return fn ? fn() : null;
}
