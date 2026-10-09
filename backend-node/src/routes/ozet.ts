import type { FastifyInstance } from 'fastify';
import { getDb, getEtlDurum, komisyonNorm, aramaLogYaz } from '../lib/db.js';
import { aykiriAyikla, BOSLUK_GUN } from '../lib/tarihYardimci.js';
import { CATEGORY_NAMES, OTHER_CATEGORY, trLower } from '../lib/taxonomy.js';
import { getLogger } from '../lib/logger.js';
import { PARTI_DISI, cleanStr, normParti } from '../lib/partyResolve.js';
import { DEPUTY_MASTER_LIST } from '../lib/deputies.js';
import {
  kanunAtiflari, torbaKararMi, esastanMi, rgSayiNorm, esasKararAnahtari,
  AYM_SONUC_ETIKET, AYM_BASVURU_ETIKET,
} from '../lib/aymKopru.js';
import { muhatapKurumHaritasi } from './onergeStats.js';
import { YEREL_YONETIM_BELEDIYELERI } from '../engines/yerelYonetim.js';
import { SANDALYE_PDF, TARIHSEL_SECIM_PDF } from '../engines/ysk.js';

const logger = getLogger('PoliticalInsight.Ozet');

export function kaynakSayimi(t: string, tarihKol: string): { kayit: number; son: string | null } {
  try {
    const r = getDb().prepare(`SELECT COUNT(*) c, MAX(${tarihKol}) son FROM ${t}`).get() as { c: number; son: string | null };
    return { kayit: r.c, son: r.son };
  } catch { return { kayit: 0, son: null }; }
}

const ALL_CATEGORIES = [...CATEGORY_NAMES, OTHER_CATEGORY];

const sqlListesi = (s: ReadonlySet<string>): string =>
  `(${[...s].map((v) => `'${v.replace(/'/g, "''")}'`).join(',')})`;
const PARTI_DISI_SQL = sqlListesi(PARTI_DISI);
const partiDisiMi = (p?: string | null): boolean => !p || PARTI_DISI.has(p);

const AKTIF_DONEM = 28;

export const KATILMADI_NOTU =
  '“Katılmadı”, açık oylama cetvelinin oy kullanmayan vekiller için kullandığı TEK ibaredir: '
  + 'salonda bulunup oy kullanmamak, izinli/görevli olmak ve oylamaya bilinçli girmemek bu başlık '
  + 'altında ayrılmaz. Devamsızlık ya da katılım ölçüsü olarak okunamaz.';

function tutanakUrl(birlesimId: string | null): string | null {
  return birlesimId ? `https://www.tbmm.gov.tr/Tutanaklar/Tutanak?Id=${birlesimId}` : null;
}

function konusmaKismiMi(donem: number): boolean {
  return getEtlDurum().some((r) => r.kaynak === 'konusma' && r.donem === donem && r.durum === 'kismi');
}
function konusmaKaliteNotu(q: { donem?: string }): string | null {
  if (q.donem === 'hepsi' || q.donem == null) return null;
  const d = Number(q.donem);
  if (!Number.isFinite(d) || !konusmaKismiMi(d)) return null;
  return 'Bu dönemin konuşma verisi eski Meclis arşiv tutanağından geliyor; tutanaktaki satır '
    + 'sarması nedeniyle konuşmacıların bir bölümü kesin olarak partiye bağlanamadı. Konuşma '
    + '(söz) bazlı parti payları VE arama sonucundaki parti dağılımı bu dönemde EKSİK olabilir — '
    + 'kanun ve önerge verileri etkilenmez.';
}

function donemKos(q: { donem?: string }, alias = 'f'): { sql: string; params: number[] } {
  if (q.donem === 'hepsi') return { sql: '', params: [] };
  const ham = String(q.donem ?? '');
  if (ham.includes(',')) {
    const list = ham.split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 0);
    if (list.length) return { sql: ` AND ${alias}.donem IN (${list.map(() => '?').join(',')})`, params: list };
  }
  const d = Number(q.donem);
  return { sql: ` AND ${alias}.donem = ?`, params: [Number.isFinite(d) && d > 0 ? d : AKTIF_DONEM] };
}

const ARAMA_MAX_KELIME = 6;
const ARAMA_MIN_KELIME_UZUNLUK = 2;

function kelimelereBol(terim: string): string[] {
  let kelimeler = terim.trim().split(/\s+/)
    .map(trLower)
    .filter((w) => w.length >= ARAMA_MIN_KELIME_UZUNLUK);
  if (!kelimeler.length) kelimeler = [trLower(terim.trim())];
  return kelimeler.slice(0, ARAMA_MAX_KELIME);
}

function aramaKosulu(terim: string): { sql: string; params: string[]; kelimeler: string[] } {
  const kelimeler = kelimelereBol(terim);
  return {
    sql: kelimeler.map(() => 'f.baslik_norm LIKE ?').join(' AND '),
    params: kelimeler.map((w) => `%${w}%`),
    kelimeler,
  };
}

function aramaKosuluIfade(terim: string, kolonIfade: string): { sql: string; params: string[]; kelimeler: string[] } {
  const kelimeler = kelimelereBol(terim);
  return {
    sql: kelimeler.map(() => `tr_lower(${kolonIfade}) LIKE ?`).join(' AND '),
    params: kelimeler.map((w) => `%${w}%`),
    kelimeler,
  };
}

interface EtiketKapi {
  yayimlanabilir: boolean; altin: number; toplam: number; altinPay: number; sebep?: string;
  kaynaklar?: { kaynak: string; toplam: number; altin: number; pay: number }[];
  kaynak_uyarisi?: string | null;
}

export function etiketKapisi(q: { donem?: string }): EtiketKapi {
  if (q.donem === 'hepsi') {
    const perD = getDb()
      .prepare(
        `SELECT f.donem, COUNT(*) AS toplam, SUM(CASE WHEN f.kategori_kaynagi='muhatap' THEN 1 ELSE 0 END) AS altin
           FROM faaliyet f JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
          WHERE fp.parti NOT IN ${PARTI_DISI_SQL} AND f.kaynak IN ('kanun','onerge')
          GROUP BY f.donem`,
      )
      .all() as { donem: number; toplam: number; altin: number }[];
    const kotu = perD.filter((d) => d.toplam > 0 && d.altin === 0).map((d) => d.donem);
    const toplam = perD.reduce((s, d) => s + d.toplam, 0);
    const altin = perD.reduce((s, d) => s + d.altin, 0);
    const altinPay = toplam > 0 ? (100 * altin) / toplam : 0;
    if (kotu.length === 0) return { yayimlanabilir: true, altin, toplam, altinPay };
    return {
      yayimlanabilir: false, altin, toplam, altinPay,
      sebep: `Çok-dönem (hepsi) parti–konu payı yayımlanamıyor: ${kotu.map((d) => d + '. dönem').join(', ')} `
           + `için doğrulanacak altın etiket yok (konu etiketleri model tahmini). Farklı dönemlerin `
           + `havuzlanması hem doğrulanamayan payları taşır hem de dönem ağırlıkları farklı olduğu için `
           + `(Simpson paradoksu) yanıltıcıdır. Dönem seçip bakın.`,
    };
  }
  const dk = donemKos(q);
  const r = getDb()
    .prepare(
      `SELECT COUNT(*) AS toplam, SUM(CASE WHEN f.kategori_kaynagi='muhatap' THEN 1 ELSE 0 END) AS altin
         FROM faaliyet f JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
        WHERE fp.parti NOT IN ${PARTI_DISI_SQL} AND f.kaynak IN ('kanun','onerge')${dk.sql}`,
    )
    .get(...dk.params) as { toplam: number; altin: number };
  const toplam = r?.toplam ?? 0;
  const altin = r?.altin ?? 0;
  const altinPay = toplam > 0 ? (100 * altin) / toplam : 0;

  const kaynakKirilim = getDb()
    .prepare(
      `SELECT f.kaynak AS kaynak, COUNT(*) AS toplam,
              SUM(CASE WHEN f.kategori_kaynagi='muhatap' THEN 1 ELSE 0 END) AS altin
         FROM faaliyet f JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
        WHERE fp.parti NOT IN ${PARTI_DISI_SQL} AND f.kaynak IN ('kanun','onerge')${dk.sql}
        GROUP BY f.kaynak`,
    )
    .all(...dk.params) as { kaynak: string; toplam: number; altin: number }[];
  const kaynaklar = kaynakKirilim.map((x) => ({
    ...x, pay: x.toplam > 0 ? Number(((100 * x.altin) / x.toplam).toFixed(1)) : 0,
  }));
  const altinsiz = kaynaklar.filter((x) => x.toplam > 0 && x.altin === 0);
  const kaynakUyarisi = altinsiz.length && altin > 0
    ? `Doğrulanabilirlik BELGE TÜRÜNE GÖRE DEĞİŞİR: `
      + kaynaklar.map((x) => `${x.kaynak === 'onerge' ? 'önerge' : 'kanun teklifi'} %${x.pay}`).join(' · ')
      + `. Altın etiket belgenin muhatap bakanlığından türetilir; kanun teklifinin muhatabı YOKTUR, `
      + `bu yüzden kanun teklifi etiketleri doğrulanamaz ve doğrulanamayacaktır. `
      + `${altinsiz.reduce((n, x) => n + x.toplam, 0).toLocaleString('tr-TR')} belge bu durumda.`
    : null;

  if (altin > 0 || toplam === 0) {
    return { yayimlanabilir: true, altin, toplam, altinPay, kaynaklar, kaynak_uyarisi: kaynakUyarisi };
  }
  return {
    yayimlanabilir: false, altin, toplam, altinPay,
    sebep: 'Bu dönemde konu etiketlerinin tamamı model tahmini; doğrulanacak altın etiket (belge '
         + 'muhatabından türetilen kesin kategori) yok. Sınıflandırıcının bu dönemdeki hatası '
         + 'ÖLÇÜLEMEDİĞİ için parti–konu payları yayımlanmıyor. Toplam sayılar ve oy verisi '
         + 'sınıflandırıcıya dayanmadığı için etkilenmiyor.',
  };
}

const kapiYaniti = (k: EtiketKapi): Record<string, unknown> => ({
  success: true, yayimlanabilir: false, sebep: k.sebep,
  etiket_kaynagi: {
    altin: k.altin, toplam: k.toplam, altin_pay: Number(k.altinPay.toFixed(1)),
    kaynaklar: k.kaynaklar, kaynak_uyarisi: k.kaynak_uyarisi ?? null,
  },
});

export function donemPencere(q: { donem?: string }): { lo: string; hi: string } | null {
  if (q.donem === 'hepsi') return null;
  const dk = donemKos(q);
  const r = getDb()
    .prepare(`SELECT MIN(f.tarih) lo, MAX(f.tarih) hi FROM faaliyet f
              JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
              WHERE f.tarih IS NOT NULL AND fp.parti NOT IN ${PARTI_DISI_SQL}${dk.sql}`)
    .get(...dk.params) as { lo: string | null; hi: string | null };
  if (!r.lo || !r.hi) return null;
  const enEski = getDb()
    .prepare(`SELECT DISTINCT f.tarih t FROM faaliyet f JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
              WHERE f.tarih IS NOT NULL AND fp.parti NOT IN ${PARTI_DISI_SQL}${dk.sql}
              ORDER BY f.tarih LIMIT 20`)
    .all(...dk.params) as { t: string }[];
  return { lo: aykiriAyikla(enEski.map((x) => x.t)) ?? r.lo, hi: r.hi };
}

function oranHesap(i: number, r: number, k: number): number | null {
  return i + r + k ? Math.round(((i + k) / (i + r + k)) * 100) : null;
}

function buildRange(kaynak: string, bas: string, bit: string, donem?: string): { clause: string; params: (string | number)[] } {
  const cond: string[] = [];
  const params: (string | number)[] = [];
  const d = donemKos({ donem });
  if (d.sql) { cond.push(d.sql.replace(/^ AND /, '')); params.push(...d.params); }
  if (kaynak) {
    cond.push('f.kaynak = ?');
    params.push(kaynak);
  } else {
    cond.push("f.kaynak IN ('kanun','onerge')");
  }
  if (bas) {
    cond.push('f.ay >= ?');
    params.push(bas);
  }
  if (bit) {
    cond.push('f.ay <= ?');
    params.push(bit);
  }
  return { clause: cond.length ? ' AND ' + cond.join(' AND ') : '', params };
}

function catTotal(row: Record<string, number>): number {
  let t = 0;
  for (const c of ALL_CATEGORIES) t += row[c] ?? 0;
  return t;
}

export function registerOzetRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/ozet/')) return;
    const d = (req.query as { donem?: string } | undefined)?.donem;
    if (d == null || d === '' || d === 'hepsi') return;
    const bilinen = (getDb().prepare('SELECT DISTINCT donem FROM faaliyet WHERE donem IS NOT NULL').all() as { donem: number }[]).map((r) => String(r.donem));
    const parcalar = String(d).split(',').map((x) => x.trim()).filter((x) => x !== '');
    const gecersiz = parcalar.filter((p) => !bilinen.includes(p));
    if (!parcalar.length || gecersiz.length) {
      return reply.code(400).send({ success: false, error: `Bilinmeyen dönem: ${gecersiz.join(', ') || d}. Mevcut: ${bilinen.sort((a, b) => Number(b) - Number(a)).join(', ')} (veya 'hepsi', ya da virgülle "26,27").` });
    }
  });

  app.get('/api/ozet/konu-zaman', async (req) => {
    const q = (req.query ?? {}) as { parti?: string; baslangic?: string; bitis?: string; kaynak?: string; granularite?: string; donem?: string };
    const kapi = etiketKapisi(q);
    if (!kapi.yayimlanabilir) return kapiYaniti(kapi);
    const gran = q.granularite === 'yil' ? 'yil' : q.granularite === 'ceyrek' ? 'ceyrek' : 'ay';
    const bucket =
      gran === 'yil'
        ? 'substr(f.ay,1,4)'
        : gran === 'ceyrek'
          ? "substr(f.ay,1,4) || '-Q' || ((CAST(substr(f.ay,6,2) AS INTEGER)+2)/3)"
          : 'f.ay';
    const { clause, params } = buildRange(q.kaynak ?? '', q.baslangic ?? '', q.bitis ?? '', q.donem);
    const partiJoin = q.parti ? 'JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id AND fp.parti = ?' : '';
    const partiParams: (string | number)[] = q.parti ? [q.parti] : [];
    const rows = getDb()
      .prepare(
        `SELECT ${bucket} AS bucket, f.kategori AS kategori, COUNT(*) AS adet
         FROM faaliyet f ${partiJoin}
         WHERE f.ay IS NOT NULL${clause}
         GROUP BY bucket, f.kategori
         ORDER BY bucket`,
      )
      .all(...partiParams, ...params) as { bucket: string; kategori: string; adet: number }[];

    const byBucket = new Map<string, Record<string, number>>();
    for (const r of rows) {
      let o = byBucket.get(r.bucket);
      if (!o) {
        o = {};
        for (const c of ALL_CATEGORIES) o[c] = 0;
        byBucket.set(r.bucket, o);
      }
      if (ALL_CATEGORIES.includes(r.kategori)) o[r.kategori] += r.adet;
      else o[OTHER_CATEGORY] += r.adet;
    }
    const data = [...byBucket.entries()].map(([bucket, o]) => {
      const toplam = catTotal(o);
      const kategoriler: Record<string, { adet: number; yuzde: number }> = {};
      for (const c of ALL_CATEGORIES) {
        kategoriler[c] = { adet: o[c], yuzde: toplam ? Math.round((1000 * o[c]) / toplam) / 10 : 0 };
      }
      return { bucket, toplam, kategoriler };
    });
    return { success: true, parti: q.parti ?? null, granularite: gran, kategoriler: ALL_CATEGORIES, data };
  });

  const MAX_GUN = 4000;
  const gunAralik = (bas: string, bit: string): string[] => {
    const out: string[] = [];
    const d = new Date(bas + 'T00:00:00Z'), end = new Date(bit + 'T00:00:00Z');
    while (d <= end && out.length < MAX_GUN) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
    if (out.length >= MAX_GUN && d <= end) {
      logger.warn(`⚠️ gunAralik KIRPILDI: ${bas}→${bit} ${MAX_GUN} günü aşıyor; indeks ${out[out.length - 1]}'de bitti. `
                + `Bu aralıktaki sonraki veri GRAFİĞE GİRMEZ — çağıran dönem/tarih filtresi vermeli.`);
    }
    return out;
  };

  app.get('/api/ozet/parti-ay-konu', async (req) => {
    const q = (req.query ?? {}) as { kaynak?: string; baslangic?: string; bitis?: string; donem?: string };
    const kapi = etiketKapisi(q);
    const dk = donemKos(q);
    const kaynakSql = q.kaynak ? 'f.kaynak = ?' : "f.kaynak IN ('kanun','onerge')";
    const kaynakPar = q.kaynak ? [q.kaynak] : [];
    const mm = getDb()
      .prepare(
        `SELECT MIN(f.tarih) lo, MAX(f.tarih) hi FROM faaliyet f
         JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
         WHERE f.tarih IS NOT NULL AND fp.parti NOT IN ${PARTI_DISI_SQL} AND ${kaynakSql}${dk.sql}`,
      )
      .get(...kaynakPar, ...dk.params) as { lo: string | null; hi: string | null };
    const enEski = getDb()
      .prepare(
        `SELECT DISTINCT f.tarih t FROM faaliyet f JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
         WHERE f.tarih IS NOT NULL AND fp.parti NOT IN ${PARTI_DISI_SQL} AND ${kaynakSql}${dk.sql}
         ORDER BY f.tarih LIMIT 20`,
      )
      .all(...kaynakPar, ...dk.params) as { t: string }[];
    const temizLo = aykiriAyikla(enEski.map((r) => r.t));
    if (temizLo && mm.lo && temizLo !== mm.lo) {
      logger.info(`[parti-ay-konu] aykırı tarih ayıklandı: ${mm.lo} → ${temizLo} (aradaki boşluk >${BOSLUK_GUN} gün; `
                + `TBMM verisinde eski kanunun tarihi teklifin tarihi sanılıyor)`);
    }
    const bas = q.baslangic || temizLo || mm.lo || '2023-06-01';
    const bit = q.bitis || mm.hi || '2026-07-31';
    const gunler = gunAralik(bas, bit);
    const aylar: string[] = [];
    for (let k = 0; k < gunler.length; k += 7) aylar.push(gunler[k]);
    const cond = [`fp.parti NOT IN ${PARTI_DISI_SQL}`, 'f.tarih >= ?', 'f.tarih <= ?'];
    const params: (string | number)[] = [bas, bit];
    if (dk.sql) { cond.push(dk.sql.replace(/^ AND /, '')); params.push(...dk.params); }
    if (q.kaynak) { cond.push('f.kaynak = ?'); params.push(q.kaynak); }
    else { cond.push("f.kaynak IN ('kanun','onerge')"); }
    const rows = getDb()
      .prepare(
        `SELECT fp.parti AS parti, f.tarih AS gun, f.kategori AS kategori, COUNT(*) AS adet
         FROM faaliyet f JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
         WHERE ${cond.join(' AND ')}
         GROUP BY parti, gun, kategori`,
      )
      .all(...params) as { parti: string; gun: string; kategori: string; adet: number }[];

    const idx = new Map(gunler.map((dd, k) => [dd, Math.floor(k / 7)]));
    const seri: Record<string, Record<string, number[]>> = {};
    const partiToplam: Record<string, number> = {};
    for (const r of rows) {
      const i = idx.get(r.gun);
      if (i === undefined) continue;
      const cat = ALL_CATEGORIES.includes(r.kategori) ? r.kategori : OTHER_CATEGORY;
      (seri[r.parti] ??= {});
      (seri[r.parti][cat] ??= new Array(aylar.length).fill(0))[i] += r.adet;
      partiToplam[r.parti] = (partiToplam[r.parti] || 0) + r.adet;
    }
    const paydaCond = [`fp.parti NOT IN ${PARTI_DISI_SQL}`];
    const paydaParams: (string | number)[] = [];
    if (dk.sql) { paydaCond.push(dk.sql.replace(/^ AND /, '')); paydaParams.push(...dk.params); }
    if (q.kaynak) { paydaCond.push('f.kaynak = ?'); paydaParams.push(q.kaynak); }
    else { paydaCond.push("f.kaynak IN ('kanun','onerge')"); }
    const paydaRows = getDb()
      .prepare(
        `SELECT fp.parti AS parti, COUNT(*) AS adet,
                SUM(CASE WHEN f.tarih IS NULL THEN 1 ELSE 0 END) AS tarihsiz
           FROM faaliyet f JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
          WHERE ${paydaCond.join(' AND ')} GROUP BY parti`,
      )
      .all(...paydaParams) as { parti: string; adet: number; tarihsiz: number }[];
    const partiTarihsiz: Record<string, number> = {};
    for (const r of paydaRows) {
      partiToplam[r.parti] = r.adet;
      partiTarihsiz[r.parti] = r.tarihsiz;
      if (!seri[r.parti]) seri[r.parti] = {};
    }
    const partiler = Object.keys(seri).sort((a, b) => (partiToplam[b] ?? 0) - (partiToplam[a] ?? 0));
    return {
      success: true, aylar, kategoriler: ALL_CATEGORIES, partiler, partiToplam, parti_tarihsiz: partiTarihsiz,
      seri: kapi.yayimlanabilir ? seri : {},
      yayimlanabilir: kapi.yayimlanabilir,
      ...(kapi.yayimlanabilir ? {} : { sebep: kapi.sebep }),
      etiket_kaynagi: {
        altin: kapi.altin, toplam: kapi.toplam, altin_pay: Number(kapi.altinPay.toFixed(1)),
        kaynaklar: kapi.kaynaklar, kaynak_uyarisi: kapi.kaynak_uyarisi ?? null,
      },
      konu_etiket: Object.fromEntries(
        (
          getDb()
            .prepare(
              `SELECT f.kategori k, COUNT(*) toplam,
                 SUM(CASE WHEN f.kategori_kaynagi='muhatap' THEN 1 ELSE 0 END) altin
               FROM faaliyet f
               WHERE f.kaynak IN ('kanun','onerge') AND f.kategori IS NOT NULL${dk.sql}
               GROUP BY f.kategori`,
            )
            .all(...dk.params) as { k: string; toplam: number; altin: number }[]
        ).map((r) => [r.k, { altin: r.altin, toplam: r.toplam, altin_pay: r.toplam ? Number(((100 * r.altin) / r.toplam).toFixed(1)) : 0 }]),
      ),
    };
  });

  app.get('/api/ozet/ortak-imza', async (req) => {
    const q = (req.query ?? {}) as { donem?: string };
    const dk = donemKos(q);
    const rows = getDb()
      .prepare(`SELECT i.faaliyet_id AS fid, i.parti, i.ilk_imza AS ilk
                FROM imza i JOIN faaliyet f ON f.id = i.faaliyet_id
                WHERE 1=1${dk.sql}`)
      .all(...dk.params) as { fid: number; parti: string; ilk: number }[];
    const byBill = new Map<number, { parti: string; ilk: number }[]>();
    for (const r of rows) {
      let arr = byBill.get(r.fid);
      if (!arr) { arr = []; byBill.set(r.fid, arr); }
      arr.push({ parti: r.parti, ilk: r.ilk });
    }
    const matris: Record<string, Record<string, number>> = {};
    const satirToplam: Record<string, number> = {};
    const partiSet = new Set<string>();
    let toplamTeklif = 0;
    for (const sigs of byBill.values()) {
      const first = sigs.find((s) => s.ilk) ?? sigs[0];
      const A = first.parti;
      if (partiDisiMi(A)) continue;
      satirToplam[A] = (satirToplam[A] || 0) + 1;
      partiSet.add(A);
      toplamTeklif++;
      const others = new Set<string>();
      for (const s of sigs) {
        if (s === first) continue;
        if (partiDisiMi(s.parti)) continue;
        others.add(s.parti);
      }
      matris[A] ??= {};
      for (const B of others) { matris[A][B] = (matris[A][B] || 0) + 1; partiSet.add(B); }
    }
    const partiler = [...partiSet].sort(
      (a, b) => (satirToplam[b] || 0) - (satirToplam[a] || 0) || a.localeCompare(b, 'tr'),
    );
    return { success: true, kaynak: 'kanun', partiler, matris, satirToplam, toplamTeklif };
  });

  app.get('/api/ozet/ortak-imza-zaman', async (req) => {
    const q = (req.query ?? {}) as { parti?: string; donem?: string };
    const A = q.parti;
    if (!A) return { success: false, error: 'parti gerekli' };
    const db = getDb();
    const dkI = donemKos(q);
    const mm = db.prepare(`SELECT MIN(tarih) lo, MAX(tarih) hi FROM faaliyet f WHERE tarih IS NOT NULL${dkI.sql}`)
      .get(...dkI.params) as { lo: string | null; hi: string | null };
    const bas = mm.lo || '2023-06-01', bit = mm.hi || '2026-07-31';
    const gunler = gunAralik(bas, bit);
    const aylar: string[] = [];
    for (let k = 0; k < gunler.length; k += 7) aylar.push(gunler[k]);
    const idx = new Map(gunler.map((dd, k) => [dd, Math.floor(k / 7)]));
    const rows = db.prepare(
      `SELECT i.faaliyet_id AS fid, f.tarih AS gun, i.parti AS parti, i.ilk_imza AS ilk
       FROM imza i JOIN faaliyet f ON f.id = i.faaliyet_id
       WHERE f.tarih IS NOT NULL${dkI.sql}
         AND i.faaliyet_id IN (SELECT faaliyet_id FROM imza WHERE ilk_imza = 1 AND parti = ?)`,
    ).all(...dkI.params, A) as { fid: number; gun: string; parti: string; ilk: number }[];
    const byBill = new Map<number, { ay: string; sigs: { parti: string; ilk: number }[] }>();
    for (const r of rows) {
      let o = byBill.get(r.fid);
      if (!o) { o = { ay: r.gun, sigs: [] }; byBill.set(r.fid, o); }
      o.sigs.push({ parti: r.parti, ilk: r.ilk });
    }
    const seri: Record<string, number[]> = {};
    const partiToplam: Record<string, number> = {};
    const teklifAy = new Array(aylar.length).fill(0);
    let toplamTeklif = 0;
    for (const { ay, sigs } of byBill.values()) {
      const i = idx.get(ay);
      if (i === undefined) continue;
      toplamTeklif++;
      teklifAy[i] += 1;
      const first = sigs.find((s) => s.ilk) ?? sigs[0];
      const others = new Set<string>();
      for (const s of sigs) { if (s === first) continue; if (partiDisiMi(s.parti)) continue; others.add(s.parti); }
      for (const B of others) { (seri[B] ??= new Array(aylar.length).fill(0))[i] += 1; partiToplam[B] = (partiToplam[B] || 0) + 1; }
    }
    const partiler = Object.keys(seri).sort((a, b) => partiToplam[b] - partiToplam[a]);
    return { success: true, parti: A, aylar, partiler, seri, partiToplam, teklifAy, toplamTeklif };
  });

  app.get('/api/ozet/karsilastir', async (req) => {
    const q = (req.query ?? {}) as { partiler?: string; baslangic?: string; bitis?: string; donem?: string };
    const kapi = etiketKapisi(q);
    if (!kapi.yayimlanabilir) return kapiYaniti(kapi);
    const partiler = (q.partiler ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 6);
    if (!partiler.length) return { success: false, error: 'partiler gerekli (virgülle ayrık)' };

    const { clause, params } = buildRange('', q.baslangic ?? '', q.bitis ?? '', q.donem);
    const placeholders = partiler.map(() => '?').join(',');
    const rows = getDb()
      .prepare(
        `SELECT fp.parti AS parti, f.kaynak AS kaynak, f.kategori AS kategori, COUNT(*) AS adet
         FROM faaliyet f JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
         WHERE fp.parti IN (${placeholders})${clause}
         GROUP BY fp.parti, f.kaynak, f.kategori`,
      )
      .all(...partiler, ...params) as { parti: string; kaynak: string; kategori: string; adet: number }[];

    const byParti = new Map<string, { parti: string; kategoriler: Record<string, number>; kanun: number; onerge: number; toplam: number }>();
    for (const p of partiler) {
      const kategoriler: Record<string, number> = {};
      for (const c of ALL_CATEGORIES) kategoriler[c] = 0;
      byParti.set(p, { parti: p, kategoriler, kanun: 0, onerge: 0, toplam: 0 });
    }
    for (const r of rows) {
      const o = byParti.get(r.parti);
      if (!o) continue;
      const cat = ALL_CATEGORIES.includes(r.kategori) ? r.kategori : OTHER_CATEGORY;
      o.kategoriler[cat] += r.adet;
      o.toplam += r.adet;
      if (r.kaynak === 'kanun') o.kanun += r.adet;
      else if (r.kaynak === 'onerge') o.onerge += r.adet;
    }
    return { success: true, data: partiler.map((p) => byParti.get(p)) };
  });

  app.get('/api/ozet/parti-konu', async (req) => {
    const q = (req.query ?? {}) as { baslangic?: string; bitis?: string; kaynak?: string; donem?: string };
    const kapi = etiketKapisi(q);
    if (!kapi.yayimlanabilir) return kapiYaniti(kapi);
    const { clause, params } = buildRange(q.kaynak ?? '', q.baslangic ?? '', q.bitis ?? '', q.donem);
    const rows = getDb()
      .prepare(
        `SELECT fp.parti AS parti, f.kategori AS kategori, COUNT(*) AS adet
         FROM faaliyet f JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
         WHERE fp.parti NOT IN ${PARTI_DISI_SQL}${clause}
         GROUP BY fp.parti, f.kategori`,
      )
      .all(...params) as { parti: string; kategori: string; adet: number }[];

    const byParti = new Map<string, Record<string, number>>();
    for (const r of rows) {
      let o = byParti.get(r.parti);
      if (!o) {
        o = {};
        for (const c of ALL_CATEGORIES) o[c] = 0;
        byParti.set(r.parti, o);
      }
      if (ALL_CATEGORIES.includes(r.kategori)) o[r.kategori] += r.adet;
      else o[OTHER_CATEGORY] += r.adet;
    }
    const data = [...byParti.entries()]
      .sort((a, b) => catTotal(b[1]) - catTotal(a[1]))
      .map(([parti, o]) => ({ parti, ...o }));
    return {
      success: true, data, yayimlanabilir: true,
      etiket_kaynagi: {
        altin: kapi.altin, toplam: kapi.toplam, altin_pay: Number(kapi.altinPay.toFixed(1)),
        kaynaklar: kapi.kaynaklar, kaynak_uyarisi: kapi.kaynak_uyarisi ?? null,
      },
    };
  });

  app.get('/api/ozet/siralama', async (req) => {
    const q = (req.query ?? {}) as { kategori?: string; baslangic?: string; bitis?: string; kaynak?: string; donem?: string };
    const kapi = etiketKapisi(q);
    if (!kapi.yayimlanabilir) return kapiYaniti(kapi);
    const { clause, params } = buildRange(q.kaynak ?? '', q.baslangic ?? '', q.bitis ?? '', q.donem);
    const catCond = q.kategori ? ' AND f.kategori = ?' : '';
    const catParams = q.kategori ? [q.kategori] : [];
    const rows = getDb()
      .prepare(
        `SELECT fp.parti AS parti, COUNT(*) AS adet
         FROM faaliyet f JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
         WHERE fp.parti NOT IN ${PARTI_DISI_SQL}${catCond}${clause}
         GROUP BY fp.parti ORDER BY adet DESC`,
      )
      .all(...catParams, ...params) as { parti: string; adet: number }[];
    return { success: true, kategori: q.kategori ?? 'hepsi', data: rows };
  });

  app.get('/api/ozet/trend', async (req) => {
    const q = (req.query ?? {}) as { parti?: string; kategori?: string; kaynak?: string; donem?: string };
    const kapi = etiketKapisi(q);
    if (!kapi.yayimlanabilir) return kapiYaniti(kapi);
    if (!q.parti) return { success: false, error: 'parti gerekli' };
    const cond: string[] = ['fp.parti = ?', 'f.ay IS NOT NULL'];
    const dkT = donemKos(q); if (dkT.sql) cond.push(dkT.sql.replace(/^ AND /, ''));
    const params: (string | number)[] = [q.parti, ...dkT.params];
    if (q.kategori) {
      cond.push('f.kategori = ?');
      params.push(q.kategori);
    }
    if (q.kaynak) {
      cond.push('f.kaynak = ?');
      params.push(q.kaynak);
    } else {
      cond.push("f.kaynak IN ('kanun','onerge')");
    }
    const rows = getDb()
      .prepare(
        `SELECT f.ay AS ay, COUNT(*) AS adet
         FROM faaliyet f JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
         WHERE ${cond.join(' AND ')}
         GROUP BY f.ay ORDER BY f.ay`,
      )
      .all(...params) as { ay: string; adet: number }[];
    return { success: true, parti: q.parti, data: rows };
  });

  app.get('/api/ozet/cesaret', async (req) => {
    const q = (req.query ?? {}) as { parti?: string; baslangic?: string; bitis?: string; donem?: string };
    const kapi = etiketKapisi(q);
    if (!kapi.yayimlanabilir) return kapiYaniti(kapi);
    if (!q.parti) return { success: false, error: 'parti gerekli' };
    const cond: string[] = ['fp.parti = ?'];
    const params: (string | number)[] = [q.parti];
    const dk = donemKos(q);
    if (dk.sql) { cond.push(dk.sql.replace(/^ AND /, '')); params.push(...dk.params); }
    if (q.baslangic) { cond.push('f.ay >= ?'); params.push(q.baslangic); }
    if (q.bitis) { cond.push('f.ay <= ?'); params.push(q.bitis); }
    const rows = getDb()
      .prepare(
        `SELECT f.kategori AS kategori,
                SUM(CASE WHEN f.kaynak='konusma' THEN 1 ELSE 0 END) AS konusma,
                SUM(CASE WHEN f.kaynak IN ('kanun','onerge') THEN 1 ELSE 0 END) AS belge
         FROM faaliyet f JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
         WHERE ${cond.join(' AND ')}
         GROUP BY f.kategori`,
      )
      .all(...params) as { kategori: string; konusma: number; belge: number }[];

    const map = new Map<string, { konusma: number; belge: number }>();
    let konusmaN = 0, belgeN = 0;
    for (const r of rows) {
      if (r.kategori === OTHER_CATEGORY) continue;
      map.set(r.kategori, { konusma: r.konusma, belge: r.belge });
      konusmaN += r.konusma;
      belgeN += r.belge;
    }
    const kategoriler = CATEGORY_NAMES.map((k) => {
      const o = map.get(k) ?? { konusma: 0, belge: 0 };
      const soylem = konusmaN ? Math.round((1000 * o.konusma) / konusmaN) / 10 : 0;
      const eylem = belgeN ? Math.round((1000 * o.belge) / belgeN) / 10 : 0;
      return { kategori: k, soylem, eylem, fark: Math.round(10 * (eylem - soylem)) / 10, konusma: o.konusma, belge: o.belge };
    })
      .filter((x) => x.konusma > 0 || x.belge > 0)
      .sort((a, b) => b.soylem + b.eylem - (a.soylem + a.eylem));
    let ortusme = 0;
    for (const x of kategoriler) ortusme += Math.min(x.soylem, x.eylem);
    ortusme = Math.round(10 * ortusme) / 10;
    return {
      success: true,
      parti: q.parti,
      yeterli: konusmaN >= 30 && belgeN >= 20,
      konusmaN,
      belgeN,
      ortusme,
      kategoriler,
    };
  });

  app.get('/api/ozet/cesaret-konu', async (req) => {
    const q = (req.query ?? {}) as { kategori?: string; baslangic?: string; bitis?: string; donem?: string };
    const kapi = etiketKapisi(q);
    if (!kapi.yayimlanabilir) return kapiYaniti(kapi);
    if (!q.kategori) return { success: false, error: 'kategori gerekli' };
    const cond: string[] = [`fp.parti NOT IN ${PARTI_DISI_SQL}`];
    const params: (string | number)[] = [q.kategori, q.kategori];
    const dkCK = donemKos(q);
    if (dkCK.sql) { cond.push(dkCK.sql.replace(/^ AND /, '')); params.push(...dkCK.params); }
    if (q.baslangic) { cond.push('f.ay >= ?'); params.push(q.baslangic); }
    if (q.bitis) { cond.push('f.ay <= ?'); params.push(q.bitis); }
    const rows = getDb()
      .prepare(
        `SELECT fp.parti AS parti,
                SUM(CASE WHEN f.kaynak='konusma' AND f.kategori!='Diğer' THEN 1 ELSE 0 END) AS konusmaTop,
                SUM(CASE WHEN f.kaynak IN ('kanun','onerge') AND f.kategori!='Diğer' THEN 1 ELSE 0 END) AS belgeTop,
                SUM(CASE WHEN f.kaynak='konusma' AND f.kategori=? THEN 1 ELSE 0 END) AS konusmaK,
                SUM(CASE WHEN f.kaynak IN ('kanun','onerge') AND f.kategori=? THEN 1 ELSE 0 END) AS belgeK
         FROM faaliyet f JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
         WHERE ${cond.join(' AND ')}
         GROUP BY fp.parti`,
      )
      .all(...params) as { parti: string; konusmaTop: number; belgeTop: number; konusmaK: number; belgeK: number }[];

    const data = rows
      .map((r) => {
        const soylem = r.konusmaTop ? Math.round((1000 * r.konusmaK) / r.konusmaTop) / 10 : 0;
        const eylem = r.belgeTop ? Math.round((1000 * r.belgeK) / r.belgeTop) / 10 : 0;
        return { parti: r.parti, soylem, eylem, fark: Math.round(10 * (eylem - soylem)) / 10, konusmaN: r.konusmaTop, belgeN: r.belgeTop, konusmaK: r.konusmaK, belgeK: r.belgeK };
      })
      .filter((x) => x.konusmaN >= 30 && x.belgeN >= 20 && x.soylem + x.eylem > 0)
      .sort((a, b) => b.soylem + b.eylem - (a.soylem + a.eylem));
    return { success: true, kategori: q.kategori, data };
  });

  app.get('/api/ozet/aylik', async (req) => {
    const q = (req.query ?? {}) as { baslangic?: string; bitis?: string; kaynak?: string; donem?: string };
    const { clause, params } = buildRange(q.kaynak ?? '', q.baslangic ?? '', q.bitis ?? '', q.donem);
    const rows = getDb()
      .prepare(
        `SELECT f.ay AS ay, f.kategori AS kategori, COUNT(*) AS adet
         FROM faaliyet f
         WHERE f.ay IS NOT NULL${clause}
         GROUP BY f.ay, f.kategori ORDER BY f.ay`,
      )
      .all(...params) as { ay: string; kategori: string; adet: number }[];

    const byAy = new Map<string, Record<string, number>>();
    for (const r of rows) {
      let o = byAy.get(r.ay);
      if (!o) {
        o = {};
        for (const c of ALL_CATEGORIES) o[c] = 0;
        byAy.set(r.ay, o);
      }
      if (ALL_CATEGORIES.includes(r.kategori)) o[r.kategori] += r.adet;
      else o[OTHER_CATEGORY] += r.adet;
    }
    const data = [...byAy.entries()].map(([ay, o]) => ({ ay, ...o }));
    return { success: true, data };
  });

  app.get('/api/ozet/gundem', async (req) => {
    const q = (req.query ?? {}) as { saat?: string; limit?: string; kaynak?: string; konu?: string; parti?: string; tip?: string; donem?: string };
    const saat = Math.min(720, Math.max(1, Number(q.saat) || 24));
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 40));
    const esik = new Date(Date.now() - saat * 3600 * 1000).toISOString();
    const cond: string[] = ['o.olay_tarih >= ?'];
    const params: (string | number)[] = [esik];
    const dkG = donemKos(q);
    if (dkG.sql) { cond.push(dkG.sql.replace(/^ AND /, '')); params.push(...dkG.params); }
    if (q.kaynak) { cond.push('f.kaynak = ?'); params.push(q.kaynak); }
    if (q.konu) { cond.push('f.kategori = ?'); params.push(q.konu); }
    if (q.tip === 'yeni' || q.tip === 'durum') { cond.push('o.tip = ?'); params.push(q.tip); }
    if (q.parti) { cond.push('EXISTS (SELECT 1 FROM faaliyet_parti fp2 WHERE fp2.faaliyet_id=f.id AND fp2.parti=?)'); params.push(q.parti); }
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT o.id AS olay_id, o.tip, o.olay_tarih, o.eski_durum, o.yeni_durum,
                f.kaynak, f.kaynak_id, f.baslik, f.ozet, f.kategori, f.tarih, f.durum, f.detay_url,
                (SELECT group_concat(fp.parti) FROM faaliyet_parti fp WHERE fp.faaliyet_id=f.id AND fp.parti NOT IN ${PARTI_DISI_SQL}) AS partiler
         FROM olay o JOIN faaliyet f ON f.id = o.faaliyet_id
         WHERE ${cond.join(' AND ')}
         ORDER BY o.olay_tarih DESC LIMIT ?`,
      )
      .all(...params, limit) as {
        olay_id: number; tip: string; olay_tarih: string; eski_durum: string | null; yeni_durum: string | null;
        kaynak: string; kaynak_id: string; baslik: string | null; ozet: string | null; kategori: string | null;
        tarih: string | null; durum: string | null; detay_url: string | null; partiler: string | null;
      }[];
    const sonHareket = (db.prepare('SELECT MAX(olay_tarih) m FROM olay').get() as { m: string | null }).m;
    const olaylar = rows.map((r) => ({
      olay_id: r.olay_id, tip: r.tip, kaynak: r.kaynak, kaynak_id: r.kaynak_id,
      baslik: r.baslik, ozet: r.ozet, kategori: r.kategori,
      partiler: r.partiler ? r.partiler.split(',') : [],
      tarih: r.tarih, eklendi: r.olay_tarih,
      durum: r.durum, eski_durum: r.eski_durum, yeni_durum: r.yeni_durum, detay_url: r.detay_url,
    }));
    return { success: true, pencere_saat: saat, son_hareket: sonHareket, olaylar };
  });

  app.get('/api/ozet/olay-gecmis', async (req) => {
    const q = (req.query ?? {}) as { kaynak?: string; kaynak_id?: string; donem?: string };
    if (!q.kaynak || !q.kaynak_id) return { success: false, error: 'kaynak ve kaynak_id gerekli' };
    const gecmis = getDb()
      .prepare(
        `SELECT o.tip, o.olay_tarih, o.eski_durum, o.yeni_durum FROM olay o JOIN faaliyet f ON f.id = o.faaliyet_id
         WHERE f.kaynak = ? AND f.kaynak_id = ? AND f.donem = ? ORDER BY o.olay_tarih ASC`,
      )
      .all(q.kaynak, q.kaynak_id, Number(q.donem) || AKTIF_DONEM);
    return { success: true, gecmis };
  });

  app.get('/api/ozet/yururluk', async (req) => {
    const q = (req.query ?? {}) as { kategori?: string; limit?: string; tur?: string; baslangic?: string; bitis?: string; donem?: string };
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 8));
    const cond: string[] = ["baslik IS NOT NULL"];
    const params: (string | number)[] = [];
    if (q.kategori) { cond.push('kategori = ?'); params.push(q.kategori); }
    if (q.tur) { cond.push('tur LIKE ?'); params.push('%' + q.tur + '%'); }
    if (!q.tur) {
      for (const d of ['%MAHKEMESİ KARARLARI%', '%YARGITAY%', '%DANIŞTAY%']) { cond.push('tur NOT LIKE ?'); params.push(d); }
    }
    const pncY = donemPencere(q);
    const rBas = q.baslangic || pncY?.lo, rBit = q.bitis || pncY?.hi;
    if (rBas) { cond.push('tarih >= ?'); params.push(rBas); }
    if (rBit) { cond.push('tarih <= ?'); params.push(rBit); }
    const db = getDb();
    const kayitlar = db
      .prepare(`SELECT tarih, tur, baslik, kategori, sayi, url FROM gazete WHERE ${cond.join(' AND ')} ORDER BY tarih DESC, id DESC LIMIT ?`)
      .all(...params, limit);
    const sonHareket = (db.prepare('SELECT MAX(tarih) m FROM gazete').get() as { m: string | null }).m;
    return { success: true, kategori: q.kategori ?? null, son_hareket: sonHareket, kayitlar };
  });

  app.get('/api/ozet/gazete-ara', async (req) => {
    const q = (req.query ?? {}) as { q?: string; donem?: string; limit?: string; baslangic?: string; bitis?: string };
    const terim = (q.q ?? '').trim();
    if (terim.length < 3) return { success: false, error: 'en az 3 harf' };
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 8));
    const db2 = getDb();
    const ak = aramaKosuluIfade(terim, 'baslik');
    const cond: string[] = ['baslik IS NOT NULL', ak.sql];
    const params: string[] = [...ak.params];
    const pnc = donemPencere(q);
    const bas = q.baslangic || pnc?.lo, bit = q.bitis || pnc?.hi;
    if (bas) { cond.push('tarih >= ?'); params.push(bas); }
    if (bit) { cond.push('tarih <= ?'); params.push(bit); }
    const kosul = cond.join(' AND ');

    const toplam = (db2.prepare(`SELECT COUNT(*) c FROM gazete WHERE ${kosul}`)
      .get(...params) as { c: number }).c;

    const turDagilim = db2.prepare(
      `SELECT COALESCE(NULLIF(TRIM(tur),''),'(tür yazılmamış)') AS tur, COUNT(*) AS n
         FROM gazete WHERE ${kosul} GROUP BY tur ORDER BY n DESC LIMIT 10`,
    ).all(...params) as { tur: string; n: number }[];

    const zamanDagilim = db2.prepare(
      `SELECT ay, COUNT(*) AS n FROM gazete WHERE ${kosul} AND ay IS NOT NULL GROUP BY ay ORDER BY ay`,
    ).all(...params) as { ay: string; n: number }[];

    const kayitlar = db2.prepare(
      `SELECT tarih, tur, baslik, sayi, url FROM gazete WHERE ${kosul} ORDER BY tarih DESC, id DESC LIMIT ?`,
    ).all(...params, limit);

    aramaLogYaz('gazete-ara', terim, q.donem ?? null, toplam);
    return {
      success: true, terim, toplam, gosterilen: (kayitlar as unknown[]).length,
      tur_dagilim: turDagilim, zaman_dagilim: zamanDagilim,
      kayitlar,
    };
  });

  app.get('/api/ozet/parti-program-ara', async (req) => {
    const q = (req.query ?? {}) as { q?: string };
    const terim = (q.q ?? '').trim();
    if (terim.length < 3) return { success: false, error: 'en az 3 harf' };
    const db2 = getDb();
    const ak = aramaKosuluIfade(terim, 'metin');
    const kosul = ak.sql;

    const kayitlar = db2.prepare(
      `SELECT parti, belge_adi, belge_turu, tarih, kaynak_url, metin FROM parti_program WHERE ${kosul} ORDER BY parti`,
    ).all(...ak.params) as { parti: string; belge_adi: string; belge_turu: string; tarih: string | null; kaynak_url: string; metin: string }[];

    const kes = (m: string) => {
      const ml = trLower(m);
      let i = -1;
      for (const w of ak.kelimeler) { const p = ml.indexOf(w); if (p >= 0 && (i < 0 || p < i)) i = p; }
      const bas = i > 80 ? i - 80 : 0;
      return (bas > 0 ? '…' : '') + m.slice(bas, bas + 320).trim();
    };

    const toplamBelge = (db2.prepare('SELECT COUNT(*) c FROM parti_program').get() as { c: number }).c;
    aramaLogYaz('parti-program-ara', terim, null, kayitlar.length);
    return {
      success: true, terim,
      toplam: kayitlar.length,
      kapsam_notu: `7 TBMM partisinden ${toplamBelge}'sının resmi metni taranıyor — İYİ Parti'nin şu an `
        + `erişilebilir bir seçim beyannamesi/parti programı yok (siteden kaldırılmış). CHP'ninki 2023 seçimine `
        + `özgü değil (Millet İttifakı ortak listesiyle girdiği için ayrı beyanname yayımlamamış), `
        + `güncel/tarihsiz parti programı taslağıdır — belge_turu alanına bakınız.`,
      kayitlar: kayitlar.map((r) => ({
        parti: r.parti, belge_adi: r.belge_adi, belge_turu: r.belge_turu, tarih: r.tarih, kaynak_url: r.kaynak_url,
        alinti: kes(r.metin),
      })),
    };
  });

  app.get('/api/ozet/yerel-karar-ara', async (req) => {
    const q = (req.query ?? {}) as { q?: string; belediye?: string; limit?: string };
    const terim = (q.q ?? '').trim();
    if (terim.length < 3) return { success: false, error: 'en az 3 harf' };
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 10));
    const db2 = getDb();
    const kelimeler = kelimelereBol(terim);
    const matchIfade = kelimeler.map((w) => `"${w.replace(/"/g, '""')}"*`).join(' ');
    const cond: string[] = ['fts.yerel_karar_fts MATCH ?'];
    const params: string[] = [matchIfade];
    if (q.belediye) { cond.push('yk.belediye = ?'); params.push(q.belediye); }
    const kosul = cond.join(' AND ');
    const kaynakTablo = 'FROM yerel_karar_fts fts JOIN yerel_karar yk ON yk.id = fts.rowid';

    const toplam = (db2.prepare(`SELECT COUNT(*) c ${kaynakTablo} WHERE ${kosul}`).get(...params) as { c: number }).c;
    const belediyeDagilim = db2.prepare(
      `SELECT yk.belediye AS belediye, COUNT(*) n ${kaynakTablo} WHERE ${kosul} GROUP BY yk.belediye ORDER BY n DESC`,
    ).all(...params) as { belediye: string; n: number }[];
    const kayitlar = db2.prepare(
      `SELECT yk.belediye AS belediye, yk.karar_no AS karar_no, yk.tarih AS tarih, yk.konu AS konu,
              yk.metin AS metin, yk.oylama_sonucu AS oylama_sonucu, yk.kaynak_url AS kaynak_url
         ${kaynakTablo} WHERE ${kosul} ORDER BY yk.tarih DESC LIMIT ?`,
    ).all(...params, limit) as { belediye: string; karar_no: string; tarih: string; konu: string | null; metin: string; oylama_sonucu: string | null; kaynak_url: string }[];

    const kes = (m: string) => {
      const ml = trLower(m);
      let i = -1;
      for (const w of kelimeler) { const p = ml.indexOf(w); if (p >= 0 && (i < 0 || p < i)) i = p; }
      const bas = i > 80 ? i - 80 : 0;
      return (bas > 0 ? '…' : '') + m.slice(bas, bas + 320).trim();
    };

    aramaLogYaz('yerel-karar-ara', terim, null, toplam);
    return {
      success: true, terim, belediye: q.belediye ?? null,
      toplam, gosterilen: kayitlar.length,
      belediye_dagilim: belediyeDagilim,
      kapsam_notu: `Yalnız ${YEREL_YONETIM_BELEDIYELERI.length} belediye (${YEREL_YONETIM_BELEDIYELERI.join(', ')}) ve yalnız `
        + '2024 yerel seçimi sonrası (mevcut meclis dönemi) — geçmiş dönemler ve diğer belediyeler bu '
        + 'kaynakta yok. Üye-bazlı oylama kırılımı (kim/hangi parti nasıl oy verdi) hiçbir kaynakta '
        + 'güvenilir şekilde yayımlanmıyor; yalnız kararın kendi oybirliği/oyçokluğu beyanı var.',
      kayitlar: kayitlar.map((r) => ({
        belediye: r.belediye, karar_no: r.karar_no || null, tarih: r.tarih, konu: r.konu,
        oylama_sonucu: r.oylama_sonucu, kaynak_url: r.kaynak_url, alinti: kes(r.metin),
      })),
    };
  });

  app.get('/api/ozet/yerel-meclis', async (req) => {
    const q = (req.query ?? {}) as { belediye?: string };
    const db2 = getDb();
    const belediye = q.belediye && (YEREL_YONETIM_BELEDIYELERI as readonly string[]).includes(q.belediye)
      ? q.belediye : YEREL_YONETIM_BELEDIYELERI[0];
    const rows = db2.prepare(
      'SELECT parti, COUNT(*) n FROM yerel_meclis_uye WHERE belediye = ? GROUP BY parti ORDER BY n DESC',
    ).all(belediye) as { parti: string; n: number }[];
    const toplamUye = rows.reduce((s, r) => s + r.n, 0);
    const diyarbakirNotu = belediye === 'Diyarbakır' && !toplamUye
      ? ' Diyarbakır Büyükşehir Belediyesi\'nin kendi sitesinde meclis üye listesi yayımlanmıyor (4 ilgili sayfa da boş) — bu kaynakta yok.'
      : '';
    const vanNotu = belediye === 'Van (Tuşba)'
      ? ' Van Büyükşehir Belediyesi kayyum yönetiminde olduğu için meclis kararları/üye listesi yayımlanmıyor — burada gösterilen veri Van\'ın kayyum atanmayan ilçesi Tuşba\'nın kendi meclisine aittir, büyükşehir meclisi DEĞİLDİR.'
      : '';
    return {
      success: true, belediyeler: YEREL_YONETIM_BELEDIYELERI,
      meclis: {
        belediye, toplam_uye: toplamUye,
        partiler: rows.map((r) => ({ parti: r.parti, n: r.n, oran: toplamUye ? Math.round((10000 * r.n) / toplamUye) / 100 : null })),
        kapsam_notu: `2024 yerel seçimi sonrası mevcut meclis kompozisyonu, belediyenin kendi resmi kaynağından.${diyarbakirNotu}${vanNotu}`,
      },
    };
  });

  app.get('/api/ozet/yargi', async (req) => {
    const q = (req.query ?? {}) as { kategori?: string; limit?: string; baslangic?: string; bitis?: string; sonuc?: string; donem?: string };
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 8));
    const cond: string[] = ["konu IS NOT NULL", "konu != ''"];
    const params: (string | number)[] = [];
    if (q.kategori) { cond.push('kategori = ?'); params.push(q.kategori); }
    const pnc = donemPencere(q);
    const yBas = q.baslangic || pnc?.lo, yBit = q.bitis || pnc?.hi;
    if (yBas) { cond.push('karar_tarihi >= ?'); params.push(yBas); }
    if (yBit) { cond.push('karar_tarihi <= ?'); params.push(yBit); }
    if (q.sonuc) { cond.push('sonuc_kod = ?'); params.push(q.sonuc); }
    const db = getDb();
    const kayitlar = db
      .prepare(`SELECT karar_tarihi AS tarih, esas_no, karar_no, sonuc, sonuc_kod, basvuru_turu, konu, kategori, url FROM aym_karar WHERE ${cond.join(' AND ')} ORDER BY karar_tarihi DESC, id DESC LIMIT ?`)
      .all(...params, limit);
    const sayim = db
      .prepare(`SELECT sonuc_kod, COUNT(*) c FROM aym_karar WHERE ${cond.join(' AND ')} GROUP BY sonuc_kod`)
      .all(...params) as { sonuc_kod: string; c: number }[];
    const m: Record<string, number> = {};
    for (const r of sayim) m[r.sonuc_kod] = r.c;
    const iptal = m.iptal ?? 0, ret = m.ret ?? 0, kismen = m.kismen ?? 0, usulden = m.ilk_ret ?? 0, digerS = m.diger ?? 0;
    const esas = iptal + ret + kismen;
    const genelCond = cond.filter((c) => c !== 'kategori = ?');
    const genelParams = q.kategori ? params.slice(1) : params;
    const gSayim = db
      .prepare(`SELECT sonuc_kod, COUNT(*) c FROM aym_karar WHERE ${genelCond.join(' AND ')} GROUP BY sonuc_kod`)
      .all(...genelParams) as { sonuc_kod: string; c: number }[];
    const gm: Record<string, number> = {};
    for (const r of gSayim) gm[r.sonuc_kod] = r.c;
    const genelOran = oranHesap(gm.iptal ?? 0, gm.ret ?? 0, gm.kismen ?? 0);
    const ozet = {
      esas, iptal, ret, kismen, usulden, diger: digerS,
      oran: oranHesap(iptal, ret, kismen),
      genel_oran: genelOran,
    };
    const sonHareket = (db.prepare('SELECT MAX(karar_tarihi) m FROM aym_karar').get() as { m: string | null }).m;
    return { success: true, kategori: q.kategori ?? null, son_hareket: sonHareket, ozet, kayitlar };
  });

  app.get('/api/ozet/aym-ara', async (req) => {
    const q = (req.query ?? {}) as { q?: string; donem?: string; limit?: string; baslangic?: string; bitis?: string };
    const terim = (q.q ?? '').trim();
    if (terim.length < 3) return { success: false, error: 'en az 3 harf' };
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 8));
    const db2 = getDb();
    const ak = aramaKosuluIfade(terim, 'konu');
    const cond: string[] = ["konu IS NOT NULL", "konu != ''", ak.sql];
    const params: string[] = [...ak.params];
    const pnc = donemPencere(q);
    const bas = q.baslangic || pnc?.lo, bit = q.bitis || pnc?.hi;
    if (bas) { cond.push('karar_tarihi >= ?'); params.push(bas); }
    if (bit) { cond.push('karar_tarihi <= ?'); params.push(bit); }
    const kosul = cond.join(' AND ');

    const toplam = (db2.prepare(`SELECT COUNT(*) c FROM aym_karar WHERE ${kosul}`)
      .get(...params) as { c: number }).c;

    const sayim = db2.prepare(`SELECT sonuc_kod, COUNT(*) c FROM aym_karar WHERE ${kosul} GROUP BY sonuc_kod`)
      .all(...params) as { sonuc_kod: string; c: number }[];
    const m: Record<string, number> = {};
    for (const r of sayim) m[r.sonuc_kod] = r.c;
    const iptal = m.iptal ?? 0, ret = m.ret ?? 0, kismen = m.kismen ?? 0, usulden = m.ilk_ret ?? 0, digerS = m.diger ?? 0;
    const sonucDagilim = { esas: iptal + ret + kismen, iptal, ret, kismen, usulden, diger: digerS, oran: oranHesap(iptal, ret, kismen) };

    const yilDagilim = db2.prepare(
      `SELECT SUBSTR(karar_tarihi,1,4) AS yil, COUNT(*) AS n FROM aym_karar WHERE ${kosul} AND karar_tarihi IS NOT NULL GROUP BY yil ORDER BY yil`,
    ).all(...params) as { yil: string; n: number }[];

    const kayitlar = db2.prepare(
      `SELECT karar_tarihi AS tarih, esas_no, karar_no, sonuc, sonuc_kod, konu, url
         FROM aym_karar WHERE ${kosul} ORDER BY karar_tarihi DESC, id DESC LIMIT ?`,
    ).all(...params, limit) as { tarih: string; esas_no: string; karar_no: string; sonuc: string; sonuc_kod: string; konu: string; url: string }[];
    const kes = (m2: string) => {
      const ml = trLower(m2);
      let i = -1;
      for (const w of ak.kelimeler) { const p = ml.indexOf(w); if (p >= 0 && (i < 0 || p < i)) i = p; }
      const b = i > 60 ? i - 60 : 0;
      return (b > 0 ? '…' : '') + m2.slice(b, b + 240).trim();
    };

    aramaLogYaz('aym-ara', terim, q.donem ?? null, toplam);
    return {
      success: true, terim, toplam, gosterilen: kayitlar.length,
      sonuc_dagilim: sonucDagilim, yil_dagilim: yilDagilim,
      kayitlar: kayitlar.map((r) => ({
        esas_no: r.esas_no, karar_no: r.karar_no, tarih: r.tarih,
        sonuc: r.sonuc, sonuc_kod: r.sonuc_kod, url: r.url,
        alinti: kes(r.konu ?? ''),
      })),
    };
  });

  const KONU_GOSTERGE: Record<string, { kod: string; baslik: string; birim: string }> = {
    'Ekonomi & Finans': { kod: 'tufe', baslik: 'Enflasyon (TÜFE, yıllık)', birim: '%' },
    'Çalışma & Sosyal Güvenlik': { kod: 'issizlik', baslik: 'İşsizlik oranı (mevsim etkisinden arındırılmış)', birim: '%' },
    'Konut & Şehircilik': { kod: 'konut', baslik: 'Konut satışı (aylık, adet)', birim: 'adet' },
    'Ulaştırma & Altyapı': { kod: 'tasit', baslik: 'Trafiğe kaydı yapılan taşıt (aylık, adet)', birim: 'adet' },
  };
  app.get('/api/ozet/gosterge', async (req) => {
    const q = (req.query ?? {}) as { kategori?: string; baslangic?: string; bitis?: string; donem?: string };
    const g = q.kategori ? KONU_GOSTERGE[q.kategori] : undefined;
    if (!g) {
      return {
        success: true, gosterge: null, seri: [],
        sebep: q.kategori
          ? `"${q.kategori}" konusu için eşleştirilmiş bir TÜİK göstergesi yok. Gösterge, konuyla `
            + `ilgisi ölçülebilen kategorilere elle bağlanır; bağlanmamış konuda sayı UYDURULMAZ.`
          : 'Gösterge için `kategori` parametresi gerekli.',
      };
    }
    const cond: string[] = ['gosterge = ?'];
    const params: (string | number)[] = [g.kod];
    const pncG = donemPencere(q);
    const gBas = q.baslangic || pncG?.lo, gBit = q.bitis || pncG?.hi;
    if (gBas) { cond.push('tarih >= ?'); params.push(gBas.slice(0, 7)); }
    if (gBit) { cond.push('tarih <= ?'); params.push(gBit.slice(0, 7)); }
    const db = getDb();
    const seri = db.prepare(`SELECT tarih, deger FROM tuik WHERE ${cond.join(' AND ')} ORDER BY tarih`).all(...params);

    const kap = db.prepare(
      'SELECT MIN(tarih) lo, MAX(tarih) hi, COUNT(*) n FROM tuik WHERE gosterge = ?',
    ).get(g.kod) as { lo: string | null; hi: string | null; n: number };

    const istenenBas = gBas ? gBas.slice(0, 7) : null;
    const eksikBaslangic = !!(istenenBas && kap.lo && istenenBas < kap.lo);
    return {
      success: true, gosterge: g, kaynak: 'TÜİK', seri,
      kapsam: { ilk: kap.lo, son: kap.hi, nokta: kap.n },
      sebep: seri.length === 0 && kap.n > 0
        ? `Bu gösterge yalnız ${kap.lo} – ${kap.hi} arasını kapsıyor; istenen dönem bu aralığın dışında.`
        : eksikBaslangic
          ? `Seri ${kap.lo} tarihinde başlıyor; istenen dönemin başı (${istenenBas}) TÜİK ölçümünün `
            + `öncesinde kaldığı için grafiğin başı boştur.`
          : null,
    };
  });

  app.get('/api/ozet/yasama', async (req) => {
    const q = (req.query ?? {}) as { donem?: string };
    const dk = donemKos(q);
    const db = getDb();
    const partiler = db
      .prepare(
        `SELECT fp.parti AS parti, COUNT(*) AS toplam,
           SUM(CASE WHEN f.durum='KANUNLAŞTI' THEN 1 ELSE 0 END) AS kanunlasti,
           SUM(CASE WHEN f.durum='KOMİSYONDA' THEN 1 ELSE 0 END) AS komisyonda,
           SUM(CASE WHEN f.durum='GÜNDEMDE'  THEN 1 ELSE 0 END) AS gundemde
         FROM faaliyet f JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
         WHERE f.kaynak='kanun' AND fp.parti NOT IN ${PARTI_DISI_SQL}${dk.sql}
         GROUP BY fp.parti ORDER BY toplam DESC`,
      )
      .all(...dk.params) as { parti: string; toplam: number; kanunlasti: number; komisyonda: number; gundemde: number }[];
    const toplamKanunlasti = (db.prepare(`SELECT COUNT(*) c FROM faaliyet f WHERE kaynak='kanun' AND durum='KANUNLAŞTI'${dk.sql}`).get(...dk.params) as { c: number }).c;
    const durumlar = db.prepare(
      `SELECT COALESCE(NULLIF(TRIM(f.durum),''),'(durum yazılmamış)') AS durum, COUNT(*) AS n
         FROM faaliyet f WHERE f.kaynak='kanun'${dk.sql} GROUP BY durum ORDER BY n DESC`,
    ).all(...dk.params) as { durum: string; n: number }[];
    const toplamTeklif = durumlar.reduce((s, r) => s + r.n, 0);
    const artikKirilim = db.prepare(
      `SELECT COALESCE(fp.parti,'Bilinmiyor') AS parti, COUNT(*) AS n,
              SUM(CASE WHEN TRIM(COALESCE(f.durum,''))='KANUNLAŞTI' THEN 1 ELSE 0 END) AS kanunlasti
         FROM faaliyet f LEFT JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
        WHERE f.kaynak='kanun' AND (fp.parti IS NULL OR fp.parti IN ${PARTI_DISI_SQL})${dk.sql}
        GROUP BY COALESCE(fp.parti,'Bilinmiyor')`,
    ).all(...dk.params) as { parti: string; n: number; kanunlasti: number }[];
    const gundemeGelen = (db.prepare(
      `SELECT COUNT(*) c FROM faaliyet f
        WHERE f.kaynak='kanun' AND f.durum IN ('KANUNLAŞTI','GÜNDEMDE')${dk.sql}`,
    ).get(...dk.params) as { c: number }).c;

    const donemNo = Number(q.donem ?? AKTIF_DONEM);
    const vekilSayisi: Record<string, number> = {};
    for (const d of DEPUTY_MASTER_LIST) {
      if (Number(d.donem) !== donemNo) continue;
      const p = normParti(d.parti);
      if (PARTI_DISI.has(p)) continue;
      vekilSayisi[p] = (vekilSayisi[p] ?? 0) + 1;
    }

    const onergePartiler = db.prepare(
      `SELECT fp.parti AS parti, COUNT(*) AS n
         FROM faaliyet f JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
        WHERE f.kaynak='onerge' AND fp.parti NOT IN ${PARTI_DISI_SQL}${dk.sql}
        GROUP BY fp.parti ORDER BY n DESC`,
    ).all(...dk.params) as { parti: string; n: number }[];
    const toplamOnerge = onergePartiler.reduce((a, b) => a + b.n, 0);
    const kanunLider = partiler.reduce<{ parti: string; kanunlasti: number } | null>(
      (a, b) => (!a || b.kanunlasti > a.kanunlasti ? b : a), null);
    const onergeLider = onergePartiler[0] ?? null;

    return {
      success: true, donem: q.donem ?? String(AKTIF_DONEM), partiler,
      toplam_kanunlasti: toplamKanunlasti, toplam_teklif: toplamTeklif, durumlar,
      artik_kirilim: artikKirilim,
      oran: {
        verilen_payda: toplamTeklif,
        gundeme_gelen_payda: gundemeGelen,
        kanunlasti: toplamKanunlasti,
        verilen_pay: toplamTeklif ? Number(((100 * toplamKanunlasti) / toplamTeklif).toFixed(1)) : null,
        gundeme_gelen_pay: gundemeGelen > toplamKanunlasti
          ? Number(((100 * toplamKanunlasti) / gundemeGelen).toFixed(1)) : null,
        gundeme_gelen_sebep: gundemeGelen > toplamKanunlasti ? null
          : 'Bu dönemde "gündemde" durumu kayıtlı değil — kapanmış dönemlerde TBMM süreç '
            + 'durumlarını nihai duruma indiriyor. Payda paya eşit olduğu için bu oran hesaplanamaz.',
      },
      durum_semasi: (() => {
        const dagilim = db.prepare(
          `SELECT donem, COALESCE(NULLIF(durum,''),'(boş)') AS durum, COUNT(*) AS n
             FROM faaliyet WHERE kaynak='kanun' GROUP BY donem, durum ORDER BY donem, n DESC`,
        ).all() as { donem: number; durum: string; n: number }[];
        const perDonem = new Map<number, string[]>();
        for (const r of dagilim) perDonem.set(r.donem, [...(perDonem.get(r.donem) ?? []), r.durum]);
        const hepsi = [...perDonem.values()];
        const ortak = hepsi.length
          ? hepsi.reduce((a2, b2) => a2.filter((x) => b2.includes(x)))
          : [];
        const yalnizBir = [...new Set(dagilim.map((r) => r.durum))].filter((d) => !ortak.includes(d));
        return {
          dagilim,
          ortak_durumlar: ortak,
          doneme_ozgu_durumlar: yalnizBir,
          not: yalnizBir.length
            ? 'Süreç durumları dönemler arasında AYNI ANLAMA GELMEZ: TBMM kapanmış dönemlerin '
              + 'ara durumlarını nihai duruma indiriyor. Bu yüzden duruma dayanan oranlar '
              + '(ör. "gündeme gelenin kaçı kanunlaştı") dönemler arası KIYASLANAMAZ.'
            : null,
        };
      })(),
      vekil_sayisi: vekilSayisi,
      arac_asimetri: {
        kanun: kanunLider ? { parti: kanunLider.parti, n: kanunLider.kanunlasti, toplam: toplamKanunlasti } : null,
        onerge: onergeLider ? { parti: onergeLider.parti, n: onergeLider.n, toplam: toplamOnerge } : null,
        ayni_parti: !!(kanunLider && onergeLider && kanunLider.parti === onergeLider.parti),
      },
    };
  });

  app.get('/api/ozet/arac-profili', async (req) => {
    const q = (req.query ?? {}) as { donem?: string };
    const dk = donemKos(q, 'f');
    const db = getDb();
    const satir = db.prepare(
      `SELECT fp.parti AS parti, f.kaynak AS kaynak, COUNT(*) AS n
         FROM faaliyet f JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
        WHERE fp.parti NOT IN ${PARTI_DISI_SQL}${dk.sql}
        GROUP BY fp.parti, f.kaynak`,
    ).all(...dk.params) as { parti: string; kaynak: string; n: number }[];

    const donemNo = Number(q.donem ?? AKTIF_DONEM);
    const vekilSayisi: Record<string, number> = {};
    for (const d of DEPUTY_MASTER_LIST) {
      if (Number(d.donem) !== donemNo) continue;
      const p = normParti(d.parti);
      if (PARTI_DISI.has(p)) continue;
      vekilSayisi[p] = (vekilSayisi[p] ?? 0) + 1;
    }

    const harita = new Map<string, { parti: string; onerge: number; kanun: number; konusma: number; toplam: number }>();
    for (const r of satir) {
      if (!harita.has(r.parti)) harita.set(r.parti, { parti: r.parti, onerge: 0, kanun: 0, konusma: 0, toplam: 0 });
      const h = harita.get(r.parti)!;
      if (r.kaynak === 'onerge' || r.kaynak === 'kanun' || r.kaynak === 'konusma') h[r.kaynak] += r.n;
      h.toplam += r.n;
    }
    const TABAN = 200;
    const VEKIL_ESIK = 20;
    const partiler = [...harita.values()]
      .filter((h) => h.toplam >= TABAN)
      .map((h) => {
        const vn = vekilSayisi[h.parti] ?? null;
        const pay = (n: number) => Number(((100 * n) / h.toplam).toFixed(1));
        return {
          ...h, vekil_n: vn,
          pay: { onerge: pay(h.onerge), kanun: pay(h.kanun), konusma: pay(h.konusma) },
          vekil_basina: vn && vn >= VEKIL_ESIK ? {
            onerge: Number((h.onerge / vn).toFixed(1)),
            kanun: Number((h.kanun / vn).toFixed(1)),
            konusma: Number((h.konusma / vn).toFixed(1)),
          } : null,
        };
      })
      .sort((a, b) => b.toplam - a.toplam);
    const elenen = [...harita.values()].filter((h) => h.toplam < TABAN);

    return {
      success: true, donem: q.donem ?? String(AKTIF_DONEM), taban: TABAN, partiler,
      taban_alti: { parti_n: elenen.length, kayit_n: elenen.reduce((a, b) => a + b.toplam, 0) },
      vekil_kapsam: Object.keys(vekilSayisi).length, vekil_esik: VEKIL_ESIK,
      konusma_kalite_notu: konusmaKaliteNotu(q),
      beyan: 'Yüzdeler her partinin KENDİ faaliyeti içindeki dağılımdır — partiler arası ham sayı '
        + 'kıyası yapılmaz. Kanun teklifi, soru önergesi ve konuşma FARKLI parlamento araçlarıdır; '
        + 'bir partinin çok önerge vermesi ile başkasının çok kanun çıkarması aynı ölçekte '
        + 'karşılaştırılamaz. Vekil başına oranlar, hacim farkını grup büyüklüğünden ayırmak '
        + 'içindir ve yalnız ' + VEKIL_ESIK + '+ vekilli partilerde gösterilir: vekil sayısı çekim '
        + 'anının görüntüsüdür, dönem içinde parti değiştirenler küçük partilerde oranı bozar.',
    };
  });

  app.get('/api/ozet/oylama', async (req) => {
    const q = (req.query ?? {}) as { donem?: string };
    const db = getDb();
    const pen = donemPencere(q);
    const tk = pen ? ' WHERE tarih >= ? AND tarih <= ?' : '';
    const tp = pen ? [pen.lo, pen.hi] : [];
    const o = db
      .prepare(
        `SELECT COUNT(*) AS toplam,
           SUM(CASE WHEN ret > 0 THEN 1 ELSE 0 END) AS cekismeli,
           SUM(CASE WHEN ret = 0 THEN 1 ELSE 0 END) AS oybirligi,
           MIN(tarih) AS ilk, MAX(tarih) AS son
         FROM oylama${tk}`,
      )
      .get(...tp) as { toplam: number; cekismeli: number; oybirligi: number; ilk: string | null; son: string | null };
    const retSql = pen ? ' AND tarih >= ? AND tarih <= ?' : '';
    const retler = (db.prepare(`SELECT ret * 100.0 / kullanilan AS r FROM oylama WHERE ret > 0 AND kullanilan > 0${retSql} ORDER BY r`).all(...tp) as { r: number }[]).map((x) => x.r);
    const ortanca = retler.length ? retler[Math.floor(retler.length / 2)]! : null;
    const uclar = (
      db
        .prepare(
          `SELECT birlesim_id, sira_sayisi, tarih, kullanilan, kabul, ret, cekimser, sonuc
           FROM oylama WHERE ret > 0${retSql} ORDER BY ret DESC LIMIT 5`,
        )
        .all(...tp) as { birlesim_id: string }[]
    ).map((r) => ({ ...r, url: tutanakUrl(r.birlesim_id) }));
    return { success: true, donem: q.donem ?? String(AKTIF_DONEM), ozet: { ...o, ret_ortanca: ortanca }, uclar };
  });

  const BUTCE_DESEN = {
    butce: /merkez[iî]\s+y[öo]netim/i,
    kesin: /kesin\s+hesap|uygulama\s+sonu[çc]/i,
    ekOdenek: /[öo]denek\s+eklenme|ek\s+[öo]denek/i,
  };
  app.get('/api/ozet/butce', async (req) => {
    const q = (req.query ?? {}) as { donem?: string };
    const db = getDb();
    const pen = donemPencere(q);
    const adaylar = db.prepare(
      `SELECT DISTINCT o.sira_sayisi AS ss, MIN(o.tarih) AS tarih, f.id AS faaliyet_id,
              f.baslik AS baslik, f.donem AS donem, t.kanun_no AS kanun_no
         FROM oy o
         JOIN teklif_sirasayisi t ON t.sira_sayisi = o.sira_sayisi
         JOIN faaliyet f ON f.id = t.faaliyet_id
        WHERE f.baslik LIKE '%erkez%' ${pen ? 'AND o.tarih >= ? AND o.tarih <= ?' : ''}
        GROUP BY o.sira_sayisi ORDER BY tarih`,
    ).all(...(pen ? [pen.lo, pen.hi] : [])) as
      { ss: string; tarih: string; faaliyet_id: number; baslik: string; donem: number; kanun_no: string | null }[];

    const kayitlar = adaylar
      .filter((a) => BUTCE_DESEN.butce.test(a.baslik))
      .map((a) => {
        const partiler = db.prepare(
          `SELECT parti,
             SUM(CASE WHEN oy='Kabul'     THEN 1 ELSE 0 END) AS kabul,
             SUM(CASE WHEN oy='Ret'       THEN 1 ELSE 0 END) AS ret,
             SUM(CASE WHEN oy='Çekimser'  THEN 1 ELSE 0 END) AS cekimser,
             SUM(CASE WHEN oy='Katılmadı' THEN 1 ELSE 0 END) AS katilmadi
           FROM oy WHERE sira_sayisi = ? AND parti NOT IN ${PARTI_DISI_SQL}
           GROUP BY parti ORDER BY kabul + ret DESC`,
        ).all(a.ss) as { parti: string; kabul: number; ret: number; cekimser: number; katilmadi: number }[];
        const kanit = db.prepare(
          `SELECT basilmis_url FROM oylama WHERE basilmis_url IS NOT NULL AND birlesim_id IN
             (SELECT DISTINCT birlesim_id FROM oy WHERE sira_sayisi = ?) LIMIT 1`,
        ).get(a.ss) as { basilmis_url: string } | undefined;
        return {
          ...a,
          tur: BUTCE_DESEN.ekOdenek.test(a.baslik) ? 'ek-odenek'
            : BUTCE_DESEN.kesin.test(a.baslik) ? 'kesin-hesap' : 'butce',
          partiler,
          kanit_pdf: kanit?.basilmis_url ?? null,
          toplam: partiler.reduce((s, p) => s + p.kabul + p.ret + p.cekimser, 0),
        };
      })
      .filter((k) => k.toplam > 0);

    return {
      success: true,
      donem: q.donem ?? String(AKTIF_DONEM),
      kayitlar,
      katilmadi_notu: KATILMADI_NOTU,
      eksik: (() => {
        const cetvelli = db.prepare(
          `SELECT DISTINCT sira_sayisi ss, MIN(tarih) tarih FROM oy
             WHERE sira_sayisi IS NOT NULL AND sira_sayisi <> '' GROUP BY sira_sayisi`,
        ).all() as { ss: string; tarih: string }[];
        const koprusuz = cetvelli.filter((c) =>
          !db.prepare('SELECT 1 FROM teklif_sirasayisi WHERE sira_sayisi = ?').get(c.ss));
        return {
          koprusuz_cetvel: koprusuz.length,
          not: koprusuz.length
            ? `Elimizde vekil bazlı cetveli olan ${koprusuz.length} oylama, S.Sayısı-belge köprüsü `
              + 'kurulamadığı için bu listede YOK. Hangi belgeye ait olduğunu doğrulayamadan '
              + 'göstermek, yanlış kanuna oy yazmak olurdu.'
            : null,
        };
      })(),
      olcut: 'Kayıtlar, TBMM\'nin kendi belge başlığında “merkezî yönetim” geçen ve basılmış oy '
        + 'cetveli çıkarılabilen oylamalardır. Oylama ile cetvel, cetvelin kendi özet kutusundaki '
        + 'Sıra Sayısı ile eşleştirildi; tahmin veya toplam benzerliği KULLANILMADI.',
      kapsam_uyarisi: 'Bütçe görüşmeleri haftalarca sürer ve bu kart yalnız GENEL KURULDAKİ NİHAİ '
        + 'oylamayı gösterir; komisyon aşaması ve madde oylamaları buna dâhil değildir.',
    };
  });

  app.get('/api/ozet/oy', async (req) => {
    const q = (req.query ?? {}) as { donem?: string };
    const db = getDb();
    const pen = donemPencere(q);
    const tk = pen ? ' AND tarih >= ? AND tarih <= ?' : '';
    const tp = pen ? [pen.lo, pen.hi] : [];
    const partiler = db
      .prepare(
        `SELECT parti,
           SUM(CASE WHEN oy='Kabul'     THEN 1 ELSE 0 END) AS kabul,
           SUM(CASE WHEN oy='Ret'       THEN 1 ELSE 0 END) AS ret,
           SUM(CASE WHEN oy='Çekimser'  THEN 1 ELSE 0 END) AS cekimser,
           SUM(CASE WHEN oy='Katılmadı' THEN 1 ELSE 0 END) AS katilmadi,
           COUNT(DISTINCT il || soyad || ad) AS vekil
         FROM oy WHERE parti NOT IN ${PARTI_DISI_SQL}${tk}
         GROUP BY parti ORDER BY kabul + ret + cekimser DESC`,
      )
      .all(...tp) as { parti: string; kabul: number; ret: number; cekimser: number; katilmadi: number; vekil: number }[];
    const o = db.prepare(`SELECT COUNT(DISTINCT birlesim_id || sira_sayisi) n, MIN(tarih) ilk, MAX(tarih) son FROM oy${pen ? ' WHERE tarih >= ? AND tarih <= ?' : ''}`).get(...tp) as { n: number; ilk: string | null; son: string | null };
    const toplamOylama = (db.prepare(`SELECT COUNT(*) c FROM oylama${pen ? ' WHERE tarih >= ? AND tarih <= ?' : ''}`).get(...tp) as { c: number }).c;
    return { success: true, donem: q.donem ?? String(AKTIF_DONEM), oylama_n: o.n, toplam_oylama: toplamOylama, ilk: o.ilk, son: o.son, partiler, katilmadi_notu: KATILMADI_NOTU };
  });

  const PARTI_COGUNLUK_CTE = `
    WITH kullanilan AS (
      SELECT birlesim_id, sira_sayisi, parti, oy, COUNT(*) n
        FROM oy WHERE oy IN ('Kabul','Ret','Çekimser') AND parti NOT IN ${PARTI_DISI_SQL} AND parti <> 'BAGIMSIZ'
        GROUP BY birlesim_id, sira_sayisi, parti, oy
    ),
    cogunluk AS (
      SELECT birlesim_id, sira_sayisi, parti, oy AS coy,
        ROW_NUMBER() OVER (PARTITION BY birlesim_id, sira_sayisi, parti ORDER BY n DESC, oy) rn
        FROM kullanilan
    )`;
  const KATILIM_TABAN = 10;
  const partiKatilimOrtanca = (db: ReturnType<typeof getDb>): Record<string, { ortanca: number; vekil_n: number }> => {
    const satir = db.prepare(
      `SELECT parti, il, ad, soyad,
              SUM(CASE WHEN oy='Katılmadı' THEN 1 ELSE 0 END) AS km, COUNT(*) AS n
         FROM oy WHERE parti NOT IN ${PARTI_DISI_SQL}
        GROUP BY parti, il, ad, soyad HAVING n >= 40`,
    ).all() as { parti: string; km: number; n: number }[];
    const havuz = new Map<string, number[]>();
    for (const s of satir) {
      if (!havuz.has(s.parti)) havuz.set(s.parti, []);
      havuz.get(s.parti)!.push(s.km / s.n);
    }
    const cikti: Record<string, { ortanca: number; vekil_n: number }> = {};
    for (const [parti, arr] of havuz) {
      if (arr.length < KATILIM_TABAN) continue;
      arr.sort((a, b) => a - b);
      const m = arr.length % 2
        ? arr[(arr.length - 1) / 2]!
        : (arr[arr.length / 2 - 1]! + arr[arr.length / 2]!) / 2;
      cikti[parti] = { ortanca: m, vekil_n: arr.length };
    }
    return cikti;
  };

  app.get('/api/ozet/vekil-oy', async (req) => {
    const q = (req.query ?? {}) as { il?: string; ad?: string; soyad?: string; ara?: string; farkli?: string; donem?: string };
    const db = getDb();
    const OY_DONEM = 28;
    if (q.donem && Number(q.donem) !== OY_DONEM) {
      return {
        success: true, mod: 'donem-yok', donem: q.donem, oy_donem: OY_DONEM, vekiller: [], iller: [],
        sebep: `Vekil bazlı oy dökümü yalnız ${OY_DONEM}. dönemde var. TBMM, 26 ve 27. dönem açık oylama `
             + `cetvelini tutanağa taranmış görüntü olarak ekledi; belgede metin katmanı bulunmadığı için `
             + `hangi vekilin nasıl oy verdiği çıkarılamıyor. O dönemlerin oylama TOPLAMLARI ise mevcut.`,
      };
    }
    const oylamaN = (db.prepare('SELECT COUNT(DISTINCT birlesim_id || sira_sayisi) n FROM oy').get() as { n: number }).n;
    const kapsamSatir = db.prepare('SELECT MIN(tarih) ilk, MAX(tarih) son FROM oy').get() as { ilk: string; son: string };
    const oylamaSon = (db.prepare('SELECT MAX(tarih) son FROM oylama').get() as { son: string | null }).son;
    const gunFarki = oylamaSon && kapsamSatir.son
      ? Math.round((Date.parse(oylamaSon) - Date.parse(kapsamSatir.son)) / 86_400_000)
      : null;
    const kapsam = {
      ilk: kapsamSatir.ilk, son: kapsamSatir.son,
      oylama_son: oylamaSon,
      gerilik_gun: gunFarki,
    };
    const adBirlestir = (rows: Record<string, unknown>[], tavan: number): Record<string, unknown>[] => {
      const anahtar = (r: Record<string, unknown>) => `${r.il}|${String(r.ad).toLocaleLowerCase('tr')}`;
      const soyadUyar = (x: Record<string, unknown>, y: Record<string, unknown>) => {
        const a2 = String(x.soyad).toLocaleLowerCase('tr').trim();
        const b2 = String(y.soyad).toLocaleLowerCase('tr').trim();
        if (a2 === b2 || a2.startsWith(b2 + ' ') || b2.startsWith(a2 + ' ')) return true;
        const xs = String(x.son_oy ?? ''), xi = String(x.ilk_oy ?? '');
        const ys = String(y.son_oy ?? ''), yi = String(y.ilk_oy ?? '');
        if (!xs || !ys || !xi || !yi) return false;
        return xs < yi || ys < xi;
      };
      const kelime = (r: Record<string, unknown>) => String(r.ad).toLocaleLowerCase('tr').split(/\s+/).filter(Boolean);
      const gruplar = new Map<string, Record<string, unknown>[]>();
      for (const r of rows) { const k = anahtar(r); if (!gruplar.has(k)) gruplar.set(k, []); gruplar.get(k)!.push(r); }
      const cikti: Record<string, unknown>[] = [];
      for (const g of gruplar.values()) {
        const kalan = [...g];
        while (kalan.length) {
          const bas = kalan.shift()!;
          const kume = [bas];
          for (let i = kalan.length - 1; i >= 0; i--) {
            const A = kelime(bas), B = kelime(kalan[i]!);
            const altKume = A.every((w) => B.includes(w)) || B.every((w) => A.includes(w));
            const soyOk = soyadUyar(bas, kalan[i]!);
            const toplamOy = kume.reduce((s, x) => s + Number(x.toplam), 0) + Number(kalan[i]!.toplam);
            if (altKume && soyOk && toplamOy <= tavan) kume.push(...kalan.splice(i, 1));
          }
          if (kume.length === 1) { cikti.push(bas); continue; }
          const kanonik = kume.reduce((a, b) => (String(b.son_oy ?? '') > String(a.son_oy ?? '') ? b : a));
          const say = (alan: string) => kume.reduce((s, x) => s + Number(x[alan] ?? 0), 0);
          cikti.push({
            ...kanonik, kabul: say('kabul'), ret: say('ret'), cekimser: say('cekimser'),
            katilmadi: say('katilmadi'), toplam: say('toplam'), farkli: say('farkli'),
            parti_n: Math.max(...kume.map((x) => Number(x.parti_n ?? 1))),
            ad_varyant: kume.map((x) => x.ad),
            soyad_varyant: kume.map((x) => x.soyad),
          });
        }
      }
      return cikti.sort((a, b) => String(a.soyad).localeCompare(String(b.soyad), 'tr') || String(a.ad).localeCompare(String(b.ad), 'tr'));
    };

    const vekilSorgu = (ekKosul: string) => `${PARTI_COGUNLUK_CTE},
       son AS (
         SELECT il, ad, soyad, parti,
           ROW_NUMBER() OVER (PARTITION BY il, ad, soyad ORDER BY tarih DESC) rn
           FROM oy
       )
       SELECT o.il, o.ad, o.soyad, s.parti AS parti,
         COUNT(DISTINCT o.parti) AS parti_n,
         SUM(CASE WHEN o.oy='Kabul'     THEN 1 ELSE 0 END) AS kabul,
         SUM(CASE WHEN o.oy='Ret'       THEN 1 ELSE 0 END) AS ret,
         SUM(CASE WHEN o.oy='Çekimser'  THEN 1 ELSE 0 END) AS cekimser,
         SUM(CASE WHEN o.oy='Katılmadı' THEN 1 ELSE 0 END) AS katilmadi,
         COUNT(*) AS toplam,
         MIN(o.tarih) AS ilk_oy, MAX(o.tarih) AS son_oy,
         SUM(CASE WHEN o.oy IN ('Kabul','Ret','Çekimser') AND c.coy IS NOT NULL AND o.oy <> c.coy THEN 1 ELSE 0 END) AS farkli
       FROM oy o
       LEFT JOIN cogunluk c ON c.birlesim_id = o.birlesim_id AND c.sira_sayisi = o.sira_sayisi AND c.parti = o.parti AND c.rn = 1
       JOIN son s ON s.il = o.il AND s.ad = o.ad AND s.soyad = o.soyad AND s.rn = 1
       WHERE o.parti NOT IN ${PARTI_DISI_SQL} ${ekKosul}
       GROUP BY o.il, o.ad, o.soyad
       ORDER BY o.soyad, o.ad`;

    if (!q.il && !q.ara && q.farkli !== '1') {
      const birlesik = adBirlestir(db.prepare(vekilSorgu('')).all() as Record<string, unknown>[], oylamaN);
      const sayac = new Map<string, number>();
      for (const v of birlesik) sayac.set(String(v.il), (sayac.get(String(v.il)) ?? 0) + 1);
      const iller = [...sayac.entries()].map(([il, vekil]) => ({ il, vekil }))
        .sort((a, b) => a.il.localeCompare(b.il, 'tr'));
      return { success: true, mod: 'iller', oylama_n: oylamaN, iller, katilmadi_notu: KATILMADI_NOTU };
    }

    if (q.il && q.ad && q.soyad) {
      const kelimeler = (s: string) => s.toLocaleLowerCase('tr').split(/\s+/).filter(Boolean);
      const hedefAd = kelimeler(q.ad);
      const adUyar = (a: string) => {
        const B = kelimeler(a);
        return hedefAd.every((w) => B.includes(w)) || B.every((w) => hedefAd.includes(w));
      };
      const tumKayit = db.prepare(
        `${PARTI_COGUNLUK_CTE}
         SELECT o.tarih, o.sira_sayisi, o.oy, o.parti, o.ad, o.birlesim_id,
           CASE WHEN o.oy IN ('Kabul','Ret','Çekimser') AND c.coy IS NOT NULL AND o.oy <> c.coy THEN 1 ELSE 0 END AS farkli,
           c.coy AS parti_cogunluk, k.baslik AS kanun_basligi, k.detay_url AS kanun_url, k.kanun_no
         FROM oy o
         LEFT JOIN cogunluk c ON c.birlesim_id = o.birlesim_id AND c.sira_sayisi = o.sira_sayisi AND c.parti = o.parti AND c.rn = 1
         -- 🔴 TEKLİF ↔ OYLAMA KÖPRÜSÜ. Satırlar "280 sıra sayılı Kanun Teklifi" diyordu — vatandaş
         -- için ANLAMSIZ bir numara. Köprü kurulunca aynı satır kanunun ADINI taşıyor.
         -- Bu JOIN oy satırını ÇOĞALTAMAZ: teklif_sirasayisi'nin PK'si faaliyet_id ve alt sorgu
         -- S.Sayısı başına TEK kayıt seçiyor (aynı S.Sayısına iki teklif düşerse en yenisi alınır;
         -- ölçüldü: d28'de böyle bir çakışma YOK).
         LEFT JOIN (
           SELECT t.sira_sayisi, f.baslik, f.detay_url, t.kanun_no,
                  ROW_NUMBER() OVER (PARTITION BY t.sira_sayisi ORDER BY f.tarih DESC) rn
             FROM teklif_sirasayisi t JOIN faaliyet f ON f.id = t.faaliyet_id
         ) k ON k.sira_sayisi = o.sira_sayisi AND k.rn = 1
         WHERE o.il=? AND o.soyad=?
         ORDER BY o.tarih DESC, o.sira_sayisi`,
      ).all(q.il, q.soyad) as { tarih: string; sira_sayisi: string; oy: string; parti: string; ad: string; birlesim_id: string; farkli: number; parti_cogunluk: string | null; kanun_basligi: string | null; kanun_url: string | null; kanun_no: string | null }[];
      const kayitlar = tumKayit.filter((r) => adUyar(r.ad)).map((r) => ({ ...r, url: tutanakUrl(r.birlesim_id) }));
      if (!kayitlar.length) return { success: true, mod: 'vekil', bulundu: false };
      const parti = kayitlar[0]!.parti;
      const partiSayisi = new Set(kayitlar.map((r) => r.parti)).size;
      const say = (t: string) => kayitlar.filter((k) => k.oy === t).length;
      const ozet = { kabul: say('Kabul'), ret: say('Ret'), cekimser: say('Çekimser'), katilmadi: say('Katılmadı'), farkli: kayitlar.filter((k) => k.farkli).length, toplam: kayitlar.length };
      return { success: true, katilmadi_notu: KATILMADI_NOTU, mod: 'vekil', bulundu: true, il: q.il, ad: q.ad, soyad: q.soyad, parti, parti_n: partiSayisi, oylama_n: oylamaN, ozet, kayitlar, parti_katilim: partiKatilimOrtanca(db), kapsam };
    }

    if (q.farkli === '1') {
      const tumFarkli = adBirlestir(db.prepare(vekilSorgu('')).all() as Record<string, unknown>[], oylamaN)
        .filter((v) => Number(v.farkli) > 0 && v.parti !== 'BAGIMSIZ')
        .sort((a, b) => Number(b.farkli) - Number(a.farkli) || String(a.soyad).localeCompare(String(b.soyad), 'tr'));
      const KES = 40;
      let sinir = KES;
      if (tumFarkli.length > KES) {
        const esik = Number(tumFarkli[KES - 1]!.farkli);
        const ilk = tumFarkli.findIndex((v) => Number(v.farkli) === esik);
        sinir = ilk;
        if (sinir < 5) sinir = tumFarkli.length;
      }
      const gosterilen = tumFarkli.slice(0, sinir);
      const esikDeger = gosterilen.length ? Number(gosterilen[gosterilen.length - 1]!.farkli) : 0;
      return {
        success: true, mod: 'farkli', oylama_n: oylamaN,
        toplam_farkli: tumFarkli.length, gosterilen_esik: esikDeger, vekiller: gosterilen,
      };
    }

    if (q.ara && q.ara.trim().length >= 3) {
      const hepsi = adBirlestir(db.prepare(vekilSorgu('')).all() as Record<string, unknown>[], oylamaN) as (Record<string, unknown> & { ad: string; soyad: string })[];
      const ara = cleanStr(q.ara);
      const bulunan = hepsi.filter((v) => cleanStr(`${v.ad} ${v.soyad}`).includes(ara)).slice(0, 30);
      return { success: true, mod: 'ara', ara: q.ara, oylama_n: oylamaN, vekiller: bulunan, parti_katilim: partiKatilimOrtanca(db), kapsam };
    }

    if (!q.il) return { success: false, error: 'il gerekli (arama için en az 3 harf yazın)' };
    const vekiller = adBirlestir(db.prepare(vekilSorgu('AND o.il = ?')).all(q.il) as Record<string, unknown>[], oylamaN);
    return { success: true, mod: 'il', il: q.il, oylama_n: oylamaN, vekiller, parti_katilim: partiKatilimOrtanca(db), kapsam };
  });

  const cevapSinifi = (durum: string | null): 'suresinde' | 'gec' | 'hic' | 'bilinmiyor' => {
    if (!durum) return 'bilinmiyor';
    if (/^Cevaplandı$/.test(durum)) return 'suresinde';
    if (/Süresi Geçtikten Sonra/.test(durum)) return 'gec';
    if (/Cevaplanmadığı/.test(durum)) return 'hic';
    return 'bilinmiyor';
  };

  app.get('/api/ozet/cevap-suresi', async (req) => {
    const q = (req.query ?? {}) as { donem?: string };
    const db = getDb();
    const harita = muhatapKurumHaritasi();
    const isoIfade = "substr(oc.cevap_tarihi,7,4)||'-'||substr(oc.cevap_tarihi,4,2)||'-'||substr(oc.cevap_tarihi,1,2)";
    const rows = db.prepare(
      `SELECT f.muhatap AS muhatap,
              COUNT(*) AS n,
              SUM(CASE WHEN oc.etiket LIKE '%Gecik%' THEN 1 ELSE 0 END) AS gecikmis,
              julianday(${isoIfade}) - julianday(f.tarih) AS gun
         FROM onerge_cevap oc JOIN faaliyet f ON f.id = oc.faaliyet_id
        WHERE f.donem = ? AND f.muhatap IS NOT NULL AND f.muhatap <> ''
          AND length(oc.cevap_tarihi) = 10 AND f.tarih IS NOT NULL
        GROUP BY f.muhatap, oc.faaliyet_id, oc.sira`,
    ).all(Number(q.donem ?? AKTIF_DONEM)) as { muhatap: string; n: number; gecikmis: number; gun: number | null }[];

    const grup = new Map<string, { gunler: number[]; gecikmis: number; toplam: number }>();
    for (const r of rows) {
      const g = grup.get(r.muhatap) ?? { gunler: [], gecikmis: 0, toplam: 0 };
      if (r.gun !== null && r.gun >= 0) g.gunler.push(r.gun);
      g.gecikmis += r.gecikmis; g.toplam += 1;
      grup.set(r.muhatap, g);
    }
    const TABAN = 10;
    const kurumlar = [...grup.entries()].map(([mid, g]) => {
      const s2 = g.gunler.slice().sort((a, b) => a - b);
      const ortanca = s2.length ? Math.round(s2[Math.floor(s2.length / 2)]!) : null;
      return {
        muhatap: harita.get(mid) ?? 'Bilinmiyor',
        ornek_n: g.toplam,
        sure_n: s2.length,
        ortanca_gun: s2.length >= TABAN ? ortanca : null,
        gecikmis: g.gecikmis,
        gecikmis_pay: g.toplam >= TABAN ? Number(((100 * g.gecikmis) / g.toplam).toFixed(1)) : null,
        taban_alti: g.toplam < TABAN,
      };
    }).filter((k) => k.muhatap !== 'Bilinmiyor')
      .sort((a, b) => (b.ortanca_gun ?? -1) - (a.ortanca_gun ?? -1));

    return {
      success: true,
      donem: q.donem ?? String(AKTIF_DONEM),
      kurumlar,
      taban: TABAN,
      olcut: 'Bu tablo KATMANLI ÖRNEKLEMdir: her muhatap kurumdan ilk N önergenin cevap kaydı '
        + 'çekilmiştir (tam sayım değil). Süre, önergenin veriliş tarihi ile cevap tarihi '
        + 'arasındaki takvim günüdür; ortanca kullanılır (ortalama tek bir uç değerle kayar).',
      gecikme_notu: '“Gecikmiş” nitelemesi TBMM’nin KENDİ kayıt ibaresidir (“Gecikmiş Cevap”); '
        + 'sitenin koyduğu bir eşik değildir.',
      kapsam_notu: 'Cevap kaydı olmayan önergeler bu tabloda YOKTUR; tablo “kaç önerge cevapsız '
        + 'kaldı” sorusunu DEĞİL, “cevaplananlar ne kadar sürede cevaplandı” sorusunu yanıtlar.',
    };
  });

  app.get('/api/ozet/muhatap-cevap', async (req) => {
    const q = (req.query ?? {}) as { donem?: string };
    const dk = donemKos(q, 'f');
    const rows = getDb().prepare(
      `SELECT LOWER(f.muhatap) AS mid, f.durum, COUNT(*) AS n
         FROM faaliyet f
        WHERE f.kaynak='onerge' AND f.muhatap IS NOT NULL AND f.durum IS NOT NULL${dk.sql}
        GROUP BY mid, f.durum`,
    ).all(...dk.params) as { mid: string; durum: string; n: number }[];
    const harita = muhatapKurumHaritasi();
    const kurumlar = new Map<string, { kurum: string; toplam: number; suresinde: number; gec: number; hic: number }>();
    for (const r of rows) {
      const ad = harita.get(r.mid);
      if (!ad) continue;
      if (!kurumlar.has(ad)) kurumlar.set(ad, { kurum: ad, toplam: 0, suresinde: 0, gec: 0, hic: 0 });
      const k = kurumlar.get(ad)!;
      k.toplam += r.n;
      const s = cevapSinifi(r.durum);
      if (s === 'suresinde') k.suresinde += r.n;
      else if (s === 'gec') k.gec += r.n;
      else if (s === 'hic') k.hic += r.n;
    }
    const liste = [...kurumlar.values()]
      .filter((k) => k.toplam >= 100)
      .map((k) => ({ ...k, hic_pay: Number(((100 * k.hic) / k.toplam).toFixed(1)) }))
      .sort((a, b) => b.hic_pay - a.hic_pay);
    const kapsanan = liste.reduce((s, k) => s + k.toplam, 0);
    const toplamOnerge = rows.reduce((s, r) => s + r.n, 0);

    const SIFIR_UUID = '00000000-0000-0000-0000-000000000000';
    const sifirlar = (getDb().prepare(
      `SELECT COUNT(*) c FROM faaliyet f
        WHERE f.kaynak='onerge' AND LOWER(f.muhatap)=?${dk.sql}`,
    ).get(SIFIR_UUID, ...dk.params) as { c: number }).c;
    const veriYok = kapsanan === 0 && sifirlar > 0;

    return {
      success: true, donem: q.donem ?? String(AKTIF_DONEM),
      kapsanan, toplam: toplamOnerge, kurumlar: liste,
      muhatapsiz: sifirlar,
      sebep: veriYok
        ? `Bu dönemde önergelerin muhatap kurumu kayıtlı değil: ${sifirlar.toLocaleString('tr-TR')} `
          + `önergenin tamamında alan boş bir kimlikle (sıfır-UUID) gelmiş. Alan teknik olarak dolu `
          + `görünür ama hangi kuruma sorulduğu bilgisini taşımaz — bu yüzden kurum bazlı cevaplanma `
          + `bu dönem için HESAPLANAMAZ. Önergelerin genel cevaplanma durumu ise bu dönemde de mevcut.`
        : null,
    };
  });

  app.get('/api/ozet/son-hareket', async (req) => {
    const q = (req.query ?? {}) as { gun?: string };
    const gun = Math.min(90, Math.max(1, Number(q.gun) || 7));
    const db = getDb();
    const enSon = (db.prepare(
      `SELECT MAX(t) t FROM (
         SELECT MAX(tarih) t FROM faaliyet WHERE tarih IS NOT NULL
         UNION ALL SELECT MAX(tarih) FROM oy)`,
    ).get() as { t: string | null }).t;
    if (!enSon) return { success: true, bos: true };
    const sinir = (db.prepare(`SELECT date(?, '-${gun} days') d`).get(enSon) as { d: string }).d;

    const say = (sql: string, ...p: unknown[]) =>
      (db.prepare(sql).get(...(p as never[])) as { n: number }).n;

    const yeniTeklif = say(`SELECT COUNT(*) n FROM faaliyet WHERE kaynak='kanun' AND tarih > ?`, sinir);
    const kanunlasan = say(
      `SELECT COUNT(*) n FROM olay o WHERE o.tip='durum' AND o.yeni_durum='KANUNLAŞTI' AND o.olay_tarih > ?`,
      sinir,
    );
    const oylama = say(`SELECT COUNT(DISTINCT birlesim_id||'|'||sira_sayisi) n FROM oylama WHERE tarih > ?`, sinir);
    const dokumluOylama = say(`SELECT COUNT(DISTINCT birlesim_id||'|'||sira_sayisi) n FROM oy WHERE tarih > ?`, sinir);
    const konusma = say(`SELECT COUNT(*) n FROM faaliyet WHERE kaynak='konusma' AND tarih > ?`, sinir);
    const birlesim = say(`SELECT COUNT(DISTINCT tarih) n FROM faaliyet WHERE kaynak='konusma' AND tarih > ?`, sinir);

    const kanunlar = (db.prepare(
      `SELECT f.baslik, f.tarih, f.detay_url url, t.sira_sayisi, t.kanun_no
         FROM olay o JOIN faaliyet f ON f.id = o.faaliyet_id
                     LEFT JOIN teklif_sirasayisi t ON t.faaliyet_id = f.id
        WHERE o.tip='durum' AND o.yeni_durum='KANUNLAŞTI' AND o.olay_tarih > ?
        ORDER BY o.olay_tarih DESC LIMIT 5`,
    ).all(sinir) as unknown[]);

    const sonBirlesim = (db.prepare(
      `SELECT MAX(tarih) t FROM faaliyet WHERE kaynak='konusma' AND tarih IS NOT NULL`,
    ).get() as { t: string | null }).t;
    const sonOylama = (db.prepare(`SELECT MAX(tarih) t FROM oylama`).get() as { t: string | null }).t;
    const sonDokum = (db.prepare(`SELECT MAX(tarih) t FROM oy`).get() as { t: string | null }).t;
    const sonKanun = (db.prepare(
      `SELECT MAX(tarih) t FROM faaliyet WHERE kaynak='kanun' AND durum='KANUNLAŞTI' AND tarih IS NOT NULL`,
    ).get() as { t: string | null }).t;

    return {
      success: true, bos: false, gun, referans: enSon, sinir,
      sayim: { yeni_teklif: yeniTeklif, kanunlasan, oylama, oylama_dokumlu: dokumluOylama, konusma, birlesim },
      kanunlar,
      en_son: { birlesim: sonBirlesim, oylama: sonOylama, kanun: sonKanun, dokum: sonDokum },
    };
  });

  app.get('/api/ozet/kanun-hikaye', async (req) => {
    const q = (req.query ?? {}) as { ss?: string; id?: string };
    const db = getDb();
    const kayit = q.id
      ? db.prepare(
          `SELECT f.id, f.baslik, f.ozet, f.durum, f.tarih, f.detay_url, f.donem,
                  t.sira_sayisi, t.kanun_no, t.esas_no, t.gelis_tarihi
             FROM faaliyet f LEFT JOIN teklif_sirasayisi t ON t.faaliyet_id = f.id
            WHERE f.id = ? AND f.kaynak='kanun'`,
        ).get(Number(q.id))
      : db.prepare(
          `SELECT f.id, f.baslik, f.ozet, f.durum, f.tarih, f.detay_url, f.donem,
                  t.sira_sayisi, t.kanun_no, t.esas_no, t.gelis_tarihi
             FROM faaliyet f JOIN teklif_sirasayisi t ON t.faaliyet_id = f.id
            WHERE t.sira_sayisi = ? AND f.kaynak='kanun'
            ORDER BY f.tarih DESC LIMIT 1`,
        ).get(String(q.ss ?? ''));
    if (!kayit) return { success: true, bulundu: false };
    const k = kayit as { id: number; baslik: string; ozet: string; durum: string; tarih: string | null;
      detay_url: string; donem: number; sira_sayisi: string | null; kanun_no: string | null;
      esas_no: string | null; gelis_tarihi: string | null };

    const imzalar = db.prepare(
      `SELECT CASE WHEN parti IN ${PARTI_DISI_SQL} THEN 'Bilinmiyor' ELSE parti END AS parti,
              COUNT(*) n, SUM(ilk_imza) ilk
         FROM imza WHERE faaliyet_id = ? GROUP BY 1 ORDER BY n DESC`,
    ).all(k.id) as { parti: string; n: number; ilk: number }[];
    const ilkImza = db.prepare(
      `SELECT ad_soyad, CASE WHEN parti IN ${PARTI_DISI_SQL} THEN 'Bilinmiyor' ELSE parti END AS parti
         FROM imza WHERE faaliyet_id = ? AND ilk_imza = 1 LIMIT 1`,
    ).get(k.id) as { ad_soyad: string; parti: string } | undefined;

    const ss = k.sira_sayisi ?? '';
    const pen = k.donem ? donemPencere({ donem: String(k.donem) }) : null;
    const oylama = ss
      ? (db.prepare(
          `SELECT birlesim_id, tarih, kullanilan, kabul, ret, cekimser, basilmis_url FROM oylama
            WHERE sira_sayisi = ?${pen ? ' AND tarih >= ? AND tarih <= ?' : ''}
            ORDER BY tarih DESC LIMIT 1`,
        ).get(...(pen ? [ss, pen.lo, pen.hi] : [ss])) as { birlesim_id: string; tarih: string; kullanilan: number; kabul: number; ret: number; cekimser: number; basilmis_url: string | null } | undefined)
      : undefined;
    const oyKapi = oylama ? ' AND birlesim_id = ?' : pen ? ' AND tarih >= ? AND tarih <= ?' : '';
    const oyArg = oylama ? [oylama.birlesim_id] : pen ? [pen.lo, pen.hi] : [];
    const partiOy = ss
      ? (db.prepare(
          `SELECT CASE WHEN parti IN ${PARTI_DISI_SQL} THEN 'Bilinmiyor' ELSE parti END AS parti,
                  SUM(CASE WHEN oy='Kabul' THEN 1 ELSE 0 END) kabul,
                  SUM(CASE WHEN oy='Ret' THEN 1 ELSE 0 END) ret,
                  SUM(CASE WHEN oy='Çekimser' THEN 1 ELSE 0 END) cekimser,
                  SUM(CASE WHEN oy='Katılmadı' THEN 1 ELSE 0 END) katilmadi,
                  COUNT(*) toplam
             FROM oy WHERE sira_sayisi = ?${oyKapi} GROUP BY 1
            ORDER BY (kabul+ret+cekimser) DESC`,
        ).all(ss, ...oyArg) as unknown[])
      : [];
    const vekilOyVar = (partiOy as { toplam: number }[]).reduce((a, b) => a + b.toplam, 0) > 0;

    const oyDurumu = vekilOyVar
      ? 'var'
      : !ss
        ? 'ss-yok'
        : oylama
          ? 'toplu'
          : 'kayit-yok';

    const po = partiOy as { kabul: number; ret: number; cekimser: number; katilmadi: number }[];
    const turetilmis = vekilOyVar && !oylama
      ? {
          kullanilan: po.reduce((a2, b2) => a2 + b2.kabul + b2.ret + b2.cekimser, 0),
          kabul: po.reduce((a2, b2) => a2 + b2.kabul, 0),
          ret: po.reduce((a2, b2) => a2 + b2.ret, 0),
          cekimser: po.reduce((a2, b2) => a2 + b2.cekimser, 0),
          tarih: null as string | null, birlesim_id: '' as string,
        }
      : null;

    const cetvelTop = vekilOyVar
      ? po.reduce((a2, b2) => ({ kabul: a2.kabul + b2.kabul, ret: a2.ret + b2.ret, cekimser: a2.cekimser + b2.cekimser }), { kabul: 0, ret: 0, cekimser: 0 })
      : null;
    const celiski = oylama && cetvelTop
      && (cetvelTop.kabul !== oylama.kabul || cetvelTop.ret !== oylama.ret || cetvelTop.cekimser !== oylama.cekimser)
      ? {
          tutanak: { kabul: oylama.kabul, ret: oylama.ret, cekimser: oylama.cekimser },
          cetvel: cetvelTop,
          fark: {
            kabul: cetvelTop.kabul - oylama.kabul,
            ret: cetvelTop.ret - oylama.ret,
            cekimser: cetvelTop.cekimser - oylama.cekimser,
          },
        }
      : null;

    const gunFark = k.gelis_tarihi && oylama?.tarih
      ? Math.round((Date.parse(oylama.tarih) - Date.parse(k.gelis_tarihi)) / 86_400_000)
      : null;

    const anlasmaKanunu = /uygun\s+bulundu[ğg]una\s+dair\s+kanun/i.test(k.baslik ?? '');
    const aymIlk = (db.prepare('SELECT MIN(karar_tarihi) t FROM aym_karar').get() as { t: string | null }).t;
    const pencereIci = !aymIlk || !k.tarih || k.tarih >= aymIlk;
    const aymUygulanabilir = pencereIci && !!k.kanun_no && !anlasmaKanunu;
    let aym: unknown = null;
    if (aymUygulanabilir) {
      const kararlar = db.prepare(
        `SELECT id, esas_no, karar_no, karar_tarihi, sonuc_kod, basvuru_turu, konu, url, rg_tarihi, rg_sayisi
           FROM aym_karar WHERE konu IS NOT NULL`,
      ).all() as { id: number; esas_no: string; karar_no: string; karar_tarihi: string; sonuc_kod: string;
        basvuru_turu: string; konu: string; url: string; rg_tarihi: string | null; rg_sayisi: string | null }[];

      const rgIdx = new Map<string, { tarih: string; sayi: string; url: string }>();
      for (const g of db.prepare(
        `SELECT tarih, sayi, baslik, url FROM gazete WHERE tur = 'ANAYASA MAHKEMESİ KARARLARI'`,
      ).all() as { tarih: string; sayi: string; baslik: string; url: string }[]) {
        const a = esasKararAnahtari(g.baslik);
        if (a && !rgIdx.has(a)) rgIdx.set(a, { tarih: g.tarih, sayi: rgSayiNorm(g.sayi), url: g.url });
      }

      const kanunYili = Number(String(k.gelis_tarihi ?? k.tarih ?? '').slice(0, 4)) || 0;
      const bulunan: Record<string, unknown>[] = [];
      for (const kr of kararlar) {
        const atif = kanunAtiflari(kr.konu);
        if (torbaKararMi(kr.konu, atif.length)) continue;
        const es = atif.find((a) => a.no === k.kanun_no && !a.olumsuz);
        if (!es) continue;
        const esasYili = Number(String(kr.esas_no).slice(0, 4)) || 0;
        if (kanunYili && esasYili && esasYili < kanunYili) continue;
        if (k.gelis_tarihi && kr.karar_tarihi && kr.karar_tarihi < k.gelis_tarihi) continue;
        bulunan.push({
          esas_no: kr.esas_no, karar_no: kr.karar_no, tarih: kr.karar_tarihi,
          sonuc_kod: kr.sonuc_kod,
          sonuc: AYM_SONUC_ETIKET[kr.sonuc_kod] ?? AYM_SONUC_ETIKET.diger,
          basvuru: AYM_BASVURU_ETIKET[kr.basvuru_turu] ?? null,
          rol: es.ana ? 'ana' : 'metin-ici',
          esastan: esastanMi(kr.sonuc_kod),
          rg_tarihi: kr.rg_tarihi || null,
          rg_sayisi: rgSayiNorm(kr.rg_sayisi) === '0' ? null : rgSayiNorm(kr.rg_sayisi) || null,
          rg_url: rgIdx.get(`${kr.esas_no}|${kr.karar_no}`)?.url ?? null,
          url: kr.url,
        });
      }
      bulunan.sort((a, b) => String(b.tarih).localeCompare(String(a.tarih)));
      const kapsam = db.prepare('SELECT MIN(karar_tarihi) lo, MAX(karar_tarihi) hi, COUNT(*) n FROM aym_karar')
        .get() as { lo: string; hi: string; n: number };
      aym = {
        kararlar: bulunan,
        esas_n: bulunan.filter((b) => b.esastan).length,
        usul_n: bulunan.filter((b) => !b.esastan).length,
        ana_n: bulunan.filter((b) => b.rol === 'ana').length,
        kapsam,
      };
    }

    const komisyonHam = db
      .prepare(`SELECT tip, ad, giris, cikis, islem FROM teklif_komisyon WHERE faaliyet_id = ?
                 ORDER BY CASE tip WHEN 'Esas' THEN 0 ELSE 1 END, giris`)
      .all(k.id) as { tip: string; ad: string; giris: string | null; cikis: string | null; islem: string | null }[];

    const uyeSorgu = db.prepare(
      `SELECT parti, COUNT(*) AS n FROM vekil_komisyon
        WHERE komisyon_norm = ? AND donem = ? AND parti IS NOT NULL AND parti <> ''
        GROUP BY parti ORDER BY n DESC`,
    );
    const komisyon = komisyonHam.map((c) => {
      const partiler = uyeSorgu.all(komisyonNorm(c.ad), k.donem) as { parti: string; n: number }[];
      return {
        ...c,
        uyeler: partiler,
        uye_toplam: partiler.reduce((s, p) => s + p.n, 0),
      };
    });
    const komisyonUyeNot = komisyon.some((c) => c.uye_toplam > 0)
      ? 'Üye dağılımı TBMM’nin vekil kayıtlarından derlendi; komisyondaki sandalye dağılımını '
        + 'gösterir, o teklife kimin nasıl oy verdiğini DEĞİL (komisyon oylamaları tutanağa '
        + 'vekil bazında geçmez).'
      : null;

    const duyurular = k.kanun_no
      ? (db.prepare(
          `SELECT d.baslik, d.tur, d.tarih, d.url FROM duyuru d
             LEFT JOIN duyuru_inceleme di ON di.gazete_id=d.gazete_id AND di.kanun_no=d.kanun_no
            WHERE d.kanun_no = ? AND (di.bayrak IS NULL OR di.bayrak != 'yanlis')
            ORDER BY d.tarih DESC LIMIT 30`,
        ).all(k.kanun_no) as { baslik: string; tur: string | null; tarih: string | null; url: string | null }[])
      : [];

    return {
      success: true, bulundu: true,
      komisyon,
      komisyon_uye_not: komisyonUyeNot,
      duyurular,
      duyuru_not: duyurular.length
        ? 'Bu kanunu uygulayan/atıf yapan sonraki resmî düzenlemeler (Resmî Gazete). Başlıklar '
          + 'AYNEN alınmıştır; bir haber akışı değil, kanunun resmî izidir.'
        : null,
      katilmadi_notu: KATILMADI_NOTU,
      aym, aym_uygulanabilir: aymUygulanabilir,
      aym_yok_sebep: aymUygulanabilir ? null
        : !pencereIci
          ? `Bu kanun, Anayasa Mahkemesi korpusumuzun başlangıcından (${aymIlk}) önce çıktı. `
            + `Aleyhine açılmış bir dava penceremizin DIŞINDA kalmış olabilir; bu, kanunun `
            + `denetlenmediği anlamına GELMEZ.`
          : anlasmaKanunu
            ? null
            : `Bu belgede kanun numarası yok; köprü kanun numarası üzerinden kurulur.`,
      kanun: {
        id: k.id, baslik: k.baslik, durum: k.durum, tarih: k.tarih, donem: k.donem,
        sira_sayisi: k.sira_sayisi, kanun_no: k.kanun_no, url: k.detay_url,
        esas_no: k.esas_no,
        gelis_tarihi: k.gelis_tarihi,
        surec_gun: gunFark !== null && gunFark >= 0 ? gunFark : null,
      },
      imza: {
        toplam: imzalar.reduce((a, b) => a + b.n, 0), partiler: imzalar, ilk: ilkImza ?? null,
        kisiler: db.prepare(
          `SELECT ad_soyad, CASE WHEN parti IN ${PARTI_DISI_SQL} THEN NULL ELSE parti END AS parti,
                  ilk_imza
             FROM imza WHERE faaliyet_id = ?
            ORDER BY ilk_imza DESC, ad_soyad LIMIT 400`,
        ).all(k.id) as { ad_soyad: string; parti: string | null; ilk_imza: number }[],
        kaynak_dogrulanmis: (db.prepare(
          `SELECT COUNT(*) c FROM imza WHERE faaliyet_id = ? AND parti_kaynak = 'tbmm'`,
        ).get(k.id) as { c: number }).c,
      },
      oy: { durum: oyDurumu, ozet: oylama ?? turetilmis, ozet_kaynagi: oylama ? 'tutanak' : (turetilmis ? 'cetvel-toplami' : null), partiler: partiOy,
            celiski, url: oylama ? tutanakUrl(oylama.birlesim_id) : null,
            kanit_pdf: oylama?.basilmis_url ?? null },
    };
  });

  app.get('/api/ozet/kanunlar', async (req) => {
    const q = (req.query ?? {}) as { donem?: string; limit?: string };
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 8));
    const dk = donemKos(q);
    const db = getDb();
    const kayitlar = db.prepare(
      `SELECT f.tarih, f.baslik, f.detay_url AS url, fp.parti, t.sira_sayisi, t.kanun_no
         FROM faaliyet f LEFT JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
         LEFT JOIN teklif_sirasayisi t ON t.faaliyet_id = f.id
        WHERE f.kaynak='kanun' AND f.durum='KANUNLAŞTI' AND f.baslik IS NOT NULL${dk.sql}
        ORDER BY f.tarih DESC, f.id DESC LIMIT ?`,
    ).all(...dk.params, limit) as { tarih: string; baslik: string; url: string | null; parti: string | null; sira_sayisi: string | null; kanun_no: string | null }[];
    const toplam = (db.prepare(
      `SELECT COUNT(*) c FROM faaliyet f WHERE f.kaynak='kanun' AND f.durum='KANUNLAŞTI'${dk.sql}`,
    ).get(...dk.params) as { c: number }).c;
    return { success: true, donem: q.donem ?? String(AKTIF_DONEM), toplam, kayitlar };
  });

  app.get('/api/ozet/son-degisiklik', async (req) => {
    const q = (req.query ?? {}) as { limit?: string; donem?: string };
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 10));
    const dk = donemKos(q, 'f');
    const kayitlar = getDb().prepare(
      `SELECT o.olay_tarih AS farkedilme, o.eski_durum, o.yeni_durum,
              f.kaynak, f.baslik, f.detay_url AS url, fp.parti
         FROM olay o
         JOIN faaliyet f ON f.id = o.faaliyet_id
         LEFT JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
        WHERE o.tip='durum'${dk.sql}
        ORDER BY o.olay_tarih DESC LIMIT ?`,
    ).all(...dk.params, limit) as Record<string, unknown>[];
    return { success: true, donem: q.donem ?? String(AKTIF_DONEM), sayi: kayitlar.length, kayitlar };
  });

  app.get('/api/ozet/konusma-ara', async (req) => {
    const q = (req.query ?? {}) as { q?: string; donem?: string; limit?: string };
    const terim = (q.q ?? '').trim();
    if (terim.length < 3) return { success: false, error: 'en az 3 harf' };
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 12));
    const dk = donemKos(q, 'f');
    const db2 = getDb();
    const ak = aramaKosulu(terim);
    const kosul = `f.kaynak='konusma' AND ${ak.sql} AND f.tarih IS NOT NULL${dk.sql}`;
    const toplam = (db2.prepare(`SELECT COUNT(*) c FROM faaliyet f WHERE ${kosul}`)
      .get(...ak.params, ...dk.params) as { c: number }).c;
    const partiSay = db2.prepare(
      `SELECT COALESCE(fp.parti,'Bilinmiyor') AS parti, COUNT(*) AS n
         FROM faaliyet f LEFT JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
        WHERE ${kosul} GROUP BY COALESCE(fp.parti,'Bilinmiyor') ORDER BY n DESC`,
    ).all(...ak.params, ...dk.params) as { parti: string; n: number }[];
    const partiDagilim = partiSay.filter((r) => !PARTI_DISI.has(r.parti));
    const yurutmeN = partiSay.find((r) => r.parti === 'YÜRÜTME')?.n ?? 0;
    const bilinmiyorN = partiSay.find((r) => r.parti === 'Bilinmiyor')?.n ?? 0;
    const sinifToplamKonusma = partiDagilim.reduce((s, r) => s + r.n, 0);
    const kayitlar = db2.prepare(
      `SELECT f.ozet AS konusmaci, f.baslik AS metin, f.tarih, f.detay_url AS url,
              CASE WHEN fp.parti IN ${PARTI_DISI_SQL} THEN NULL ELSE fp.parti END AS parti,
              CASE WHEN fp.parti = 'YÜRÜTME' THEN 1 ELSE 0 END AS yurutme
         FROM faaliyet f LEFT JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
        WHERE ${kosul}
        ORDER BY f.tarih DESC LIMIT ?`,
    ).all(...ak.params, ...dk.params, limit) as { konusmaci: string; metin: string; tarih: string; url: string; parti: string | null; yurutme: number }[];
    const kes = (m: string) => {
      const ml = trLower(m);
      let i = -1;
      for (const w of ak.kelimeler) { const p = ml.indexOf(w); if (p >= 0 && (i < 0 || p < i)) i = p; }
      const bas = i > 60 ? i - 60 : 0;
      return (bas > 0 ? '…' : '') + m.slice(bas, bas + 240).trim();
    };
    aramaLogYaz('konusma-ara', terim, q.donem ?? null, toplam);
    return {
      success: true, terim, donem: q.donem ?? String(AKTIF_DONEM),
      toplam, gosterilen: kayitlar.length, sayi: kayitlar.length,
      konusma_kalite_notu: konusmaKaliteNotu(q),
      parti_dagilim: { partiler: partiDagilim, yurutme_n: yurutmeN, bilinmiyor_n: bilinmiyorN, sinif_toplam: sinifToplamKonusma },
      kayitlar: kayitlar.map((r) => ({
        konusmaci: r.konusmaci, parti: r.parti, tarih: r.tarih, url: r.url,
        yurutme: r.yurutme === 1,
        alinti: kes(r.metin ?? ''),
      })),
    };
  });

  app.get('/api/ozet/onerge-ara', async (req) => {
    const q = (req.query ?? {}) as { q?: string; donem?: string; limit?: string };
    const terim = (q.q ?? '').trim();
    if (terim.length < 3) return { success: false, error: 'en az 3 harf' };
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 12));
    const dk = donemKos(q, 'f');
    const db2 = getDb();
    const ak = aramaKosulu(terim);
    const kosul = `f.kaynak='onerge' AND ${ak.sql} AND f.tarih IS NOT NULL${dk.sql}`;

    const toplam = (db2.prepare(`SELECT COUNT(*) c FROM faaliyet f WHERE ${kosul}`)
      .get(...ak.params, ...dk.params) as { c: number }).c;

    const durumSay = db2.prepare(
      `SELECT f.durum, COUNT(*) n FROM faaliyet f WHERE ${kosul} GROUP BY f.durum`,
    ).all(...ak.params, ...dk.params) as { durum: string | null; n: number }[];
    const cevap = { suresinde: 0, gec: 0, hic: 0, bilinmiyor: 0 };
    for (const d of durumSay) cevap[cevapSinifi(d.durum)] += d.n;
    const sinifToplam = cevap.suresinde + cevap.gec + cevap.hic;

    const kayitlar = db2.prepare(
      `SELECT f.baslik AS soru, f.ozet AS soran, f.tarih, f.durum, f.detay_url AS url,
              CASE WHEN fp.parti IN ${PARTI_DISI_SQL} THEN NULL ELSE fp.parti END AS parti
         FROM faaliyet f LEFT JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
        WHERE ${kosul}
        ORDER BY f.tarih DESC, f.id DESC LIMIT ?`,
    ).all(...ak.params, ...dk.params, limit) as { soru: string; soran: string; tarih: string; durum: string | null; url: string; parti: string | null }[];

    aramaLogYaz('onerge-ara', terim, q.donem ?? null, toplam);
    return {
      success: true, terim, donem: q.donem ?? String(AKTIF_DONEM),
      toplam, gosterilen: kayitlar.length,
      kapsam: 'Bu arama yalnız YAZILI SORU önergelerini kapsar. Gensoru, Meclis araştırması/'
        + 'soruşturması, genel görüşme ve sözlü soru bu korpusta yer almaz; bir partinin denetim '
        + 'faaliyetinin tamamı olarak okunmamalıdır.',
      cevap: {
        ...cevap,
        sinif_toplam: sinifToplam,
        hic_pay: sinifToplam ? Number(((100 * cevap.hic) / sinifToplam).toFixed(1)) : null,
      },
      kayitlar: kayitlar.map((r) => ({
        soru: r.soru, soran: r.soran, parti: r.parti, tarih: r.tarih,
        durum: r.durum, cevap_sinifi: cevapSinifi(r.durum), url: r.url,
      })),
    };
  });

  app.get('/api/ozet/kanun-ara', async (req) => {
    const q = (req.query ?? {}) as { q?: string; donem?: string; limit?: string };
    const terim = (q.q ?? '').trim();
    if (terim.length < 3) return { success: false, error: 'en az 3 harf' };
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 8));
    const dk = donemKos(q, 'f');
    const db2 = getDb();
    const ak = aramaKosulu(terim);
    const kosul = `f.kaynak='kanun' AND ${ak.sql} AND f.tarih IS NOT NULL${dk.sql}`;

    const toplam = (db2.prepare(`SELECT COUNT(*) c FROM faaliyet f WHERE ${kosul}`)
      .get(...ak.params, ...dk.params) as { c: number }).c;

    const durumDagilim = db2.prepare(
      `SELECT COALESCE(NULLIF(TRIM(f.durum),''),'(durum yazılmamış)') AS durum, COUNT(*) AS n
         FROM faaliyet f WHERE ${kosul} GROUP BY durum ORDER BY n DESC`,
    ).all(...ak.params, ...dk.params) as { durum: string; n: number }[];

    const partiSay = db2.prepare(
      `SELECT COALESCE(fp.parti,'Bilinmiyor') AS parti, COUNT(*) AS n,
              SUM(CASE WHEN TRIM(COALESCE(f.durum,''))='KANUNLAŞTI' THEN 1 ELSE 0 END) AS kanunlasti
         FROM faaliyet f LEFT JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
        WHERE ${kosul} GROUP BY COALESCE(fp.parti,'Bilinmiyor') ORDER BY n DESC`,
    ).all(...ak.params, ...dk.params) as { parti: string; n: number; kanunlasti: number }[];
    const partiDagilim = partiSay.filter((r) => !PARTI_DISI.has(r.parti));
    const artik = partiSay.filter((r) => PARTI_DISI.has(r.parti));

    const kayitlar = db2.prepare(
      `SELECT f.baslik AS baslik, f.tarih, f.durum, f.detay_url AS url, t.sira_sayisi AS sira_sayisi,
              CASE WHEN fp.parti IN ${PARTI_DISI_SQL} THEN NULL ELSE fp.parti END AS parti
         FROM faaliyet f LEFT JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
                         LEFT JOIN teklif_sirasayisi t ON t.faaliyet_id = f.id
        WHERE ${kosul}
        ORDER BY f.tarih DESC, f.id DESC LIMIT ?`,
    ).all(...ak.params, ...dk.params, limit) as { baslik: string; tarih: string; durum: string | null; url: string; sira_sayisi: string | null; parti: string | null }[];

    aramaLogYaz('kanun-ara', terim, q.donem ?? null, toplam);
    return {
      success: true, terim, donem: q.donem ?? String(AKTIF_DONEM),
      toplam, gosterilen: kayitlar.length,
      durum_dagilim: durumDagilim,
      parti_dagilim: { partiler: partiDagilim, artik },
      kayitlar,
    };
  });

  app.get('/api/ozet/ara-parti-donem', async (req) => {
    const q = (req.query ?? {}) as { q?: string };
    const terim = (q.q ?? '').trim();
    if (terim.length < 3) return { success: false, error: 'en az 3 harf' };
    const db2 = getDb();
    const ak = aramaKosulu(terim);
    const kosul = `f.kaynak IN ('onerge','konusma','kanun') AND ${ak.sql} AND fp.parti NOT IN ${PARTI_DISI_SQL}`;

    const detayHam = db2.prepare(
      `SELECT f.donem AS donem, fp.parti AS parti, f.kaynak AS kaynak, COUNT(*) AS n
         FROM faaliyet f JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
        WHERE ${kosul} GROUP BY f.donem, fp.parti, f.kaynak`,
    ).all(...ak.params) as { donem: number; parti: string; kaynak: string; n: number }[];

    const toplam = detayHam.reduce((s, r) => s + r.n, 0);
    const donemToplam = new Map<number, number>();
    const partiToplam = new Map<string, number>();
    const hucreToplam = new Map<string, number>();
    for (const r of detayHam) {
      donemToplam.set(r.donem, (donemToplam.get(r.donem) ?? 0) + r.n);
      partiToplam.set(r.parti, (partiToplam.get(r.parti) ?? 0) + r.n);
      const k = `${r.donem}|${r.parti}`;
      hucreToplam.set(k, (hucreToplam.get(k) ?? 0) + r.n);
    }
    const donemler = [...donemToplam.keys()].sort((a, b) => a - b);
    const PARTI_MAX = 10;
    const partiler = [...partiToplam.entries()].sort((a, b) => b[1] - a[1]).slice(0, PARTI_MAX).map(([p]) => p);
    const partilerSet = new Set(partiler);
    const kirpilanParti = partiToplam.size - partiler.length;

    const kismiDonemler = [...new Set(
      getEtlDurum().filter((r) => r.kaynak === 'konusma' && r.durum === 'kismi' && donemToplam.has(r.donem)).map((r) => r.donem),
    )].sort((a, b) => a - b);

    aramaLogYaz('ara-parti-donem', terim, null, toplam);
    return {
      success: true, terim, toplam,
      kaynaklar: ['onerge', 'konusma', 'kanun'],
      donemler, partiler, kirpilan_parti: kirpilanParti, kismi_donemler: kismiDonemler,
      hucre: [...hucreToplam.entries()].map(([k, n]) => {
        const [donem, parti] = k.split('|');
        return { donem: Number(donem), parti, n };
      }).filter((r) => partilerSet.has(r.parti)),
      detay: detayHam.filter((r) => partilerSet.has(r.parti)),
    };
  });

  app.get('/api/ozet/konu-cevap', async (req) => {
    const q = (req.query ?? {}) as { taban?: string };
    const TABAN = Math.max(100, Number(q.taban) || 300);
    const rows = getDb().prepare(
      `SELECT kategori, durum, COUNT(*) n FROM faaliyet
        WHERE kaynak='onerge' AND donem IN (26,27) AND kategori IS NOT NULL AND durum IS NOT NULL
        GROUP BY kategori, durum`,
    ).all() as { kategori: string; durum: string; n: number }[];

    const konu = new Map<string, { konu: string; toplam: number; suresinde: number; gec: number; hic: number }>();
    for (const r of rows) {
      if (!konu.has(r.kategori)) konu.set(r.kategori, { konu: r.kategori, toplam: 0, suresinde: 0, gec: 0, hic: 0 });
      const k = konu.get(r.kategori)!;
      const s = cevapSinifi(r.durum);
      if (s === 'bilinmiyor') continue;
      k.toplam += r.n;
      k[s] += r.n;
    }
    const liste = [...konu.values()]
      .filter((k) => k.toplam >= TABAN)
      .map((k) => ({ ...k, hic_pay: Number(((100 * k.hic) / k.toplam).toFixed(1)) }))
      .sort((a, b) => b.hic_pay - a.hic_pay);
    const elenen = [...konu.values()].filter((k) => k.toplam < TABAN);

    return {
      success: true,
      donemler: [26, 27],
      taban: TABAN,
      konular: liste,
      taban_alti: { konu_n: elenen.length, kayit_n: elenen.reduce((s, k) => s + k.toplam, 0) },
      beyan: '26 ve 27. dönem verisidir. 28. dönem BİLEREK dışarıda: o dönemde konu etiketinin '
        + '%72,8\'i doğrudan sorunun muhatabı olan bakanlıktan türetiliyor, dolayısıyla '
        + '"konu × cevapsızlık" kesişimi kendi girdisini geri okur. Konu ekseni model/anahtar '
        + 'kelime TAHMİNİDİR; cevaplanma durumu ise TBMM\'nin kendi alanıdır. Ölçülen şey '
        + 'yürütmenin cevap verme davranışıdır — soruyu soranın partisine hiçbir atıf yapılmaz.',
    };
  });

  app.get('/api/ozet/onerge-durum', async (req) => {
    const q = (req.query ?? {}) as { donem?: string };
    const dk = donemKos(q);
    const rows = getDb().prepare(
      `SELECT f.durum, COUNT(*) AS n FROM faaliyet f
        WHERE f.kaynak='onerge' AND f.durum IS NOT NULL${dk.sql}
        GROUP BY f.durum ORDER BY n DESC`,
    ).all(...dk.params) as { durum: string; n: number }[];
    const toplam = rows.reduce((s, r) => s + r.n, 0);
    return {
      success: true, donem: q.donem ?? String(AKTIF_DONEM), toplam,
      dagilim: rows.map((r) => ({ durum: r.durum, n: r.n, pay: toplam ? Number(((100 * r.n) / toplam).toFixed(1)) : 0 })),
    };
  });

  app.get('/api/ozet/vekil-konusma', async (req) => {
    const q = (req.query ?? {}) as { il?: string; ad?: string; soyad?: string; limit?: string };
    if (!q.il || !q.ad || !q.soyad) return { success: false, error: 'il, ad, soyad gerekli' };
    const n = Math.min(Number(q.limit) || 5, 20);
    const aday = getDb().prepare(
      `SELECT f.ozet, f.baslik, f.tarih, f.detay_url, f.kategori
         FROM faaliyet f
        WHERE f.kaynak='konusma' AND f.ozet LIKE ? AND f.tarih IS NOT NULL AND f.baslik IS NOT NULL
        ORDER BY f.tarih DESC`,
    ).all('%(' + q.il + ')') as { ozet: string; baslik: string; tarih: string; detay_url: string; kategori: string }[];
    const hedefKel = cleanStr(`${q.ad} ${q.soyad}`).split(/\s+/).filter(Boolean);
    const konusmaciKel = (ozet: string): string[] =>
      cleanStr(
        String(ozet ?? '')
          .replace(/\s*\(Devamla\)\s*/gi, ' ')
          .replace(/\s*\([^)]*\)\s*$/, '')
          .replace(/^\s*GRUBU\s+ADINA\s+/i, ''),
      ).split(/\s+/).filter(Boolean);
    const eslesen = aday.filter((r) => {
      const K = konusmaciKel(r.ozet);
      if (!K.length) return false;
      return hedefKel.every((w) => K.includes(w)) || K.every((w) => hedefKel.includes(w));
    });
    const kayitlar = eslesen
      .slice(0, n)
      .map((r) => ({ tarih: r.tarih, url: r.detay_url, alinti: (r.baslik ?? '').trim().slice(0, 240) }));
    return { success: true, il: q.il, ad: q.ad, soyad: q.soyad, toplam: eslesen.length, kayitlar };
  });

  app.get('/api/ozet/birlesim', async (req) => {
    const q = (req.query ?? {}) as { donem?: string; b?: string; limit?: string };
    const db = getDb();

    if (q.b) {
      const kayitlar = db.prepare(
        `SELECT f.ozet AS konusmaci, f.tarih, f.baslik AS metin, f.detay_url AS url,
                CASE WHEN fp.parti IN ${PARTI_DISI_SQL} THEN NULL ELSE fp.parti END AS parti
           FROM faaliyet f LEFT JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
          WHERE f.kaynak='konusma' AND f.kaynak_id LIKE ?
          ORDER BY f.id`,
      ).all(`${q.b}:%`) as { konusmaci: string; tarih: string; metin: string; url: string; parti: string | null }[];
      if (!kayitlar.length) return { success: true, bulundu: false, birlesim: q.b };
      return {
        success: true, bulundu: true, birlesim: q.b,
        tarih: kayitlar[0]!.tarih,
        sayi: kayitlar.length,
        kayitlar: kayitlar.map((r) => ({
          konusmaci: r.konusmaci, parti: r.parti, url: r.url,
          alinti: (r.metin ?? '').trim().slice(0, 260),
        })),
      };
    }

    const dk = donemKos(q, 'f');
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 40));
    const satir = db.prepare(
      `SELECT substr(f.kaynak_id, 1, instr(f.kaynak_id, ':') - 1) AS birlesim,
              MIN(f.tarih) AS tarih, COUNT(*) AS konusma_n
         FROM faaliyet f
        WHERE f.kaynak='konusma' AND instr(f.kaynak_id, ':') > 0${dk.sql}
        GROUP BY birlesim ORDER BY tarih DESC LIMIT ?`,
    ).all(...dk.params, limit) as { birlesim: string; tarih: string; konusma_n: number }[];
    const toplam = (db.prepare(
      `SELECT COUNT(DISTINCT substr(f.kaynak_id, 1, instr(f.kaynak_id, ':') - 1)) c
         FROM faaliyet f WHERE f.kaynak='konusma' AND instr(f.kaynak_id, ':') > 0${dk.sql}`,
    ).get(...dk.params) as { c: number }).c;

    return {
      success: true, donem: q.donem ?? String(AKTIF_DONEM),
      toplam, gosterilen: satir.length, birlesimler: satir,
    };
  });

  app.get('/api/ozet/vekil-onerge', async (req) => {
    const q = (req.query ?? {}) as { il?: string; ad?: string; soyad?: string; limit?: string; donem?: string };
    if (!q.il || !q.ad || !q.soyad) return { success: false, error: 'il, ad, soyad gerekli' };
    const n = Math.min(Number(q.limit) || 5, 20);
    const dk = donemKos(q, 'f');
    const db2 = getDb();
    const ilBuyuk = q.il.toLocaleUpperCase('tr');
    const aday = db2.prepare(
      `SELECT f.ozet, f.baslik, f.tarih, f.durum, f.detay_url
         FROM faaliyet f
        WHERE f.kaynak='onerge' AND f.ozet LIKE ? AND f.tarih IS NOT NULL AND f.baslik IS NOT NULL${dk.sql}
        ORDER BY f.tarih DESC`,
    ).all(`${ilBuyuk} Milletvekili %`, ...dk.params) as { ozet: string; baslik: string; tarih: string; durum: string | null; detay_url: string }[];

    const hedefAd = cleanStr(`${q.ad} ${q.soyad}`);
    const hedefIl = cleanStr(q.il);
    const benim = aday.filter((r) => {
      const [ilKismi, adKismi] = String(r.ozet ?? '').split(/\sMilletvekili\s+/u);
      return cleanStr(ilKismi ?? '') === hedefIl && cleanStr(adKismi ?? '') === hedefAd;
    });

    const cevap = { suresinde: 0, gec: 0, hic: 0, bilinmiyor: 0 };
    for (const r of benim) cevap[cevapSinifi(r.durum)] += 1;
    const sinifToplam = cevap.suresinde + cevap.gec + cevap.hic;

    return {
      success: true, il: q.il, ad: q.ad, soyad: q.soyad,
      donem: q.donem ?? String(AKTIF_DONEM),
      toplam: benim.length,
      cevap: {
        ...cevap,
        sinif_toplam: sinifToplam,
        hic_pay: sinifToplam ? Number(((100 * cevap.hic) / sinifToplam).toFixed(1)) : null,
      },
      kayitlar: benim.slice(0, n).map((r) => ({
        tarih: r.tarih, url: r.detay_url, durum: r.durum,
        cevap_sinifi: cevapSinifi(r.durum), soru: (r.baslik ?? '').trim(),
      })),
    };
  });

  app.get('/api/ozet/vekil-komisyon', async (req) => {
    const q = (req.query ?? {}) as { ad?: string; soyad?: string; donem?: string };
    if (!q.ad || !q.soyad) return { success: false, error: 'ad, soyad gerekli' };
    const adSoyad = `${q.ad} ${q.soyad}`.toLocaleUpperCase('tr');
    const donem = Number(q.donem) || AKTIF_DONEM;
    const kayitlar = getDb()
      .prepare(`SELECT komisyon, rol FROM vekil_komisyon WHERE ad_soyad = ? AND donem = ? ORDER BY komisyon`)
      .all(adSoyad, donem) as { komisyon: string; rol: string | null }[];
    return { success: true, ad_soyad: adSoyad, donem, kayitlar };
  });

  app.get('/api/ozet/donem-karsilastir', async (req) => {
    const q = (req.query ?? {}) as { parti?: string; kaynak?: string };
    if (!q.parti) return { success: false, error: 'parti gerekli' };
    const db = getDb();
    const donemler = (db.prepare('SELECT DISTINCT donem FROM faaliyet WHERE donem IS NOT NULL ORDER BY donem').all() as { donem: number }[]).map((r) => r.donem);
    const kaynakSql = q.kaynak ? 'f.kaynak = ?' : "f.kaynak IN ('kanun','onerge')";
    const kaynakPar = q.kaynak ? [q.kaynak] : [];
    const out: { donem: number; n: number; ilk: string | null; son: string | null; yil: number; kategoriler: Record<string, number> }[] = [];
    const atlanan: { donem: number; sebep: string }[] = [];
    for (const d of donemler) {
      const dKapi = etiketKapisi({ donem: String(d) });
      if (!dKapi.yayimlanabilir) { atlanan.push({ donem: d, sebep: dKapi.sebep! }); continue; }
      const rows = db.prepare(
        `SELECT f.kategori k, COUNT(*) c FROM faaliyet f JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
         WHERE fp.parti = ? AND f.donem = ? AND ${kaynakSql} AND f.kategori != ?
         GROUP BY k`,
      ).all(q.parti, d, ...kaynakPar, OTHER_CATEGORY) as { k: string; c: number }[];
      const n = rows.reduce((s, r) => s + r.c, 0);
      if (!n) continue;
      const tarihler = db.prepare(
        `SELECT DISTINCT f.tarih t FROM faaliyet f JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
         WHERE fp.parti = ? AND f.donem = ? AND ${kaynakSql} AND f.tarih IS NOT NULL ORDER BY f.tarih LIMIT 20`,
      ).all(q.parti, d, ...kaynakPar) as { t: string }[];
      const son = db.prepare(
        `SELECT MAX(f.tarih) hi FROM faaliyet f JOIN faaliyet_parti fp ON fp.faaliyet_id = f.id
         WHERE fp.parti = ? AND f.donem = ? AND ${kaynakSql} AND f.tarih IS NOT NULL`,
      ).get(q.parti, d, ...kaynakPar) as { hi: string | null };
      const ilk = aykiriAyikla(tarihler.map((x) => x.t));
      const kategoriler: Record<string, number> = {};
      for (const r of rows) kategoriler[r.k] = Math.round((1000 * r.c) / n) / 10;
      const yil = ilk && son.hi ? Math.round(((new Date(son.hi).getTime() - new Date(ilk).getTime()) / 31557600000) * 10) / 10 : 0;
      out.push({ donem: d, n, ilk, son: son.hi, yil, kategoriler });
    }
    return { success: true, parti: q.parti, aktif_donem: AKTIF_DONEM, donemler: out, atlanan };
  });

  app.get('/api/ozet/secim-sonucu', async (req) => {
    const q = (req.query ?? {}) as { donem?: string };
    const db = getDb();
    const donemler = (db.prepare('SELECT DISTINCT donem FROM secim_sonucu ORDER BY donem DESC').all() as { donem: number }[]).map((r) => r.donem);
    if (!donemler.length) return { success: true, secim: null, donemler: [], sebep: 'YSK seçim sonucu henüz çekilmedi.' };
    const donem = q.donem && donemler.includes(Number(q.donem)) ? Number(q.donem) : donemler[0]!;
    const rows = db.prepare(
      'SELECT parti, oy, sandalye, secim_id, tarih, secim_adi, gecerli_oy_toplami, gecersiz_oy_toplami, secmen_sayisi, katilma_orani FROM secim_sonucu WHERE donem = ? ORDER BY oy DESC',
    ).all(donem) as {
      parti: string; oy: number; sandalye: number | null; secim_id: number; tarih: string; secim_adi: string | null;
      gecerli_oy_toplami: number | null; gecersiz_oy_toplami: number | null; secmen_sayisi: number | null; katilma_orani: number | null;
    }[];
    if (!rows.length) return { success: true, secim: null, donemler, sebep: `Dönem ${donem} için satır yok.` };
    const ilk = rows[0]!;
    const partiOyToplami = rows.reduce((s, r) => s + r.oy, 0);
    const fark = (ilk.gecerli_oy_toplami ?? 0) - partiOyToplami;
    const farkOrani = ilk.gecerli_oy_toplami ? (100 * fark) / ilk.gecerli_oy_toplami : 0;

    const oran = (oy: number) => (ilk.gecerli_oy_toplami ? Math.round((10000 * oy) / ilk.gecerli_oy_toplami) / 100 : null);
    const sandalyeBiliniyor = rows.some((r) => r.sandalye !== null);
    const belirgin = (sandalyeBiliniyor ? rows.filter((r) => (r.sandalye ?? 0) > 0) : rows.filter((r) => oran(r.oy)! >= 1))
      .map((r) => ({ parti: r.parti, oy: r.oy, oran: oran(r.oy), sandalye: r.sandalye }))
      .sort((a, b) => (sandalyeBiliniyor ? (b.sandalye ?? 0) - (a.sandalye ?? 0) : (b.oran ?? 0) - (a.oran ?? 0)));
    const digerRows = sandalyeBiliniyor ? rows.filter((r) => (r.sandalye ?? 0) === 0) : rows.filter((r) => oran(r.oy)! < 1);
    const diger = digerRows.length ? {
      n: digerRows.length,
      oy: digerRows.reduce((s, r) => s + r.oy, 0),
      oran: oran(digerRows.reduce((s, r) => s + r.oy, 0)),
    } : null;
    const toplamSandalye = sandalyeBiliniyor ? belirgin.reduce((s, r) => s + (r.sandalye ?? 0), 0) : null;

    return {
      success: true,
      donemler,
      secim: {
        donem, secim_id: ilk.secim_id, tarih: ilk.tarih, secim_adi: ilk.secim_adi,
        secmen_sayisi: ilk.secmen_sayisi, katilma_orani: ilk.katilma_orani,
        gecerli_oy_toplami: ilk.gecerli_oy_toplami, gecersiz_oy_toplami: ilk.gecersiz_oy_toplami,
        parti_oy_toplami: partiOyToplami,
        toplam_sandalye: toplamSandalye,
        sandalye_biliniyor: sandalyeBiliniyor,
        partiler: belirgin,
        diger,
        tum_partiler: rows.map((r) => ({ parti: r.parti, oy: r.oy, oran: oran(r.oy), sandalye: r.sandalye })),
        kaynak_url: SANDALYE_PDF[donem] ?? TARIHSEL_SECIM_PDF[donem]?.url ?? null,
        kapsam_notu:
          'Ülke geneli (yurt içi + yurt dışı sandıklar) — il/seçim çevresi kırılımı bu kaynakta yok. '
          + (Math.abs(farkOrani) >= 0.1
            ? `Parti oyları toplamı (${partiOyToplami.toLocaleString('tr-TR')}), YSK'nin ülke geneli geçerli oy `
              + `toplamından (${(ilk.gecerli_oy_toplami ?? 0).toLocaleString('tr-TR')}) yaklaşık %${Math.abs(farkOrani).toFixed(2)} ${fark >= 0 ? 'düşük' : 'yüksek'} `
              + (sandalyeBiliniyor
                ? `— aradaki fark muhtemelen bu veri kaynağının parti kırılımında yer almayan gümrük/yurt dışı sandık kayıtlarından kaynaklanıyor.`
                : `— aradaki küçük fark bu tarihsel kaynağın kendi il-bazlı derlemesinden geliyor, ayrıştırma hatası değil (bkz. kaynak PDF).`)
            : 'Parti oyları toplamı, YSK\'nin ülke geneli geçerli oy toplamıyla örtüşüyor.')
          + (sandalyeBiliniyor
            ? ` Sandalye sayısı YSK'nin ayrı "Kesin Seçim Sonuçları" duyurusundan.`
            : ` Bu seçim için sandalye (kazanılan milletvekili) dağılımı kaynakta yok — yalnızca oy sayıları gösteriliyor.`),
      },
    };
  });

  app.get('/api/ozet/meta', async () => {
    const db = getDb();
    const aylar = (db.prepare('SELECT DISTINCT ay FROM faaliyet WHERE ay IS NOT NULL ORDER BY ay').all() as { ay: string }[]).map((r) => r.ay);
    const donemler = (db.prepare('SELECT DISTINCT donem FROM faaliyet WHERE donem IS NOT NULL ORDER BY donem DESC').all() as { donem: number }[]).map((r) => r.donem);
    const partiler = (db.prepare(`SELECT DISTINCT parti FROM faaliyet_parti WHERE parti NOT IN ${PARTI_DISI_SQL} ORDER BY parti`).all() as { parti: string }[]).map((r) => r.parti);
    const toplam = (db.prepare('SELECT COUNT(*) c FROM faaliyet').get() as { c: number }).c;
    const kirilim: Record<string, number> = {};
    for (const r of db.prepare('SELECT kaynak, COUNT(*) c FROM faaliyet GROUP BY kaynak').all() as { kaynak: string; c: number }[]) kirilim[r.kaynak] = r.c;
    const kaynaklar = {
      tbmm: { kayit: toplam, kirilim, son: (db.prepare('SELECT MAX(tarih) m FROM faaliyet').get() as { m: string | null }).m, donemler, url: 'https://www.tbmm.gov.tr' },
      gazete: { ...kaynakSayimi('gazete', 'tarih'), url: 'https://www.resmigazete.gov.tr' },
      aym: { ...kaynakSayimi('aym_karar', 'karar_tarihi'), url: 'https://normkararlarbilgibankasi.anayasa.gov.tr' },
      tuik: {
        ...kaynakSayimi('tuik', 'tarih'),
        gostergeler: (db.prepare('SELECT DISTINCT gosterge g FROM tuik ORDER BY g').all() as { g: string }[]).map((r) => r.g),
        url: 'https://www.tuik.gov.tr',
      },
      ysk: {
        ...kaynakSayimi('secim_sonucu', 'tarih'),
        donemler: (db.prepare('SELECT DISTINCT donem FROM secim_sonucu ORDER BY donem DESC').all() as { donem: number }[]).map((r) => r.donem),
        url: 'https://www.ysk.gov.tr',
      },
      parti_program: kaynakSayimi('parti_program', 'guncelleme'),
      yerel_yonetim: {
        karar: kaynakSayimi('yerel_karar', 'tarih'),
        belediyeler: (db.prepare('SELECT DISTINCT belediye b FROM yerel_karar ORDER BY b').all() as { b: string }[]).map((r) => r.b),
      },
    };
    return {
      success: true,
      aylar,
      donemler,
      partiler,
      kategoriler: ALL_CATEGORIES,
      toplam_kayit: toplam,
      kaynaklar,
      etl_durum: getEtlDurum(),
    };
  });
}
