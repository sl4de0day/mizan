import type { FastifyInstance, FastifyReply } from 'fastify';
import { MotionEngine } from '../engines/motion.js';
import { LawEngine } from '../engines/law.js';
import { MinuteEngine } from '../engines/minute.js';

const motion = new MotionEngine();
const law = new LawEngine();
const minute = new MinuteEngine();

async function streamSSE(reply: FastifyReply, gen: AsyncGenerator<unknown>): Promise<void> {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  try {
    for await (const ev of gen) {
      reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
  } catch (e) {
    reply.raw.write(`data: ${JSON.stringify({ step: 'error', message: (e as Error).message, progress: 0 })}\n\n`);
  }
  reply.raw.end();
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '');

export function registerParliamentRoutes(app: FastifyInstance): void {
  app.get('/api/onerge/filters', async (req) => {
    const { term } = (req.query ?? {}) as { term?: string };
    return motion.getMetadataFilters(term && term !== '' ? term : undefined);
  });

  app.get('/api/onerge/stream', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string>;
    await streamSSE(
      reply,
      motion.searchMotionsStream({
        keyword: s(q.keyword),
        after: s(q.after),
        before: s(q.before),
        status: s(q.status),
        term: s(q.term),
        year: s(q.year),
        deputy: s(q.deputy),
        addressed_to: s(q.addressed_to),
        file_no: s(q.file_no),
        last_term_only: q.last_term_only ?? 'true',
        party: s(q.party),
        first_signer_only: q.first_signer_only ?? 'false',
        sort_column: q.sort_column ?? '3',
        sort_dir: q.sort_dir ?? 'asc',
        ping: q.ping ?? 'false',
      }),
    );
  });

  app.get('/api/onerge/detay/:uuid', async (req) => {
    const { uuid } = req.params as { uuid: string };
    return motion.fetchMotionDetail(uuid);
  });

  app.get('/api/kanun/filters', async () => {
    return law.getMetadataFilters();
  });

  app.get('/api/kanun/stream', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string>;
    await streamSSE(
      reply,
      law.searchLawsStream({
        keyword: s(q.keyword),
        startDate: s(q.start_date),
        endDate: s(q.end_date),
        status: q.status ?? null,
        period: q.period ?? null,
        party: q.party ?? null,
        deputy: q.deputy ?? null,
        commission: q.commission ?? null,
        fileNo: q.file_no ?? null,
        passedOnly: q.passed_only ?? 'false',
        ownerType: s(q.owner_type),
        sortColumn: q.sort_column ?? '2',
        sortDir: q.sort_dir ?? 'desc',
        ping: q.ping ?? 'false',
      }),
    );
  });

  app.get('/api/kanun/detail/:uuid', async (req) => {
    const { uuid } = req.params as { uuid: string };
    return law.fetchLawDetail(uuid);
  });

  app.get('/api/tutanak/stream', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string>;
    await streamSSE(
      reply,
      minute.searchMinutesStream({
        keyword: s(q.keyword),
        term: q.term ?? '28',
        year: s(q.year),
        startDate: s(q.start_date),
        endDate: s(q.end_date),
        sortColumn: q.sort_column ?? '0',
        sortDir: q.sort_dir ?? 'asc',
        ping: q.ping ?? 'false',
      }),
    );
  });

  app.get('/api/tutanak/detail/:uuid', async (req) => {
    const { uuid } = req.params as { uuid: string };
    const { page } = (req.query ?? {}) as { page?: string };
    return minute.fetchMinuteDetail(uuid, page ?? '1');
  });
}
