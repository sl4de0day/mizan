import type { FastifyInstance } from 'fastify';
import { ConstitutionalEngine } from '../engines/constitutional.js';

const engine = new ConstitutionalEngine();

export function registerConstitutionalRoutes(app: FastifyInstance): void {
  app.post('/api/anayasa/norm/sorgu', async (req) => {
    const b = (req.body ?? {}) as Record<string, string>;
    return engine.searchNorm({
      keyword: b.keyword ?? '',
      esas_no: b.esas_no ?? '',
      karar_no: b.karar_no ?? '',
      basvuru_turu: b.basvuru_turu ?? '',
      karar_turu: b.karar_turu ?? '',
    });
  });

  app.post('/api/anayasa/parti/sorgu', async (req) => {
    const b = (req.body ?? {}) as Record<string, string>;
    return engine.searchParty({
      keyword: b.keyword ?? '',
      esas_no: b.esas_no ?? '',
      karar_no: b.karar_no ?? '',
      karar_turu: b.karar_turu ?? '',
      parti_id: b.parti_id ?? '',
      karar_tarihi_ilk: b.karar_tarihi_ilk ?? '',
      karar_tarihi_son: b.karar_tarihi_son ?? '',
    });
  });

  app.post('/api/anayasa/detay', async (req) => {
    const b = (req.body ?? {}) as { url?: string };
    return engine.fetchDetail(b.url ?? '');
  });
}
