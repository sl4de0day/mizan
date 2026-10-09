import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar, kararNoSiraDoldur,
  pdfMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Antalya');

const ANTALYA_BASE = 'https://www.antalya.bel.tr';
const GUNDEM_SAYFA_URL = `${ANTALYA_BASE}/tr/meclis-gundemi`;
const UYELER_SAYFA_URL = `${ANTALYA_BASE}/tr/meclis-uyeleri`;
const VUE_DATA_URL = `${ANTALYA_BASE}/tr/seolink/VueData/GetVueData`;

const GUNDEM_COLLECTION_ID = 'f7fcc3d4-8479-4f27-b7cd-ee9db292f098';
const GUNDEM_PAGE_ID = '67778e61603726274cb61c4a';
const PARTI_COLLECTION_ID = '7083ca00-2510-4368-b162-83546f6a1c79';
const UYE_COLLECTION_ID = '6788cd7ce209c1a316665192';
const UYELER_PAGE_ID = '67778e2b603726274cb61c44';

const NEZAKET_MS = 180;
function bekle(): Promise<void> {
  return new Promise((r) => setTimeout(r, NEZAKET_MS));
}

interface CerezToken { cookie: string; token: string }

async function cerezVeTokenAl(sayfaUrl: string): Promise<CerezToken> {
  const res = await fetchWithBackoff(sayfaUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-antalya] sayfa (${sayfaUrl}): HTTP ${res.status}`);
  const cerezler = res.headers.getSetCookie?.() ?? [];
  const cookie = cerezler.map((c) => c.split(';')[0]).join('; ');
  const html = await res.text();
  const tokenM = html.match(/__RequestVerificationToken[^>]*value="([^"]+)"/);
  if (!cookie || !tokenM) throw new Error(`[yerel-antalya] sayfa (${sayfaUrl}): antiforgery çerez/token bulunamadı`);
  return { cookie, token: tokenM[1]! };
}

interface VueDataIstek {
  colllection: string;
  pageid: string;
  seolink: string;
  dbfind?: Record<string, unknown>[];
  relationcollection?: Record<string, unknown>[];
  tablerefselectprojectionfield?: string;
}

async function vueDataGetir<T>(referer: string, cz: CerezToken, istek: VueDataIstek): Promise<T[]> {
  const govde = new URLSearchParams({
    __RequestVerificationToken: cz.token,
    colllection: istek.colllection,
    lang: '1',
    dateformat: '',
    dbfind: istek.dbfind ? JSON.stringify(istek.dbfind) : '',
    pageid: istek.pageid,
    requestquery: '{}',
    collectiontype: '0',
    relationcollection: istek.relationcollection ? JSON.stringify(istek.relationcollection) : '',
    collectionfunction: '',
    seolink: istek.seolink,
    sourcetablerefcombobox: '',
    destinationtablerefcombobox: '',
    tablerefselectprojectionfield: istek.tablerefselectprojectionfield ?? '',
    isexitingcontrolrequest: 'false',
  });
  const res = await fetchWithBackoff(VUE_DATA_URL, {
    method: 'POST',
    headers: {
      ...HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: referer,
      Cookie: cz.cookie,
    },
    body: govde.toString(),
    timeoutMs: 30000,
  }, 3);
  if (!res.ok) throw new Error(`[yerel-antalya] GetVueData (${istek.colllection}): HTTP ${res.status}`);
  const json = (await res.json()) as { issuccess: boolean; data: string; message?: string | null };
  if (!json.issuccess) throw new Error(`[yerel-antalya] GetVueData (${istek.colllection}): issuccess=false ${json.message ?? ''}`);
  return JSON.parse(json.data) as T[];
}

interface AntalyaGundemKaydi {
  _id: string;
  council_title: string;
  council_content: string;
}

const AY_ADI_YIL: Record<string, string> = {
  ocak: '01', şubat: '02', mart: '03', nisan: '04', mayıs: '05', haziran: '06',
  temmuz: '07', ağustos: '08', eylül: '09', ekim: '10', kasım: '11', aralık: '12',
};
const AY_ADLARI_DESEN = Object.keys(AY_ADI_YIL).join('|');

function ayYilCikar(baslik: string): string | null {
  const duz = baslik.toLocaleLowerCase('tr');
  const re = new RegExp(`(?:(${AY_ADLARI_DESEN})\\s*(\\d{4})|(\\d{4})\\s*(${AY_ADLARI_DESEN}))`);
  const m = duz.match(re);
  if (!m) return null;
  const ay = m[1] ? AY_ADI_YIL[m[1]] : AY_ADI_YIL[m[4]!];
  const yil = m[2] ?? m[3];
  if (!ay || !yil) return null;
  return `${yil}-${ay}-01`;
}

interface AntalyaKararAday { url: string; tarih: string; konu: string | null }

function pdfAdaylariCikar(content: string, entryTarih: string): AntalyaKararAday[] {
  const $ = cheerio.load(content);
  const sonuc: AntalyaKararAday[] = [];
  const gorulen = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (!/\.pdf(\?|$)/i.test(href) || gorulen.has(href)) return;
    gorulen.add(href);
    const metin = $(el).text().replace(/\s+/g, ' ').trim();
    const tarihM = metin.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    const tarih = tarihM ? `${tarihM[3]}-${tarihM[2]}-${tarihM[1]}` : entryTarih;
    sonuc.push({ url: href, tarih, konu: metin || null });
  });
  return sonuc;
}

export async function fetchAntalyaKararlar(): Promise<YerelKararSonucu[]> {
  const cz = await cerezVeTokenAl(GUNDEM_SAYFA_URL);
  const kayitlar = await vueDataGetir<AntalyaGundemKaydi>(GUNDEM_SAYFA_URL, cz, {
    colllection: GUNDEM_COLLECTION_ID,
    pageid: GUNDEM_PAGE_ID,
    seolink: 'meclis-gundemi',
    dbfind: [
      { field: 'registernumber', wherecluse: 'sorting', fieldValue: 'Desc', pageparamsid: 'Desc', isrequest: 'False', fieldtype: 'string' },
      { field: 'RowCount', wherecluse: '=', fieldValue: '1000', pageparamsid: '1000', isrequest: 'false', fieldtype: 'string' },
    ],
    tablerefselectprojectionfield: 'council_content,council_title,RefLanguageId,_id,registernumber,CreateDate,RefModuleId,SeoLink',
  });

  const adaylar: AntalyaKararAday[] = [];
  for (const kayit of kayitlar) {
    const ayYil = ayYilCikar(kayit.council_title ?? '');
    if (!ayYil || ayYil < BASLANGIC_TARIHI) continue;
    adaylar.push(...pdfAdaylariCikar(kayit.council_content ?? '', ayYil));
  }
  const benzersiz = Array.from(new Map(adaylar.map((a) => [a.url, a] as const)).values());
  if (benzersiz.length === 0) return [];

  let kanaryaGercek = false;
  for (const aday of benzersiz.slice(0, 2)) {
    try {
      const pres = await fetchWithBackoff(aday.url, { headers: HEADERS, timeoutMs: 45000 }, 2);
      if (pres.ok) {
        const metin = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
        if (metin.trim().length >= ASGARI_KARAR_UZUNLUK) { kanaryaGercek = true; break; }
      }
    } catch (e) {
      logger.error(`[yerel-antalya] kanarya PDF (${aday.url}): ${(e as Error).message}`);
    }
    await bekle();
  }

  if (!kanaryaGercek) {
    logger.warn(`[yerel-antalya] kanarya kontrolü GERÇEK DUVAR'ı doğruladı (PDF'ler taranmış görüntü, metin katmanı yok) — ${benzersiz.length} aday PDF indirilmeden atlandı, kararlar boş dönüyor. bkz. dosya başı notu.`);
    return [];
  }

  const sonuc: YerelKararSonucu[] = [];
  for (const aday of benzersiz) {
    await bekle();
    try {
      const pres = await fetchWithBackoff(aday.url, { headers: HEADERS, timeoutMs: 45000 }, 3);
      if (!pres.ok) { logger.error(`[yerel-antalya] karar PDF (${aday.url}): HTTP ${pres.status}`); continue; }
      const metin = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
      if (metin.trim().length < ASGARI_KARAR_UZUNLUK) continue;
      sonuc.push({
        belediye: 'Antalya', karar_no: null, tarih: aday.tarih, konu: aday.konu,
        metin: metin.trim(), oylama_sonucu: oylamaSonucuCikar(metin), kaynak_url: aday.url,
      });
    } catch (e) {
      logger.error(`[yerel-antalya] karar PDF (${aday.url}): ${(e as Error).message}`);
    }
  }
  return kararNoSiraDoldur(sonuc);
}

interface AntalyaUyeKaydi {
  membercouncil_name?: string;
  membercouncil_neighbourhood?: string;
}
interface AntalyaPartiKaydi {
  party_name?: string;
  custominclude?: AntalyaUyeKaydi[];
}

export async function fetchAntalyaUyeler(): Promise<YerelUyeSonucu[]> {
  const cz = await cerezVeTokenAl(UYELER_SAYFA_URL);
  const partiler = await vueDataGetir<AntalyaPartiKaydi>(UYELER_SAYFA_URL, cz, {
    colllection: PARTI_COLLECTION_ID,
    pageid: UYELER_PAGE_ID,
    seolink: 'meclis-uyeleri',
    dbfind: [
      { field: 'custominclude.councilmember_arrangement', wherecluse: 'sorting', fieldValue: 'Asc', pageparamsid: 'Asc', isrequest: 'False', fieldtype: 'string' },
      { field: 'CreateDate', wherecluse: 'sorting', fieldValue: 'Desc', pageparamsid: 'Desc', isrequest: 'false', fieldtype: 'string' },
    ],
    relationcollection: [{
      sourcetable: PARTI_COLLECTION_ID, sourcetableField: '_id',
      destionationtable: UYE_COLLECTION_ID, destionationtableField: 'membercouncil_party',
      destionatiodatalimit: 'listdata', isnulloremptycontrol: false,
    }],
  });

  const sonuc: YerelUyeSonucu[] = [];
  for (const parti of partiler) {
    const hamParti = (parti.party_name ?? '').trim();
    if (!hamParti) continue;
    const kanonik = normParti(hamParti);
    const partiAdi = kanonik === 'Bilinmiyor' ? hamParti : kanonik;
    for (const uye of parti.custominclude ?? []) {
      const ad = (uye.membercouncil_name ?? '').replace(/\s+/g, ' ').trim();
      if (!ad) continue;
      const hamIlce = (uye.membercouncil_neighbourhood ?? '').trim();
      const ilce = hamIlce && !hamIlce.toLocaleLowerCase('tr').includes('başkan') ? hamIlce : null;
      sonuc.push({ belediye: 'Antalya', ad_soyad: ad, parti: partiAdi, ilce });
    }
  }
  return sonuc;
}
