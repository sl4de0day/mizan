import * as cheerio from 'cheerio';
import { existsSync } from 'node:fs';
import {
  BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar, HEADERS,
  type YerelKararSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Kastamonu');

const KASTAMONU_KARARLAR_URL = 'https://webserver.kastamonu.bel.tr/web/guest/26';

const SISTEM_CHROMIUM_ADAYLARI = ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/snap/bin/chromium'];
function sistemChromiumBul(): string | null {
  return SISTEM_CHROMIUM_ADAYLARI.find((p) => existsSync(p)) ?? null;
}

function ddmmyyyyToIso(s: string): string | null {
  const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

interface KastamonuSatir { tarih: string; kararNo: string; konu: string; ozet: string }

function satirlariAyristir(html: string): KastamonuSatir[] {
  const $ = cheerio.load(html);
  const sonuc: KastamonuSatir[] = [];
  $('table.iceDatTbl tbody > tr[id]').each((_, tr) => {
    const id = $(tr).attr('id') || '';
    if (!/meclisKararSonuc:\d+$/.test(id)) return;
    const tds = $(tr).find('> td');
    if (tds.length < 5) return;
    const tarih = ddmmyyyyToIso($(tds[0]).text());
    const kararNo = $(tds[1]).text().trim();
    const konu = $(tds[2]).text().trim();
    const ozet = $(tds[4]).text().replace(/\s+/g, ' ').trim();
    if (!tarih || !kararNo) return;
    sonuc.push({ tarih, kararNo, konu, ozet });
  });
  return sonuc;
}

export async function fetchKastamonuKararlar(): Promise<YerelKararSonucu[]> {
  const yol = sistemChromiumBul();
  if (!yol) throw new Error(`[yerel-kastamonu] sistem Chromium bulunamadı (aday yollar: ${SISTEM_CHROMIUM_ADAYLARI.join(', ')})`);
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath: yol, headless: true });
  const sonuc: YerelKararSonucu[] = [];
  const gorulen = new Set<string>();
  try {
    const page = await browser.newPage({ userAgent: HEADERS['User-Agent'] });
    await page.goto(KASTAMONU_KARARLAR_URL, { waitUntil: 'networkidle', timeout: 30000 });
    const nextBtn = page.locator('a.iceCmdLnk[id$="scroll_1meclisKararSonucnext"]');

    let sinirAsildi = false;
    const AZAMI_SAYFA = 120;
    for (let i = 0; i < AZAMI_SAYFA; i++) {
      const html = await page.content();
      const satirlar = satirlariAyristir(html);
      if (satirlar.length === 0) { logger.error(`[yerel-kastamonu] sayfa ${i + 1}: 0 satır ayrıştırıldı, duruluyor (format değişmiş olabilir)`); break; }

      for (const s of satirlar) {
        if (s.tarih < BASLANGIC_TARIHI) { sinirAsildi = true; continue; }
        const anahtar = `${s.tarih}|${s.kararNo}`;
        if (gorulen.has(anahtar)) continue;
        gorulen.add(anahtar);
        if (s.ozet.length < ASGARI_KARAR_UZUNLUK) continue;
        sonuc.push({
          belediye: 'Kastamonu', karar_no: s.kararNo, tarih: s.tarih, konu: s.konu || null,
          metin: s.ozet, oylama_sonucu: oylamaSonucuCikar(s.ozet), kaynak_url: KASTAMONU_KARARLAR_URL,
        });
      }
      if (sinirAsildi) break;

      const adet = await nextBtn.count();
      if (adet === 0) break;
      const sinif = await nextBtn.first().getAttribute('class');
      if (sinif?.includes('dis')) break;

      const oncekiIlkTarih = satirlar[0].tarih;
      const oncekiIlkNo = satirlar[0].kararNo;
      await nextBtn.first().click();
      let degisti = false;
      for (let t = 0; t < 20; t++) {
        await page.waitForTimeout(400);
        const yeniSatirlar = satirlariAyristir(await page.content());
        if (yeniSatirlar.length > 0 && (yeniSatirlar[0].tarih !== oncekiIlkTarih || yeniSatirlar[0].kararNo !== oncekiIlkNo)) {
          degisti = true;
          break;
        }
      }
      if (!degisti) { logger.error(`[yerel-kastamonu] sayfa ${i + 1} sonrası "İleri" tıklaması içerik değiştirmedi (8s içinde), duruluyor`); break; }
      await page.waitForTimeout(180);
    }
  } finally {
    await browser.close();
  }
  return sonuc;
}

