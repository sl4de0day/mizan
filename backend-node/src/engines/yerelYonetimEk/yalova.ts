import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar, kararNoSiraDoldur,
  type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Yalova');

const EBELEDIYE_BASE = 'https://ebelediye.yalova.bel.tr';
const INDEX_URL = `${EBELEDIYE_BASE}/MeclisEncumenKararlari/Index/`;
const DONEMLER_URL = `${EBELEDIYE_BASE}/MeclisEncumenKararlari/GetirMeclisEncumenKararDonemler/`;
const BIRLESIMLER_URL = `${EBELEDIYE_BASE}/MeclisEncumenKararlari/FindAllIEmBirlesim/`;
const KARARLAR_URL = `${EBELEDIYE_BASE}/MeclisEncumenKararlari/GetirMeclisEncumenKararlari`;
const KARARLAR_SAYFA_URL = INDEX_URL;

const UYELER_URL = 'https://www.yalova.bel.tr/meclisuyeleri';

const NEZAKET_MS = 180;
function bekle(): Promise<void> {
  return new Promise((r) => setTimeout(r, NEZAKET_MS));
}

interface YalovaOturum { token: string; cookie: string }

async function oturumBaslat(): Promise<YalovaOturum> {
  const res = await fetchWithBackoff(INDEX_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-yalova] Index sayfası: HTTP ${res.status}`);
  const html = await res.text();
  const tokenM = html.match(/name="__RequestVerificationToken" type="hidden" value="([^"]+)"/);
  if (!tokenM) throw new Error('[yerel-yalova] antiforgery token bulunamadı — sayfa yapısı değişmiş olabilir');
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (!setCookies.length) throw new Error('[yerel-yalova] oturum çerezi alınamadı — sayfa yapısı değişmiş olabilir');
  const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  return { token: tokenM[1]!, cookie };
}

interface YalovaDonem { Id: number; Value: string }

async function donemleriGetir(oturum: YalovaOturum, yil: number): Promise<YalovaDonem[]> {
  const url = `${DONEMLER_URL}?id=${yil}&donemTuru=MECLIS`;
  const res = await fetchWithBackoff(url, {
    method: 'POST',
    headers: { ...HEADERS, 'X-Requested-With': 'XMLHttpRequest', __RequestVerificationToken: oturum.token, Cookie: oturum.cookie },
    body: '',
    timeoutMs: 20000,
  }, 3);
  if (!res.ok) throw new Error(`[yerel-yalova] Donemler (${yil}): HTTP ${res.status}`);
  return (await res.json()) as YalovaDonem[];
}

interface YalovaBirlesim { id: number; birlesimAdi: string; tarih: string | null }

function birlesimTarihiIso(tarih: string | null): string | null {
  if (!tarih) return null;
  const m = tarih.match(/\/Date\((\d+)\)\//);
  if (!m) return null;
  return new Date(Number(m[1])).toISOString().slice(0, 10);
}

async function birlesimleriGetir(oturum: YalovaOturum, donemId: number): Promise<YalovaBirlesim[]> {
  const url = `${BIRLESIMLER_URL}?iemDonemId=${donemId}&donemTuru=MECLIS`;
  const res = await fetchWithBackoff(url, {
    method: 'POST',
    headers: { ...HEADERS, 'X-Requested-With': 'XMLHttpRequest', __RequestVerificationToken: oturum.token, Cookie: oturum.cookie },
    body: '',
    timeoutMs: 20000,
  }, 3);
  if (!res.ok) throw new Error(`[yerel-yalova] Birlesimler (donem ${donemId}): HTTP ${res.status}`);
  return (await res.json()) as YalovaBirlesim[];
}

function turkTarihiIso(metin: string): string | null {
  const m = metin.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
}

function kararlariAyristir(html: string): YerelKararSonucu[] {
  const $ = cheerio.load(html);
  const sonuc: YerelKararSonucu[] = [];
  $('#detayTablosu tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 4) return;
    const kararNoHam = $(tds[0]).text().replace(/\s+/g, ' ').trim();
    const tarihHam = $(tds[1]).text().replace(/\s+/g, ' ').trim();
    const konuHam = $(tds[2]).text().replace(/\s+/g, ' ').trim();
    const kararHam = $(tds[3]).text().replace(/\s+/g, ' ').trim();
    if (!kararHam) return;
    const tarih = turkTarihiIso(tarihHam);
    if (!tarih || tarih < BASLANGIC_TARIHI) return;
    const metin = konuHam ? `${konuHam}\n\nKARAR: ${kararHam}` : `KARAR: ${kararHam}`;
    if (metin.length < ASGARI_KARAR_UZUNLUK) return;
    sonuc.push({
      belediye: 'Yalova',
      karar_no: kararNoHam || null,
      tarih,
      konu: null,
      metin,
      oylama_sonucu: oylamaSonucuCikar(kararHam),
      kaynak_url: KARARLAR_SAYFA_URL,
    });
  });
  return sonuc;
}

async function birlesimKararlariGetir(
  oturum: YalovaOturum, yil: number, donemId: number, birlesimId: number,
): Promise<YerelKararSonucu[]> {
  const body = new URLSearchParams({
    __RequestVerificationToken: oturum.token,
    KararTuru: 'MECLIS',
    Yil: String(yil),
    Donem: String(donemId),
    idIemBirlesim: String(birlesimId),
    idIemOturum: '',
    Mudurluk: '',
    Konu: '',
  });
  const res = await fetchWithBackoff(KARARLAR_URL, {
    method: 'POST',
    headers: {
      ...HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: INDEX_URL,
      Origin: EBELEDIYE_BASE,
      Cookie: oturum.cookie,
    },
    body: body.toString(),
    timeoutMs: 30000,
  }, 3);
  if (!res.ok) throw new Error(`[yerel-yalova] Kararlar (yil ${yil}, donem ${donemId}, birlesim ${birlesimId}): HTTP ${res.status}`);
  return kararlariAyristir(await res.text());
}

export async function fetchYalovaKararlar(): Promise<YerelKararSonucu[]> {
  const oturum = await oturumBaslat();

  const ilkYil = Number(BASLANGIC_TARIHI.slice(0, 4));
  const sonYil = new Date().getUTCFullYear();

  const donemYil = new Map<number, number>();
  for (let yil = ilkYil; yil <= sonYil; yil++) {
    await bekle();
    try {
      const donemler = await donemleriGetir(oturum, yil);
      for (const d of donemler) if (!donemYil.has(d.Id)) donemYil.set(d.Id, yil);
    } catch (e) {
      logger.error(`[yerel-yalova] Donemler (${yil}): ${(e as Error).message}`);
    }
  }

  const islenenBirlesim = new Set<number>();
  const sonuc: YerelKararSonucu[] = [];

  for (const [donemId, yil] of donemYil) {
    await bekle();
    let birlesimler: YalovaBirlesim[];
    try {
      birlesimler = await birlesimleriGetir(oturum, donemId);
    } catch (e) {
      logger.error(`[yerel-yalova] Birlesimler (donem ${donemId}): ${(e as Error).message}`);
      continue;
    }
    if (!birlesimler.length) continue;

    for (const b of birlesimler) {
      if (islenenBirlesim.has(b.id)) continue;
      islenenBirlesim.add(b.id);
      const birlesimTarih = birlesimTarihiIso(b.tarih);
      if (birlesimTarih && birlesimTarih < BASLANGIC_TARIHI) continue;
      await bekle();
      try {
        const kararlar = await birlesimKararlariGetir(oturum, yil, donemId, b.id);
        sonuc.push(...kararlar);
      } catch (e) {
        logger.error(`[yerel-yalova] Kararlar (yil ${yil}, donem ${donemId}, birleşim ${b.id}/${b.birlesimAdi}): ${(e as Error).message}`);
      }
    }
  }

  logger.info(`[yerel-yalova] ${sonuc.length} karar, ${islenenBirlesim.size} birleşim tarandı`);
  return kararNoSiraDoldur(sonuc);
}

export async function fetchYalovaUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-yalova-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());

  const sonuc: YerelUyeSonucu[] = [];
  $('.party-content').each((_, blok) => {
    $(blok).find('h3').each((__, h3) => {
      const ad = $(h3).text().replace(/\s+/g, ' ').trim();
      const hamParti = $(h3).closest('a').find('span').first().text().replace(/\s+/g, ' ').trim();
      if (!ad || !hamParti) return;
      const kanonik = normParti(hamParti);
      sonuc.push({ belediye: 'Yalova', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
    });
  });
  if (sonuc.length === 0) throw new Error('[yerel-yalova-uye] hiç üye bulunamadı — sayfa yapısı değişmiş olabilir');
  return sonuc;
}
