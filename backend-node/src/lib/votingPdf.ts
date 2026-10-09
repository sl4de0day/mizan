import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface OyKaydi {
  il: string;
  soyad: string;
  ad: string;
  parti: string;
  oy: string;
}
export interface OzetKutusu {
  sira_sayisi: string;
  uye: number; kabul: number; ret: number; cekimser: number;
  bos: number; gecersiz: number; mukerrer: number; toplam: number; acik_uyelik: number;
}
export interface CetvelSonuc {
  ozetler: OzetKutusu[];
  oylar: Map<string, OyKaydi[]>;
  sayfa: number;
  cakisma: string[];
}

interface Parca { t: string; x: number; y: number; s: number }

const OY_DESEN = /^(Kabul|Ret|Çekimser|Katılmadı|Mük\.|Boş|Geçersiz)(?:$|\/|\s+\d+\s*\(Mük\.\d*\))/;
export function oyCoz(s: string): string | null {
  const m = OY_DESEN.exec(s.replace(/[¹²³⁴⁵]/g, '').trim());
  return m ? m[1]! : null;
}

function parcalar(items: { str: string; transform: number[] }[]): Parca[] {
  const ham = items
    .filter((i) => i.str.trim())
    .map((i) => ({ t: i.str.trim(), x: +i.transform[4]!.toFixed(1), y: +i.transform[5]!.toFixed(1), s: +i.transform[0]!.toFixed(2) }));
  const gorulen = new Set<string>();
  const out: Parca[] = [];
  for (const i of ham) {
    const k = `${i.t}|${Math.round(i.x * 2)}|${Math.round(i.y * 2)}|${i.s}`;
    if (gorulen.has(k)) continue;
    gorulen.add(k);
    out.push(i);
  }
  return out;
}

function tamKopya(p: Parca[]): Parca[] | null {
  let en: { b: Parca[]; n: number } | null = null;
  for (const s of new Set(p.map((i) => i.s))) {
    const b = p.filter((i) => i.s === s);
    const n = b.filter((i) => /^S\. S\. \d+$/.test(i.t)).length;
    if (!en || n > en.n) en = { b, n };
  }
  return en && en.n > 0 ? en.b : null;
}

const SATIR_TOLERANS = 3;
function satirla(p: Parca[]): Parca[][] {
  const sirali = [...p].sort((a, b) => b.y - a.y);
  const gruplar: Parca[][] = [];
  let grup: Parca[] = [];
  let merkez = Infinity;
  for (const i of sirali) {
    if (grup.length && Math.abs(i.y - merkez) > SATIR_TOLERANS) {
      gruplar.push(grup);
      grup = [];
    }
    if (!grup.length) merkez = i.y;
    grup.push(i);
  }
  if (grup.length) gruplar.push(grup);
  return gruplar.map((ws) => ws.sort((a, b) => a.x - b.x));
}

const SAYI = (s: string): number => { const m = /(-?\d+)/.exec(s); return m ? Number(m[1]) : 0; };

function ozetOku(blok: Parca[]): OzetKutusu[] {
  const ss = blok.filter((i) => i.t === 'Sıra Sayısı');
  if (!ss.length) return [];
  const kutular: OzetKutusu[] = [];
  for (const bas of ss.sort((a, b) => a.x - b.x)) {
    const sonraki = ss.filter((o) => o.x > bas.x + 5).sort((a, b) => a.x - b.x)[0];
    const icinde = (i: Parca): boolean => i.x >= bas.x - 3 && (!sonraki || i.x < sonraki.x - 3);
    const alan = blok.filter(icinde);
    const alanSatir = satirla(alan);
    const deger = (etiket: RegExp): number => {
      const s = alanSatir.find((ws) => ws.some((w) => etiket.test(w.t)));
      if (!s) return 0;
      const sayilar = s.filter((w) => /^\s*:?\s*-?\d+\s*$/.test(w.t));
      return sayilar.length ? SAYI(sayilar[sayilar.length - 1]!.t) : 0;
    };
    const sira = alanSatir.find((ws) => ws.some((w) => w.t === 'Sıra Sayısı'));
    const siraNo = sira?.filter((w) => /^\d+$/.test(w.t)).pop()?.t;
    if (!siraNo) continue;
    kutular.push({
      sira_sayisi: siraNo,
      uye: deger(/^Üye Sayısı\s*:?$/), kabul: deger(/^Kabul Edenler\s*:?$/), ret: deger(/^Reddedenler\s*:?$/),
      cekimser: deger(/^Çekimserler\s*:?$/), bos: deger(/^Boş\s*:?$/), gecersiz: deger(/^Geçersiz Oylar\s*:?$/),
      mukerrer: deger(/^Mükerrer Oylar\s*:?$/), toplam: deger(/^Toplam\s*:?$/), acik_uyelik: deger(/^Açık Üyelikler\s*:?$/),
    });
  }
  return kutular;
}

function sayfaCetvel(blok: Parca[]): { ozetler: OzetKutusu[]; oylar: Map<string, OyKaydi[]> } | null {
  const bas: Record<string, Parca> = {};
  for (const h of blok) {
    if (/^(İli|Soyadı|Adı|Parti)$/.test(h.t) || /^S\. S\. \d+$/.test(h.t)) {
      const v = bas[h.t];
      if (!v || h.y > v.y) bas[h.t] = h;
    }
  }
  const parti = bas['Parti'], il = bas['İli'];
  if (!parti || !il) return null;
  const oySut = Object.entries(bas).filter(([k]) => /^S\. S\. /.test(k)).map(([k, v]) => [k, v.x] as const).sort((a, b) => a[1] - b[1]);
  if (!oySut.length) return null;
  const araliklar = oySut.slice(1).map((c, i) => c[1] - oySut[i]![1]);
  const SUTUN_SINIR = araliklar.length ? Math.min(...araliklar) / 2 : 30;

  const ozetler = ozetOku(blok.filter((i) => i.y > parti.y + 5));
  const oylar = new Map<string, OyKaydi[]>();
  for (const [ss] of oySut) oylar.set(ss, []);

  const enYakin = (bx: number, tol: number) => (s: Parca[]): string => {
    let en: Parca | undefined;
    for (const k of s) if (Math.abs(k.x - bx) <= tol && (!en || Math.abs(k.x - bx) < Math.abs(en.x - bx))) en = k;
    return en?.t ?? '';
  };
  const ilOku = enYakin(il.x, 6);
  const soyOku = bas['Soyadı'] ? enYakin(bas['Soyadı'].x, 8) : () => '';
  const adOku = bas['Adı'] ? enYakin(bas['Adı'].x, 8) : () => '';
  const partiOku = enYakin(parti.x, 6);

  for (const s of satirla(blok.filter((i) => i.y < parti.y - SATIR_TOLERANS))) {
    const partiAd = partiOku(s);
    const ilAd = ilOku(s);
    if (!partiAd || !ilAd) continue;
    const pj = { t: partiAd }, ij = { t: ilAd };
    const adj = { t: adOku(s) }, soyj = { t: soyOku(s) };
    const oyJeton = s.filter((k) => oyCoz(k.t));
    for (const [ss, sx] of oySut) {
      let en: Parca | undefined;
      for (const j of oyJeton) if (!en || Math.abs(j.x - sx) < Math.abs(en.x - sx)) en = j;
      if (!en || Math.abs(en.x - sx) > SUTUN_SINIR) continue;
      oylar.get(ss)!.push({ il: ij.t, soyad: soyj.t, ad: adj.t, parti: pj.t, oy: oyCoz(en.t)! });
    }
  }
  return { ozetler, oylar };
}

export async function parseCetvel(data: Uint8Array): Promise<CetvelSonuc> {
  const doc = await getDocument({ data, verbosity: 0 }).promise;
  const oylar = new Map<string, OyKaydi[]>();
  const ozetler = new Map<string, OzetKutusu>();
  const cakisma: string[] = [];
  let sayfa = 0;
  let bulundu = false;
  for (let p = doc.numPages; p >= 1; p--) {
    const tc = await doc.getPage(p).then((pg) => pg.getTextContent());
    const blok = tamKopya(parcalar(tc.items as { str: string; transform: number[] }[]));
    const r = blok && sayfaCetvel(blok);
    if (!r) {
      if (bulundu) break;
      continue;
    }
    bulundu = true;
    sayfa++;
    for (const o of r.ozetler) {
      const eski = ozetler.get(o.sira_sayisi);
      if (!eski) { ozetler.set(o.sira_sayisi, o); continue; }
      if (eski.kabul !== o.kabul || eski.ret !== o.ret) {
        cakisma.push(`S.S.${o.sira_sayisi}: ${eski.kabul}/${eski.ret} vs ${o.kabul}/${o.ret}`);
      }
    }
    for (const [ss, arr] of r.oylar) {
      const v = oylar.get(ss) ?? [];
      v.push(...arr);
      oylar.set(ss, v);
    }
  }
  await doc.cleanup();
  return { ozetler: [...ozetler.values()], oylar, sayfa, cakisma };
}

export function kapiGecti(ozet: OzetKutusu, oylar: OyKaydi[]): boolean {
  const say = (v: string): number => oylar.filter((o) => o.oy === v).length;
  return say('Kabul') === ozet.kabul && say('Ret') === ozet.ret && say('Çekimser') === ozet.cekimser;
}
