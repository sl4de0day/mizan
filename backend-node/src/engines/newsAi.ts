const MODEL = 'gemini-2.5-flash';

async function gemini(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Yapay zekâ API anahtarı (GEMINI_API_KEY) tanımlı değil.');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) throw new Error(`Gemini API HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = j.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini yanıtında metin yok.');
  return text;
}

function jsonAyikla(ham: string): unknown {
  let t = ham.trim();
  if (t.startsWith('```')) {
    t = t.split('```')[1] ?? t;
    if (t.startsWith('json')) t = t.slice(4).trim();
  }
  const bas = t.indexOf('{');
  const bit = t.lastIndexOf('}');
  if (bas !== -1 && bit !== -1) t = t.slice(bas, bit + 1);
  return JSON.parse(t);
}

export interface AiSorguParametreleri { keywords: string[]; exclude: string; site: string; after: string; before: string }

export async function aiSorguAyristir(query: string): Promise<AiSorguParametreleri> {
  const bugun = new Date().toISOString().slice(0, 10);
  const prompt = `Sen profesyonel bir "Haber Sorgu Veri Ayıklayıcı"sın. Görevin, kullanıcı metninden sadece gerekli arama parametrelerini ayıklayıp JSON formatında döndürmektir.

BUGÜNÜN TARİHİ: ${bugun}

KURALLAR:
1. Zaman Belirtilmemişse: Kullanıcı metninde bir zaman aralığı yoksa, "after" ve "before" alanlarını kesinlikle BOŞ BIRAK ("").
2. Anahtar Kelime Yapısı: Çıkarılan anahtar kelimeler mutlaka TEKİL KELİMELERDEN oluşan bir liste (array) olmalıdır. Kelime grupları yasaktır.
3. Gereksiz Kelimeleri Ayıkla: Sorgu amacı taşımayan bağlaç ve dolgu kelimelerini alma.
4. Hariç Tutma: Kullanıcı "şu kelimeler olmasın", "şunu hariç tut" gibi ifadeler kullanırsa "exclude" alanına ekle.
5. Web Sitesi: Kullanıcı spesifik bir haber sitesi/alan adı belirtirse "site" alanına ekle.
6. Çıktı: Sadece JSON, açıklama yok.

ÇIKTI FORMATI:
{"keywords": ["kelime1"], "exclude": "", "site": "", "after": "YYYY-MM-DD veya boş", "before": "YYYY-MM-DD veya boş"}

Kullanıcı Sorgusu: "${query}"
Yanıt:`;
  const data = jsonAyikla(await gemini(prompt)) as { keywords?: string[]; exclude?: string; site?: string; after?: string; before?: string };
  return { keywords: data.keywords ?? [], exclude: data.exclude ?? '', site: data.site ?? '', after: data.after ?? '', before: data.before ?? '' };
}

export interface AiKonuAnalizSonucu { ana_konu: string; alt_konular: string[]; ozet: string }

const MAKALE_KIRPMA_UZUNLUK = 4000;

export async function aiKonuAnalizEt(keyword: string, makaleler: { title: string; text: string }[]): Promise<AiKonuAnalizSonucu> {
  const gecerliler = makaleler.filter((m) => m.text && m.text.length > 100);
  if (!gecerliler.length) return { ana_konu: 'Sonuç Bulunamadı', alt_konular: [], ozet: 'Haber içerikleri alınamadı.' };
  const birlesikMetin = gecerliler
    .map((m) => `BAŞLIK: ${m.title}\nİÇERİK: ${m.text.slice(0, MAKALE_KIRPMA_UZUNLUK)}`)
    .join('\n\n---\n\n');
  const prompt = `Aşağıda "${keyword}" araması sonucu elde edilen haber metinleri yer almaktadır.
Lütfen bu haber içeriklerini derinlemesine analiz et ve "${keyword}" ile ilgili en çok hangi konunun/konuların işlendiğini belirle.
Sadece aşağıdaki JSON formatında yanıt ver, markdown veya açıklama ekleme:
{"ana_konu": "Ana gündem maddesi", "alt_konular": ["Alt konu 1", "Alt konu 2"], "ozet": "Haberlerin detaylı genel özetini anlatan Türkçe 2-3 cümle."}

METİNLER:
${birlesikMetin}`;
  const data = jsonAyikla(await gemini(prompt)) as { ana_konu?: string; alt_konular?: string[]; ozet?: string };
  return { ana_konu: data.ana_konu ?? 'Bilinmiyor', alt_konular: data.alt_konular ?? [], ozet: data.ozet ?? '' };
}
