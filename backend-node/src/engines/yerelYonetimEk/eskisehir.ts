import * as cheerio from 'cheerio';
import {
  type YerelKararSonucu, type YerelUyeSonucu,
  BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar, HEADERS, fetchWithBackoff, pdfMetinCikar,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Eskisehir');

const ESKISEHIR_BASE = 'https://www.eskisehir.bel.tr';
const ESKISEHIR_KARARLAR_URL = `${ESKISEHIR_BASE}/belediye-meclis-kararlari`;
const ESKISEHIR_UYELER_URL = `${ESKISEHIR_BASE}/meclis-uyeleri`;

async function fetchDecodedHtml(url: string): Promise<string> {
  const res = await fetchWithBackoff(url, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return new TextDecoder('windows-1254').decode(buf);
}

const KARAR_BASLIK_RE = /(?=T\.C\.\s*ESKİŞEHİR\s*BÜYÜKŞEHİR\s*BELEDİYESİ\s*MECLİS\s*KARARI)/;
const META_RE = /KARAR\s*SAYISI\s*:\s*(\d+(?:-\d+)?)\s*KARAR\s*TARİHİ\s*:\s*(\d{2})\.(\d{2})\.(\d{4})\s*KARARIN\s*ÖZÜ\s*:\s*(.*?)\s*MECLİS\s*BAŞKANI\s*:.*?MEVCUT\s*ÜYE\s*SAYISI\s*:.*?k\s*i\s*ş\s*i\s*\.?\s*(.*)/s;

function bosLinkMi(href: string | undefined): boolean {
  if (!href) return true;
  const h = href.trim().replace(/^http:/, 'https:').replace(/\/$/, '');
  return h === ESKISEHIR_BASE || h === `${ESKISEHIR_BASE}/0`;
}

export async function fetchEskisehirKararlar(): Promise<YerelKararSonucu[]> {
  const sonuc: YerelKararSonucu[] = [];
  const html = await fetchDecodedHtml(ESKISEHIR_KARARLAR_URL);
  const $ = cheerio.load(html);
  const rows = $('tr[align="left"]').toArray();
  for (const el of rows) {
    const tds = $(el).find('td');
    if (tds.length < 4) continue;
    const tarihMetin = $(tds[0]).text().trim();
    const tm = tarihMetin.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!tm) continue;
    const satirTarihi = `${tm[3]}-${tm[2]}-${tm[1]}`;
    if (satirTarihi < BASLANGIC_TARIHI) continue;
    const hamHref = $(tds[2]).find('a').attr('href');
    if (bosLinkMi(hamHref)) continue;
    const kararUrl = hamHref!.trim().replace(/^http:/, 'https:');
    try {
      const pres = await fetchWithBackoff(kararUrl, { headers: HEADERS, timeoutMs: 45000 }, 3);
      if (!pres.ok) { logger.error(`[yerel-eskisehir] PDF indirilemedi (${satirTarihi}): HTTP ${pres.status}`); continue; }
      const metinTam = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
      const metinDuz = metinTam.replace(/\s+/g, ' ').trim();
      const bloklar = metinDuz.split(KARAR_BASLIK_RE).filter((b) => b.trim());
      for (const blok of bloklar) {
        const bm = blok.match(META_RE);
        if (!bm) { logger.error(`[yerel-eskisehir] karar bloğu parse edilemedi (${satirTarihi}): "${blok.slice(0, 100)}"`); continue; }
        const [, no, gg, aa, yyyy, konuHam, govdeHam] = bm;
        const tarih = `${yyyy}-${aa}-${gg}`;
        if (tarih < BASLANGIC_TARIHI) continue;
        const govde = govdeHam.trim();
        if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
        sonuc.push({
          belediye: 'Eskişehir', karar_no: no, tarih, konu: konuHam.trim() || null,
          metin: govde, oylama_sonucu: oylamaSonucuCikar(govde), kaynak_url: kararUrl,
        });
      }
    } catch (e) {
      logger.error(`[yerel-eskisehir] oturum (${satirTarihi}): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

export async function fetchEskisehirUyeler(): Promise<YerelUyeSonucu[]> {
  const html = await fetchDecodedHtml(ESKISEHIR_UYELER_URL);
  const $ = cheerio.load(html);
  const sonuc: YerelUyeSonucu[] = [];
  $('tr[onclick]').each((_, el) => {
    const tds = $(el).find('td');
    if (tds.length < 5) return;
    const ad = $(tds[1]).text().replace(/\s+/g, ' ').trim();
    const unvan = $(tds[2]).text().replace(/\s+/g, ' ').trim();
    const hamParti = $(tds[3]).text().replace(/\s+/g, ' ').trim();
    const ilceHam = $(tds[4]).text().replace(/\s+/g, ' ').trim();
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    const ilce = unvan === 'Büyükşehir Belediye Başkanı' ? null : (ilceHam || null);
    sonuc.push({ belediye: 'Eskişehir', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce });
  });
  return sonuc;
}
