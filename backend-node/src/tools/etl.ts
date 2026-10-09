import { LawEngine, type LawResult } from '../engines/law.js';
import { MotionEngine, type MotionResult } from '../engines/motion.js';
import { MinuteEngine } from '../engines/minute.js';
import { GazetteEngine } from '../engines/gazette.js';
import { ConstitutionalEngine, type AymNormItem } from '../engines/constitutional.js';
import { StatisticsEngine } from '../engines/statistics.js';
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseOylama, parseBaslik } from '../lib/votingParse.js';
import { parseCetvel, kapiGecti } from '../lib/votingPdf.js';
import { STORAGE_DIR } from '../lib/config.js';
import { resolveParty, normParti, CETVEL_KESIK, yurutmeBelgesiMi, PARTI_DISI } from '../lib/partyResolve.js';
import { aykiriAyikla } from '../lib/tarihYardimci.js';
import { rosterSagligi } from '../lib/deputies.js';
import { parseSpeeches } from '../lib/minuteParse.js';
import { classify, classifyDetailed, TAXONOMY_VERSION, MUHATAP_KATEGORI } from '../lib/taxonomy.js';
import { trainNB, saveModel, loadModelFile, normText, type LabeledDoc, type TopicModel, type TrainReport } from '../lib/nb.js';
import { upsertOyToplu, upsertFaaliyet, upsertFaaliyetTracked, replaceFaaliyetParties, replaceOnergeCevap, onergeCevapCekildiMi, onergeCevapIsaretle, replaceVekilKomisyon, vekilProfilCekildiMi, vekilProfilIsaretle, imzaIlkParti, onergeAtfet, anakronizmSuz, rebuildVekilPartiDonem, markEtl, isDonemDone, getDb, loadKnownIds, loadDurumMap, upsertGazete, upsertAym, upsertTuik, upsertOylama, upsertAymParti, upsertSecimSonucu, updateSecimSandalye, upsertPartiProgram, upsertYerelKarar, upsertYerelMeclisUye, type FaaliyetKayit } from '../lib/db.js';
import { tanimlayiciCikar, korpustaMi, type KorpusSorgu } from '../lib/haberOlcut.js';
import { MVEngine } from '../engines/milletvekili.js';
import { YskEngine, YSK_MILLETVEKILI_SECIMLERI, fetchSandalyeSayisi, TARIHSEL_SECIM_PDF, fetchTarihselSecimSonucu } from '../engines/ysk.js';
import { PARTI_PROGRAM_TANIMLARI, fetchPartiProgram } from '../engines/partiProgram.js';
import { YEREL_YONETIM_BELEDIYELERI, fetchYerelKararlar, fetchYerelUyeler } from '../engines/yerelYonetim.js';
import { DEPUTY_IDS_MAPPING } from '../lib/deputies.js';
import { getLogger } from '../lib/logger.js';

const logger = getLogger('PoliticalInsight.ETL');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const LAW_PERIODS: { donem: number; period: string }[] = [
  { donem: 28, period: '' },
  { donem: 27, period: 'f72877c2-f508-037b-e050-007f01005610' },
  { donem: 26, period: 'f72877c2-f51d-037b-e050-007f01005610' },
  { donem: 25, period: 'f72877c2-f509-037b-e050-007f01005610' },
  { donem: 24, period: 'f72877c2-f50a-037b-e050-007f01005610' },
  { donem: 23, period: 'f72877c2-f50b-037b-e050-007f01005610' },
  { donem: 22, period: 'f72877c2-f50c-037b-e050-007f01005610' },
  { donem: 21, period: 'f72877c2-f50d-037b-e050-007f01005610' },
  { donem: 20, period: 'f72877c2-f50e-037b-e050-007f01005610' },
];

const motionCurrent = (donem: number): boolean => donem === 28;

const DONEM_ARASI_BEKLEME = 3000;
const KONUSMA_ARASI_BEKLEME = 2000;

const KONUSMA_DONEMLER = [28, 27, 26, 25, 24, 23, 22, 21, 20];

const DONEM_BASLANGIC: Record<number, string> = { 28: '2023-06' };

function donemDen(donemYil: string | null | undefined): number | null {
  const m = /^\s*(\d{1,2})\s*\//.exec(String(donemYil ?? ''));
  if (!m) return null;
  const d = Number(m[1]);
  return d >= 1 && d <= 40 ? d : null;
}
let donemUyusmazlik = 0;
let tarihiBilinmeyen = 0;

function parseTarih(raw: string | null | undefined): { tarih: string; ay: string; yil: number } | null {
  if (!raw) return null;
  const s = raw.split('/').join('.').trim();
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s);
  if (!m) return null;
  const dd = m[1].padStart(2, '0');
  const mm = m[2].padStart(2, '0');
  const yyyy = m[3];
  if (Number(mm) < 1 || Number(mm) > 12) return null;
  return { tarih: `${yyyy}-${mm}-${dd}`, ay: `${yyyy}-${mm}`, yil: Number(yyyy) };
}

const TR_AYLAR: Record<string, string> = {
  ocak: '01', şubat: '02', mart: '03', nisan: '04', mayıs: '05', haziran: '06',
  temmuz: '07', ağustos: '08', eylül: '09', ekim: '10', kasım: '11', aralık: '12',
};
function parseTurkishDate(raw: string | null | undefined): { tarih: string; ay: string; yil: number } | null {
  if (!raw) return null;
  const m = /(\d{1,2})\s+([A-Za-zÇĞİÖŞÜçğıöşü]+)\s+(\d{4})/.exec(raw.trim());
  if (!m) return null;
  const mm = TR_AYLAR[m[2].toLocaleLowerCase('tr')];
  if (!mm) return null;
  const dd = m[1].padStart(2, '0');
  const yyyy = m[3];
  return { tarih: `${yyyy}-${mm}-${dd}`, ay: `${yyyy}-${mm}`, yil: Number(yyyy) };
}

async function collectLaws(engine: LawEngine, period: string): Promise<LawResult[]> {
  for await (const step of engine.searchLawsStream({ period })) {
    if (step.step === 'finished') return step.data ?? [];
  }
  return [];
}

async function collectMotions(engine: MotionEngine, term: string, current: boolean): Promise<MotionResult[]> {
  const params = current ? { last_term_only: 'true' } : { term, last_term_only: 'false' };
  for await (const step of engine.searchMotionsStream(params)) {
    if (step.step === 'finished') return step.data ?? [];
  }
  return [];
}

function lawToKayit(rec: LawResult, donem: number): FaaliyetKayit | null {
  if (!rec.id) return null;
  const d = parseTarih(rec.tarih);
  const gercekDonem = donemDen(rec.donem_yil);
  if (gercekDonem !== null && gercekDonem !== donem) donemUyusmazlik++;
  const donemFinal = gercekDonem ?? donem;
  const bas = DONEM_BASLANGIC[donemFinal];
  const tarihTutarsiz = !!(bas && d && d.ay < bas);
  if (tarihTutarsiz && gercekDonem === null) return null;
  if (tarihTutarsiz) tarihiBilinmeyen++;
  const baslik = typeof rec.baslik === 'string' ? rec.baslik : '';
  const vekiller = typeof rec.vekiller === 'string' ? rec.vekiller : '';
  const c = classifyDetailed(baslik, { kaynak: 'kanun' });
  return {
    kaynak: 'kanun',
    kaynak_id: rec.id,
    tarih: tarihTutarsiz ? null : (d?.tarih ?? null),
    ay: tarihTutarsiz ? null : (d?.ay ?? null),
    yil: tarihTutarsiz ? null : (d?.yil ?? null),
    donem: donemFinal,
    baslik,
    ozet: vekiller,
    durum: typeof rec.durum === 'string' ? rec.durum : '',
    kategori: c.cat,
    detay_url: typeof rec.detay_url === 'string' ? rec.detay_url : '',
    kategori_versiyon: TAXONOMY_VERSION,
    kategori_kaynagi: c.kaynak,
  };
}

function motionToKayit(rec: MotionResult, donem: number): FaaliyetKayit | null {
  if (!rec.id) return null;
  const d = parseTarih(rec.tarih);
  const ozet = typeof rec.ozet === 'string' ? rec.ozet : '';
  const gercekDonem = donemDen(rec.donem_yil);
  if (gercekDonem !== null && gercekDonem !== donem) donemUyusmazlik++;
  const donemFinal = gercekDonem ?? donem;
  const c = classifyDetailed(ozet, { kaynak: 'onerge', muhatapId: rec.muhatap_id, donem: donemFinal });
  return {
    kaynak: 'onerge',
    kaynak_id: rec.id,
    tarih: d?.tarih ?? null,
    ay: d?.ay ?? null,
    yil: d?.yil ?? null,
    donem: donemFinal,
    baslik: ozet,
    ozet: typeof rec.vekil === 'string' ? rec.vekil : '',
    durum: typeof rec.durum === 'string' ? rec.durum : '',
    kategori: c.cat,
    detay_url: typeof rec.detay_url === 'string' ? rec.detay_url : '',
    muhatap: typeof rec.muhatap_id === 'string' ? rec.muhatap_id : null,
    muhatap_text: typeof rec.muhatap_text === 'string' && rec.muhatap_text ? rec.muhatap_text : null,
    kategori_versiyon: TAXONOMY_VERSION,
    kategori_kaynagi: c.kaynak,
  };
}

async function ingestLawDonem(donem: number, period: string): Promise<number> {
  const engine = new LawEngine();
  const laws = await collectLaws(engine, period);
  let n = 0, yurutmeBelge = 0;
  const partiCozulemedi = (p: string) => p === 'Bilinmiyor' || p === "DİĞER" || !p;
  for (const rec of laws) {
    const kayit = lawToKayit(rec, donem);
    if (!kayit) continue;
    const { id } = upsertFaaliyetTracked(kayit);
    let parti = imzaIlkParti(id)
      ?? anakronizmSuz(resolveParty(rec.vekiller, donem, Array.isArray(rec.parties) ? rec.parties : []), rec.vekiller, kayit.tarih);
    if (partiCozulemedi(parti) && (yurutmeBelgesiMi(kayit.ozet) || yurutmeBelgesiMi(kayit.baslik))) {
      parti = 'YÜRÜTME';
      yurutmeBelge++;
    }
    replaceFaaliyetParties(id, [parti]);
    n++;
  }
  if (tarihiBilinmeyen) logger.info(`[kanun d${donem}] ${tarihiBilinmeyen} kaydın tarihi değiştirilen eski kanuna ait → tarih NULL yazıldı (kayıt korundu).`);
  if (yurutmeBelge) logger.info(`[kanun d${donem}] ${yurutmeBelge} yürütme belgesi (tasarı/KHK/bütçe) YÜRÜTME etiketlendi — parti metriklerine girmez.`);
  return n;
}

async function ingestMotionDonem(donem: number, term: string, current: boolean): Promise<number> {
  const engine = new MotionEngine();
  const motions = await collectMotions(engine, term, current);
  let n = 0;
  const gorulen = new Set<string>();
  let mukerrer = 0;
  const swN = rebuildVekilPartiDonem();
  if (swN) logger.info(`[onerge d${donem}] vekil_parti_donem zaman çizgisi: ${swN} switcher-parti aralığı (imza-türevli)`);
  for (const rec of motions) {
    const kayit = motionToKayit(rec, donem);
    if (!kayit) continue;
    if (gorulen.has(kayit.kaynak_id)) mukerrer++;
    gorulen.add(kayit.kaynak_id);
    const { id } = upsertFaaliyetTracked(kayit);
    const parti = onergeAtfet(rec.vekil, donem, kayit.tarih, Array.isArray(rec.parties) ? rec.parties : []);
    replaceFaaliyetParties(id, [parti]);
    if (Array.isArray(rec.cevaplar) && rec.cevaplar.length) replaceOnergeCevap(id, rec.cevaplar);
    n++;
  }
  if (mukerrer > 0) {
    logger.warn(`⚠️ [onerge d${donem}] sunucu ${mukerrer} kaydı MÜKERRER gönderdi → aynı sayıda kayıt HİÇ gelmemiş demektir `
              + `(sayfalama sıralama anahtarı benzersiz değil). Beklenen benzersiz: ${gorulen.size}, çekilen: ${n}. `
              + `Sıralama EsasNo (kolon 2) olmalı — bkz. motion.ts sıralama notu.`);
  }
  logger.info(`[onerge d${donem}] ${gorulen.size} benzersiz kayıt (${n} upsert)`);
  return gorulen.size;
}

async function ingestKonusmaDonem(donem: number, opts: EtlOpts): Promise<number> {
  const eng = new MinuteEngine();
  const db = getDb();
  const sessions = await eng.discoverSessions(String(donem));
  logger.info(`[konusma d${donem}] ${sessions.length} birleşim keşfedildi.`);

  const doneKeys = new Set<string>();
  if (!opts.force) {
    for (const r of db.prepare("SELECT DISTINCT kaynak_id FROM faaliyet WHERE kaynak='konusma'").all() as { kaynak_id: string }[]) {
      const i = r.kaynak_id.indexOf(':');
      if (i > 0) doneKeys.add(r.kaynak_id.slice(0, i));
    }
  }

  const limit = opts.limit ?? Infinity;
  let n = 0, islenen = 0, atlanan = 0, bos = 0;
  for (const s of sessions) {
    if (islenen >= limit) break;
    const yy = (s.donem_yil ?? '').split('/')[1] ?? '';
    const sessionKey = `${donem}-${yy}-${s.birlesim}`;
    if (doneKeys.has(sessionKey)) { atlanan++; continue; }
    islenen++;
    const text = await eng.fetchSessionText(s.id, s.sayfa ?? '1');
    if (!text) { bos++; logger.error(`[konusma] ${sessionKey}: metin YOK (sonraki koşuda tekrar denenir)`); await sleep(KONUSMA_ARASI_BEKLEME); continue; }
    const dt = parseTurkishDate(s.tarih);
    const { speeches } = parseSpeeches(text, { donem });
    for (const sp of speeches) {
      const c = classifyDetailed(sp.metin, { kaynak: 'konusma', announceLabel: sp.duyuruEtiket });
      const { id } = upsertFaaliyetTracked({
        kaynak: 'konusma',
        kaynak_id: `${sessionKey}:${sp.speakerSlug}`,
        tarih: dt?.tarih ?? null,
        ay: dt?.ay ?? null,
        yil: dt?.yil ?? null,
        donem,
        baslik: sp.metin,
        ozet: `${sp.ad} (${sp.il})`,
        durum: `${s.donem_yil} · ${s.birlesim}. Birleşim`,
        kategori: c.cat,
        detay_url: s.detay_url ?? '',
        muhatap: null,
        kategori_versiyon: TAXONOMY_VERSION,
        kategori_kaynagi: c.kaynak,
      });
      replaceFaaliyetParties(id, [sp.partiKaynak === 'GRUP' ? sp.parti : anakronizmSuz(sp.parti, sp.ad, dt?.tarih ?? null)]);
      n++;
    }
    logger.info(`[konusma] ${sessionKey} (${s.tarih}): ${speeches.length} konuşma`);
    await sleep(KONUSMA_ARASI_BEKLEME);
  }
  logger.info(`[konusma d${donem}] ${n} konuşma yazıldı · ${islenen} birleşim işlendi · ${atlanan} atlandı(resume) · ${bos} boş.`);
  return n;
}

export function reconcileKonusma(): number {
  const db = getDb();

  const upP = db.prepare('UPDATE faaliyet_parti SET parti=? WHERE parti=?');
  for (const { parti } of db.prepare('SELECT DISTINCT parti FROM faaliyet_parti').all() as { parti: string }[]) {
    if (PARTI_DISI.has(parti)) continue;
    const target = normParti(parti);
    if (target && !PARTI_DISI.has(target) && target !== parti) upP.run(target, parti);
  }

  const rows = db
    .prepare(
      `SELECT f.id AS id, f.ozet AS ozet, fp.parti AS parti
       FROM faaliyet f JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
       WHERE f.kaynak='konusma'`,
    )
    .all() as { id: number; ozet: string; parti: string }[];
  const personKey = (ozet: string) => ozet.replace(/\s*\(Devamla\)\s*/i, ' ').replace(/\s+/g, ' ').trim();
  const votes = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (r.parti === 'Bilinmiyor') continue;
    const k = personKey(r.ozet);
    if (!votes.has(k)) votes.set(k, new Map());
    const m = votes.get(k)!;
    m.set(r.parti, (m.get(r.parti) ?? 0) + 1);
  }
  const learned = new Map<string, string>();
  for (const [k, m] of votes) {
    let best: string | null = null, bn = -1;
    for (const [p, n] of m) if (n > bn) { bn = n; best = p; }
    if (best) learned.set(k, best);
  }
  const upd = db.prepare("UPDATE faaliyet_parti SET parti=? WHERE faaliyet_id=? AND parti='Bilinmiyor'");
  let fixed = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      if (r.parti !== 'Bilinmiyor') continue;
      const p = learned.get(personKey(r.ozet));
      if (p) { upd.run(p, r.id); fixed++; }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  logger.info(`[konusma reconcile] ${fixed} Bilinmiyor konuşma, grup-sözcüsü sinyaliyle partiye bağlandı.`);

  const YUR_UNVAN = /\b(BAKANI|CUMHURBAŞKANI)\b/;
  const kisiAdi = (ozet: string): string =>
    (ozet || '')
      .replace(/\s*\(Devamla\)\s*/gi, ' ')
      .replace(/^.*?\b(BAKANI|CUMHURBAŞKANI YARDIMCISI|CUMHURBAŞKANI)\b\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
  const yurKisiler = new Set<string>();
  for (const r of rows) if (YUR_UNVAN.test(r.ozet || '')) yurKisiler.add(kisiAdi(r.ozet));
  const updY = db.prepare("UPDATE faaliyet_parti SET parti='YÜRÜTME' WHERE faaliyet_id=? AND parti='Bilinmiyor'");
  let yurutme = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      if (r.parti !== 'Bilinmiyor') continue;
      const o = r.ozet || '';
      if (YUR_UNVAN.test(o) || (yurKisiler.size > 0 && yurKisiler.has(kisiAdi(o)))) { updY.run(r.id); yurutme++; }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const kalan = (db.prepare("SELECT COUNT(*) c FROM faaliyet f JOIN faaliyet_parti fp ON fp.faaliyet_id=f.id WHERE f.kaynak='konusma' AND fp.parti='Bilinmiyor'").get() as { c: number }).c;
  logger.info(`[konusma reconcile] ${yurutme} bakan/CB konuşması 'YÜRÜTME' etiketlendi (parti UYDURULMADI) · kalan Bilinmiyor: ${kalan}`);
  return fixed + yurutme;
}

async function runKonusma(opts: EtlOpts): Promise<void> {
  for (const donem of KONUSMA_DONEMLER) {
    if (opts.onlyDonem && opts.onlyDonem !== donem) continue;
    if (!opts.force && opts.limit == null && isDonemDone('konusma', donem)) {
      logger.info(`[konusma d${donem}] zaten tamam — atlanıyor (resume).`);
      continue;
    }
    try {
      logger.info(`[konusma d${donem}] çekiliyor...`);
      const n = await ingestKonusmaDonem(donem, opts);
      reconcileKonusma();
      const BILINMIYOR_TAVAN = 0.05;
      const bilinmez = (getDb().prepare(
        "SELECT AVG(CASE WHEN fp.parti='Bilinmiyor' THEN 1.0 ELSE 0 END) r FROM faaliyet f JOIN faaliyet_parti fp ON fp.faaliyet_id=f.id WHERE f.kaynak='konusma' AND f.donem=?",
      ).get(donem) as { r: number | null }).r ?? 0;
      const durum = bilinmez > BILINMIYOR_TAVAN ? 'kismi' : 'ok';
      if (opts.limit == null) markEtl('konusma', donem, n, durum);
      if (durum === 'kismi') {
        logger.warn(`[konusma d${donem}] 🔴 Bilinmiyor oranı %${(100 * bilinmez).toFixed(1)} > %${100 * BILINMIYOR_TAVAN} → 'kismi' işaretlendi, YAYIMLANMAYACAK. `
          + `Muhtemel sebep: arşiv tutanağı satır sarması (soyad-only başlık). Veri yazıldı, düzeltip yeniden koş.`);
      } else {
        logger.info(`[konusma d${donem}] ${n} konuşma yazıldı (Bilinmiyor %${(100 * bilinmez).toFixed(1)}).`);
      }
    } catch (e) {
      const msg = (e as Error).message;
      const durum = /Request Rejected|403|blocked|WAF/i.test(msg) ? 'blocked' : 'error';
      markEtl('konusma', donem, 0, durum);
      logger.error(`[konusma d${donem}] ${durum}: ${msg}`);
    }
    await sleep(DONEM_ARASI_BEKLEME);
  }
}

interface EtlOpts {
  onlyDonem?: number | null;
  onlyKaynak?: 'kanun' | 'onerge' | 'konusma' | null;
  force?: boolean;
  limit?: number | null;
}

async function runKaynak(
  kaynak: 'kanun' | 'onerge',
  rows: { donem: number }[],
  ingest: (row: { donem: number }) => Promise<number>,
  opts: EtlOpts,
): Promise<void> {
  for (const row of rows) {
    if (opts.onlyDonem && row.donem !== opts.onlyDonem) continue;
    if (!opts.force && !opts.onlyDonem && isDonemDone(kaynak, row.donem)) {
      logger.info(`[${kaynak} d${row.donem}] zaten tamam — atlanıyor (resume).`);
      continue;
    }
    const rs = rosterSagligi(row.donem);
    if (!rs.saglikli && !opts.force) {
      markEtl(kaynak, row.donem, 0, 'roster-yetersiz');
      logger.error(
        `[${kaynak} d${row.donem}] 🔴 ROSTER YETERSİZ — çekim REDDEDİLDİ. ` +
        `Roster: ${rs.toplam} vekil` +
        (rs.elliKesik.length ? `, TAM 50'de kesik parti: ${rs.elliKesik.join(', ')} (sayfalama kesiği imzası)` : '') +
        `. Önce: npm run build:deputies --donem ${row.donem} — sonra tekrar dene. ` +
        `(Bilerek devam için --force; ama o dönemin parti istatistiği YANLI olur.)`,
      );
      continue;
    }
    try {
      logger.info(`[${kaynak} d${row.donem}] çekiliyor...`);
      const n = await ingest(row);
      markEtl(kaynak, row.donem, n, 'ok');
      logger.info(`[${kaynak} d${row.donem}] ${n} kayıt yazıldı.`);
    } catch (e) {
      const msg = (e as Error).message;
      const durum = /Request Rejected|403|blocked|WAF/i.test(msg) ? 'blocked' : 'error';
      markEtl(kaynak, row.donem, 0, durum);
      logger.error(`[${kaynak} d${row.donem}] ${durum}: ${msg} — diğer dönemlere devam.`);
    }
    await sleep(DONEM_ARASI_BEKLEME);
  }
}

export async function backfill(opts: EtlOpts = {}): Promise<void> {
  getDb();
  logger.info(`=== BACKFILL başladı (donem=${opts.onlyDonem ?? 'hepsi'}, kaynak=${opts.onlyKaynak ?? 'hepsi'}) ===`);
  if (opts.onlyKaynak == null || opts.onlyKaynak === 'kanun') {
    await runKaynak('kanun', LAW_PERIODS, (r) => ingestLawDonem(r.donem, periodOf(r.donem)), opts);
  }
  if (opts.onlyKaynak == null || opts.onlyKaynak === 'onerge') {
    await runKaynak('onerge', LAW_PERIODS, (r) =>
      ingestMotionDonem(r.donem, periodOf(r.donem), motionCurrent(r.donem)), opts);
  }
  if (opts.onlyKaynak == null || opts.onlyKaynak === 'konusma') {
    await runKonusma(opts);
  }
  await maybeTrainTopic();
  if (donemUyusmazlik > 0) {
    logger.warn(`⚠️ ${donemUyusmazlik} kayıtta istenen dönem ile verinin dönemi UYUŞMADI. `
              + `Kayıtlar veriden okunan döneme yazıldı (doğru), ama sunucu dönem filtresi güvenilmez — `
              + `dönem başına recordsTotal'ı doğrula (iki dönem aynı sayıyı veriyorsa filtre kırık).`);
    donemUyusmazlik = 0;
  }
  logger.info('=== BACKFILL bitti ===');
}

function periodOf(donem: number): string {
  return LAW_PERIODS.find((p) => p.donem === donem)?.period ?? '';
}

export async function incremental(): Promise<void> {
  getDb();
  logger.info('=== INCREMENTAL (güncel dönem 28) başladı ===');
  await backfill({ onlyDonem: 28, force: true });
  logger.info('=== INCREMENTAL bitti ===');
}

export interface PollSummary { yeniKanun: number; yeniOnerge: number; durumKanun: number; durumOnerge: number; }

async function pollLaws(donem: number, knownIds: Set<string>, durumMap: Map<string, string>, s: PollSummary): Promise<void> {
  const engine = new LawEngine();
  for await (const step of engine.searchLawsStream({ period: periodOf(donem), knownIds })) {
    if (step.step !== 'finished') continue;
    for (const rec of step.data ?? []) {
      const kayit = lawToKayit(rec, donem);
      if (!kayit) continue;
      const bilinen = knownIds.has(kayit.kaynak_id);
      if (bilinen && durumMap.get(`kanun:${kayit.kaynak_id}`) === (kayit.durum ?? '')) continue;
      const { id, tip } = upsertFaaliyetTracked(kayit);
      if (tip === 'durum') s.durumKanun++;
      replaceFaaliyetParties(id, [imzaIlkParti(id)
        ?? anakronizmSuz(resolveParty(rec.vekiller, donem, Array.isArray(rec.parties) ? rec.parties : []), rec.vekiller, kayit.tarih)]);
      if (!bilinen) s.yeniKanun++;
    }
  }
}

async function pollMotions(donem: number, knownIds: Set<string>, durumMap: Map<string, string>, s: PollSummary): Promise<void> {
  const engine = new MotionEngine();
  for await (const step of engine.searchMotionsStream({ last_term_only: 'true', knownIds, sort_column: '3', sort_dir: 'desc' })) {
    if (step.step !== 'finished') continue;
    for (const rec of step.data ?? []) {
      const kayit = motionToKayit(rec, donem);
      if (!kayit) continue;
      const bilinen = knownIds.has(kayit.kaynak_id);
      if (bilinen && durumMap.get(`onerge:${kayit.kaynak_id}`) === (kayit.durum ?? '')) continue;
      const { id, tip } = upsertFaaliyetTracked(kayit);
      if (tip === 'durum') s.durumOnerge++;
      replaceFaaliyetParties(id, [onergeAtfet(rec.vekil, donem, kayit.tarih, Array.isArray(rec.parties) ? rec.parties : [])]);
      if (!bilinen) s.yeniOnerge++;
    }
  }
}

export async function poll(): Promise<PollSummary> {
  getDb();
  const donem = 28;
  const s: PollSummary = { yeniKanun: 0, yeniOnerge: 0, durumKanun: 0, durumOnerge: 0 };
  const durumMap = loadDurumMap(donem);
  try {
    await pollLaws(donem, loadKnownIds('kanun', donem), durumMap, s);
  } catch (e) { logger.error(`[poll] kanun: ${(e as Error).message}`); throw e; }
  await sleep(DONEM_ARASI_BEKLEME);
  try {
    await pollMotions(donem, loadKnownIds('onerge', donem), durumMap, s);
  } catch (e) { logger.error(`[poll] önerge: ${(e as Error).message}`); throw e; }
  if (s.yeniKanun + s.yeniOnerge > 0) await maybeTrainTopic();
  logger.info(`[poll] yeni: kanun ${s.yeniKanun} · önerge ${s.yeniOnerge} | durum-değişimi: kanun ${s.durumKanun} · önerge ${s.durumOnerge}`);
  return s;
}

export async function pollKonusma(): Promise<number> {
  getDb();
  const n = await ingestKonusmaDonem(28, {});
  if (n > 0) { reconcileKonusma(); await maybeTrainTopic(); }
  logger.info(`[poll-konusma] ${n} yeni konuşma satırı`);
  return n;
}

const GAZETE_ATLA_KELIME = ['ünivers', 'vekalet etme', 'münhal', 'il idare kurul', 'belediye meclis', 'köy muhtar'];
function gazeteAtla(tur: string, baslik: string): boolean {
  const s = `${tur} ${baslik}`.toLocaleLowerCase('tr');
  return GAZETE_ATLA_KELIME.some((k) => s.includes(k));
}
function gazeteTarih(raw: string): { tarih: string; ay: string } | null {
  const m = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec((raw || '').trim());
  if (!m) return null;
  const dd = m[1].padStart(2, '0'), mm = m[2].padStart(2, '0');
  return { tarih: `${m[3]}-${mm}-${dd}`, ay: `${m[3]}-${mm}` };
}
async function ingestGazetteAralik(after: string, before: string): Promise<{ n: number; atlanan: number }> {
  const eng = new GazetteEngine();
  const PAGE = 100;
  let n = 0, atlanan = 0;
  for (let sayfa = 0; sayfa < 30; sayfa++) {
    let r: { success?: boolean; data?: { title?: string; type?: string; date?: string; issue_no?: string; url?: string; mukerrer?: string }[] };
    try { r = (await eng.searchGazette({ after, before, start: sayfa * PAGE, length: PAGE })) as typeof r; }
    catch (e) { logger.error(`[gazete] ${after}: ${(e as Error).message}`); break; }
    if (!r?.success || !r.data?.length) break;
    for (const it of r.data) {
      const tur = (it.type || '').trim();
      const baslik = (it.title || '').trim();
      if (baslik.length < 8 || gazeteAtla(tur, baslik)) { atlanan++; continue; }
      const dt = gazeteTarih(it.date || '');
      upsertGazete({
        url: it.url || '', tarih: dt?.tarih ?? null, ay: dt?.ay ?? null, tur, baslik,
        kategori: classify(baslik, { kaynak: 'kanun' }),
        sayi: it.issue_no || '', kategori_versiyon: TAXONOMY_VERSION,
        mukerrer: it.mukerrer || undefined,
      });
      n++;
    }
    if (r.data.length < PAGE) break;
    await sleep(500);
  }
  return { n, atlanan };
}
export async function ingestGazette(baslangicAy = '2024-01'): Promise<number> {
  getDb();
  const now = new Date();
  const sonIdx = now.getFullYear() * 12 + now.getMonth();
  const [by, bm] = baslangicAy.split('-').map(Number);
  let toplam = 0, toplamAtla = 0;
  for (let idx = by * 12 + (bm - 1); idx <= sonIdx; idx++) {
    const y = Math.floor(idx / 12), m = (idx % 12) + 1;
    const mm = String(m).padStart(2, '0');
    const sonG = new Date(y, m, 0).getDate();
    const { n, atlanan } = await ingestGazetteAralik(`${y}-${mm}-01`, `${y}-${mm}-${String(sonG).padStart(2, '0')}`);
    toplam += n; toplamAtla += atlanan;
    if (n > 0) logger.info(`[gazete] ${y}-${mm}: ${n} kayıt`);
    await sleep(400);
  }
  logger.info(`[gazete] TOPLAM ${toplam} kayıt · ${toplamAtla} atlandı (${baslangicAy}→bugün).`);
  return toplam;
}
export async function pollGazette(): Promise<number> {
  const now = new Date();
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const bas = new Date(now); bas.setDate(now.getDate() - 7);
  const { n } = await ingestGazetteAralik(fmt(bas), fmt(now));
  logger.info(`[gazete poll] ${n} kayıt (son 7 gün)`);
  return n;
}

export async function reclassify(): Promise<void> {
  const db = getDb();
  await maybeTrainTopic();
  const rows = db.prepare('SELECT id, kaynak, baslik, donem, muhatap, kategori_kaynagi FROM faaliyet').all() as {
    id: number;
    kaynak: string;
    baslik: string | null;
    donem: number | null;
    muhatap: string | null;
    kategori_kaynagi: string | null;
  }[];
  logger.info(`Reclassify: ${rows.length} kayıt (taksonomi v${TAXONOMY_VERSION})...`);
  const upd = db.prepare('UPDATE faaliyet SET kategori=?, kategori_versiyon=?, kategori_kaynagi=? WHERE id=?');
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      if (r.kategori_kaynagi === 'duyuru') continue;
      const c = classifyDetailed(r.baslik ?? '', {
        kaynak: (r.kaynak === 'kanun' || r.kaynak === 'konusma' ? r.kaynak : 'onerge'),
        muhatapId: r.muhatap,
        donem: r.donem,
      });
      upd.run(c.cat, TAXONOMY_VERSION, c.kaynak, r.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const diger = (db.prepare("SELECT COUNT(*) c FROM faaliyet WHERE kategori='Diğer'").get() as { c: number }).c;
  logger.info(`Reclassify bitti: ${rows.length} kayıt | Diğer=${diger} (%${((100 * diger) / (rows.length || 1)).toFixed(1)})`);
}

export function reclassifyGazete(): void {
  const db = getDb();
  const rows = db.prepare('SELECT rowid AS rid, baslik, kategori FROM gazete').all() as {
    rid: number;
    baslik: string | null;
    kategori: string | null;
  }[];
  const upd = db.prepare('UPDATE gazete SET kategori=? WHERE rowid=?');
  let degisen = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const yeni = classify(r.baslik ?? '', { kaynak: 'kanun' });
      if (yeni !== r.kategori) { upd.run(yeni, r.rid); degisen++; }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  logger.info(`Gazete reclassify bitti: ${rows.length} kayıt · ${degisen} değişti (taksonomi v${TAXONOMY_VERSION}).`);
}

const AYM_ITIRAZ = '2ea77d81-53b6-f7bf-ab8c-2cd5f3a30025';
const AYM_IPTAL = '31f02286-c419-f056-94fe-601310a716d7';
function aymBasvuruTuru(uuid: string, konu: string): string {
  if (uuid === AYM_IPTAL) return 'iptal';
  if (uuid === AYM_ITIRAZ) return 'itiraz';
  const k = (konu || '').toLocaleLowerCase('tr');
  if (k.includes('iptal davas')) return 'iptal';
  if (k.includes('itiraz')) return 'itiraz';
  return '';
}
function aymSonucKod(label: string): string {
  const l = (label || '').toLocaleLowerCase('tr');
  if (l.startsWith('ilk')) return 'ilk_ret';
  if (l.includes('iptal') && l.includes('ret')) return 'kismen';
  if (l.includes('iptal')) return 'iptal';
  if (l.includes('ret')) return 'ret';
  return 'diger';
}
function aymKonuKisalt(konu: string): string {
  return (konu || '').replace(/^.*?konusu\s*:?\s*/i, '').trim() || (konu || '').trim();
}
function aymKanunAdlari(konu: string): string {
  const re = /sayılı\s+(.{2,70}?)\s+kanun/gi;
  const adlar: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(konu)) !== null && adlar.length < 4) {
    const ad = m[1].replace(/^[;,.\s]*[A-Za-zÇĞİÖŞÜ]\.\s*/, '').replace(/[;,]/g, ' ').replace(/\s+/g, ' ').trim();
    if (ad.length >= 2) adlar.push(`${ad} Kanunu`);
  }
  return adlar.join('. ');
}
const AYM_BOILERPLATE = /bazı (kanun|alacak)|kanun hükmünde kararname|değişiklik yapıl|bazı kanunlarda/i;
function aymKategori(konu: string): string {
  const adlar = aymKanunAdlari(konu);
  const metin = adlar && !AYM_BOILERPLATE.test(adlar) ? adlar : konu;
  return classify(metin, { kaynak: 'kanun' });
}

export async function ingestAymAralik(tarihIlk: string, tarihSon: string): Promise<number> {
  const eng = new ConstitutionalEngine();
  const PAGE = 100;
  let n = 0;
  for (let sayfa = 1; sayfa <= 60; sayfa++) {
    let r: { total: number; data: AymNormItem[] };
    try { r = await eng.searchNormDenetimi({ page: sayfa, size: PAGE, tarihIlk, tarihSon }); }
    catch (e) { logger.error(`[aym] ${tarihIlk}: ${(e as Error).message}`); break; }
    if (!r.data.length) break;
    for (const it of r.data) {
      if (!it.esasNo || !it.kararNo) continue;
      const konu = aymKonuKisalt(it.konu);
      if (!konu) continue;
      upsertAym({
        aym_id: it.id, esas_no: it.esasNo, karar_no: it.kararNo,
        karar_tarihi: it.kararTarihi || null, ay: it.kararTarihi ? it.kararTarihi.slice(0, 7) : null,
        rg_tarihi: it.rgTarihi || null, rg_sayisi: it.rgSayisi,
        basvuru_turu: aymBasvuruTuru(it.basvuruTuru, it.konu),
        sonuc: it.sonucLabel, sonuc_kod: aymSonucKod(it.sonucLabel),
        konu, kategori: aymKategori(konu),
        url: it.url, kategori_versiyon: TAXONOMY_VERSION,
      });
      n++;
    }
    if (r.data.length < PAGE) break;
    await sleep(500);
  }
  return n;
}

const bugunISO = (): string => new Date().toISOString().slice(0, 10);

export async function ingestOnergeCevapOrneklem(donem = 28, hedefN = 30): Promise<number> {
  const db = getDb();
  const eng = new MotionEngine();
  const katmanlar = db.prepare(
    `SELECT muhatap, COUNT(*) AS n FROM faaliyet
      WHERE kaynak='onerge' AND donem=? AND muhatap IS NOT NULL AND muhatap<>''
      GROUP BY muhatap ORDER BY n DESC`,
  ).all(donem) as { muhatap: string; n: number }[];
  logger.info(`[onerge-cevap] d${donem} · ${katmanlar.length} katman × ${hedefN} örnek (katmanlı, deterministik).`);

  const sec = db.prepare(
    `SELECT f.id, f.detay_url FROM faaliyet f
      WHERE f.kaynak='onerge' AND f.donem=? AND f.muhatap=?
        AND f.detay_url LIKE '%Detay/%'
        AND NOT EXISTS (SELECT 1 FROM onerge_cevap_cekim c WHERE c.faaliyet_id = f.id)
      ORDER BY f.id LIMIT ?`,
  );
  let yazildi = 0, bos = 0, hata = 0, ardisikBos = 0;
  for (const k of katmanlar) {
    const zaten = (db.prepare(
      `SELECT COUNT(*) c FROM onerge_cevap_cekim oc JOIN faaliyet f ON f.id = oc.faaliyet_id
        WHERE f.donem = ? AND f.muhatap = ?`,
    ).get(donem, k.muhatap) as { c: number }).c;
    const eksik = Math.max(0, hedefN - zaten);
    if (!eksik) continue;
    const hedefler = (sec.all(donem, k.muhatap, eksik) as { id: number; detay_url: string }[])
      .map((h) => ({ id: h.id, uuid: (h.detay_url.split('/').pop() ?? '').trim() }))
      .filter((h) => /^[0-9a-f-]{30,}$/i.test(h.uuid));
    for (const h of hedefler) {
      try {
        const d = await eng.fetchMotionDetail(h.uuid);
        const cevaplar = (d as { cevaplar?: unknown[] })?.cevaplar ?? [];
        const ayristirildiTop = Object.keys((d as { ana_bilgiler?: object })?.ana_bilgiler ?? {}).length > 0;
        if (cevaplar.length) {
          replaceOnergeCevap(h.id, cevaplar as never[]);
          onergeCevapIsaretle(h.id, cevaplar.length, bugunISO());
          yazildi++; ardisikBos = 0;
        } else {
          const ayristirildi = ayristirildiTop;
          if (ayristirildi) onergeCevapIsaretle(h.id, 0, bugunISO());
          bos++;
          if (!ayristirildi) {
            ardisikBos++;
            if (ardisikBos >= 8) {
              logger.warn('[onerge-cevap] 8 ardışık AYRIŞTIRILAMAYAN yanıt — WAF olabilir, 60sn bekleniyor.');
              await sleep(60000); ardisikBos = 0;
            }
          } else ardisikBos = 0;
        }
      } catch (e) {
        hata++;
        logger.error(`[onerge-cevap] ${h.uuid}: ${(e as Error).message}`);
      }
      await sleep(400);
    }
    logger.info(`[onerge-cevap] katman bitti (${hedefler.length} hedef) · yazıldı ${yazildi} · boş ${bos} · hata ${hata}`);
  }
  logger.info(`[onerge-cevap] BİTTİ: ${yazildi} önergede cevap kaydı · ${bos} cevapsız/boş · ${hata} hata.`);
  return yazildi;
}

export async function ingestVekilKomisyon(donem = 28): Promise<number> {
  getDb();
  const eng = new MVEngine();
  const adlar = Object.keys(DEPUTY_IDS_MAPPING);
  logger.info(`[vekil-komisyon] d${donem} · ${adlar.length} vekil (çekilmiş olan atlanır).`);
  const gun = new Date().toISOString().slice(0, 10);
  let yazildi = 0, bos = 0, atlandi = 0, hata = 0, ardisikBos = 0;

  for (const ad of adlar) {
    if (vekilProfilCekildiMi(ad, donem)) { atlandi++; continue; }
    const v = DEPUTY_IDS_MAPPING[ad];
    if (!v?.id || !v?.donem_id) { hata++; continue; }
    try {
      const d = await eng.getDeputyDetails(v.id, v.donem_id, ad);
      const kom = d.komisyonlar ?? [];
      if (kom.length) {
        replaceVekilKomisyon(ad, donem, v.parti ? normParti(v.parti) : null, v.il ?? null, kom);
        yazildi++; ardisikBos = 0;
      } else {
        bos++; ardisikBos++;
      }
      vekilProfilIsaretle(ad, donem, kom.length, gun);

      if (ardisikBos >= 15) {
        logger.warn(`[vekil-komisyon] 15 ardışık BOŞ — WAF olabilir, 30sn bekleniyor (son: ${ad})`);
        await sleep(30000); ardisikBos = 0;
      }
    } catch (e) {
      hata++;
      logger.error(`[vekil-komisyon] ${ad}: ${(e as Error).message}`);
    }
    if ((yazildi + bos) % 50 === 0 && (yazildi + bos) > 0) {
      logger.info(`[vekil-komisyon] ilerleme: yazıldı ${yazildi} · boş ${bos} · atlandı ${atlandi} · hata ${hata}`);
    }
    await sleep(350);
  }
  logger.info(`[vekil-komisyon] BİTTİ: ${yazildi} vekil komisyonlu · ${bos} komisyonsuz · ${atlandi} zaten vardı · ${hata} hata.`);
  return yazildi;
}

export function ingestDuyuru(): number {
  const db = getDb();
  const kanunNoSet = new Set(
    (db.prepare("SELECT DISTINCT kanun_no FROM teklif_sirasayisi WHERE kanun_no IS NOT NULL AND kanun_no<>''")
      .all() as { kanun_no: string }[]).map((r) => r.kanun_no),
  );
  const sorgu: KorpusSorgu = {
    kanunVarMi: (no) => (kanunNoSet.has(no) ? { baslik: null } : null),
    siraSayisiVarMi: () => null,
    esasNoVarMi: () => null,
    aymVarMi: () => null,
  };
  const rg = db.prepare(
    "SELECT id, tarih, tur, baslik, url FROM gazete WHERE tur NOT IN ('ANAYASA MAHKEMESİ KARARLARI','KANUNLAR')",
  ).all() as { id: number; tarih: string | null; tur: string | null; baslik: string; url: string | null }[];

  const ins = db.prepare(
    `INSERT INTO duyuru (gazete_id, kanun_no, baslik, tur, tarih, url) VALUES (?,?,?,?,?,?)
     ON CONFLICT(gazete_id, kanun_no) DO UPDATE SET baslik=excluded.baslik, tur=excluded.tur, tarih=excluded.tarih, url=excluded.url`,
  );
  let n = 0;
  for (const g of rg) {
    const capalar = korpustaMi(tanimlayiciCikar(g.baslik), sorgu);
    for (const c of capalar) {
      if (c.tur !== 'kanun') continue;
      ins.run(g.id, c.deger, g.baslik, g.tur, g.tarih, g.url);
      n++;
    }
  }
  logger.info(`[duyuru] ${rg.length} RG öğesi tarandı → ${n} kanun-çıpalı duyuru yazıldı (SIFIR ağ isteği).`);
  return n;
}

export async function ingestAymParti(tarihIlk?: string): Promise<number> {
  getDb();
  const eng = new ConstitutionalEngine();
  const now = new Date();
  const tarihSon = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const PAGE = 100;
  let n = 0, taranan = 0, sonSayfa = 400;
  for (let sayfa = 1; sayfa <= sonSayfa; sayfa++) {
    let r: { total: number; data: AymNormItem[] };
    try { r = await eng.searchPartiYapisal({ page: sayfa, size: PAGE, ...(tarihIlk ? { tarihIlk, tarihSon } : {}) }); }
    catch (e) { logger.error(`[aym-parti] ${(e as Error).message}`); break; }
    if (!r.data.length) break;
    if (sayfa === 1 && r.total) sonSayfa = Math.min(400, Math.ceil(r.total / PAGE));
    taranan += r.data.length;
    for (const it of r.data) {
      if (!it.esasNo || !it.kararNo) continue;
      upsertAymParti({
        aym_id: it.id, esas_no: it.esasNo, karar_no: it.kararNo,
        karar_tarihi: it.kararTarihi, rg_tarihi: it.rgTarihi, rg_sayisi: it.rgSayisi,
        basvuru_turu: it.basvuruTuru, sonuc: it.sonucLabel,
        konu: aymKonuKisalt(it.konu) || it.konu, url: it.url,
      });
      n++;
    }
    if (r.data.length < PAGE) break;
    await sleep(500);
  }
  logger.info(`[aym-parti] ${taranan} kayıt tarandı → ${n} siyasi parti kararı yazıldı ` +
    `(${taranan ? (100 * n / taranan).toFixed(1) : "0"}%; kalanı bireysel başvuru — bu banka BİRLEŞİKTİR).`);
  if (taranan > 0 && n === 0) logger.warn(`[aym-parti] 🔴 ${taranan} kayıt tarandı, HİÇBİRİ parti kararı değil — kapı veya sayfalama bozulmuş olabilir.`);
  return n;
}

export async function ingestAym(tarihIlk = '2023-06-01'): Promise<number> {
  getDb();
  const now = new Date();
  const tarihSon = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const n = await ingestAymAralik(tarihIlk, tarihSon);
  logger.info(`[aym] TOPLAM ${n} norm denetimi kararı (${tarihIlk}→bugün).`);
  return n;
}

export async function pollAym(): Promise<number> {
  const now = new Date();
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const bas = new Date(now); bas.setDate(now.getDate() - 45);
  const n = await ingestAymAralik(fmt(bas), fmt(now));
  logger.info(`[aym poll] ${n} kayıt (son 45 gün)`);
  return n;
}

export function reclassifyAym(): void {
  const db = getDb();
  const rows = db.prepare('SELECT rowid AS rid, konu, kategori FROM aym_karar').all() as {
    rid: number; konu: string | null; kategori: string | null;
  }[];
  const upd = db.prepare('UPDATE aym_karar SET kategori=? WHERE rowid=?');
  let degisen = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const yeni = aymKategori(r.konu ?? '');
      if (yeni !== r.kategori) { upd.run(yeni, r.rid); degisen++; }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  logger.info(`AYM reclassify bitti: ${rows.length} kayıt · ${degisen} değişti (taksonomi v${TAXONOMY_VERSION}).`);
}

function tuikTarih(kod: string, raw: string): string | null {
  if (!raw) return null;
  if (kod === 'gsyh') {
    const m = /^(\d{4})\/(\d)/.exec(raw);
    return m ? `${m[1]}-${String(Number(m[2]) * 3).padStart(2, '0')}` : null;
  }
  const m = /^(\d{4})\/(\d{1,2})/.exec(raw);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}` : null;
}

const TUIK_DATAFLOW: Array<{ kod: string; dataflowId: string; filtre: Record<string, string> }> = [
  { kod: 'konut', dataflowId: 'TR,DF_SATIS_SEKLI_SATIS_DURUMU_V3,1.0',
    filtre: { FREQ: 'M', SATIS_TURU: '_T', REF_AREA: 'TR', KONUT_ISYERI_GSTERGE: '2', SATIS_ADET_PAY: '_T', INDICATOR: 'MII_KSS' } },
  { kod: 'tasit', dataflowId: 'TR,DF_MOTORLU_KARA_TASIT_KAYDI_YAPILAN_IL_V2,1.0',
    filtre: { REF_AREA: 'TR', FREQ: 'M', INDICATOR: 'U_TKYMKTS', AY: '@ay', ARAC_TUR: '_T', UNIT_MEASURE: 'PN' } },
  { kod: 'issizlik', dataflowId: 'TR,DF_ISGUCU_AYLIK_TEMEL_ISGUCU_C,1.0',
    filtre: { REF_AREA: 'TR', FREQ: 'M', INDICATOR: 'ISGI_TIG', ISGUCU_GOSTERGE: '8',
              TEMEL_YAS: 'Y_GE15', SEASONAL_ADJUST: 'S', SEX: '_T' } },
];

export async function ingestTuik(): Promise<number> {
  getDb();
  const eng = new StatisticsEngine();
  let toplam = 0;
  for (const kod of ['tufe', 'gsyh', 'sanayi', 'guven']) {
    try {
      const r = (await eng.getIndicatorDetails(kod)) as {
        error?: string; trend?: { date: string; value: unknown }[];
        chart1?: { date: string; arindirilmis?: unknown }[];
      };
      if (r?.error) { logger.error(`[tuik] ${kod}: ${r.error}`); continue; }
      const seri = kod === 'issizlik' ? (r.chart1 ?? []) : (r.trend ?? []);
      const noktalar = (seri as { date: string; value?: unknown; arindirilmis?: unknown }[])
        .map((p) => ({ tarih: tuikTarih(kod, p.date), deger: Number(kod === 'issizlik' ? p.arindirilmis : p.value) }))
        .filter((x) => x.tarih && Number.isFinite(x.deger)) as { tarih: string; deger: number }[];
      while (noktalar.length && noktalar[noktalar.length - 1]!.deger === 0) noktalar.pop();
      let n = 0;
      for (const p of noktalar) { upsertTuik({ gosterge: kod, tarih: p.tarih, deger: p.deger }); n++; }
      toplam += n;
      logger.info(`[tuik] ${kod}: ${n} nokta`);
      await sleep(400);
    } catch (e) { logger.error(`[tuik] ${kod}: ${(e as Error).message}`); }
  }
  for (const df of TUIK_DATAFLOW) {
    try {
      const seri = await eng.getDataflowSeries(df.dataflowId, df.filtre);
      let n = 0;
      for (const p of seri) {
        if (!/^\d{4}-\d{2}$/.test(p.tarih) || !Number.isFinite(p.deger)) continue;
        upsertTuik({ gosterge: df.kod, tarih: p.tarih, deger: p.deger });
        n++;
      }
      toplam += n;
      logger.info(`[tuik] ${df.kod}: ${n} nokta (databrowser2, tam geçmiş)`);
      await sleep(400);
    } catch (e) { logger.error(`[tuik] ${df.kod}: ${(e as Error).message}`); }
  }
  logger.info(`[tuik] TOPLAM ${toplam} nokta.`);
  return toplam;
}
export const pollTuik = ingestTuik;

let _oylamaAltSinirOnbellek: string | null | undefined;
function oylamaAltSiniri(): string | null {
  if (_oylamaAltSinirOnbellek !== undefined) return _oylamaAltSinirOnbellek;
  const enEski = getDb()
    .prepare(`SELECT DISTINCT tarih t FROM faaliyet WHERE tarih IS NOT NULL AND donem = 26 ORDER BY tarih LIMIT 20`)
    .all() as { t: string }[];
  _oylamaAltSinirOnbellek = aykiriAyikla(enEski.map((x) => x.t));
  return _oylamaAltSinirOnbellek;
}

export async function ingestOylama(): Promise<number> {
  const dir = join(STORAGE_DIR, 'tutanak_cache');
  if (!existsSync(dir)) { logger.error(`[oylama] cache yok: ${dir}`); return 0; }
  const altSinir = oylamaAltSiniri();
  let yazilan = 0, atlanan = 0, dosya = 0, tarihsiz = 0, donemDisi = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.txt'))) {
    const metin = readFileSync(join(dir, f), 'utf8');
    const bloklar = parseOylama(metin);
    if (!bloklar.length) continue;
    dosya++;
    const { tarih } = parseBaslik(metin);
    if (!tarih) { tarihsiz++; continue; }
    if (altSinir && tarih < altSinir) { donemDisi++; continue; }
    const uuid = f.replace(/\.txt$/, '');
    for (const b of bloklar) {
      if (!b.tutarli) { atlanan++; continue; }
      upsertOylama({
        birlesim_id: uuid, sira_sayisi: b.sira_sayisi, tarih, konu: b.konu,
        kullanilan: b.kullanilan, kabul: b.kabul, ret: b.ret, cekimser: b.cekimser,
        mukerrer: b.mukerrer, sonuc: b.sonuc,
      });
      yazilan++;
    }
  }
  logger.info(`[oylama] ${yazilan} açık oylama (${dosya} birleşim) · ${atlanan} blok ayrıştırılamadı (yazılmadı)`
            + (tarihsiz ? ` · ${tarihsiz} birleşimde tarih okunamadı (null)` : '')
            + (donemDisi ? ` · ${donemDisi} birleşim dönem-dışı (${altSinir} öncesi, yazılmadı)` : ''));
  return yazilan;
}

export async function ingestYsk(): Promise<number> {
  getDb();
  const eng = new YskEngine();
  let toplam = 0;
  for (const tanim of YSK_MILLETVEKILI_SECIMLERI) {
    try {
      const r = await eng.fetchSecimSonucu(tanim);
      for (const p of r.partiler) {
        upsertSecimSonucu({
          donem: r.donem, secim_id: r.secimId, tarih: r.tarih, secim_adi: r.secimAdi,
          parti: p.parti, oy: p.oy,
          gecerli_oy_toplami: r.gecerliOyToplami, gecersiz_oy_toplami: r.gecersizOyToplami,
          secmen_sayisi: r.secmenSayisi, katilma_orani: r.katilmaOrani,
        });
        toplam++;
      }
      logger.info(`[ysk d${r.donem}] ${r.partiler.length} parti/bağımsız satırı (katılım %${r.katilmaOrani.toFixed(2)}).`);
    } catch (e) {
      logger.error(`[ysk d${tanim.donem}] ${(e as Error).message}`);
    }
    await sleep(800);

    try {
      const sandalyeler = await fetchSandalyeSayisi(tanim.donem);
      let guncellenen = 0, bulunamayan: string[] = [];
      for (const s of sandalyeler) {
        if (updateSecimSandalye(tanim.donem, s.parti, s.sandalye)) guncellenen++;
        else bulunamayan.push(`${s.parti}:${s.sandalye}`);
      }
      logger.info(`[ysk-sandalye d${tanim.donem}] ${guncellenen}/${sandalyeler.length} parti güncellendi.`
        + (bulunamayan.length ? ` ⚠️ oy tablosunda karşılığı yok (yazılamadı): ${bulunamayan.join(', ')}` : ''));
    } catch (e) {
      logger.error(`[ysk-sandalye d${tanim.donem}] ${(e as Error).message}`);
    }
    await sleep(800);
  }
  logger.info(`[ysk] TOPLAM ${toplam} satır (${YSK_MILLETVEKILI_SECIMLERI.length} seçim).`);
  return toplam;
}

export async function ingestYskTarihsel(): Promise<number> {
  getDb();
  let toplam = 0;
  for (const donem of Object.keys(TARIHSEL_SECIM_PDF).map(Number)) {
    try {
      const r = await fetchTarihselSecimSonucu(donem);
      for (const p of r.partiler) {
        upsertSecimSonucu({
          donem: r.donem, secim_id: r.donem, tarih: r.tarih, secim_adi: r.secimAdi,
          parti: p.parti, oy: p.oy,
          gecerli_oy_toplami: r.gecerliOyToplami, gecersiz_oy_toplami: r.gecersizOyToplami,
          secmen_sayisi: r.secmenSayisi, katilma_orani: r.katilmaOrani,
        });
        toplam++;
      }
      logger.info(`[ysk-tarihsel d${r.donem}] ${r.partiler.length} parti/bağımsız satırı (katılım %${r.katilmaOrani.toFixed(2)}).`);
    } catch (e) {
      logger.error(`[ysk-tarihsel d${donem}] ${(e as Error).message}`);
    }
    await sleep(800);
  }
  logger.info(`[ysk-tarihsel] TOPLAM ${toplam} satır (${Object.keys(TARIHSEL_SECIM_PDF).length} seçim).`);
  return toplam;
}

export async function ingestPartiProgram(): Promise<number> {
  getDb();
  let toplam = 0;
  for (const tanim of PARTI_PROGRAM_TANIMLARI) {
    try {
      const { metin } = await fetchPartiProgram(tanim);
      upsertPartiProgram({
        parti: tanim.parti, belge_adi: tanim.belgeAdi, belge_turu: tanim.belgeTuru,
        tarih: tanim.tarih, kaynak_url: tanim.url, metin,
      });
      toplam++;
    } catch (e) {
      logger.error(`[parti-program ${tanim.parti}] ${(e as Error).message}`);
    }
    await sleep(1200);
  }
  logger.info(`[parti-program] TOPLAM ${toplam}/${PARTI_PROGRAM_TANIMLARI.length} belge yazıldı.`);
  return toplam;
}

export async function ingestYerelYonetim(sadeceBelediye?: string): Promise<number> {
  getDb();
  let toplam = 0;
  const belediyeler = sadeceBelediye
    ? YEREL_YONETIM_BELEDIYELERI.filter((b) => b === sadeceBelediye)
    : YEREL_YONETIM_BELEDIYELERI;
  if (sadeceBelediye && !belediyeler.length) {
    logger.error(`[yerel-yonetim] bilinmeyen belediye: "${sadeceBelediye}" — geçerli: ${YEREL_YONETIM_BELEDIYELERI.join(', ')}`);
    return 0;
  }
  for (const belediye of belediyeler) {
    try {
      const uyeler = await fetchYerelUyeler(belediye);
      if (uyeler) {
        for (const u of uyeler) upsertYerelMeclisUye(u);
        logger.info(`[yerel-yonetim ${belediye}] ${uyeler.length} meclis üyesi.`);
      } else {
        logger.info(`[yerel-yonetim ${belediye}] üye listesi kaynakta yok (bkz. engines/yerelYonetim.ts) — atlandı.`);
      }
    } catch (e) {
      logger.error(`[yerel-yonetim ${belediye}] üye listesi: ${(e as Error).message}`);
    }
    try {
      const kararlar = await fetchYerelKararlar(belediye);
      for (const k of kararlar) { upsertYerelKarar(k); toplam++; }
      logger.info(`[yerel-yonetim ${belediye}] ${kararlar.length} karar.`);
    } catch (e) {
      logger.error(`[yerel-yonetim ${belediye}] kararlar: ${(e as Error).message}`);
    }
  }
  logger.info(`[yerel-yonetim] TOPLAM ${toplam} karar (${belediyeler.length} belediye).`);
  return toplam;
}

const TANINAN_PARTI = new Set(['AKP', 'CHP', 'DEM', 'MHP', 'IYI', 'YENI YOL', 'YENIDEN REFAH', 'SAADET',
  'GELECEK', 'DEVA', 'DBP', 'TIP', 'EMEP', 'HUDA PAR', 'BAGIMSIZ', 'DSP', 'DP', 'BBP', 'ZAFER']);
const bilinmeyenParti = new Map<string, number>();

export async function ingestOy(): Promise<number> {
  const db = getDb();
  bilinmeyenParti.clear();
  const dir = join(STORAGE_DIR, 'basilmis_cache');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const engine = new MinuteEngine();

  const CETVEL_METIN_BASLANGIC = '2023-06-01';
  const birlesimler = (db.prepare('SELECT DISTINCT birlesim_id, tarih FROM oylama ORDER BY tarih').all() as { birlesim_id: string; tarih: string | null }[])
    .filter((b) => (b.tarih ?? '') >= CETVEL_METIN_BASLANGIC);
  logger.info(`[oy] ${birlesimler.length} birleşimde açık oylama var (≥${CETVEL_METIN_BASLANGIC}; öncesi taranmış görüntü → atlandı) → cetvel taranıyor.`);

  let yazilan = 0, gecen = 0, kalan = 0, pdfYok = 0;
  for (const b of birlesimler) {
    const dosya = join(dir, `${b.birlesim_id}.pdf`);
    let bayt: Buffer;
    if (existsSync(dosya)) {
      bayt = readFileSync(dosya);
    } else {
      const url = (await engine.fetchDetailMeta(b.birlesim_id)).basilmis_url;
      if (!url) { pdfYok++; continue; }
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0' } });
        if (!r.ok) { pdfYok++; continue; }
        bayt = Buffer.from(await r.arrayBuffer());
        writeFileSync(dosya, bayt);
        await sleep(1200);
      } catch (e) {
        logger.error(`[oy] ${b.birlesim_id.slice(0, 8)} indirilemedi: ${(e as Error).message}`);
        pdfYok++; continue;
      }
    }
    let cetvel;
    try {
      cetvel = await parseCetvel(new Uint8Array(bayt));
    } catch (e) {
      logger.error(`[oy] ${b.birlesim_id.slice(0, 8)} ayrıştırılamadı: ${(e as Error).message}`);
      continue;
    }
    if (cetvel.cakisma.length) {
      logger.warn(`⚠️ [oy] ${b.birlesim_id.slice(0,8)}: aynı S.S. altında FARKLI kutu → ${cetvel.cakisma.join(" · ")} ` +
        `(TBMM kanun-olmayan oylamalara S.S.0 veriyor; bir birleşimde iki tane olursa anahtar çakışır)`);
    }
    for (const ozet of cetvel.ozetler) {
      const oylar = cetvel.oylar.get(`S. S. ${ozet.sira_sayisi}`) ?? [];
      if (!kapiGecti(ozet, oylar)) {
        kalan++;
        const say = (v: string): number => oylar.filter((o) => o.oy === v).length;
        logger.warn(`[oy] KAPI KALDI — ${b.birlesim_id.slice(0, 8)} S.S.${ozet.sira_sayisi}: `
                  + `kutu ${ozet.kabul}/${ozet.ret}/${ozet.cekimser} ≠ cetvel ${say('Kabul')}/${say('Ret')}/${say('Çekimser')} → YAZILMADI`);
        continue;
      }
      gecen++;
      yazilan += upsertOyToplu(oylar.map((o) => {
        const kanon0 = normParti(o.parti);
        const kanon = CETVEL_KESIK[kanon0] ?? kanon0;
        if (!TANINAN_PARTI.has(kanon)) bilinmeyenParti.set(o.parti, (bilinmeyenParti.get(o.parti) ?? 0) + 1);
        return {
          birlesim_id: b.birlesim_id, sira_sayisi: ozet.sira_sayisi,
          il: o.il, soyad: o.soyad, ad: o.ad, parti: kanon, oy: o.oy, tarih: b.tarih,
        };
      }));
    }
  }
  logger.info(`[oy] ${yazilan} oy satırı · ${gecen} oylama kapıyı geçti · ${kalan} oylama KALDI (yazılmadı) · ${pdfYok} birleşimde Basılmış PDF yok.`);
  if (bilinmeyenParti.size) {
    const liste = [...bilinmeyenParti.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `"${p}"×${n}`).join(' · ');
    logger.warn(`⚠️ [oy] normParti'nin TANIMADIĞI ${bilinmeyenParti.size} parti etiketi ham yazıldı: ${liste}`
              + ` — partyResolve'a eklenmeli, yoksa bu vekiller parti kırılımında ayrı parti gibi sayılır.`);
  }
  return yazilan;
}

export async function cleanup(): Promise<void> {
  const db = getDb();
  let toplamSilinen = 0;
  for (const [d, bas] of Object.entries(DONEM_BASLANGIC)) {
    const before = (db.prepare('SELECT COUNT(*) c FROM faaliyet WHERE donem = ? AND ay IS NOT NULL AND ay < ?').get(Number(d), bas) as { c: number }).c;
    if (!before) continue;
    db.prepare('DELETE FROM faaliyet WHERE donem = ? AND ay IS NOT NULL AND ay < ?').run(Number(d), bas);
    toplamSilinen += before;
    logger.info(`Cleanup: dönem ${d} → ${before} yanlış-dönem kayıt silindi (ay < ${bas}).`);
  }
  const korunan = (db.prepare(`SELECT COUNT(*) c FROM faaliyet WHERE donem NOT IN (${Object.keys(DONEM_BASLANGIC).join(',')})`).get() as { c: number }).c;
  const total = (db.prepare('SELECT COUNT(*) c FROM faaliyet').get() as { c: number }).c;
  logger.info(`Cleanup: ${toplamSilinen} kayıt silindi · ${korunan} kayıt başlangıcı tanımsız dönemlerde (dokunulmadı). Kalan toplam: ${total}.`);
}

function collectTopicLabels(): LabeledDoc[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT f.baslik, f.muhatap, f.donem,
            (SELECT CASE WHEN COUNT(*) = 1 THEN MIN(fp.parti) ELSE NULL END
               FROM faaliyet_parti fp WHERE fp.faaliyet_id = f.id) AS parti
       FROM faaliyet f
      WHERE f.kaynak='onerge' AND f.muhatap IS NOT NULL AND f.baslik IS NOT NULL`,
  ).all() as { baslik: string; muhatap: string; donem: number; parti: string | null }[];
  const docs: LabeledDoc[] = [];
  for (const r of rows) {
    const cat = MUHATAP_KATEGORI[r.donem]?.[(r.muhatap || '').toLowerCase()];
    if (!cat || cat === 'MULTI') continue;
    const parti = r.parti && !PARTI_DISI.has(r.parti) ? r.parti : null;
    docs.push({ text: r.baslik, cat, splitKey: normText(r.baslik), parti });
  }
  return docs;
}

function buildTopicModel(): { model: TopicModel; report: TrainReport } | null {
  const docs = collectTopicLabels();
  if (docs.length < 500) {
    logger.error(`[topic] yetersiz etiketli veri (${docs.length}) — model eğitilmedi (keyword'e düşülür).`);
    return null;
  }
  const { model, report } = trainNB(docs);
  model.taxonomyVersion = TAXONOMY_VERSION;
  return { model, report };
}

function logTopicReport(report: TrainReport): void {
  logger.info(`[topic] HELD-OUT micro %${report.micro} · macro %${report.macro} · Diğer'e çekilen %${report.digerPct} · vocab ${report.vocab} (train ${report.trainDocs}/held ${report.heldoutDocs})`);
  const zayif = Object.entries(report.perCat).filter(([, v]) => v.n >= 20).sort((a, b) => a[1].recall - b[1].recall).slice(0, 5).map(([c, v]) => `${c} %${v.recall}(n${v.n})`);
  logger.info(`[topic] en zayıf: ${zayif.join(' · ')}`);
  logger.info(`[topic] en sık karışıklık: ${report.confusion.slice(0, 4).join(' | ')}`);
  const y = Object.entries(report.perParti).sort((a, b) => Math.abs(b[1].artik) - Math.abs(a[1].artik))
    .map(([p, v]) => `${p} ${v.artik > 0 ? '+' : ''}${v.artik}(n${v.n})`);
  logger.info(`[topic] PARTİ YANLILIĞI (LOPO artık, max ${report.yanlilikMaxPP}pp): ${y.join(' · ')}`);
}

export async function trainTopic(): Promise<{ micro: number; macro: number } | null> {
  const built = buildTopicModel();
  if (!built) return null;
  logger.info(`[train-topic] ${built.model.trainDocs} muhatap-etiketli önerge ile eğitildi.`);
  saveModel(built.model);
  logTopicReport(built.report);
  return { micro: built.report.micro, macro: built.report.macro };
}

export async function maybeTrainTopic(force = false): Promise<void> {
  const cur = loadModelFile();
  const labeled = collectTopicLabels().length;
  const noModel = !cur;
  const staleTax = cur != null && cur.taxonomyVersion !== TAXONOMY_VERSION;
  const grew = cur != null && cur.trainDocs > 0 && labeled > cur.trainDocs * 1.05;
  if (!force && !noModel && !staleTax && !grew) {
    logger.info(`[topic] model güncel (${cur!.trainDocs} doc, taxo v${cur!.taxonomyVersion}, micro %${cur!.heldoutMicro ?? '?'}) — retrain atlandı.`);
    return;
  }
  logger.info(`[topic] retrain tetiklendi (${noModel ? 'model-yok' : staleTax ? 'taksonomi-bump' : grew ? `veri-artışı ${cur!.trainDocs}→${labeled}` : 'zorla'})...`);
  const built = buildTopicModel();
  if (!built) return;

  const YANLILIK_REGRESYON_PP = 1.5;
  const MICRO_DUSUS_PP = 4;
  const eskiYanlilik = cur?.yanlilikMaxPP;
  const yeniYanlilik = built.report.yanlilikMaxPP;

  if (eskiYanlilik != null && yeniYanlilik > eskiYanlilik + YANLILIK_REGRESYON_PP) {
    logger.error(
      `[topic] REGRESYON GUARD (yanlılık): max parti-artığı %${eskiYanlilik} → %${yeniYanlilik} ` +
      `(+${(yeniYanlilik - eskiYanlilik).toFixed(1)} puan > ${YANLILIK_REGRESYON_PP}) → RET, eski model korunuyor. ` +
      `Yeni model bir partiyi eskisinden daha fazla kayırıyor.`,
    );
    return;
  }
  if (cur?.heldoutMicro != null && built.report.micro < cur.heldoutMicro - MICRO_DUSUS_PP) {
    const yanlilikIyilesti = eskiYanlilik != null && yeniYanlilik < eskiYanlilik;
    if (!yanlilikIyilesti) {
      logger.error(
        `[topic] REGRESYON GUARD (micro): %${built.report.micro} < %${cur.heldoutMicro}−${MICRO_DUSUS_PP} ` +
        `ve yanlılık iyileşmiyor (%${eskiYanlilik ?? '?'} → %${yeniYanlilik}) → RET.`,
      );
      return;
    }
    logger.warn(
      `[topic] micro düştü (%${cur.heldoutMicro} → %${built.report.micro}) AMA yanlılık iyileşti ` +
      `(%${eskiYanlilik} → %${yeniYanlilik}) → KABUL. Takas bilinçli: hâkim lehçeye daha az uymak, ` +
      `partiler arası daha eşit davranmak.`,
    );
  }
  saveModel(built.model);
  logTopicReport(built.report);
}

function parseArgs(argv: string[]): { mode: string; opts: EtlOpts } {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const mode = positional[0] ?? 'backfill';
  const di = argv.indexOf('--donem');
  const ki = argv.indexOf('--kaynak');
  const li = argv.indexOf('--limit');
  const kv = ki >= 0 ? argv[ki + 1] : undefined;
  const opts: EtlOpts = {
    onlyDonem: di >= 0 && argv[di + 1] ? Number(argv[di + 1]) : null,
    onlyKaynak: kv === 'kanun' || kv === 'onerge' || kv === 'konusma' ? kv : null,
    force: argv.includes('--force'),
    limit: li >= 0 && argv[li + 1] ? Number(argv[li + 1]) : null,
  };
  return { mode, opts };
}

function argBaslangic(): string | null {
  const i = process.argv.indexOf('--baslangic');
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && /^\d{4}-\d{2}$/.test(v) ? v : null;
}

function argBelediye(): string | undefined {
  const i = process.argv.indexOf('--belediye');
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { mode, opts } = parseArgs(process.argv.slice(2));
  const run =
    mode === 'incremental' ? incremental()
    : mode === 'reclassify' ? reclassify()
    : mode === 'gazete-reclassify' ? Promise.resolve().then(() => { getDb(); reclassifyGazete(); })
    : mode === 'aym' ? ingestAym(argBaslangic() ? argBaslangic() + '-01' : undefined).then(() => undefined)
    : mode === 'onerge-cevap' ? ingestOnergeCevapOrneklem().then(() => undefined)
    : mode === 'vekil-komisyon' ? ingestVekilKomisyon().then(() => undefined)
    : mode === 'duyuru' ? Promise.resolve().then(() => { getDb(); ingestDuyuru(); })
    : mode === 'aym-parti' ? ingestAymParti(argBaslangic() ?? undefined).then(() => undefined)
    : mode === 'aym-reclassify' ? Promise.resolve().then(() => { getDb(); reclassifyAym(); })
    : mode === 'tuik' ? ingestTuik().then(() => undefined)
    : mode === 'oylama' ? ingestOylama().then(() => undefined)
    : mode === 'oy' ? ingestOy().then(() => undefined)
    : mode === 'cleanup' ? cleanup()
    : mode === 'reconcile-konusma' ? Promise.resolve().then(() => { getDb(); reconcileKonusma(); })
    : mode === 'train-topic' ? trainTopic()
    : mode === 'poll' ? poll().then(() => undefined)
    : mode === 'gazete' ? ingestGazette(argBaslangic() ?? undefined).then(() => undefined)
    : mode === 'ysk' ? ingestYsk().then(() => undefined)
    : mode === 'ysk-tarihsel' ? ingestYskTarihsel().then(() => undefined)
    : mode === 'parti-program' ? ingestPartiProgram().then(() => undefined)
    : mode === 'yerel-yonetim' ? ingestYerelYonetim(argBelediye()).then(() => undefined)
    : backfill(opts);
  run
    .then(() => process.exit(0))
    .catch((e) => {
      logger.error((e as Error).message);
      process.exit(1);
    });
}
