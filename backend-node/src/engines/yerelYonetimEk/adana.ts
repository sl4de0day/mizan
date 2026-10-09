import * as cheerio from 'cheerio';
import { Agent, ProxyAgent } from 'undici';
import {
  type YerelKararSonucu, type Belediye,
  BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar, HEADERS, pdfMetinCikar,
} from '../yerelYonetimOrtak.js';
import { proxyUrlForKaynak } from '../../lib/http.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Adana');

const ADANA_BASE = 'https://www.adana.bel.tr';
const ADANA_LISTE_URL = `${ADANA_BASE}/tr/meclis-kararlari`;

const ADANA_TLS_AGENT = new Agent({ connect: { maxVersion: 'TLSv1.2' } });

async function adanaFetch(url: string, timeoutMs = 30000, retries = 3): Promise<Response> {
  const proxyUrl = proxyUrlForKaynak('yerel_yonetim');
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : ADANA_TLS_AGENT;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher,
      } as unknown as RequestInit);
      if ((res.status >= 500 || res.status === 429) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000 + Math.floor(Math.random() * 700)));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000 + Math.floor(Math.random() * 700)));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('[yerel-adana] adanaFetch başarısız');
}

const AY_KISALTMA: Record<string, string> = {
  Oca: '01', Şub: '02', Mar: '03', Nis: '04', May: '05', Haz: '06',
  Tem: '07', Ağu: '08', Eyl: '09', Eki: '10', Kas: '11', Ara: '12',
};
function etiketAyYil(etiket: string): string | null {
  const m = etiket.match(/^([A-ZÇĞİÖŞÜ][a-zçğıöşü]{2})\s+(\d{4})$/);
  if (!m) return null;
  const ay = AY_KISALTMA[m[1]];
  if (!ay) return null;
  return `${m[2]}-${ay}`;
}

interface AdanaSatir { etiket: string; href: string }

function listeSayfasiniAyristir(html: string): AdanaSatir[] {
  const $ = cheerio.load(html);
  const sonuc: AdanaSatir[] = [];
  $('.card.event-list-box').each((_, el) => {
    const etiket = $(el).find('.act-hero-text span').first().text().replace(/\s+/g, ' ').trim();
    const hrefHam = $(el).find('.col-md-10 a[href]').first().attr('href');
    if (!etiket || !hrefHam) return;
    const href = hrefHam.startsWith('http') ? hrefHam : `${ADANA_BASE}${hrefHam}`;
    sonuc.push({ etiket, href });
  });
  return sonuc;
}

const KARAR_HEADER_RE = /T\.C\.\s+ADANA\s+BÜYÜKŞEHİR\s+BELEDİYESİ\s+M\s*E\s*C\s*L\s*İ\s*S\s+Sayı\s*:\s*(\S+)\s+(\d{2})\.(\d{2})\.(\d{4})\s+Özü\s*:\s*(.*?)\s+K\s*A\s*R\s*A\s*R\s/gs;

interface AdanaKararGrubu { sayiHam: string; gg: string; aa: string; yyyy: string; konuHam: string; parcalar: string[] }

function kararlariAyristir(metin: string, pdfUrl: string): YerelKararSonucu[] {
  const matches = [...metin.matchAll(KARAR_HEADER_RE)];
  const gruplar: AdanaKararGrubu[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const [, sayiHam, gg, aa, yyyy, konuHam] = m;
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : metin.length;
    const parca = metin.slice(start, end);
    const sonGrup = gruplar[gruplar.length - 1];
    if (sonGrup && sonGrup.sayiHam === sayiHam) {
      sonGrup.parcalar.push(parca);
    } else {
      gruplar.push({ sayiHam, gg, aa, yyyy, konuHam, parcalar: [parca] });
    }
  }
  const sonuc: YerelKararSonucu[] = [];
  for (const g of gruplar) {
    const tarih = `${g.yyyy}-${g.aa}-${g.gg}`;
    if (tarih < BASLANGIC_TARIHI) continue;
    const govde = g.parcalar.join(' ').replace(/\s+/g, ' ').trim();
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    const sonSegment = g.sayiHam.split('/').pop() ?? g.sayiHam;
    sonuc.push({
      belediye: 'Adana',
      karar_no: `${g.yyyy}/${sonSegment}`,
      tarih,
      konu: g.konuHam.replace(/\s+/g, ' ').trim() || null,
      metin: govde,
      oylama_sonucu: oylamaSonucuCikar(govde),
      kaynak_url: pdfUrl,
    });
  }
  return sonuc;
}

export async function fetchAdanaKararlar(): Promise<YerelKararSonucu[]> {
  const sonuc: YerelKararSonucu[] = [];
  const esikAyYil = BASLANGIC_TARIHI.slice(0, 7);
  for (let offset = 0; offset <= 400; offset += 5) {
    const url = offset === 0 ? ADANA_LISTE_URL : `${ADANA_LISTE_URL}/${offset}`;
    const res = await adanaFetch(url);
    if (!res.ok) throw new Error(`[yerel-adana] liste sayfası (offset ${offset}): HTTP ${res.status}`);
    const satirlar = listeSayfasiniAyristir(await res.text());
    if (!satirlar.length) break;
    let sayfadaEski = false;
    for (const satir of satirlar) {
      const ayYil = etiketAyYil(satir.etiket);
      if (ayYil !== null && ayYil < esikAyYil) { sayfadaEski = true; continue; }
      try {
        const pres = await adanaFetch(satir.href, 60000);
        if (!pres.ok) { logger.error(`[yerel-adana] PDF indirilemedi (${satir.etiket}): HTTP ${pres.status}`); continue; }
        const metin = await pdfMetinCikar(new Uint8Array(await pres.arrayBuffer()));
        if (!metin.trim()) { logger.error(`[yerel-adana] PDF metin katmanı boş (${satir.etiket}, ${satir.href}) — taranmış görüntü olabilir, atlanıyor`); continue; }
        const kararlar = kararlariAyristir(metin, satir.href);
        sonuc.push(...kararlar);
      } catch (e) {
        logger.error(`[yerel-adana] (${satir.etiket}): ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 180));
    }
    if (sayfadaEski) break;
  }
  return sonuc;
}
