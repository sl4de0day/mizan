import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  docxMetinCikar, type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Erzincan');

const KARARLAR_URL = 'https://erzincan.bel.tr/mecliskararlari';
const UYELER_URL = 'https://erzincan.bel.tr/meclisuyeleri';

const AYLAR = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];

interface Oturum { token: string; cookie: string }

async function oturumAl(): Promise<Oturum> {
  const res = await fetchWithBackoff(KARARLAR_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-erzincan] oturum GET: HTTP ${res.status}`);
  const html = await res.text();
  const tokenMatch = html.match(/name="_token" value="([^"]+)"/);
  if (!tokenMatch) throw new Error('[yerel-erzincan] CSRF _token bulunamadı (sayfa yapısı değişmiş olabilir)');
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('[yerel-erzincan] oturum çerezi (Set-Cookie) alınamadı');
  return { token: tokenMatch[1], cookie };
}

async function ayYilGetir(oturum: Oturum, ay: string, yil: number): Promise<string> {
  const body = new URLSearchParams({ _token: oturum.token, ay, yil: String(yil), submit: 'Karar Getir' });
  const res = await fetchWithBackoff(KARARLAR_URL, {
    method: 'POST',
    headers: {
      ...HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: oturum.cookie,
      Referer: KARARLAR_URL,
    },
    body: body.toString(),
    timeoutMs: 30000,
  }, 3);
  if (!res.ok) throw new Error(`[yerel-erzincan] ${yil}-${ay} POST: HTTP ${res.status}`);
  return res.text();
}

interface ErzincanSatir { baslik: string; docxUrl: string }

function kararSatirlariniCikar(html: string): ErzincanSatir[] {
  const $ = cheerio.load(html);
  const sonuc: ErzincanSatir[] = [];
  $('.accordion-item').each((_, el) => {
    const baslik = $(el).find('.accordion-button').first().text().replace(/\s+/g, ' ').trim();
    if (!/TARİH:\d{4}-\d{2}-\d{2}/.test(baslik)) return;
    const href = $(el).find('a[href$=".docx"]').first().attr('href');
    if (!href) return;
    sonuc.push({ baslik, docxUrl: href.startsWith('http') ? href : `https://erzincan.bel.tr${href}` });
  });
  return sonuc;
}

function tekilKararAyristir(metin: string, kaynakUrl: string): YerelKararSonucu | null {
  const tarihM = metin.match(/KARAR TARİHİ\s*(\d{2})\.(\d{2})\.(\d{4})/);
  const noM = metin.match(/KARAR NO[^[]*\[\s*(\d{1,2})\s*\/\s*(\d{1,4})/);
  if (!tarihM) return null;
  const tarih = `${tarihM[3]}-${tarihM[2]}-${tarihM[1]}`;
  const konuM = metin.match(/KONUSU\s+([\s\S]*?)MECLİS BAŞKAN/);
  const konu = konuM ? konuM[1].replace(/\s+/g, ' ').trim() || null : null;
  const govdeBaslangic = metin.indexOf('MECLİS KARARI');
  const imzaBaslangic = metin.indexOf('Meclis Başkan');
  let govde = govdeBaslangic >= 0
    ? metin.slice(govdeBaslangic + 'MECLİS KARARI'.length, imzaBaslangic > govdeBaslangic ? imzaBaslangic : undefined)
    : metin;
  govde = govde.replace(/\s+/g, ' ').trim();
  if (govde.length < ASGARI_KARAR_UZUNLUK) return null;
  if (tarih < BASLANGIC_TARIHI) return null;
  const kararNo = noM ? `${tarihM[3]}/${noM[2]}` : null;
  return {
    belediye: 'Erzincan', karar_no: kararNo, tarih, konu, metin: govde,
    oylama_sonucu: oylamaSonucuCikar(govde), kaynak_url: kaynakUrl,
  };
}

function topluKararlarAyristir(metin: string, kaynakUrl: string): YerelKararSonucu[] {
  const re = /(\d{2})\.(\d{2})\.(\d{4})(\d{4})\/(\d{1,4})/g;
  const damgalar: { index: number; sonIndex: number; tarih: string; kararNo: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(metin))) {
    damgalar.push({ index: m.index, sonIndex: m.index + m[0].length, tarih: `${m[3]}-${m[2]}-${m[1]}`, kararNo: `${m[4]}/${m[5]}` });
  }
  const sonuc: YerelKararSonucu[] = [];
  for (let i = 0; i < damgalar.length; i++) {
    const d = damgalar[i];
    const govdeSonu = i + 1 < damgalar.length ? damgalar[i + 1].index : metin.length;
    const govde = metin.slice(d.sonIndex, govdeSonu).replace(/\s+/g, ' ').trim();
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    if (d.tarih < BASLANGIC_TARIHI) continue;
    sonuc.push({
      belediye: 'Erzincan', karar_no: d.kararNo, tarih: d.tarih, konu: null, metin: govde,
      oylama_sonucu: oylamaSonucuCikar(govde), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

function kararMetniAyristir(metin: string, kaynakUrl: string): YerelKararSonucu[] {
  const bas = metin.slice(0, 20);
  if (bas.includes('KARAR TARİHİ')) {
    const tek = tekilKararAyristir(metin, kaynakUrl);
    return tek ? [tek] : [];
  }
  if (bas.includes('BELEDİYE MECLİSİ')) {
    return topluKararlarAyristir(metin, kaynakUrl);
  }
  logger.warn(`[yerel-erzincan] tanınmayan DOCX biçimi (${kaynakUrl}), atlanıyor`);
  return [];
}

export async function fetchErzincanKararlar(): Promise<YerelKararSonucu[]> {
  const oturum = await oturumAl();
  const bugun = new Date();
  const sonuc: YerelKararSonucu[] = [];
  const gorulenDocx = new Set<string>();

  const kombinasyonlar: { ay: string; yil: number }[] = [];
  for (let yil = 2024; yil <= bugun.getFullYear(); yil++) {
    for (const ay of AYLAR) {
      const tarih = `${yil}-${ay}-01`;
      if (tarih < BASLANGIC_TARIHI.slice(0, 7) + '-01') continue;
      if (yil === bugun.getFullYear() && Number(ay) > bugun.getMonth() + 1) continue;
      kombinasyonlar.push({ ay, yil });
    }
  }

  for (const { ay, yil } of kombinasyonlar) {
    try {
      const html = await ayYilGetir(oturum, ay, yil);
      const satirlar = kararSatirlariniCikar(html);
      for (const { docxUrl } of satirlar) {
        if (gorulenDocx.has(docxUrl)) continue;
        gorulenDocx.add(docxUrl);
        try {
          const dres = await fetchWithBackoff(docxUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
          if (!dres.ok) { logger.error(`[yerel-erzincan] DOCX indirilemedi (${docxUrl}): HTTP ${dres.status}`); continue; }
          const buf = Buffer.from(await dres.arrayBuffer());
          const metin = docxMetinCikar(buf);
          if (!metin) { logger.error(`[yerel-erzincan] DOCX metni çıkarılamadı (${docxUrl})`); continue; }
          sonuc.push(...kararMetniAyristir(metin, docxUrl));
        } catch (e) {
          logger.error(`[yerel-erzincan] DOCX (${docxUrl}): ${(e as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, 180));
      }
    } catch (e) {
      logger.error(`[yerel-erzincan] ${yil}-${ay}: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

export async function fetchErzincanUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-erzincan-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.tab-pane .personnel-list > .row > div').each((_, kart) => {
    const ad = $(kart).find('.mavi').first().text().replace(/\s+/g, ' ').trim();
    const hamParti = $(kart).find('.fs12').first().text().replace(/\s+/g, ' ').trim();
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Erzincan', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
