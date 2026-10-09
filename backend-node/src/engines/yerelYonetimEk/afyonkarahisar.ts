import * as cheerio from 'cheerio';
import {
  fetchWithBackoff, HEADERS, BASLANGIC_TARIHI, ASGARI_KARAR_UZUNLUK, oylamaSonucuCikar,
  type YerelKararSonucu, type YerelUyeSonucu, type Belediye,
} from '../yerelYonetimOrtak.js';
import { normParti } from '../../lib/partyResolve.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Afyonkarahisar');

const BASE = 'https://afyon.bel.tr';
const LISTE_URL = `${BASE}/meclis-kararlari`;
const UYE_URL = `${BASE}/kurumsal-yapi/1/5/belediye-meclisi`;

async function decodedText(res: Response): Promise<string> {
  return new TextDecoder('iso-8859-9').decode(await res.arrayBuffer());
}

function formAlanlariCikar($: cheerio.CheerioAPI): URLSearchParams {
  const body = new URLSearchParams();
  $('#aspnetForm input').each((_, el) => {
    const name = $(el).attr('name');
    const type = ($(el).attr('type') || 'text').toLowerCase();
    if (!name || type === 'submit' || type === 'button' || type === 'image') return;
    body.set(name, $(el).attr('value') ?? '');
  });
  $('#aspnetForm select').each((_, el) => {
    const name = $(el).attr('name');
    if (!name) return;
    body.set(name, $(el).find('option[selected]').attr('value') ?? $(el).find('option').first().attr('value') ?? '');
  });
  return body;
}

interface AyPenceresi { bas: string; bit: string }

function ayPencereleriUret(): AyPenceresi[] {
  const [baslangicYil, baslangicAy] = BASLANGIC_TARIHI.split('-').slice(0, 2).map(Number);
  const simdi = new Date();
  const sonuc: AyPenceresi[] = [];
  let yil = baslangicYil;
  let ay = baslangicAy;
  while (yil < simdi.getFullYear() || (yil === simdi.getFullYear() && ay <= simdi.getMonth() + 1)) {
    const ayStr = String(ay).padStart(2, '0');
    const sonGun = new Date(yil, ay, 0).getDate();
    sonuc.push({ bas: `01.${ayStr}.${yil}`, bit: `${String(sonGun).padStart(2, '0')}.${ayStr}.${yil}` });
    ay += 1;
    if (ay > 12) { ay = 1; yil += 1; }
  }
  return sonuc;
}

function detayiAyristir(html: string, kaynakUrl: string): YerelKararSonucu[] {
  const $ = cheerio.load(html);
  const ham = $('#ctl00_ContentPlaceHolder1_lbaciklama').html();
  if (!ham) return [];
  const satirBazliHtml = ham.replace(/<br\s*\/?>/gi, '\n');
  const metinTumu = cheerio.load(satirBazliHtml).text();
  const satirlar = metinTumu.split('\n').map((s) => s.trim()).filter(Boolean);

  const satirDeseni = /^\d{1,3}\s+(\d{2})\.(\d{2})\.(\d{4})-(\d+)\s+(.+)$/;
  const sonuc: YerelKararSonucu[] = [];
  for (const satir of satirlar) {
    const m = satir.match(satirDeseni);
    if (!m) continue;
    const [, gg, aa, yyyy, kararNo, metinHam] = m;
    const tarih = `${yyyy}-${aa}-${gg}`;
    if (tarih < BASLANGIC_TARIHI) continue;
    const govde = metinHam.trim();
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    sonuc.push({
      belediye: 'Afyonkarahisar', karar_no: kararNo, tarih, konu: null, metin: govde,
      oylama_sonucu: oylamaSonucuCikar(govde), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

async function ayIcinKararlariGetir(pencere: AyPenceresi): Promise<YerelKararSonucu[]> {
  const res1 = await fetchWithBackoff(LISTE_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res1.ok) { logger.error(`[yerel-afyonkarahisar] liste sayfası (${pencere.bas}): HTTP ${res1.status}`); return []; }
  const $1 = cheerio.load(await decodedText(res1));

  const aramaBody = formAlanlariCikar($1);
  aramaBody.set('ctl00$ContentPlaceHolder1$tbbastarih', pencere.bas);
  aramaBody.set('ctl00$ContentPlaceHolder1$tbbittarih', pencere.bit);
  aramaBody.set('ctl00$ContentPlaceHolder1$drtur', '0');
  aramaBody.set('ctl00$ContentPlaceHolder1$btlistele', 'Ara');
  await new Promise((r) => setTimeout(r, 180));
  const res2 = await fetchWithBackoff(LISTE_URL, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: aramaBody.toString(),
    timeoutMs: 30000,
  }, 3);
  if (!res2.ok) { logger.error(`[yerel-afyonkarahisar] arama (${pencere.bas}): HTTP ${res2.status}`); return []; }
  const $2 = cheerio.load(await decodedText(res2));
  const satirlar = $2('#ctl00_ContentPlaceHolder1_gv tr.gridsatir').toArray();

  const sonuc: YerelKararSonucu[] = [];
  for (const satir of satirlar) {
    const $satir = $2(satir);
    const konu = $satir.find('a').last().text().replace(/\s+/g, ' ').trim();
    const konuKucuk = konu.toLocaleLowerCase('tr');
    if (konuKucuk.includes('gündem') || konuKucuk.includes('komisyon')) continue;
    const href = $satir.find('a').first().attr('href') || '';
    const hedefMatch = href.match(/__doPostBack\('([^']+)'/);
    if (!hedefMatch) continue;

    const tiklamaBody = formAlanlariCikar($2);
    tiklamaBody.set('__EVENTTARGET', hedefMatch[1]);
    tiklamaBody.set('__EVENTARGUMENT', '');
    tiklamaBody.delete('ctl00$ContentPlaceHolder1$btlistele');

    await new Promise((r) => setTimeout(r, 180));
    let tiklamaRes: Response;
    try {
      tiklamaRes = await fetchWithBackoff(LISTE_URL, {
        method: 'POST',
        headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tiklamaBody.toString(),
        timeoutMs: 30000,
        followRedirects: false,
      }, 3);
    } catch (e) {
      logger.error(`[yerel-afyonkarahisar] tıklama (${konu}): ${(e as Error).message}`);
      continue;
    }
    const konum = tiklamaRes.headers.get('location');
    if (tiklamaRes.status !== 302 || !konum) {
      logger.error(`[yerel-afyonkarahisar] tıklama (${konu}): yönlendirme yok (HTTP ${tiklamaRes.status})`);
      continue;
    }
    const detayUrl = new URL(konum, BASE).toString();

    await new Promise((r) => setTimeout(r, 180));
    const detayRes = await fetchWithBackoff(detayUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
    if (!detayRes.ok) { logger.error(`[yerel-afyonkarahisar] detay (${konu}): HTTP ${detayRes.status}`); continue; }
    const detayHtml = await decodedText(detayRes);
    sonuc.push(...detayiAyristir(detayHtml, detayRes.url || detayUrl));
  }
  return sonuc;
}

export async function fetchAfyonkarahisarKararlar(): Promise<YerelKararSonucu[]> {
  const sonuc: YerelKararSonucu[] = [];
  for (const pencere of ayPencereleriUret()) {
    try {
      sonuc.push(...(await ayIcinKararlariGetir(pencere)));
    } catch (e) {
      logger.error(`[yerel-afyonkarahisar] ay penceresi (${pencere.bas}..${pencere.bit}): ${(e as Error).message}`);
    }
  }
  return sonuc;
}

export async function fetchAfyonkarahisarUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(UYE_URL, { headers: HEADERS, timeoutMs: 30000 }, 3);
  if (!res.ok) throw new Error(`[yerel-afyonkarahisar-uye] HTTP ${res.status}`);
  const $ = cheerio.load(await decodedText(res));
  const sonuc: YerelUyeSonucu[] = [];
  $('a[id*="DataList1"][id*="lnkadi"]').each((_, el) => {
    const ad = $(el).find('h4').text().replace(/\s+/g, ' ').trim();
    const hamParti = $(el).find('p.text-muted').text().replace(/\s+/g, ' ').trim();
    if (!ad || !hamParti) return;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Afyonkarahisar', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  });
  return sonuc;
}
