import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { basename } from 'node:path';
import { registerAdminOpsRoutes, biletTuket } from './adminOps.js';
import { adminKullaniciTokenDogrula } from '../lib/db.js';
import { safeEqual } from '../lib/authUtil.js';

export function registerAdminRoutes(rootApp: FastifyInstance): void {
  rootApp.register(async (app) => {
  await app.register(rateLimit, { max: 200, timeWindow: '1 minute' });

  app.addHook('preHandler', async (req, reply) => {
    const beklenen = process.env.ADMIN_TOKEN;
    if (!beklenen) {
      return reply.code(503).send({ detail: 'ADMIN_TOKEN tanımlı değil — admin uçları kapalı.' });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/admin/yedekler/')) {
      const dosya = (req.params as { dosya?: string } | undefined)?.dosya;
      const bilet = (req.query as { bilet?: string } | undefined)?.bilet;
      if (dosya && bilet && biletTuket(bilet, basename(dosya))) return;
    }
    const gelen = req.headers['x-admin-token'] as string | undefined;
    if (gelen && safeEqual(gelen, beklenen)) {
      (req as unknown as { adminIsim: string }).adminIsim = 'admin';
      return;
    }
    const kullanici = gelen ? adminKullaniciTokenDogrula(gelen) : null;
    if (kullanici) {
      (req as unknown as { adminIsim: string }).adminIsim = kullanici.isim;
      return;
    }
    return reply.code(401).send({ detail: 'Yetkisiz.' });
  });

  registerAdminOpsRoutes(app);
  });
}
