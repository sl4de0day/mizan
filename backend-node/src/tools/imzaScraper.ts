import { LawEngine } from '../engines/law.js';
import { resolveParty, normParti } from '../lib/partyResolve.js';
import { getDb, imzaKokeniBiliniyorMu, replaceImzalar, replaceTeklifKomisyon, detayCekildiMi, detayCekimIsaretle, type ImzaRow } from '../lib/db.js';
import { getLogger } from '../lib/logger.js';

const logger = getLogger('PoliticalInsight.ImzaScraper');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const stripImzaMark = (name: string): string =>
  name.replace(/İLK\s*İMZA\s*SAHİBİ/g, '').replace(/İLK\s*İMZA/g, '').replace(/\s+/g, ' ').trim();

export function imzaSatiri(
  hamParti: string | undefined | null,
  ad: string,
  donem: number,
): { parti: string; parti_kaynak: string } {
  const ham = (hamParti ?? '').trim();
  if (ham) return { parti: normParti(ham), parti_kaynak: 'tbmm' };
  return { parti: resolveParty(ad, donem), parti_kaynak: 'roster-fallback' };
}

const AKTIF_DONEM = 28;
export async function scrapeImzalar(donem: number = AKTIF_DONEM): Promise<{ yazildi: number; bos: number; atlandi: number }> {
  const db = getDb();
  const engine = new LawEngine();
  const bills = db
    .prepare("SELECT id, kaynak_id FROM faaliyet WHERE kaynak='kanun' AND kaynak_id IS NOT NULL AND kaynak_id != '' AND donem = ? ORDER BY id")
    .all(donem) as { id: number; kaynak_id: string }[];
  logger.info(`Ortak-imza scraper: dönem ${donem} · ${bills.length} kanun teklifi (çekilmiş olan atlanır).`);

  let done = 0, empty = 0, skipped = 0, consec = 0;
  for (let i = 0; i < bills.length; i++) {
    const b = bills[i];
    if (imzaKokeniBiliniyorMu(b.id) && detayCekildiMi(b.id)) { skipped++; continue; }

    const detail = await engine.fetchLawDetail(b.kaynak_id);
    const sahipler = detail?.imza_sahipleri ?? [];
    const ayristirilabildi = Object.keys(detail?.ana_bilgiler ?? {}).length > 0;
    if (ayristirilabildi) {
      const km = detail?.komisyon_bilgileri ?? [];
      if (km.length) replaceTeklifKomisyon(b.id, km);
      detayCekimIsaretle(b.id, km.length, new Date().toISOString().slice(0, 10));
    }
    if (!sahipler.length) {
      empty++;
      if (!ayristirilabildi) {
        consec++;
        if (consec >= 8) {
          logger.warn(`8 ardışık AYRIŞTIRILAMAYAN yanıt — WAF/ağ olabilir, 60sn bekleniyor... (son: ${b.kaynak_id})`);
          await sleep(60000);
          consec = 0;
        } else await sleep(500);
      } else {
        consec = 0;
        await sleep(500);
      }
      continue;
    }
    consec = 0;

    const rows: ImzaRow[] = [];
    const seen = new Set<string>();
    for (const imza of sahipler) {
      const name = stripImzaMark(imza.ad_soyad);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      rows.push({ ...imzaSatiri(imza.parti, name, donem), ad_soyad: name, ilk_imza: imza.ilk_imza ? 1 : 0 });
    }
    if (rows.length && !rows.some((r) => r.ilk_imza)) rows[0].ilk_imza = 1;

    if (rows.length) { replaceImzalar(b.id, rows); done++; } else empty++;
    if ((done + empty) % 25 === 0)
      logger.info(`İlerleme: ${i + 1}/${bills.length} · yazıldı ${done} · boş ${empty} · atlandı ${skipped}`);
    await sleep(300);
  }
  logger.info(`Bitti: yazıldı ${done} · boş/eksik ${empty} · zaten vardı ${skipped}. Boş kalanlar için tekrar çalıştır.`);
  const denenen = done + empty;
  if (denenen >= 20 && empty / denenen > 0.5) {
    throw new Error(
      `İMZA ÇEKİMİ BAŞARISIZ (d${donem}): ${denenen} denemenin ${empty}'i boş (%${Math.round((100 * empty) / denenen)}). ` +
      `Meşru boş oranı ~%0,3 (yalnız yürütme belgeleri) → bu, WAF banı ya da ayrıştırıcı arızası. ` +
      `Veri YAZILMADI; kökeni 'bilinmiyor' kalan satırlar bir sonraki koşuda yeniden denenir.`,
    );
  }
  return { yazildi: done, bos: empty, atlandi: skipped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const di = process.argv.indexOf('--donem');
  const donem = di >= 0 && process.argv[di + 1] ? Number(process.argv[di + 1]) : AKTIF_DONEM;
  if (!Number.isFinite(donem) || donem <= 0) { logger.error(`Geçersiz --donem: ${process.argv[di + 1]}`); process.exit(1); }
  scrapeImzalar(donem).then(() => process.exit(0)).catch((e) => { logger.error((e as Error).message); process.exit(1); });
}
