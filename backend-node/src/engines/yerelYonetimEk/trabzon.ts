import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Trabzon');

const TRABZON_BASE = 'https://www.trabzon.bel.tr';
const TRABZON_TOPLANTI_URL = `${TRABZON_BASE}/Web/MeclisToplanti`;
const TRABZON_UYELER_URL = `${TRABZON_BASE}/Web/MeclisUyeleri`;
const MECLIS_TOPLANTI_TIP_ID = '213';
const NEZAKET_MS = 180;

async function bekle(): Promise<void> {
  await new Promise((r) => setTimeout(r, NEZAKET_MS));
}

async function fragmanGetir(path: string, kontrol: Record<string, string>): Promise<string> {
  const res = await fetchWithBackoff(
    `${TRABZON_BASE}${path}`,
    {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
      body: new URLSearchParams(kontrol),
      timeoutMs: 30000,
    },
    3,
  );
  await bekle();
  if (!res.ok) throw new Error(`HTTP ${res.status} (${path})`);
  return res.text();
}

async function yilListesiGetir(): Promise<number[]> {
  const res = await fetchWithBackoff(TRABZON_TOPLANTI_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-trabzon] ana sayfa: HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const esikYil = Number(BASLANGIC_TARIHI.slice(0, 4));
  const yillar: number[] = [];
  $('#selectYilEski2 option').each((_, el) => {
    const v = Number($(el).attr('value'));
    if (Number.isFinite(v) && v >= esikYil) yillar.push(v);
  });
  return yillar.sort((a, b) => a - b);
}

const AY_MAP: Record<string, string> = {
  OCAK: '01', ŞUBAT: '02', MART: '03', NİSAN: '04', MAYIS: '05', HAZİRAN: '06',
  TEMMUZ: '07', AĞUSTOS: '08', EYLÜL: '09', EKİM: '10', KASIM: '11', ARALIK: '12',
};
function baslikTarihCikar(baslik: string): string | null {
  const m = baslik.toLocaleUpperCase('tr').match(/(\d{1,2})\s+([A-ZÇĞİÖŞÜ]+)\s+(\d{4})/);
  if (!m) return null;
  const ay = AY_MAP[m[2]];
  if (!ay) return null;
  return `${m[3]}-${ay}-${m[1].padStart(2, '0')}`;
}

interface TrabzonBirlesim { id: string; baslik: string }

function birlesimleriAyikla(html: string): TrabzonBirlesim[] {
  const $ = cheerio.load(html);
  const sonuc: TrabzonBirlesim[] = [];
  $('button[onclick^="birlesimFunc("]').each((_, el) => {
    const onclick = $(el).attr('onclick') || '';
    const m = onclick.match(/birlesimFunc\((\d+)\)/);
    if (!m) return;
    const baslik = $(el).find('h5').first().text().replace(/\s+/g, ' ').trim();
    sonuc.push({ id: m[1], baslik });
  });
  return sonuc;
}

function gundemIdleriAyikla(html: string): string[] {
  const $ = cheerio.load(html);
  const sonuc: string[] = [];
  $('.accordion-header[id]').each((_, el) => {
    const id = $(el).attr('id');
    if (id) sonuc.push(id);
  });
  return sonuc;
}

interface TrabzonKararHam { kararNo: string | null; tarih: string; metin: string }

function kararlariAyikla(html: string): TrabzonKararHam[] {
  const $ = cheerio.load(html);
  const sonuc: TrabzonKararHam[] = [];
  $('.card .card-body').each((_, el) => {
    const kararNo = $(el).find('.badge').first().text().trim() || null;
    const hamMetin = $(el).find('p.card-text').first().text().replace(/\s+/g, ' ').trim();
    const m = hamMetin.match(/^(.*?)(\d{2})\.(\d{2})\.(\d{4})\s*$/);
    if (!m) return;
    const [, govdeHam, gg, ay, yil] = m;
    const metin = govdeHam.trim();
    if (metin.length < ASGARI_KARAR_UZUNLUK) return;
    sonuc.push({ kararNo, tarih: `${yil}-${ay}-${gg}`, metin });
  });
  return sonuc;
}

export async function fetchTrabzonKararlar(): Promise<YerelKararSonucu[]> {
  const yillar = await yilListesiGetir();
  const esikYil = Number(BASLANGIC_TARIHI.slice(0, 4));
  const sonuc: YerelKararSonucu[] = [];

  for (const yil of yillar) {
    let birlesimler: TrabzonBirlesim[];
    try {
      const listHtml = await fragmanGetir('/Web/_ToplantiBilgisi', { tarih: String(yil), id: '', toplantiTipId: MECLIS_TOPLANTI_TIP_ID, gundemId: '' });
      birlesimler = birlesimleriAyikla(listHtml);
    } catch (e) {
      logger.error(`[yerel-trabzon] ${yil} yılı birleşim listesi: ${(e as Error).message}`);
      continue;
    }

    for (const b of birlesimler) {
      if (yil === esikYil) {
        const bt = baslikTarihCikar(b.baslik);
        if (bt && bt < BASLANGIC_TARIHI) break;
      }
      try {
        const gundemHtml = await fragmanGetir('/Web/_ToplantiBilgisiGundem', { tarih: String(yil), id: b.id, toplantiTipId: MECLIS_TOPLANTI_TIP_ID, gundemId: '' });
        const gundemIdler = gundemIdleriAyikla(gundemHtml);
        for (const gid of gundemIdler) {
          try {
            const kararHtml = await fragmanGetir('/Web/_ToplantiGundemKararlari', { tarih: String(yil), id: b.id, toplantiTipId: MECLIS_TOPLANTI_TIP_ID, gundemId: gid });
            const kararlar = kararlariAyikla(kararHtml);
            for (const k of kararlar) {
              if (k.tarih < BASLANGIC_TARIHI) continue;
              sonuc.push({
                belediye: 'Trabzon', karar_no: k.kararNo, tarih: k.tarih, konu: null, metin: k.metin,
                oylama_sonucu: oylamaSonucuCikar(k.metin), kaynak_url: TRABZON_TOPLANTI_URL,
              });
            }
          } catch (e) {
            logger.error(`[yerel-trabzon] gündem maddesi (birleşim ${b.id}, gündem ${gid}): ${(e as Error).message}`);
          }
        }
      } catch (e) {
        logger.error(`[yerel-trabzon] birleşim gündemi (${b.baslik}, id ${b.id}): ${(e as Error).message}`);
      }
    }
  }
  return sonuc;
}

function unvandanIlce(unvan: string): string | null {
  const m = unvan.match(/^(.+?)\s+(?:Meclis\s+Üyesi|Belediye\s+Başkanı)$/);
  if (!m) return null;
  if (m[1].includes('Büyükşehir')) return null;
  return m[1];
}

export async function fetchTrabzonUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(TRABZON_UYELER_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-trabzon-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];

  const baskanAd = $('.baskanTitle').first().text().replace(/\s+/g, ' ').trim();
  const baskanTexts = $('.baskanMeclis').parent().find('p.card-text');
  const baskanParti = baskanTexts.length > 1 ? $(baskanTexts[1]).text().replace(/\s+/g, ' ').trim() : '';
  if (baskanAd && baskanParti) {
    const kanonik = normParti(baskanParti);
    sonuc.push({ belediye: 'Trabzon', ad_soyad: baskanAd, parti: kanonik === 'Bilinmiyor' ? baskanParti : kanonik, ilce: null });
  }

  $('div.meclisCard').each((_, kart) => {
    const ad = $(kart).find('.card-title').first().text().replace(/\s+/g, ' ').trim();
    const texts = $(kart).find('p.card-text');
    const unvan = texts.length > 0 ? $(texts[0]).text().replace(/\s+/g, ' ').trim() : '';
    const hamParti = texts.length > 1 ? $(texts[1]).text().replace(/\s+/g, ' ').trim() : '';
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Trabzon', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: unvandanIlce(unvan) });
  });

  return sonuc;
}
