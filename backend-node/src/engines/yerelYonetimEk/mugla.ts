import * as cheerio from 'cheerio';
import { fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar, type YerelKararSonucu, type YerelUyeSonucu } from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Mugla');

const MUGLA_HEADERS = { ...HEADERS, Cookie: 'lng=tr' };

const MUGLA_KARARLAR_URL = 'https://www.mugla.bel.tr/mecliskararlari';
const MUGLA_UYELER_URL = 'https://www.mugla.bel.tr/belediye-meclis-uyeleri';
const MUGLA_BASE = 'https://www.mugla.bel.tr/';

interface MuglaSatir { href: string; tarih: string; kararNo: string }

function satirlariCikar(html: string): MuglaSatir[] {
  const $ = cheerio.load(html);
  const sonuc: MuglaSatir[] = [];
  $('#tummecliskararlari tbody tr').each((_, tr) => {
    const $td = $(tr).find('td[onclick]').first();
    const onclick = $td.attr('onclick') ?? '';
    const href = onclick.match(/document\.location\s*=\s*'([^']+)'/)?.[1];
    if (!href) return;
    const metin = $td.text().replace(/\s+/g, ' ').trim();
    const m = metin.match(/(\d{2})\.(\d{2})\.(\d{4})\s+tarih ve\s+(.+?)\s+karar numaralı/);
    if (!m) return;
    const [, gg, aa, yyyy, kararNoHam] = m;
    sonuc.push({ href, tarih: `${yyyy}-${aa}-${gg}`, kararNo: kararNoHam.replace(/\s+/g, ' ').trim() });
  });
  return sonuc;
}

function konuCikar(paragraflar: string[]): string | null {
  const idx = paragraflar.findIndex((p) => /^konusu\s*:?$/i.test(p));
  if (idx === -1) return null;
  for (let i = idx + 1; i < paragraflar.length; i++) {
    if (paragraflar[i]) return paragraflar[i];
  }
  return null;
}

export async function fetchMuglaKararlar(): Promise<YerelKararSonucu[]> {
  const listRes = await fetchWithBackoff(MUGLA_KARARLAR_URL, { headers: MUGLA_HEADERS, timeoutMs: 30000 }, 3);
  if (!listRes.ok) throw new Error(`[yerel-mugla] liste sayfası: HTTP ${listRes.status}`);
  const satirlar = satirlariCikar(await listRes.text())
    .filter((s) => s.tarih >= BASLANGIC_TARIHI);

  const sonuc: YerelKararSonucu[] = [];
  for (const { href, tarih, kararNo } of satirlar) {
    const kaynakUrl = href.startsWith('http') ? href : `${MUGLA_BASE}${href}`;
    try {
      const res = await fetchWithBackoff(kaynakUrl, { headers: MUGLA_HEADERS, timeoutMs: 30000 }, 3);
      if (!res.ok) { logger.error(`[yerel-mugla] karar ${kararNo} (${tarih}): HTTP ${res.status}`); continue; }
      const $ = cheerio.load(await res.text());
      const govde = $('.accordion-body').first();
      if (!govde.length) { logger.error(`[yerel-mugla] karar ${kararNo} (${tarih}): .accordion-body bulunamadı`); continue; }
      const raw = govde.html() ?? '';
      const metin = raw.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      if (metin.length < ASGARI_KARAR_UZUNLUK) continue;
      const paragraflar = govde.find('p').toArray().map((p) => $(p).text().replace(/\s+/g, ' ').trim());
      sonuc.push({
        belediye: 'Muğla', karar_no: kararNo, tarih, konu: konuCikar(paragraflar), metin,
        oylama_sonucu: oylamaSonucuCikar(metin), kaynak_url: kaynakUrl,
      });
    } catch (e) {
      logger.error(`[yerel-mugla] karar ${kararNo} (${tarih}): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

export async function fetchMuglaUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(MUGLA_UYELER_URL, { headers: MUGLA_HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-mugla-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const sonuc: YerelUyeSonucu[] = [];
  $('.ilce-card').each((_, ilceEl) => {
    const ilce = $(ilceEl).find('.ilce-baslik').first().text().replace(/\s+/g, ' ').trim() || null;
    $(ilceEl).find('.uye-card').each((_, kart) => {
      const adNode = $(kart).find('.uye-ad').clone();
      adNode.find('.parti-rozet').remove();
      const ad = adNode.text().replace(/\s+/g, ' ').trim();
      const hamParti = $(kart).find('.parti-rozet').first().text().trim();
      if (!ad || !hamParti) return;
      const kanonik = normParti(hamParti);
      sonuc.push({ belediye: 'Muğla', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce });
    });
  });
  return sonuc;
}
