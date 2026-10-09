
import { classifyNB, modelKategorileri } from './nb.js';

export const TAXONOMY_VERSION = 5;

export const WORD_CLASS = '[\\p{L}\\p{N}_]';

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function trLower(s: string): string {
  return s.replace(/İ/g, 'i').replace(/I/g, 'ı').toLowerCase();
}

export function countKeyword(word: string, text: string): number {
  let base = word;
  let guard = '';
  const ti = word.indexOf('~');
  if (ti >= 0) {
    base = word.slice(0, ti);
    guard = word.slice(ti + 1);
  }
  const la = guard ? `(?!${escapeRegExp(guard)})` : '';
  const re = new RegExp(`(?<!${WORD_CLASS})${escapeRegExp(base)}${la}${WORD_CLASS}*`, 'gu');
  let count = 0;
  while (re.exec(text) !== null) count += 1;
  return count;
}

export const CATEGORIES: Record<string, string[]> = {
  'Afet & Acil Durum': ['deprem', 'afet', 'afad', 'heyelan', 'yangın', 'çığ', 'taşkın', 'su baskın', 'sel felaket', 'fay hattı', 'enkaz', 'zelzele', 'artçı', 'tsunami', 'olağanüstü hal', 'acil durum'],
  'Enerji & Madencilik': ['enerji', 'elektrik', 'doğalgaz', 'doğal gaz', 'petrol', 'akaryakıt', 'maden', 'kömür', 'linyit', 'nükleer', 'epdk', 'santral', 'rafineri', 'boru hattı', 'yenilenebilir', 'jeotermal', 'botaş', 'termik', 'elektrik zam', 'benzin', 'motorin', 'lpg'],
  'Sağlık': ['sağlık', 'hastane', 'doktor', 'hekim', 'ilaç', 'eczane', 'tedavi', 'hasta', 'aşı', 'ameliyat', 'poliklinik', 'tıbbi', 'salgın', 'hemşire', 'ambulans', 'kanser', 'diyaliz', 'aile hekim', 'tıp fakült', 'engelli', 'randevu', 'sağlık ocağ', 'kızılay', 'sağlık çalışan', 'ebe', 'psikolog', 'obezite', 'bağımlılık', 'hıfzıssıhha'],
  'Eğitim': ['okul', 'öğretmen', 'öğrenci', 'üniversite', 'eğitim', 'yök', 'müfredat', 'yükseköğretim', 'lise', 'ilkokul', 'ortaokul', 'ösym', 'yks', 'kyk', 'akademi', 'öğretim', 'sınav', 'burs', 'kreş', 'anaokul', 'meb', 'diploma', 'denklik', 'öğrenim', 'mezun', 'dershane', 'imam hatip', 'meslek lise', 'okul öncesi', 'seçme ve yerleştirme'],
  'Çalışma & Sosyal Güvenlik': ['işçi', 'memur', 'kadro', 'sözleşmeli', 'taşeron', 'sendika', 'işsiz', 'işten', 'işveren', 'kamu personel', 'kpss', 'mülakat', 'atama', 'işkur', 'çalışan', 'işyeri', 'iş kaza', 'norm kadro', 'ek gösterge', 'özlük', 'grev', 'toplu sözleşme', 'iş güvenli', 'meslek hastalı', 'emekçi', 'işe iade', 'ücretli öğretmen', 'iş kanun', 'kıdem tazmin', 'fazla mesai', 'iş sözleşme', 'çalışma hayat', 'işgücü', 'muhtaç', 'aylık bağlan', 'sosyal hizmet'],
  'Ulaştırma & Altyapı': ['karayol', 'otoyol', 'otoban', 'köprü', 'havaliman', 'havayol', 'demiryol', 'ulaşım', 'ulaştırma', 'altyapı', 'liman', 'metro', 'yht', 'trafik', 'kavşak', 'tünel', 'raylı', 'toplu taşıma', 'otobüs', 'tren', 'uçak', 'thy', 'tcdd', 'bölünmüş yol', 'duble yol', 'viyadük', 'feribot', 'kgm', 'ehliyet', 'plaka', 'asfalt', 'yol bakım', 'yol onarım', 'yol yapım', 'yol çalışma', 'stabilize', 'menfez', 'sahil yol', 'çevre yol'],
  'Adalet & Hukuk': ['ceza', 'mahkeme', 'hâkim', 'hakim', 'savcı', 'avukat', 'hukuk', 'infaz', 'hapis', 'anayasa', 'yargı', 'tutuklu', 'tutukla', 'adalet', 'adli', 'dava', 'soruşturma', 'yargıtay', 'danıştay', 'icra', 'gözaltı', 'cezaevi', 'hükümlü', 'yolsuzluk', 'rüşvet', 'dokunulmazlık', 'istinaf', 'baro', 'kadı'],
  'Güvenlik & Savunma': ['asker', 'polis', 'jandarma', 'güvenlik', 'savunma', 'terör', 'tsk', 'silahlı kuvvet', 'şehit', 'gazi', 'emniyet', 'asayiş', 'suç örgüt', 'uyuşturucu', 'kaçakçılık', 'istihbarat', 'savunma sanayi', 'mit', 'pkk', 'hudut', 'komando', 'özel harekat', 'bekçi', 'silah', 'sınır güvenli', 'erbaş', 'astsubay', 'subay', 'uzman çavuş', 'sahil güvenlik', 'jandarma karakol', 'muvazzaf', 'pasaport', 'gösteri yürüyüş'],
  'Dış Politika': ['dışişleri', 'büyükelçi', 'konsolosluk', 'nato', 'avrupa birliği', 'diplomat', 'mülteci', 'göçmen', 'sığınmacı', 'yurt dışı', 'dış politika', 'vize', 'suriyeli', 'uygur', 'filistin', 'gazze', 'kıbrıs', 'sınır ötesi', 'yabancı uyruklu', 'elçilik', 'göç idaresi', 'uluslararası', 'soykırım', 'ambargo'],
  'Kadın, Aile & Çocuk': ['kadın', 'aile', 'çocuk', 'şiddet', 'istismar', 'boşanma', 'nafaka', 'evlilik', 'kadına yönelik', 'toplumsal cinsiyet', 'ev içi', 'koruma karar', 'kadın cinayet', 'çocuk işçi', 'bebek', 'anne', 'yaşlı bakım'],
  'Konut & Şehircilik': ['konut', 'imar', 'toki', 'ruhsat', 'iskan', 'kentsel dönüşüm', 'gecekondu', 'emlak', 'tapu', 'müteahhit', 'kat mülkiyet', 'kira', 'kiracı', 'barınma', 'riskli yapı', 'rezerv alan', 'yapı ruhsat', 'imar plan'],
  'Yerel Yönetim': ['belediye', 'muhtar', 'büyükşehir', 'il özel idare', 'kaymakam', 'valilik', 'mahalle', 'il genel meclis', 'beldes', 'kayyum', 'vali', 'il kurul', 'ilçe kurul', 'mahalli idare', 'köy tüzel', 'meclis üye'],
  'Din & İnanç': ['diyanet', 'cami', 'imam', 'umre', 'kuran', 'müftü', 'hutbe', 'ezan', 'ilahiyat', 'cemev', 'ibadethane', 'din görevli', 'gayrimüslim', 'hac ibadet', 'kuran kurs'],
  'Kültür, Turizm & Spor': ['turizm', 'sanat', 'kültür~sinde', 'müze', 'spor', 'futbol', 'stadyum', 'sporcu', 'olimpiyat', 'tarihi eser', 'festival', 'sinema', 'tiyatro', 'otel', 'turist', 'milli takım', 'ören yer', 'sit alan', 'kütüphane', 'konser', 'arkeoloji', 'basın', 'gazeteci', 'medya', 'rtük', 'sansür', 'trt', 'televizyon', 'radyo', 'yayıncı', 'reklam', 'gazete', 'ulusal bayram', 'genel tatil'],
  'Çevre & Tarım': ['çevre~sinde', 'orman', 'tarım', 'çiftçi', 'hayvan', 'gıda', 'iklim', 'doğa', 'toprak', 'sulama', 'baraj', 'balık', 'zeytin', 'fındık', 'buğday', 'hasat', 'gübre', 'mera', 'kirlilik', 'atık', 'su ürün', 'mısır', 'pancar', 'tütün', 'arıcı', 'süt üretic', 'sera', 'tohum', 'kuraklık', 'ormanlık', 'hava kirlil', 'duman', 'haşere', 'sivrisinek', 'koku', 'arıtma', 'emisyon', 'dere ıslah', 'dere yatağ', 'çöp', 'geri dönüşüm', 'sera gazı', 'milli park', 'su kanun'],
  'Ekonomi & Finans': ['vergi', 'faiz', 'bütçe', 'kredi', 'hazine', 'maaş', 'emekli', 'borç', 'ticaret', 'istihdam', 'sigorta', 'sgk', 'ekonomi', 'banka', 'finans', 'enflasyon', 'döviz', 'dolar', 'asgari ücret', 'yatırım', 'ihracat', 'ithalat', 'esnaf', 'tüketici', 'fiyat', 'teşvik', 'zam~an', 'maliye', 'harç', 'prim', 'kdv', 'ötv', 'bütçe açığ', 'zamlar', 'amme alacak', 'borç yapılandır', 'vergi af', 'matrah', 'gümrük', 'kur korumalı', 'hayat pahalı', 'yoksul', 'açlık sınır', 'geçim', 'gelir dağılım', 'yaşam maliyet', 'satın alma güc', 'yoksulluk sınır', 'ihale'],
};

export const CATEGORY_NAMES = Object.keys(CATEGORIES);
export const OTHER_CATEGORY = 'Diğer';

export const MUHATAP_KATEGORI: Record<number, Record<string, string>> = {
  28: {
    'e3ce1232-4307-435c-b361-4ae5c53ee75a': 'MULTI',
    'bd9fadf2-93ba-4a18-9979-01888f881d3a': 'MULTI',
    '23caa63b-efc8-4e3a-8e8d-019c4d4f68fc': 'Adalet & Hukuk',
    'f47e3e8e-a4b6-4170-9edf-01888f89ce16': 'Adalet & Hukuk',
    '050b9aa4-255a-4d83-8f36-01888f8ac96b': 'Kadın, Aile & Çocuk',
    '30113760-2d92-4b49-b6b2-01888f8b7200': 'Çalışma & Sosyal Güvenlik',
    'f7c04932-84ff-48c2-a884-01907254761a': 'MULTI',
    '9a5beffb-44c8-42f7-a64a-01888f8c99c6': 'MULTI',
    'b268bd1d-0376-45da-a9ba-01888f8d2bc0': 'Dış Politika',
    '33900f98-4f2f-49cd-8251-01888f8fa87b': 'Enerji & Madencilik',
    '49f139e8-81cf-40fe-8bc6-01888f904ae4': 'Kültür, Turizm & Spor',
    '29669c6c-01a1-45d1-a3c5-01888f9110e4': 'Ekonomi & Finans',
    'c37a0947-b190-4037-9d4c-019c4c9236e8': 'MULTI',
    '2aa51e07-88d7-4642-bfac-01888f91aca1': 'MULTI',
    '82c6a9e5-0676-4c44-83e2-01888f92441e': 'Kültür, Turizm & Spor',
    '193c5bce-438f-4771-949a-01888f936251': 'Eğitim',
    '07041329-d38c-49c1-8e84-01888f93cf19': 'Güvenlik & Savunma',
    '007a6836-79c8-4ecb-8152-01907343309e': 'Sağlık',
    '48addca0-945d-4886-9c2a-01888f94b1c9': 'Sağlık',
    'e5fdeb55-8cd1-44ad-a06c-01888f952bb1': 'Ekonomi & Finans',
    'e0c4fc5e-e037-4b3c-8d5a-01888f971079': 'Çevre & Tarım',
    'd0ab6f77-a66f-45e2-a0bc-01888f97a58b': 'Ekonomi & Finans',
    'df0a4762-181e-4ea4-86d7-01888f9889e4': 'Ulaştırma & Altyapı',
  },
};

export interface ClassifyOpts {
  muhatapId?: string | null;
  donem?: number | null;
  kaynak?: 'kanun' | 'onerge' | 'konusma';
  announceLabel?: string | null;
}

export type KategoriKaynak = 'muhatap' | 'duyuru' | 'model' | 'keyword' | 'diger';
export interface ClassifyResult { cat: string; kaynak: KategoriKaynak; }

export function classifyByKeyword(text: string): { cat: string; score: number } {
  const lower = trLower(text);
  let bestCat = CATEGORY_NAMES[0];
  let bestScore = -1;
  for (const cat of CATEGORY_NAMES) {
    let s = 0;
    for (const w of CATEGORIES[cat]) s += countKeyword(w, lower);
    if (s > bestScore) {
      bestScore = s;
      bestCat = cat;
    }
  }
  return { cat: bestScore > 0 ? bestCat : OTHER_CATEGORY, score: Math.max(bestScore, 0) };
}

export function keywordSkorlari(text: string): Record<string, number> {
  const lower = trLower(text);
  const out: Record<string, number> = {};
  for (const cat of CATEGORY_NAMES) {
    let s = 0;
    for (const w of CATEGORIES[cat]) s += countKeyword(w, lower);
    if (s > 0) out[cat] = s;
  }
  return out;
}

const YUKSEK_KESINLIK: Array<[string, string]> = [
  ['muayene ve kabul', 'Ekonomi & Finans'],
  ['kamu ihale', 'Ekonomi & Finans'],
  ['kamu alımlar', 'Ekonomi & Finans'],
  ['mesafeli sözleşme', 'Ekonomi & Finans'],
  ['finansal hizmet', 'Ekonomi & Finans'],
  ['medeni kanun', 'Adalet & Hukuk'],
  ['ticaret kanun', 'Ekonomi & Finans'],
  ['noterlik kanun', 'Adalet & Hukuk'],
  ['ceza muhakemesi', 'Adalet & Hukuk'],
  ['hakimler ve savcılar', 'Adalet & Hukuk'],
  ['yükseköğretim kanun', 'Eğitim'],
  ['kat mülkiyet', 'Konut & Şehircilik'],
  ['sınai mülkiyet', 'Ekonomi & Finans'],
  ['sağlık hizmetleri temel', 'Sağlık'],
  ['endüstri bölgeleri', 'Ekonomi & Finans'],
  ['tabipleri birli', 'Sağlık'],
  ['eczacılar birli', 'Sağlık'],
  ['parasının kıymetini', 'Ekonomi & Finans'],
];
for (const [, cat] of YUKSEK_KESINLIK) {
  if (!CATEGORY_NAMES.includes(cat)) throw new Error(`YUKSEK_KESINLIK geçersiz kategori: "${cat}" (CATEGORY_NAMES'de yok)`);
}
export function yuksekKesinlikOverride(text: string): string | null {
  const t = trLower(text).replace(/î/g, 'i').replace(/â/g, 'a').replace(/û/g, 'u');
  for (const [ibare, cat] of YUKSEK_KESINLIK) if (t.includes(ibare)) return cat;
  return null;
}

export function classifyDetailed(text: string, opts: ClassifyOpts = {}): ClassifyResult {
  if (opts.kaynak === 'onerge' && opts.muhatapId && opts.donem != null) {
    const m = MUHATAP_KATEGORI[opts.donem]?.[opts.muhatapId.toLowerCase()];
    if (m && m !== 'MULTI') return { cat: m, kaynak: 'muhatap' };
  }
  if (opts.kaynak === 'konusma' && opts.announceLabel && CATEGORY_NAMES.includes(opts.announceLabel)) {
    return { cat: opts.announceLabel, kaynak: 'duyuru' };
  }
  if (opts.kaynak !== 'konusma') {
    const ov = yuksekKesinlikOverride(text);
    if (ov) return { cat: ov, kaynak: 'keyword' };
  }
  const nb = classifyNB(text, opts.kaynak === 'kanun' || opts.kaynak === 'onerge');
  if (nb && nb.decided) {
    const uretebilir = modelKategorileri();
    const ks = keywordSkorlari(text);
    let disCat = ''; let disSkor = 0; let icMax = 0;
    for (const [c, s] of Object.entries(ks)) {
      if (uretebilir.has(c)) icMax = Math.max(icMax, s);
      else if (s > disSkor) { disSkor = s; disCat = c; }
    }
    if (disCat && disSkor >= 2 && disSkor > icMax) return { cat: disCat, kaynak: 'keyword' };
    return { cat: nb.cat, kaynak: 'model' };
  }
  const kw = classifyByKeyword(text);
  if (kw.score > 0) return { cat: kw.cat, kaynak: 'keyword' };
  return { cat: OTHER_CATEGORY, kaynak: 'diger' };
}

export function classify(text: string, opts: ClassifyOpts = {}): string {
  return classifyDetailed(text, opts).cat;
}
