import { cleanStr, normParti, resolveByNameIl } from './partyResolve.js';
import { classifyByKeyword } from './taxonomy.js';

const U = 'A-ZÇĞİÖŞÜÂÎÛ';
const SEP = '[-–—]';
const GRUP_RE = new RegExp(`^(?<party>[${U}][${U} .'’]+?)\\s+GRUBU\\s+ADINA\\s+(?<name>[${U}][${U} .'’]+?)\\s*\\((?<il>[^)]{1,40})\\)\\s*${SEP}\\s*(?<speech>.*)$`, 'u');
const KURSU_RE = new RegExp(`^(?<name>[${U}][${U} .'’]{2,60}?)\\s*\\((?<paren>[^)]{1,40})\\)\\s*${SEP}\\s*(?<speech>.*)$`, 'u');
const USUL_RE = new RegExp(`^(BAŞKAN|OTURUM\\s+BAŞKANI|BAŞKAN\\s+VEKİLİ|GEÇİCİ\\s+BAŞKAN|KÂTİP\\s+ÜYE|KATİP\\s+ÜYE|DİVAN)\\b`, 'u');
const SAHNE_RE = /\((?:Alkışlar|Gülüşmeler|Gülüşme|Gürültüler|Gürültü|Uğultular|Uğultu|Ayağa kalk[^)]*|Mikrofon[^)]*|[^)]*sıralarından[^)]*|[^)]*sesleri[^)]*|Kapalı otur[^)]*)\)/gu;

const MIN_METIN = 250;

const DUYURU_RE = /Milletvekili\s+(?<name>[A-ZÇĞİÖŞÜ][A-Za-zÇĞİÖŞÜçğıöşü .]{2,45}?)['’´]?(?:n?[ıiuü]n)?\s*,\s*(?<subj>[^.,][^.]{4,95}?)\s+ilişkin\s+gündem\s*dışı/u;

function announceLabel(subj: string): string | undefined {
  if (!subj || subj.length > 120) return undefined;
  const { cat, score } = classifyByKeyword(subj);
  return score >= 2 && cat !== 'Diğer' ? cat : undefined;
}

export interface ParsedSpeech {
  ad: string;
  il: string;
  parti: string;
  partiKaynak: string;
  tip: string;
  metin: string;
  kategori: string;
  duyuruEtiket?: string;
  speakerSlug: string;
}

export interface ParseStats {
  satir: number;
  baslik: number;
  baslikSatirBirlesti: number;
  usulElendi: number;
  sahneElendi: number;
  birlesikKonusmaci: number;
  gecerli: number;
  kisaSuzulen: number;
  bilinmiyor: number;
}

interface Konusmaci {
  ad: string;
  il: string;
  partiHint: string | null;
  tip: string;
  text: string[];
  duyuruEtiket?: string;
}

const slug = (s: string) =>
  cleanStr(s)
    .toLowerCase()
    .replace(/[^a-z0-9çğıöşü]+/gi, '-')
    .replace(/^-+|-+$/g, '');

export function parseSpeeches(
  rawText: string,
  opts: { donem: number | string },
): { speeches: ParsedSpeech[]; stats: ParseStats } {
  const hamLines = rawText
    .split('\n')
    .map((l) => l.replace(/[ \t\r\n]+/g, ' ').trim())
    .filter(Boolean);

  let baslikSatirBirlesti = 0;
  const lines: string[] = [];
  for (let i = 0; i < hamLines.length; i++) {
    const ln = hamLines[i]!;
    if (GRUP_RE.test(ln) || KURSU_RE.test(ln) || ln.startsWith('(')) { lines.push(ln); continue; }
    let birlesti = false;
    for (let uzat = 1; uzat <= 2 && i + uzat < hamLines.length; uzat++) {
      const aday = [ln, ...hamLines.slice(i + 1, i + 1 + uzat)].join(' ');
      if (GRUP_RE.test(aday) || KURSU_RE.test(aday)) {
        lines.push(aday);
        i += uzat;
        baslikSatirBirlesti++;
        birlesti = true;
        break;
      }
    }
    if (!birlesti) lines.push(ln);
  }

  const speakers = new Map<string, Konusmaci>();
  const keyOf = (ad: string, il: string) => cleanStr(ad) + '|' + cleanStr(il);
  let curKey: string | null = null;
  let baslik = 0;
  let usulElendi = 0;
  let sahneElendi = 0;
  let pendingDuyuru: { name: string; label: string } | null = null;
  const attachDuyuru = (sp: Konusmaci) => {
    if (!pendingDuyuru) return;
    const pn = cleanStr(pendingDuyuru.name), sn = cleanStr(sp.ad);
    if (pn && sn && (sn.includes(pn) || pn.includes(sn))) {
      if (!sp.duyuruEtiket) sp.duyuruEtiket = pendingDuyuru.label;
      pendingDuyuru = null;
    }
  };

  for (const ln of lines) {
    const dm = DUYURU_RE.exec(ln);
    if (dm?.groups) {
      const lab = announceLabel(dm.groups.subj!.trim());
      if (lab) { pendingDuyuru = { name: dm.groups.name!.trim(), label: lab }; continue; }
    }
    if (ln.startsWith('(')) {
      sahneElendi++;
      continue;
    }
    if (USUL_RE.test(ln)) {
      usulElendi++;
      curKey = null;
      continue;
    }

    const g = GRUP_RE.exec(ln);
    if (g?.groups) {
      baslik++;
      const ad = g.groups.name!.trim();
      const il = g.groups.il!.trim();
      const party = g.groups.party!.trim();
      const key = keyOf(ad, il);
      const ex = speakers.get(key);
      if (!ex) speakers.set(key, { ad, il, partiHint: party, tip: 'GRUP', text: [g.groups.speech ?? ''] });
      else {
        if (party && !ex.partiHint) ex.partiHint = party;
        ex.text.push(g.groups.speech ?? '');
      }
      attachDuyuru(speakers.get(key)!);
      curKey = key;
      continue;
    }

    const k = KURSU_RE.exec(ln);
    if (k?.groups) {
      const ad = k.groups.name!.trim();
      const paren = k.groups.paren!.trim();
      if (/^Devam/i.test(paren)) {
        const nc = cleanStr(ad);
        let found: string | null = null;
        for (const [key, sp] of speakers) if (cleanStr(sp.ad) === nc) found = key;
        if (found) {
          speakers.get(found)!.text.push(k.groups.speech ?? '');
          curKey = found;
          continue;
        }
      }
      baslik++;
      const key = keyOf(ad, paren);
      const ex = speakers.get(key);
      if (!ex) speakers.set(key, { ad, il: paren, partiHint: null, tip: 'KURSU', text: [k.groups.speech ?? ''] });
      else ex.text.push(k.groups.speech ?? '');
      attachDuyuru(speakers.get(key)!);
      curKey = key;
      continue;
    }

    if (curKey) speakers.get(curKey)!.text.push(ln);
  }

  const speeches: ParsedSpeech[] = [];
  let kisaSuzulen = 0;
  let bilinmiyor = 0;
  for (const sp of speakers.values()) {
    const metin = sp.text.join(' ').replace(SAHNE_RE, ' ').replace(/\s+/g, ' ').trim();
    if (metin.length < MIN_METIN) {
      kisaSuzulen++;
      continue;
    }
    let parti: string;
    let partiKaynak: string;
    if (sp.tip === 'GRUP' && sp.partiHint) {
      parti = normParti(sp.partiHint);
      partiKaynak = 'GRUP';
    } else {
      parti = resolveByNameIl(sp.ad, sp.il, opts.donem);
      partiKaynak = parti === 'Bilinmiyor' ? 'çözülemedi' : 'ad+il';
    }
    if (parti === 'Bilinmiyor') bilinmiyor++;
    const { cat } = classifyByKeyword(metin);
    speeches.push({
      ad: sp.ad,
      il: sp.il,
      parti,
      partiKaynak,
      tip: sp.tip,
      metin,
      kategori: cat,
      duyuruEtiket: sp.duyuruEtiket,
      speakerSlug: `${slug(sp.ad)}-${slug(sp.il)}`,
    });
  }

  return {
    speeches,
    stats: {
      satir: lines.length,
      baslik,
      baslikSatirBirlesti,
      usulElendi,
      sahneElendi,
      birlesikKonusmaci: speakers.size,
      gecerli: speeches.length,
      kisaSuzulen,
      bilinmiyor,
    },
  };
}
