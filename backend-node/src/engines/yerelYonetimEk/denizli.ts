import * as cheerio from 'cheerio';
import {
  type YerelKararSonucu, type Belediye,
  BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar, HEADERS, fetchWithBackoff,
} from '../yerelYonetimOrtak.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Denizli');

const DENIZLI_KARARLAR_URL = 'https://www.denizli.bel.tr/Default.aspx?k=meclis-kararlari';

function tekAydanKararlar(html: string, yil: number, ay: number): Omit<YerelKararSonucu, 'belediye'>[] {
  const $ = cheerio.load(html);
  const sonuc: Omit<YerelKararSonucu, 'belediye'>[] = [];
  const rows = $('#ctl14_wscontentarea table tr').toArray().filter((el) => $(el).find('td').length >= 4);
  for (const el of rows) {
    const cells = $(el).find('td');
    const tarihHam = $(cells[0]).text().trim();
    const [gg, aa, yyyy] = tarihHam.split('-');
    const tarih = gg && aa && yyyy ? `${yyyy}-${aa}-${gg}` : null;
    if (!tarih || tarih < BASLANGIC_TARIHI) continue;
    const kararNo = $(cells[1]).text().trim() || null;
    const konu = $(cells[2]).text().trim() || null;
    const metin = $(cells[3]).text().replace(/\s+/g, ' ').trim();
    if (metin.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({
      karar_no: kararNo, tarih, konu, metin,
      oylama_sonucu: oylamaSonucuCikar(metin), kaynak_url: DENIZLI_KARARLAR_URL,
    });
  }
  return sonuc;
}

export async function fetchDenizliKararlar(): Promise<YerelKararSonucu[]> {
  const sonuc: YerelKararSonucu[] = [];
  const baslangicYil = Number(BASLANGIC_TARIHI.slice(0, 4));
  const baslangicAy = Number(BASLANGIC_TARIHI.slice(5, 7));
  const simdi = new Date();
  const suankiYil = simdi.getUTCFullYear();
  const suankiAy = simdi.getUTCMonth() + 1;

  for (let yil = baslangicYil; yil <= suankiYil; yil++) {
    const ayBas = yil === baslangicYil ? baslangicAy : 1;
    const ayBit = yil === suankiYil ? suankiAy : 12;
    for (let ay = ayBas; ay <= ayBit; ay++) {
      const ayStr = String(ay).padStart(2, '0');
      try {
        const res = await fetchWithBackoff(DENIZLI_KARARLAR_URL, {
          method: 'POST',
          headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body: new URLSearchParams({ yil: String(yil), ay: ayStr }).toString(),
          timeoutMs: 30000,
        }, 3);
        if (!res.ok) { logger.error(`[yerel-denizli] ${yil}-${ayStr}: HTTP ${res.status}`); continue; }
        const kararlar = tekAydanKararlar(await res.text(), yil, ay);
        for (const k of kararlar) sonuc.push({ belediye: 'Denizli', ...k });
      } catch (e) {
        logger.error(`[yerel-denizli] ${yil}-${ayStr}: ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 180));
    }
  }
  return sonuc;
}
