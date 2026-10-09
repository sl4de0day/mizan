import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as cheerio from 'cheerio';
import { httpFetch as _httpFetch, proxyUrlForKaynak, type HttpOptions } from '../lib/http.js';
import { getLogger } from '../lib/logger.js';
import { PROJECT_ROOT, BACKEND_NODE_ROOT } from '../lib/config.js';

const logger = getLogger('tbmm.deputy_builder');

const KAYNAK = 'tbmm';
function httpFetch(url: string, opts: HttpOptions = {}) { return _httpFetch(url, { proxyUrl: proxyUrlForKaynak(KAYNAK), ...opts }); }

const IDS_OUTPUT = join(BACKEND_NODE_ROOT, 'data', 'deputy_tbmm_ids.json');
const MASTER_OUTPUT = join(PROJECT_ROOT, 'deputy_master_list.json');

const FORM_URL = 'https://www.tbmm.gov.tr/milletvekili-arama/form';
const LIST_URL = 'https://www.tbmm.gov.tr/milletvekili-arama/liste';
const CSRF_NAME = 'X-CSRF-TOKEN-TBMM.WEB.Mvc.Prod';

const FALLBACK_DONEM_ID = '134155f0-c3d6-4d24-893b-f3a2ef695ae7';

const BLOCK_MARKERS = ['Request Rejected', 'stealth_fail'];
const RETRY_SLEEP = 10_000;
const REQUEST_SLEEP = 1_000;
const MAX_RETRIES = 3;

const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
  Referer: FORM_URL,
  Origin: 'https://www.tbmm.gov.tr',
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface MetaOption {
  id: string;
  name: string;
  selected: boolean;
}
interface Metadata {
  terms: MetaOption[];
  cities: MetaOption[];
  parties: MetaOption[];
}
interface DeputyIdInfo {
  id: string;
  donem_id: string;
  parti: string;
  il: string;
  photo: string;
  photoUrl?: string;
}
interface MasterRecord {
  ad_soyad: string;
  parti: string;
  il: string;
  donem: string;
}

export class Session {
  csrf: string | null = null;
  jar = new Map<string, string>();

  absorb(resp: Response): void {
    const anyHeaders = resp.headers as unknown as { getSetCookie?: () => string[] };
    for (const c of anyHeaders.getSetCookie?.() ?? []) {
      const pair = c.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx > 0) this.jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  cookieHeader(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export async function initSession(session: Session): Promise<{ csrf: string | null; html: string | null }> {
  try {
    const r = await httpFetch(FORM_URL, { headers: HEADERS, timeoutMs: 15_000 });
    session.absorb(r);
    if (r.status === 200) {
      const html = await r.text();
      const $ = cheerio.load(html);
      const val = $(`input[name="${CSRF_NAME}"]`).attr('value');
      if (val) return { csrf: val, html };
      logger.error('CSRF token etiketi bulunamadı (form yapısı değişmiş olabilir).');
      return { csrf: null, html };
    }
    logger.error(`Form sayfası HTTP ${r.status} döndürdü.`);
  } catch (e) {
    logger.error(`Oturum başlatma hatası: ${(e as Error).message}`);
  }
  return { csrf: null, html: null };
}

export function loadMetadata(html: string | null): Metadata {
  const meta: Metadata = { terms: [], cities: [], parties: [] };
  if (!html) {
    logger.error('Canlı form alınamadı — metadata boş.');
    return meta;
  }
  const $ = cheerio.load(html);
  const map: [keyof Metadata, string][] = [
    ['terms', 'DonemId'],
    ['cities', 'IlId'],
    ['parties', 'PartiId'],
  ];
  for (const [key, selectId] of map) {
    const select = $(`select#${selectId}`);
    if (!select.length) {
      logger.warn(`Form'da '${selectId}' select bulunamadı.`);
      continue;
    }
    select.find('option').each((_, opt) => {
      const val = $(opt).attr('value');
      if (val) {
        meta[key].push({
          id: val,
          name: $(opt).text().trim(),
          selected: $(opt).attr('selected') !== undefined,
        });
      }
    });
  }
  logger.info(`Metadata: ${meta.terms.length} dönem, ${meta.cities.length} il, ${meta.parties.length} parti.`);
  return meta;
}

export function resolveActiveDonem(terms: MetaOption[]): string {
  const selected = terms.find((t) => t.selected);
  if (selected) {
    logger.info(`Aktif dönem (selected): ${selected.name} -> ${selected.id}`);
    return selected.id;
  }
  if (terms.length) {
    const termNum = (t: MetaOption): number => {
      const digits = (t.name || '').replace(/\D/g, '');
      return digits ? parseInt(digits, 10) : -1;
    };
    const newest = terms.reduce((a, b) => (termNum(b) > termNum(a) ? b : a));
    if (termNum(newest) >= 0) {
      logger.info(`Aktif dönem (en yüksek numara): ${newest.name} -> ${newest.id}`);
      return newest.id;
    }
    logger.info(`Aktif dönem (ilk seçenek, numara yok): ${terms[0].name} -> ${terms[0].id}`);
    return terms[0].id;
  }
  logger.warn(
    `Dönem listesi boş — sabit FALLBACK_DONEM_ID kullanılıyor (${FALLBACK_DONEM_ID}). ` +
      'Bu değer çürümüş olabilir; form yapısını kontrol et.',
  );
  return FALLBACK_DONEM_ID;
}

function isBlocked(status: number, text: string): boolean {
  if (status !== 200) return true;
  return BLOCK_MARKERS.some((m) => text.includes(m));
}

export async function postSearch(session: Session, il = '', parti = '', donem = ''): Promise<string | null> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const payload = new URLSearchParams({
      [CSRF_NAME]: session.csrf ?? '',
      Adi: '',
      Soyadi: '',
      Ozgecmis: '',
      IlId: il,
      DonemId: donem,
      PartiId: parti,
    });
    try {
      const r = await httpFetch(LIST_URL, {
        method: 'POST',
        headers: { ...HEADERS, Cookie: session.cookieHeader() },
        body: payload,
        timeoutMs: 15_000,
      });
      const text = await r.text();
      if (!isBlocked(r.status, text)) return text;
      logger.warn(`Blok/anormal yanıt (HTTP ${r.status}) — deneme ${attempt}/${MAX_RETRIES}, CSRF yenileniyor...`);
    } catch (e) {
      logger.warn(`İstek hatası (${(e as Error).message}) — deneme ${attempt}/${MAX_RETRIES}.`);
    }
    await sleep(RETRY_SLEEP);
    const { csrf } = await initSession(session);
    if (csrf) session.csrf = csrf;
  }
  logger.error(`Tüm denemeler başarısız — sorgu atlandı (il=${il || '-'} parti=${parti || '-'}).`);
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractCity(card: cheerio.Cheerio<any>): string {
  const p = card.find('div.milletvekili_cehresi p').first();
  if (p.length) {
    const lines = p
      .text()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length >= 2) return lines[1].replace(/Milletvekili/g, '').trim();
  }
  return 'Bilinmiyor';
}

export function parseIdCards(html: string, defaultParty: string | null = null): Record<string, DeputyIdInfo> {
  const $ = cheerio.load(html);
  const out: Record<string, DeputyIdInfo> = {};
  $('div.profile-list').each((_, el) => {
    const card = $(el);
    const nameTag = card.find('strong.isim_soyisim').first();
    if (!nameTag.length) return;
    const aTag = nameTag.find('a').first();
    if (!aTag.length) return;

    let params: URLSearchParams;
    try {
      params = new URL(aTag.attr('href') ?? '', 'https://www.tbmm.gov.tr').searchParams;
    } catch {
      return;
    }
    const name = nameTag.text().replace(/Öz geçmiş/g, '').trim();
    const deputyId = params.get('Id') ?? '';
    const donemId = params.get('DonemId') ?? '';
    if (!name || !deputyId) return;

    const imgSrc = card.find('img.profile-image').first().attr('src') ?? '';
    const photo = imgSrc.split('/').pop() ?? '';
    const photoUrl = imgSrc ? new URL(imgSrc, 'https://www.tbmm.gov.tr').toString() : '';

    let partyName = defaultParty;
    if (partyName === null) {
      partyName = 'Bilinmeyen Parti';
      const gorev = card.find('span.gorev_listesi').first();
      if (gorev.length) {
        const strong = gorev.find('strong').first();
        if (strong.length) {
          partyName = strong.text().trim();
        } else {
          const lines = gorev
            .text()
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);
          if (lines.length) partyName = lines[0];
        }
      }
    }

    out[name.toUpperCase()] = {
      id: deputyId,
      donem_id: donemId,
      parti: partyName,
      il: extractCity(card),
      photo,
      photoUrl,
    };
  });
  return out;
}

export function parseMasterCards(html: string, termName: string, partyName: string): MasterRecord[] {
  const $ = cheerio.load(html);
  const out: MasterRecord[] = [];
  $('div.profile-list').each((_, el) => {
    const card = $(el);
    const nameTag = card.find('strong.isim_soyisim').first();
    if (!nameTag.length) return;
    const fullName = nameTag.text().replace(/Öz geçmiş/g, '').trim();
    if (!fullName) return;
    out.push({ ad_soyad: fullName, parti: partyName, il: extractCity(card), donem: termName });
  });
  return out;
}

function loadIds(): Record<string, DeputyIdInfo> {
  if (existsSync(IDS_OUTPUT)) {
    try {
      return JSON.parse(readFileSync(IDS_OUTPUT, 'utf-8'));
    } catch (e) {
      logger.warn(`Mevcut ${IDS_OUTPUT} okunamadı, sıfırdan başlanıyor: ${(e as Error).message}`);
    }
  }
  return {};
}

function ensureDir(file: string): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function saveIds(mapping: Record<string, DeputyIdInfo>): void {
  ensureDir(IDS_OUTPUT);
  writeFileSync(IDS_OUTPUT, JSON.stringify(mapping, null, 2));
}

const rosterKey = (r: { ad_soyad?: string; donem?: string; il?: string }): string =>
  `${(r.ad_soyad ?? '').replace(/İ/g, 'i').replace(/I/g, 'ı').toLowerCase().replace(/\s+/g, ' ').trim()}|${r.donem ?? ''}|${r.il ?? ''}`;

function saveMaster(records: MasterRecord[]): void {
  ensureDir(MASTER_OUTPUT);
  let eski: MasterRecord[] = [];
  if (existsSync(MASTER_OUTPUT)) {
    try {
      const p = JSON.parse(readFileSync(MASTER_OUTPUT, 'utf-8'));
      if (Array.isArray(p)) eski = p;
    } catch (e) {
      logger.error(`Mevcut roster okunamadı (${(e as Error).message}) — GÜVENLİK: yazma iptal.`);
      return;
    }
  }
  if (!records.length) { logger.error('Çekim BOŞ döndü — roster yazımı iptal (mevcut liste korunuyor).'); return; }

  const cekilenDonemler = new Set(records.map((r) => r.donem));
  const korunan = eski.filter((r) => !cekilenDonemler.has(r.donem));
  const eskiMap = new Map(eski.map((r) => [rosterKey(r), r]));
  const guncel = records.map((r) => {
    const e = eskiMap.get(rosterKey(r));
    return e ? { ...e, ...r } : r;
  });
  const out = [...korunan, ...guncel];

  if (eski.length > 0 && out.length < eski.length * 0.9) {
    logger.error(`GÜVENLİK: yeni roster ${out.length} kayıt, mevcut ${eski.length} — %10'dan fazla küçülme, yazma İPTAL. (Kötü çekim/WAF olabilir; --force-shrink yok, bilerek.)`);
    return;
  }
  if (eski.length) {
    try {
      const dir = join(BACKEND_NODE_ROOT, 'storage', 'roster-backup');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      writeFileSync(join(dir, `deputy_master_list.${stamp}.json`), JSON.stringify(eski, null, 2));
    } catch (e) { logger.warn(`Yedek alınamadı: ${(e as Error).message}`); }
  }
  const zenginKorunan = guncel.filter((r) => (r as unknown as Record<string, unknown>).id != null).length;
  writeFileSync(MASTER_OUTPUT, JSON.stringify(out, null, 2));
  logger.info(`Roster yazıldı: ${out.length} kayıt (çekilen ${guncel.length} · korunan-dönem ${korunan.length} · zengin-alanı korunan ${zenginKorunan}).`);
}

async function modeByParty(session: Session, meta: Metadata, donemId: string): Promise<Record<string, DeputyIdInfo>> {
  const mapping = loadIds();
  if (!meta.parties.length) {
    logger.error('Parti listesi boş — by-party modu çalışamaz.');
    return mapping;
  }
  let idx = 0;
  for (const party of meta.parties) {
    idx++;
    logger.info(`Parti taranıyor: ${party.name} (${idx}/${meta.parties.length})`);
    const html = await postSearch(session, '', party.id, donemId);
    if (html === null) continue;
    const found = parseIdCards(html, party.name);
    const n = Object.keys(found).length;
    if (!n) logger.warn(`  ${party.name} için 0 vekil ayrıştırıldı (blok/seçici değişikliği olabilir).`);
    Object.assign(mapping, found);
    if (n === MAKS_SONUC && meta.cities.length) {
      logger.info(`  ${party.name}: ${MAKS_SONUC} = kesilmiş → il il taranıyor (${meta.cities.length} il)`);
      for (const city of meta.cities) {
        await sleep(REQUEST_SLEEP);
        const ch = await postSearch(session, city.id, party.id, donemId);
        if (ch === null) continue;
        const cf = parseIdCards(ch, party.name);
        if (Object.keys(cf).length === MAKS_SONUC) logger.warn(`    ⚠️ ${party.name}/${city.name}: il kırılımında da ${MAKS_SONUC} → HÂLÂ KESİK`);
        Object.assign(mapping, cf);
      }
    }
    logger.info(`  ${Object.keys(found).length} vekil (toplam ${Object.keys(mapping).length})`);
    saveIds(mapping);
    await sleep(REQUEST_SLEEP);
  }
  return mapping;
}

async function modeByProvince(session: Session, meta: Metadata, donemId: string): Promise<Record<string, DeputyIdInfo>> {
  const mapping = loadIds();
  if (!meta.cities.length) {
    logger.error('İl listesi boş — by-province modu çalışamaz.');
    return mapping;
  }
  let idx = 0;
  for (const city of meta.cities) {
    idx++;
    const cityUpper = city.name.toUpperCase();
    if (Object.values(mapping).some((v) => (v.il || '').toUpperCase() === cityUpper)) {
      logger.info(`Atlanıyor: ${city.name} (${idx}/${meta.cities.length}) — zaten taranmış.`);
      continue;
    }
    logger.info(`İl taranıyor: ${city.name} (${idx}/${meta.cities.length})`);
    const html = await postSearch(session, city.id, '', donemId);
    if (html === null) continue;
    const found = parseIdCards(html);
    if (!Object.keys(found).length) logger.warn(`  ${city.name} için 0 vekil ayrıştırıldı.`);
    Object.assign(mapping, found);
    logger.info(`  ${Object.keys(found).length} vekil (toplam ${Object.keys(mapping).length})`);
    saveIds(mapping);
    await sleep(REQUEST_SLEEP);
  }
  return mapping;
}

async function modeRemaining(session: Session, meta: Metadata, donemId: string): Promise<Record<string, DeputyIdInfo>> {
  const mapping = loadIds();
  if (!(meta.parties.length && meta.cities.length)) {
    logger.error('Parti veya il listesi boş — remaining modu çalışamaz.');
    return mapping;
  }
  for (const party of meta.parties) {
    let idx = 0;
    for (const city of meta.cities) {
      idx++;
      const cityUpper = city.name.toUpperCase();
      const already = Object.values(mapping).some(
        (v) => v.parti === party.name && (v.il || '').toUpperCase() === cityUpper,
      );
      if (already) continue;
      logger.info(`Taranıyor: ${party.name} / ${city.name} (${idx}/${meta.cities.length})`);
      const html = await postSearch(session, city.id, party.id, donemId);
      if (html === null) continue;
      const found = parseIdCards(html, party.name);
      if (Object.keys(found).length) {
        logger.info(`  ${Object.keys(found).length} vekil (toplam ${Object.keys(mapping).length + Object.keys(found).length})`);
        Object.assign(mapping, found);
        saveIds(mapping);
      }
      await sleep(REQUEST_SLEEP);
    }
  }
  return mapping;
}

async function modeFull(session: Session, meta: Metadata, donemId: string): Promise<Record<string, DeputyIdInfo>> {
  const mapping = loadIds();
  if (!meta.cities.length) {
    logger.error('İl listesi boş — full modu çalışamaz.');
    return mapping;
  }
  let idx = 0;
  for (const city of meta.cities) {
    idx++;
    logger.info(`İl taranıyor: ${city.name} (${idx}/${meta.cities.length})`);
    const html = await postSearch(session, city.id, '', donemId);
    await sleep(REQUEST_SLEEP);
    if (html === null) continue;
    const found = parseIdCards(html);
    const n = Object.keys(found).length;
    if (!n) logger.warn(`  ${city.name} için 0 vekil ayrıştırıldı.`);
    Object.assign(mapping, found);

    if (n === MAKS_SONUC && meta.parties.length) {
      logger.info(`  ${city.name}: ${MAKS_SONUC} = kesilmiş → parti parti taranıyor`);
      for (const party of meta.parties) {
        const ph = await postSearch(session, city.id, party.id, donemId);
        await sleep(REQUEST_SLEEP);
        if (ph === null) continue;
        const pf = parseIdCards(ph, party.name);
        const pn = Object.keys(pf).length;
        if (pn) logger.info(`    ${party.name}: ${pn} vekil`);
        if (pn === MAKS_SONUC) logger.warn(`    ⚠️ ${city.name}/${party.name}: parti kırılımında da ${MAKS_SONUC} → HÂLÂ KESİK`);
        Object.assign(mapping, pf);
      }
    } else {
      logger.info(`  ${n} vekil`);
    }
    saveIds(mapping);
  }
  return mapping;
}

const MAKS_SONUC = 50;

async function modeMaster(session: Session, meta: Metadata, donemOverride?: string | null): Promise<MasterRecord[]> {
  let terms = meta.terms;
  const parties = meta.parties;
  const cities = meta.cities;
  if (donemOverride) {
    terms = terms.filter((t) => t.id === donemOverride);
    if (!terms.length) logger.warn(`--donem ${donemOverride} form'daki dönemlerle eşleşmedi; master boş dönecek.`);
  }
  if (!(terms.length && parties.length)) {
    logger.error('Dönem veya parti listesi boş — master modu çalışamaz.');
    return [];
  }
  if (!cities.length) {
    logger.error('İl listesi boş — 50-kesme onarımı yapılamaz, parti sayıları yanlı olurdu. Durduruldu.');
    return [];
  }
  const master: MasterRecord[] = [];
  const seen = new Set<string>();
  const total = terms.length * parties.length;
  let step = 0;

  const adaslar: string[] = [];
  const topla = (html: string | null, termName: string, partyName: string): number => {
    if (html === null) return -1;
    const kartlar = parseMasterCards(html, termName, partyName);
    for (const dep of kartlar) {
      const key = `${dep.ad_soyad}-${dep.donem}-${dep.il}`;
      if (!seen.has(key)) {
        if ([...seen].some((k) => k.startsWith(`${dep.ad_soyad}-${dep.donem}-`))) {
          adaslar.push(`${dep.ad_soyad} (d${dep.donem}) — ${dep.il}/${dep.parti}`);
        }
        seen.add(key);
        master.push(dep);
      }
    }
    return kartlar.length;
  };

  for (const term of terms) {
    logger.info(`--- ${term.name}. Dönem taraması ---`);
    let kesikKaldi = 0;
    for (const party of parties) {
      step++;
      const n = topla(await postSearch(session, '', party.id, term.id), term.name, party.name);
      await sleep(300);

      if (n === MAKS_SONUC) {
        logger.info(`  ${term.name}/${party.name}: ${MAKS_SONUC} = kesilmiş → il il taranıyor (${cities.length} il)`);
        for (const city of cities) {
          const m = topla(await postSearch(session, city.id, party.id, term.id), term.name, party.name);
          await sleep(300);
          if (m === MAKS_SONUC) {
            kesikKaldi++;
            logger.warn(`  ⚠️ ${term.name}/${party.name}/${city.name}: il kırılımında da ${MAKS_SONUC} → HÂLÂ KESİK`);
          }
        }
      }
      if (step % 20 === 0) logger.info(`İlerleme: ${step}/${total} istek | ${master.length} benzersiz vekil`);
    }
    const bu = master.filter((r) => r.donem === term.name);
    const dagilim = new Map<string, number>();
    for (const r of bu) dagilim.set(r.parti, (dagilim.get(r.parti) ?? 0) + 1);
    const ilk = [...dagilim.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([p, c]) => `${p}:${c}`).join(' · ');
    logger.info(`--- ${term.name}. Dönem: ${bu.length} vekil | ${ilk}`);
    if (kesikKaldi > 0) logger.warn(`⚠️ ${term.name}. dönemde ${kesikKaldi} sorgu hâlâ kesik — bu dönemin parti sayıları EKSİK, yayınlama.`);
    saveMaster(master);
  }
  logger.info(`Master liste tamamlandı: ${master.length} benzersiz vekil.`);
  if (adaslar.length) {
    logger.warn(`⚠️ ${adaslar.length} ADAŞ (aynı ad+dönem, farklı il) — ikisi de kaydedildi, ama ` +
                `il'siz çözümleme (resolveParty) bunları ayıramaz: ${adaslar.join(' | ')}`);
  }
  return master;
}

type Mode = 'full' | 'by-party' | 'by-province' | 'remaining' | 'master';
const MODES: Mode[] = ['full', 'by-party', 'by-province', 'remaining', 'master'];

export async function run(mode: Mode = 'full', donem: string | null = null): Promise<unknown> {
  if (!MODES.includes(mode)) throw new Error(`Bilinmeyen mod: ${mode}. Geçerli: ${MODES.join(', ')}`);

  logger.info(`=== Milletvekili taraması başladı (mod=${mode}) ===`);
  const session = new Session();
  const { csrf, html } = await initSession(session);
  if (!csrf) {
    logger.error('Canlı oturum açılamadı (CSRF alınamadı). Sonlandırılıyor.');
    return null;
  }
  session.csrf = csrf;

  const meta = loadMetadata(html);

  let result: Record<string, DeputyIdInfo> | MasterRecord[];
  if (mode === 'master') {
    result = await modeMaster(session, meta, donem);
  } else {
    const donemId = donem || resolveActiveDonem(meta.terms);
    const runner = { full: modeFull, 'by-party': modeByParty, 'by-province': modeByProvince, remaining: modeRemaining }[mode];
    result = await runner(session, meta, donemId);
  }
  const size = Array.isArray(result) ? result.length : Object.keys(result).length;
  logger.info(`=== Tamamlandı (mod=${mode}) — toplam kayıt: ${size} ===`);
  return result;
}

function parseArgs(argv: string[]): { mode: Mode; donem: string | null } {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const mode = (positional[0] as Mode) ?? 'full';
  let donem: string | null = null;
  const di = argv.indexOf('--donem');
  if (di >= 0 && argv[di + 1]) donem = argv[di + 1];
  return { mode, donem };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { mode, donem } = parseArgs(process.argv.slice(2));
  run(mode, donem).catch((e) => {
    logger.error((e as Error).message);
    process.exitCode = 1;
  });
}
