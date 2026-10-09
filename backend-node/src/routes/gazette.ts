import type { FastifyInstance } from 'fastify';
import { GazetteEngine } from '../engines/gazette.js';

const engine = new GazetteEngine();

export function registerGazetteRoutes(app: FastifyInstance): void {
  app.post('/api/gazette/sorgu', async (req) => {
    const b = (req.body ?? {}) as Record<string, string>;
    return engine.searchGazette({
      keyword: b.keyword ?? '',
      after: b.after ?? '',
      before: b.before ?? '',
      category: b.category ?? '',
      institution: b.institution ?? '',
      gazetteNo: b.gazette_no ?? '',
      legislationNo: b.legislation_no ?? '',
      mukerrer: b.mukerrer ?? '',
    });
  });

  app.get('/api/gazette/fihrist', async (req) => {
    const { date } = (req.query ?? {}) as { date?: string };
    return engine.getDailyIndex(date);
  });

  app.post('/api/gazette/content', async (req) => {
    const b = (req.body ?? {}) as { url?: string };
    return engine.fetchContent(b.url ?? '');
  });
}
