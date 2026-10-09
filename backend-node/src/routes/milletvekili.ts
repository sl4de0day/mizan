import type { FastifyInstance } from 'fastify';
import { MVEngine } from '../engines/milletvekili.js';

const engine = new MVEngine();

export function registerMilletvekiliRoutes(app: FastifyInstance): void {
  app.get('/api/milletvekili/detay', async (req) => {
    const q = (req.query ?? {}) as { id?: string; donem_id?: string; name?: string };
    return engine.getDeputyDetails(q.id ?? '', q.donem_id ?? '', q.name ?? '');
  });
}
