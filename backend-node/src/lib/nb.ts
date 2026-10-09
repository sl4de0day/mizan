import { existsSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { STORAGE_DIR } from './config.js';
import { getLogger } from './logger.js';

const logger = getLogger('PoliticalInsight.NB');
export const MODEL_VERSION = 1;
export const MODEL_PATH = join(STORAGE_DIR, 'topic-model.json');

function trLower(s: string): string {
  return s.replace(/İ/g, 'i').replace(/I/g, 'ı').toLowerCase();
}

const TR_BASE =
  've veya ile ama fakat çünkü ki da de ise ya hem ne gibi için kadar göre sonra önce üzere dolayı rağmen ancak yani her bir bu şu o bunlar şunlar onlar ben sen biz siz kim hangi nasıl neden çok daha en az hiç tüm bütün bazı kendi şey olan olarak olur oldu var yok değil mi mı mu mü evet hayır işte artık henüz halen zaten ve ayrıca hatta yine bile ise diye şöyle böyle öyle burada orada şimdi bugün';
const MECLIS_USUL =
  'sayın başkan başkanı başkanlık teşekkür arkadaşlar arkadaşım değerli milletvekili milletvekilleri vekil grup genel kurul söz kürsü madde önerge teklif kanun tasarı görüşme oturum birleşim tutanak gündem oylama kabul ret lütfen biliyorsunuz efendim hepimiz huzur kıymetli muhterem saygı selam buyurun alkış gülüşme kayıt tespit ifade konuşma hatip söylüyorum ediyorum ederim dedi diyor cumhuriyet meclis';
const STOPWORDS = new Set([...TR_BASE.split(/\s+/), ...MECLIS_USUL.split(/\s+/)].map(trLower).filter(Boolean));

export interface NBParams {
  prefix: number;
  alpha: number;
  priorBeta: number;
  minDf: number;
  tauShort: number;
  tauLong: number;
  coverMin: number;
  targetPrec: number;
  partiAgirlik: boolean;
}
export const DEFAULT_PARAMS: NBParams = {
  prefix: 7, alpha: 0.1, priorBeta: 0.3, minDf: 3,
  tauShort: 0.31, tauLong: 0.4, coverMin: 0.15, targetPrec: 0.85,
  partiAgirlik: false,
};

export interface TopicModel {
  modelVersion: number;
  taxonomyVersion: number;
  trainedAt: string;
  trainDocs: number;
  heldoutMicro?: number;
  heldoutMacro?: number;
  yanlilikMaxPP?: number;
  heldoutFrom?: 'train-fold';
  params: NBParams;
  categories: string[];
  logPrior: number[];
  logFloor: number[];
  vocab: string[];
  weights: Record<number, Record<number, number>>;
}

export interface ClassifyNBResult {
  cat: string;
  decided: boolean;
  normMargin: number;
  cover: number;
  scoreTop: number;
}

export function tokenize(text: string, prefix = DEFAULT_PARAMS.prefix): string[] {
  const low = trLower(text || '');
  const raw = low.match(/[\p{L}\p{N}_]+/gu) || [];
  const out: string[] = [];
  for (const t of raw) {
    if (t.length < 2) continue;
    if (/^\d+$/.test(t)) continue;
    if (STOPWORDS.has(t)) continue;
    out.push(t.slice(0, prefix));
  }
  return out;
}

export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
export function splitFold(normText: string): number {
  return fnv1a(normText) % 100;
}
export function normText(s: string): string {
  return trLower(s || '').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

interface RuntimeModel {
  m: TopicModel;
  vocabIdx: Map<string, number>;
  W: Float32Array[];
}
function toRuntime(m: TopicModel): RuntimeModel {
  const V = m.vocab.length;
  const vocabIdx = new Map<string, number>();
  for (let i = 0; i < V; i++) vocabIdx.set(m.vocab[i]!, i);
  const W: Float32Array[] = [];
  for (let k = 0; k < m.categories.length; k++) {
    const arr = new Float32Array(V).fill(m.logFloor[k]!);
    const wk = m.weights[k] || {};
    for (const vi in wk) arr[+vi] = wk[vi]!;
    W.push(arr);
  }
  return { m, vocabIdx, W };
}

export function classifyNBRuntime(text: string, rt: RuntimeModel, aggressive = false): ClassifyNBResult {
  const { m, vocabIdx, W } = rt;
  const toks = tokenize(text, m.params.prefix);
  const counts = new Map<number, number>();
  let L = 0;
  for (const t of toks) {
    const vi = vocabIdx.get(t);
    if (vi === undefined) continue;
    counts.set(vi, (counts.get(vi) || 0) + 1);
    L++;
  }
  if (L === 0) return { cat: 'Diğer', decided: false, normMargin: 0, cover: 0, scoreTop: -Infinity };
  const K = m.categories.length;
  const score = new Array<number>(K);
  for (let k = 0; k < K; k++) {
    let s = m.logPrior[k]!;
    const wk = W[k]!;
    for (const [vi, c] of counts) s += c * wk[vi]!;
    score[k] = s;
  }
  let i1 = 0, i2 = -1;
  for (let k = 1; k < K; k++) if (score[k]! > score[i1]!) i1 = k;
  for (let k = 0; k < K; k++) if (k !== i1 && (i2 < 0 || score[k]! > score[i2]!)) i2 = k;
  const s1 = score[i1]!, s2 = i2 >= 0 ? score[i2]! : s1;
  const normMargin = (s1 - s2) / L;
  const cover = L / Math.max(toks.length, 1);
  const p = m.params;
  let decided: boolean;
  if (aggressive) {
    decided = normMargin >= 0.03;
  } else {
    const isShort = toks.length <= 4;
    decided = isShort ? normMargin >= p.tauShort : normMargin >= p.tauLong && cover >= p.coverMin;
  }
  return { cat: m.categories[i1]!, decided, normMargin, cover, scoreTop: s1 };
}

let _rt: RuntimeModel | null = null;
let _mtime = 0;
let _checkedAt = 0;
export function getModel(): RuntimeModel | null {
  const now = Date.now();
  if (_rt && now - _checkedAt < 60000) return _rt;
  _checkedAt = now;
  if (!existsSync(MODEL_PATH)) { _rt = null; return null; }
  try {
    const mt = statSync(MODEL_PATH).mtimeMs;
    if (_rt && mt === _mtime) return _rt;
    const m = JSON.parse(readFileSync(MODEL_PATH, 'utf-8')) as TopicModel;
    if (m.modelVersion !== MODEL_VERSION) { logger.info(`model versiyon uyumsuz (${m.modelVersion}≠${MODEL_VERSION}) → keyword`); _rt = null; return null; }
    _rt = toRuntime(m);
    _mtime = mt;
    return _rt;
  } catch (e) {
    logger.error(`model yükleme hatası: ${(e as Error).message}`);
    _rt = null;
    return null;
  }
}
export function classifyNB(text: string, aggressive = false): ClassifyNBResult | null {
  const rt = getModel();
  return rt ? classifyNBRuntime(text, rt, aggressive) : null;
}

export function modelKategorileri(): ReadonlySet<string> {
  const rt = getModel();
  return new Set(rt?.m.categories ?? []);
}
export function invalidateModel(): void { _rt = null; _mtime = 0; _checkedAt = 0; }

export interface LabeledDoc { text: string; cat: string; splitKey: string; parti?: string | null }

export interface TrainReport {
  micro: number; macro: number; digerPct: number;
  perCat: Record<string, { n: number; recall: number; precision: number }>;
  confusion: string[];
  trainDocs: number; heldoutDocs: number; vocab: number;
  perParti: Record<string, { n: number; gozlenen: number; beklenen: number; artik: number }>;
  yanlilikMaxPP: number;
}

const YANLILIK_MIN_N = 200;

export function lopoArtiklar(
  preds: { truth: string; parti: string | null | undefined; ok: boolean }[],
): { perParti: TrainReport['perParti']; yanlilikMaxPP: number } {
  const partili = preds.filter((p) => p.parti);
  const perParti: TrainReport['perParti'] = {};
  const partiler = [...new Set(partili.map((p) => p.parti!))];

  for (const P of partiler) {
    const bizim = partili.filter((p) => p.parti === P);
    if (bizim.length < YANLILIK_MIN_N) continue;
    const gozlenen = (100 * bizim.filter((p) => p.ok).length) / bizim.length;

    let beklenen = 0;
    for (const c of new Set(bizim.map((p) => p.truth))) {
      const karisim = bizim.filter((p) => p.truth === c).length / bizim.length;
      const digerleri = partili.filter((p) => p.truth === c && p.parti !== P);
      if (!digerleri.length) continue;
      beklenen += karisim * ((100 * digerleri.filter((p) => p.ok).length) / digerleri.length);
    }
    const yuvarla = (v: number): number => Math.round(v * 10) / 10;
    perParti[P] = {
      n: bizim.length, gozlenen: yuvarla(gozlenen), beklenen: yuvarla(beklenen),
      artik: yuvarla(gozlenen - beklenen),
    };
  }
  const artiklar = Object.values(perParti).map((x) => Math.abs(x.artik));
  return { perParti, yanlilikMaxPP: artiklar.length ? Math.round(Math.max(...artiklar) * 10) / 10 : 0 };
}

interface Counts { docCount: number[]; N: number[]; cnt: Map<number, number>[]; }
function partiAgirliklari(docs: LabeledDoc[]): Map<LabeledDoc, number> {
  const hucre = new Map<string, number>();
  for (const d of docs) if (d.parti) hucre.set(`${d.cat}|${d.parti}`, (hucre.get(`${d.cat}|${d.parti}`) ?? 0) + 1);

  const w = new Map<LabeledDoc, number>();
  for (const c of new Set(docs.map((d) => d.cat))) {
    const bu = docs.filter((d) => d.cat === c);
    const ham = bu.map((d) => (d.parti ? 1 / (hucre.get(`${c}|${d.parti}`) ?? 1) : 1));
    const toplam = ham.reduce((a, b) => a + b, 0) || 1;
    const olcek = bu.length / toplam;
    bu.forEach((d, i) => w.set(d, ham[i]! * olcek));
  }
  return w;
}

function buildCounts(
  docs: LabeledDoc[], cats: string[], vocabIdx: Map<string, number>, prefix: number,
  agirlik?: Map<LabeledDoc, number>,
): Counts {
  const K = cats.length;
  const catIdx = new Map(cats.map((c, i) => [c, i]));
  const docCount = new Array(K).fill(0);
  const N = new Array(K).fill(0);
  const cnt: Map<number, number>[] = Array.from({ length: K }, () => new Map());
  for (const d of docs) {
    const k = catIdx.get(d.cat);
    if (k === undefined) continue;
    const w = agirlik?.get(d) ?? 1;
    docCount[k]++;
    for (const t of tokenize(d.text, prefix)) {
      const vi = vocabIdx.get(t);
      if (vi === undefined) continue;
      cnt[k]!.set(vi, (cnt[k]!.get(vi) || 0) + w);
      N[k] += w;
    }
  }
  return { docCount, N, cnt };
}
function buildModel(docs: LabeledDoc[], cats: string[], vocab: string[], vocabIdx: Map<string, number>, p: NBParams): TopicModel {
  const { docCount, N, cnt } = buildCounts(docs, cats, vocabIdx, p.prefix,
    p.partiAgirlik ? partiAgirliklari(docs) : undefined);
  const V = vocab.length;
  const totalDocs = docCount.reduce((a, b) => a + b, 0) || 1;
  const logPrior = docCount.map((dc) => p.priorBeta * Math.log((dc || 1) / totalDocs));
  const logFloor = N.map((nk) => Math.log(p.alpha / (nk + p.alpha * V)));
  const weights: Record<number, Record<number, number>> = {};
  for (let k = 0; k < cats.length; k++) {
    const wk: Record<number, number> = {};
    for (const [vi, c] of cnt[k]!) wk[vi] = Math.round(Math.log((c + p.alpha) / (N[k]! + p.alpha * V)) * 1000) / 1000;
    weights[k] = wk;
  }
  return {
    modelVersion: MODEL_VERSION, taxonomyVersion: 0, trainedAt: new Date().toISOString(),
    trainDocs: docs.length, params: p, categories: cats, logPrior, logFloor, vocab, weights,
  };
}

export function trainNB(docs: LabeledDoc[], params: Partial<NBParams> = {}): { model: TopicModel; report: TrainReport } {
  const p = { ...DEFAULT_PARAMS, ...params };
  const cats = [...new Set(docs.map((d) => d.cat))].sort();
  const train = docs.filter((d) => splitFold(d.splitKey) >= 20);
  const held = docs.filter((d) => splitFold(d.splitKey) < 20);
  const df = new Map<string, number>();
  for (const d of train) {
    const seen = new Set<string>();
    for (const t of tokenize(d.text, p.prefix)) if (!seen.has(t)) { seen.add(t); df.set(t, (df.get(t) || 0) + 1); }
  }
  const vocab = [...df.entries()].filter(([, c]) => c >= p.minDf).map(([w]) => w).sort();
  const vocabIdx = new Map(vocab.map((w, i) => [w, i]));
  const trainModel = buildModel(train, cats, vocab, vocabIdx, p);
  const rt = toRuntime(trainModel);
  const preds = held.map((d) => ({ truth: d.cat, parti: d.parti, r: classifyNBRuntime(d.text, rt) }));
  const grid: number[] = [];
  for (let t = 0.1; t <= 2.0; t += 0.05) grid.push(Math.round(t * 100) / 100);
  const calib = (isShortSet: boolean) => {
    let best = isShortSet ? p.tauShort : p.tauLong;
    for (const t of grid) {
      let tp = 0, fp = 0;
      for (const pr of preds) {
        const dec = pr.r.normMargin >= t && (isShortSet || pr.r.cover >= p.coverMin);
        if (!dec) continue;
        if (pr.r.cat === pr.truth) tp++; else fp++;
      }
      if (tp + fp >= 20 && tp / (tp + fp) >= p.targetPrec) { best = t; break; }
    }
    return best;
  };
  p.tauShort = calib(true);
  p.tauLong = calib(false);
  const K = cats.length;
  const catN: Record<string, number> = {}, catOk: Record<string, number> = {}, predN: Record<string, number> = {};
  const conf = new Map<string, number>();
  let micro = 0;
  for (const pr of preds) {
    catN[pr.truth] = (catN[pr.truth] || 0) + 1;
    predN[pr.r.cat] = (predN[pr.r.cat] || 0) + 1;
    if (pr.r.cat === pr.truth) { micro++; catOk[pr.truth] = (catOk[pr.truth] || 0) + 1; }
    else conf.set(`${pr.truth} → ${pr.r.cat}`, (conf.get(`${pr.truth} → ${pr.r.cat}`) || 0) + 1);
  }
  const perCat: TrainReport['perCat'] = {};
  let macroSum = 0;
  for (const c of cats) {
    const recall = catN[c] ? (catOk[c] || 0) / catN[c]! : 0;
    const precision = predN[c] ? (catOk[c] || 0) / predN[c]! : 0;
    perCat[c] = { n: catN[c] || 0, recall: Math.round(recall * 1000) / 10, precision: Math.round(precision * 1000) / 10 };
    macroSum += recall;
  }
  const digerPred = preds.filter((pr) => !pr.r.decided).length;
  const { perParti, yanlilikMaxPP } = lopoArtiklar(
    preds.map((pr) => ({ truth: pr.truth, parti: pr.parti, ok: pr.r.cat === pr.truth })),
  );
  const report: TrainReport = {
    micro: Math.round((micro / (held.length || 1)) * 1000) / 10,
    macro: Math.round((macroSum / K) * 1000) / 10,
    digerPct: Math.round((digerPred / (held.length || 1)) * 1000) / 10,
    perCat,
    confusion: [...conf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => `${k}: ${n}`),
    trainDocs: train.length, heldoutDocs: held.length, vocab: vocab.length,
    perParti, yanlilikMaxPP,
  };
  const finalModel = buildModel(docs, cats, vocab, vocabIdx, p);
  finalModel.heldoutMicro = report.micro;
  finalModel.heldoutMacro = report.macro;
  finalModel.yanlilikMaxPP = report.yanlilikMaxPP;
  finalModel.heldoutFrom = 'train-fold';
  return { model: finalModel, report };
}

export function saveModel(m: TopicModel): void {
  const tmp = MODEL_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(m), 'utf-8');
  renameSync(tmp, MODEL_PATH);
  invalidateModel();
}
export function loadModelFile(): TopicModel | null {
  if (!existsSync(MODEL_PATH)) return null;
  try { return JSON.parse(readFileSync(MODEL_PATH, 'utf-8')) as TopicModel; } catch { return null; }
}
