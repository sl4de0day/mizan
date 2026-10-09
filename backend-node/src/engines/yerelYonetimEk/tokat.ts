import { getLogger } from '../../lib/logger.js';
import { normParti } from '../../lib/partyResolve.js';
import {
  ASGARI_KARAR_UZUNLUK, BASLANGIC_TARIHI, fetchWithBackoff, HEADERS, pdfMetinCikar,
  type Belediye, type YerelKararSonucu, type YerelUyeSonucu,
} from '../yerelYonetimOrtak.js';

const logger = getLogger('PoliticalInsight.YerelYonetim.Tokat');

const TOKAT_API_BASE = 'https://client-api.tokat.bel.tr';
const TOKAT_KARARLAR_API = `${TOKAT_API_BASE}/api/public/council-resolutions`;
const TOKAT_UYELER_API = `${TOKAT_API_BASE}/api/public/council-members`;

interface TokatKararKaydi {
  id: string;
  title: string;
  slug: string;
  kararNo: string;
  pdfUrl: string;
  resolutionDate: string;
  status: string;
}
interface TokatKararlarYaniti { success: boolean; data: TokatKararKaydi[]; pagination: { total: number } }

interface TokatUyeKaydi { id: string; fullName: string; party: string | null; position: string; status: string }
interface TokatUyelerYaniti { success: boolean; data: TokatUyeKaydi[]; pagination: { total: number } }

function fuzzyDesen(kok: string): RegExp {
  const harfler = [...kok];
  return new RegExp(harfler.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'g');
}
const GUNDEMIN_DESENI = fuzzyDesen('gündemin');
const OYLANDI_DESENI = fuzzyDesen('oylandı');
const OYBIRLIGI_DESENI = fuzzyDesen('oybirliği');
const OYCOKLUGU_DESENI = fuzzyDesen('oyçokluğu');

function fuzzyIcerir(duzKucukMetin: string, desen: RegExp): boolean {
  desen.lastIndex = 0;
  return desen.test(duzKucukMetin);
}

function bolumBasilangiclariniBul(duzKucukMetin: string): number[] {
  GUNDEMIN_DESENI.lastIndex = 0;
  const sonuc: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = GUNDEMIN_DESENI.exec(duzKucukMetin))) {
    sonuc.push(m.index);
    if (m[0].length === 0) GUNDEMIN_DESENI.lastIndex++;
  }
  return sonuc;
}

function tokatOylamaSonucu(duzKucukMetin: string): 'oybirlik' | 'oycoklugu' | null {
  const birlikVar = fuzzyIcerir(duzKucukMetin, OYBIRLIGI_DESENI);
  const cokVar = fuzzyIcerir(duzKucukMetin, OYCOKLUGU_DESENI);
  if (birlikVar && cokVar) return null;
  if (birlikVar) return 'oybirlik';
  if (cokVar) return 'oycoklugu';
  return null;
}

function kararlariAyristir(ham: string, tarih: string, belgeKararNo: string, kaynakUrl: string): YerelKararSonucu[] {
  const duz = ham.toLocaleLowerCase('tr');
  const basliklar = bolumBasilangiclariniBul(duz);
  const noktalar = Array.from(new Set([0, ...basliklar])).sort((a, b) => a - b);
  const sonuc: YerelKararSonucu[] = [];
  let sira = 0;
  for (let i = 0; i < noktalar.length; i++) {
    const baslangic = noktalar[i];
    const bitis = i + 1 < noktalar.length ? noktalar[i + 1] : ham.length;
    const govde = ham.slice(baslangic, bitis).replace(/\s+/g, ' ').trim();
    if (govde.length < ASGARI_KARAR_UZUNLUK) continue;
    if (i === 0 && basliklar.length > 0 && !fuzzyIcerir(govde.toLocaleLowerCase('tr'), OYLANDI_DESENI)) continue;
    sira++;
    sonuc.push({
      belediye: 'Tokat', karar_no: `${belgeKararNo}-${sira}`, tarih, konu: null, metin: govde,
      oylama_sonucu: tokatOylamaSonucu(govde.toLocaleLowerCase('tr')), kaynak_url: kaynakUrl,
    });
  }
  return sonuc;
}

export async function fetchTokatKararlar(): Promise<YerelKararSonucu[]> {
  const listRes = await fetchWithBackoff(TOKAT_KARARLAR_API, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ limit: 100 }),
    timeoutMs: 30000,
  }, 3);
  if (!listRes.ok) throw new Error(`[yerel-tokat] liste API: HTTP ${listRes.status}`);
  const liste = (await listRes.json()) as TokatKararlarYaniti;
  if (!liste.success) throw new Error('[yerel-tokat] liste API success:false döndü');

  const sonuc: YerelKararSonucu[] = [];
  for (const kayit of liste.data) {
    const tarih = kayit.resolutionDate.slice(0, 10);
    if (tarih < BASLANGIC_TARIHI) continue;
    if (!kayit.pdfUrl) { logger.error(`[yerel-tokat] pdfUrl yok (${kayit.title})`); continue; }
    try {
      const pdfRes = await fetchWithBackoff(kayit.pdfUrl, { headers: HEADERS, timeoutMs: 30000 }, 3);
      if (!pdfRes.ok) { logger.error(`[yerel-tokat] PDF indirilemedi (${kayit.title}): HTTP ${pdfRes.status}`); continue; }
      const metin = await pdfMetinCikar(new Uint8Array(await pdfRes.arrayBuffer()));
      if (metin.trim().length < ASGARI_KARAR_UZUNLUK) {
        logger.error(`[yerel-tokat] PDF neredeyse boş metin döndürdü, taranmış görüntü olabilir (${kayit.title}): ${metin.length} karakter`);
        continue;
      }
      sonuc.push(...kararlariAyristir(metin, tarih, kayit.kararNo, kayit.pdfUrl));
    } catch (e) {
      logger.error(`[yerel-tokat] (${kayit.title}): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 180));
  }
  return sonuc;
}

export async function fetchTokatUyeler(): Promise<YerelUyeSonucu[]> {
  const res = await fetchWithBackoff(TOKAT_UYELER_API, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ limit: 100 }),
    timeoutMs: 30000,
  }, 3);
  if (!res.ok) throw new Error(`[yerel-tokat-uye] HTTP ${res.status}`);
  const yanit = (await res.json()) as TokatUyelerYaniti;
  if (!yanit.success) throw new Error('[yerel-tokat-uye] success:false döndü');

  const sonuc: YerelUyeSonucu[] = [];
  for (const uye of yanit.data) {
    if (uye.status !== 'yayinda') continue;
    const ad = uye.fullName?.trim();
    const hamParti = uye.party?.trim();
    if (!ad || !hamParti) continue;
    const kanonik = normParti(hamParti);
    sonuc.push({ belediye: 'Tokat', ad_soyad: ad, parti: kanonik === 'Bilinmiyor' ? hamParti : kanonik, ilce: null });
  }
  return sonuc;
}
