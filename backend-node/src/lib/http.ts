import { setGlobalDispatcher, getGlobalDispatcher, ProxyAgent } from 'undici';

export type Kaynak = 'tbmm' | 'gazete' | 'aym' | 'tuik' | 'ysk' | 'parti_program' | 'yerel_yonetim';
const KAYNAK_PROXY_URL: Partial<Record<Kaynak, string>> = {};
export function setKaynakProxyUrlleri(harita: Partial<Record<Kaynak, string | undefined>>): void {
  for (const k of Object.keys(KAYNAK_PROXY_URL) as Kaynak[]) delete KAYNAK_PROXY_URL[k];
  for (const [k, v] of Object.entries(harita)) if (v) KAYNAK_PROXY_URL[k as Kaynak] = v;
  for (const url of PROXY_AGENT_CACHE.values()) url.close().catch(() => {});
  PROXY_AGENT_CACHE.clear();
}
export function proxyUrlForKaynak(kaynak: Kaynak): string | undefined {
  return KAYNAK_PROXY_URL[kaynak];
}
const PROXY_AGENT_CACHE = new Map<string, ProxyAgent>();
function proxyAgentIcin(url: string): ProxyAgent {
  let agent = PROXY_AGENT_CACHE.get(url);
  if (!agent) { agent = new ProxyAgent(url); PROXY_AGENT_CACHE.set(url, agent); }
  return agent;
}

const VARSAYILAN_DISPATCHER = getGlobalDispatcher();
export function applyProxyConfig(url: string | undefined): void {
  setGlobalDispatcher(url ? new ProxyAgent(url) : VARSAYILAN_DISPATCHER);
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
  timeoutMs?: number;
  proxyUrl?: string;
  followRedirects?: boolean;
}

export async function httpFetch(url: string, opts: HttpOptions = {}): Promise<Response> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 20000,
    proxyUrl,
    followRedirects = true,
  } = opts;

  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: followRedirects ? 'follow' : 'manual',
  };
  if (body !== undefined) init.body = body;

  if (proxyUrl) {
    (init as unknown as { dispatcher: unknown }).dispatcher = proxyAgentIcin(proxyUrl);
  }

  return fetch(url, init);
}

export async function fetchWithBackoff(url: string, opts: HttpOptions = {}, retries = 3): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await httpFetch(url, opts);
      if ((res.status >= 500 || res.status === 429) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000 + Math.floor(Math.random() * 700)));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000 + Math.floor(Math.random() * 700)));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('fetchWithBackoff başarısız');
}

export async function getJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
  const res = await httpFetch(url, { ...opts, headers: { Accept: 'application/json', ...opts.headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

export async function getText(url: string, opts: HttpOptions = {}): Promise<string> {
  const res = await httpFetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}
