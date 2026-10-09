import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Redis from 'ioredis';
import { getLogger } from './logger.js';

const logger = getLogger('PoliticalInsight.Cache');

let redis: Redis | null = null;
let redisAvailable = false;
if (process.env.REDIS_DISABLED !== '1') {
  try {
    redis = new Redis({
      host: process.env.REDIS_HOST ?? '127.0.0.1',
      port: Number(process.env.REDIS_PORT ?? 6379),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    redis.on('error', () => { redisAvailable = false; });
    redis.connect().then(() => { redisAvailable = true; }).catch(() => { redisAvailable = false; });
  } catch {
    redisAvailable = false;
  }
}

const memoryCache = new Map<string, { value: unknown; ts: number }>();

export async function getCached<T = unknown>(key: string, maxAgeSeconds = 86400): Promise<T | null> {
  if (redisAvailable && redis) {
    try {
      const val = await redis.get(key);
      if (val != null) return JSON.parse(val) as T;
    } catch {  }
  }
  const hit = memoryCache.get(key);
  if (hit && (Date.now() - hit.ts) / 1000 < maxAgeSeconds) return hit.value as T;
  return null;
}

export async function setCached(key: string, val: unknown, maxAgeSeconds = 86400): Promise<void> {
  if (redisAvailable && redis) {
    try {
      await redis.setex(key, maxAgeSeconds, JSON.stringify(val));
      return;
    } catch {  }
  }
  memoryCache.set(key, { value: val, ts: Date.now() });
}

export class FileCache {
  private dir: string;
  private ttlSeconds: number;

  constructor(dir: string, ttlSeconds = 30 * 24 * 60 * 60) {
    this.dir = dir;
    this.ttlSeconds = ttlSeconds;
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  private pathFor(key: string): string {
    const h = createHash('md5').update(key).digest('hex');
    return join(this.dir, `${h}.json`);
  }

  get<T = unknown>(key: string): T | null {
    try {
      const p = this.pathFor(key);
      if (existsSync(p)) {
        const ageSec = (Date.now() - statSync(p).mtimeMs) / 1000;
        if (ageSec < this.ttlSeconds) return JSON.parse(readFileSync(p, 'utf-8')) as T;
      }
    } catch (e) {
      logger.warn(`Cache okunamadı: ${(e as Error).message}`);
    }
    return null;
  }

  set(key: string, data: unknown): void {
    try {
      writeFileSync(this.pathFor(key), JSON.stringify(data), 'utf-8');
    } catch (e) {
      logger.warn(`Cache yazılamadı: ${(e as Error).message}`);
    }
  }
}
