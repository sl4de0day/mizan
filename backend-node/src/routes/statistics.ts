import type { FastifyInstance } from 'fastify';
import { StatisticsEngine } from '../engines/statistics.js';

const engine = new StatisticsEngine();

export function registerStatisticsRoutes(app: FastifyInstance): void {
  app.get('/api/istatistik/ozet', async () => {
    return { success: true, data: await engine.getMainIndicators() };
  });

  app.get('/api/istatistik/detay/:statId', async (req) => {
    const { statId } = req.params as { statId: string };
    return engine.getIndicatorDetails(statId);
  });
}
