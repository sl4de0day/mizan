import type { FastifyInstance } from 'fastify';
import { NewsEngine } from '../engines/news.js';
import { izinliMi, IZINLI_HOSTLAR } from '../lib/kaynakIzin.js';

const news = new NewsEngine();

export function registerNewsRoutes(app: FastifyInstance): void {
  app.post('/ayikla', async (req, reply) => {
    const b = (req.body ?? {}) as { url?: string };
    if (!b.url) return reply.code(400).send({ detail: 'URL required' });
    const izin = izinliMi(b.url);
    if (!izin.izinli) {
      return reply.code(403).send({
        success: false,
        error: 'Kaynak izinli değil',
        sebep: izin.sebep,
        izinli_kaynaklar: IZINLI_HOSTLAR,
      });
    }
    return news.extractContent(b.url);
  });
}
