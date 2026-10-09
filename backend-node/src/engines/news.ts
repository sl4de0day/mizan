import { Defuddle } from 'defuddle/node';
import * as cheerio from 'cheerio';
import { getLogger } from '../lib/logger.js';
import { httpFetch, proxyUrlForKaynak } from '../lib/http.js';
import { izinliMi, izinliZincir, kaynakForUrl } from '../lib/kaynakIzin.js';

const logger = getLogger('PoliticalInsight.Kaynak');

export class NewsEngine {
  private userAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  async extractFromHtml(html: string, url: string): Promise<{ success: boolean; data?: unknown; error?: string }> {
    try {
      const result = await Defuddle(html, url, { markdown: false });
      const $ = cheerio.load(result.content ?? '');
      const parts: string[] = [];
      $('p, h1, h2, h3, h4, h5, li, blockquote, pre').each((_, el) => {
        const t = $(el).text().trim();
        if (t) parts.push(t);
      });
      let text = parts.join('\n\n');
      if (!text) text = $.root().text().trim();

      const keywords: string[] = [];
      for (const m of result.metaTags ?? []) {
        const key = (m.name || m.property || '').toLowerCase();
        if ((key === 'keywords' || key === 'news_keywords') && m.content) {
          for (const kw of m.content.split(',').map((s) => s.trim()).filter(Boolean)) keywords.push(kw);
        }
      }
      const allImages: string[] = $('img')
        .map((_, el) => $(el).attr('src') || '')
        .get()
        .filter(Boolean);

      const data = {
        title: result.title || 'Başlık bulunamadı',
        text: text || 'İçerik ayıklanamadı.',
        author: result.author || 'Bilinmiyor',
        date: result.published || 'Bilinmiyor',
        description: result.description || '',
        source_url: url,
        publisher: result.site || result.domain || '',
        image: result.image || '',
        all_images: allImages,
        keywords,
        tags: [] as string[],
        categories: [] as string[],
        text_length: (text || '').length,
        extraction_sources: { defuddle: true },
      };
      return { success: true, data };
    } catch (e) {
      return { success: false, error: `İçerik çekilemedi: ${(e as Error).message}` };
    }
  }

  async extractContent(url: string): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const ilk = izinliMi(url);
    if (!ilk.izinli) return { success: false, error: `Kaynak izinli değil: ${ilk.sebep}` };

    const zincir: string[] = [url];
    let simdiki = url;
    try {
      for (let sicrama = 0; sicrama < 5; sicrama++) {
        const hopKaynak = kaynakForUrl(simdiki);
        const r = await httpFetch(simdiki, {
          headers: { 'User-Agent': this.userAgent, 'Accept-Language': 'tr' },
          timeoutMs: 20000,
          followRedirects: false,
          proxyUrl: hopKaynak ? proxyUrlForKaynak(hopKaynak) : undefined,
        });
        if (r.status >= 300 && r.status < 400) {
          const hedef = r.headers.get('location');
          if (!hedef) return { success: false, error: 'Yönlendirme hedefi yok' };
          simdiki = new URL(hedef, simdiki).toString();
          zincir.push(simdiki);
          const z = izinliZincir(zincir);
          if (!z.izinli) return { success: false, error: z.sebep };
          continue;
        }
        if (!r.ok) return { success: false, error: `Kaynak HTTP ${r.status}` };
        return await this.extractFromHtml(await r.text(), simdiki);
      }
      return { success: false, error: 'Yönlendirme zinciri çok uzun' };
    } catch (e) {
      logger.error(`Ayıklama hatası: ${(e as Error).message}`);
      return { success: false, error: `İçerik çekilemedi: ${(e as Error).message}` };
    }
  }
}
