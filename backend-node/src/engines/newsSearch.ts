import * as cheerio from 'cheerio';
import { getLogger } from '../lib/logger.js';
import { NewsEngine } from './news.js';

const logger = getLogger('PoliticalInsight.Admin.HaberArastirma');

const SISTEM_CHROMIUM_ADAYLARI = ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/snap/bin/chromium'];
let sistemChromiumYolu: string | null | undefined;
async function sistemChromiumBul(): Promise<string | null> {
  if (sistemChromiumYolu !== undefined) return sistemChromiumYolu;
  const { existsSync } = await import('node:fs');
  sistemChromiumYolu = SISTEM_CHROMIUM_ADAYLARI.find((p) => existsSync(p)) ?? null;
  return sistemChromiumYolu;
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface HaberAramaSonucu { title: string; url: string; date: string; source: string }

function jslogdanUrlCoz(jslog: string | undefined): string | null {
  if (!jslog) return null;
  const m = jslog.match(/5:([A-Za-z0-9+/=_-]+)/);
  if (!m) return null;
  try {
    const b64 = m[1].replace(/_/g, '/').replace(/-/g, '+');
    const eksikPadding = (4 - (b64.length % 4)) % 4;
    const decoded = Buffer.from(b64 + '='.repeat(eksikPadding), 'base64').toString('utf-8');
    const urlM = decoded.match(/https?:\/\/[^\s"'<>]+/);
    return urlM ? urlM[0] : null;
  } catch { return null; }
}

export async function googleHaberAra(secenek: {
  keyword: string; after?: string; before?: string; exclude?: string; site?: string; limit?: number;
}): Promise<HaberAramaSonucu[]> {
  const yol = await sistemChromiumBul();
  if (!yol) throw new Error('[haber-arama] sistem Chromium bulunamadı (aday yollar: ' + SISTEM_CHROMIUM_ADAYLARI.join(', ') + ')');
  let sorgu = secenek.keyword;
  if (secenek.exclude?.trim()) for (const w of secenek.exclude.split(/\s+/)) sorgu += ` -${w}`;
  if (secenek.site?.trim()) sorgu += ` site:${secenek.site}`;
  if (secenek.after?.trim()) sorgu += ` after:${secenek.after}`;
  if (secenek.before?.trim()) sorgu += ` before:${secenek.before}`;
  const url = `https://news.google.com/search?q=${encodeURIComponent(sorgu)}&hl=tr&gl=TR&ceid=TR:tr`;
  logger.info(`[haber-arama] ${url}`);

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath: yol, headless: true });
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'tr-TR', viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    const reddetBtn = await page.$('button:has-text("Tümünü reddet"), button:has-text("Reject all")');
    if (reddetBtn) { await reddetBtn.click().catch(() => {}); await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {}); }

    const limit = secenek.limit ?? 100;
    if (limit > 100) {
      const kaydirma = Math.min(Math.floor((limit - 100) / 50) + 1, 5);
      for (let i = 0; i < kaydirma; i++) {
        await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
        await page.waitForTimeout(1000);
      }
    }

    const html = await page.content();
    const $ = cheerio.load(html);
    const sonuc: HaberAramaSonucu[] = [];
    $('a.JtKRv').each((_, a) => {
      if (sonuc.length >= limit) return;
      const $a = $(a);
      const title = $a.text().trim();
      if (!title) return;
      const container = $a.closest('c-wiz').length ? $a.closest('c-wiz') : $a.parent().parent();
      const dateEl = container.find('time').first();
      const sourceEl = container.find('.vr1PYe, .Mg70ce').first();
      const hiddenLink = container.find('a.WwrzSb').first();
      const href = $a.attr('href') || '';
      const gercekUrl = jslogdanUrlCoz(hiddenLink.attr('jslog')) ?? (href.startsWith('./') ? `https://news.google.com${href.slice(1)}` : href);
      sonuc.push({ title, url: gercekUrl, date: dateEl.text().trim() || 'Bilinmiyor', source: sourceEl.text().trim() || 'Bilinmiyor' });
    });
    logger.info(`[haber-arama] ${sonuc.length} sonuç.`);
    return sonuc;
  } finally {
    await browser.close();
  }
}

async function tekSayfaIcerikCek(browser: import('playwright').Browser, url: string): Promise<{ success: boolean; data?: unknown; error?: string }> {
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT });
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      const t = route.request().resourceType();
      const u = route.request().url();
      if (['image', 'media', 'font', 'stylesheet'].includes(t) || u.includes('google-analytics') || u.includes('doubleclick')) return route.abort();
      return route.continue();
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const html = await page.content();
    await context.close();
    return await new NewsEngine().extractFromHtml(html, url);
  } catch (e) {
    return { success: false, error: `İçerik çekilemedi: ${(e as Error).message}` };
  }
}

export async function adminIcinIcerikCek(url: string): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const yol = await sistemChromiumBul();
  if (!yol) return { success: false, error: 'sistem Chromium bulunamadı' };
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath: yol, headless: true });
  try { return await tekSayfaIcerikCek(browser, url); }
  finally { await browser.close(); }
}

export async function cokluIcerikCek(urls: string[]): Promise<{ success: boolean; data?: unknown; error?: string }[]> {
  const yol = await sistemChromiumBul();
  if (!yol) return urls.map(() => ({ success: false, error: 'sistem Chromium bulunamadı' }));
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath: yol, headless: true });
  try {
    const sonuc: { success: boolean; data?: unknown; error?: string }[] = new Array(urls.length);
    const ESZAMANLI = 5;
    let sonrakiIndex = 0;
    async function isci(): Promise<void> {
      for (;;) {
        const i = sonrakiIndex++;
        if (i >= urls.length) return;
        sonuc[i] = await tekSayfaIcerikCek(browser, urls[i]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(ESZAMANLI, urls.length) }, () => isci()));
    return sonuc;
  } finally {
    await browser.close();
  }
}
