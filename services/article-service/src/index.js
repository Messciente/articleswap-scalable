import 'dotenv/config';
import express from 'express';
import pg from 'pg';
import { createArticlesRoute } from './interfaces/http/articles.route.js';
import { SubmitArticle } from './usecases/SubmitArticle.js';
import { GetArticle } from './usecases/GetArticle.js';
import { ListArticles } from './usecases/ListArticles.js';
import { KafkaEventPublisher } from './infrastructure/messaging/KafkaEventPublisher.js';
import { KafkaTopicEnsurer } from './infrastructure/kafka/KafkaTopicEnsurer.js';
import { PostgresArticleRepository } from './infrastructure/persistence/PostgresArticleRepository.js';
import { runMigrations } from './infrastructure/persistence/migrate.js';
import { createArticleSubmitRateLimiter } from './infrastructure/http/rateLimit.js';
import { TtlCache } from './infrastructure/cache/TtlCache.js';

const SERVICE = 'article-service';

async function main() {
  const brokers = process.env.KAFKA_BROKERS || 'localhost:9092';
  const topic = process.env.KAFKA_TOPIC || 'article-submissions';
  const databaseUrl = process.env.DATABASE_URL;

  const eventPublisher = new KafkaEventPublisher({
    brokers,
    clientId: process.env.KAFKA_CLIENT_ID || SERVICE
  });

  const topicEnsurer = new KafkaTopicEnsurer({
    brokers,
    clientId: `${SERVICE}-admin`
  });

  await Promise.all([
    topicEnsurer.ensure(topic),
    eventPublisher.connect()
  ]);

  let pool = null;
  let articleRepository = null;
  if (databaseUrl) {
    pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    });
    await runMigrations(pool);
    articleRepository = new PostgresArticleRepository({ pool });
    console.log(`[${SERVICE}] DB ready`);
  } else {
    console.warn(`[${SERVICE}] DATABASE_URL not set — DB persistence disabled`);
  }

  const submitArticleUseCase = new SubmitArticle({ eventPublisher, articleRepository });
  const getArticleUseCase = new GetArticle({ articleRepository });
  const listArticlesUseCase = new ListArticles({ articleRepository });

  const app = express();
  if (process.env.TRUST_PROXY) {
    app.set('trust proxy', Number(process.env.TRUST_PROXY));
  }
  app.use(express.json({ limit: '40mb' }));
  app.get('/health', async (_req, res) => {
    if (!pool) return res.json({ status: 'ok', db: 'disabled' });
    try {
      await pool.query('SELECT 1');
      return res.json({ status: 'ok', db: 'ok' });
    } catch (e) {
      return res.status(503).json({ status: 'degraded', db: 'error', error: e.message });
    }
  });
  const readCache = new TtlCache({
    ttlMs: Number(process.env.ARTICLE_CACHE_TTL_MS) || 30_000,
    maxEntries: Number(process.env.ARTICLE_CACHE_MAX_ENTRIES) || 500
  });
  const submitRateLimiter = createArticleSubmitRateLimiter();

  app.use('/api/articles', (req, res, next) => {
    if (req.method !== 'POST') return next();
    return submitRateLimiter(req, res, next);
  });
  app.use('/api', createArticlesRoute({ submitArticleUseCase, getArticleUseCase, listArticlesUseCase, readCache }));

  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';

  const server = app.listen(port, host, () => {
    console.log(`[${SERVICE}] listening on http://${host}:${port}`);
  });

  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
      console.log(`[${SERVICE}] received ${sig}, shutting down`);
      server.close();
      if (pool) await pool.end().catch(() => {});
      process.exit(0);
    });
  }
}

main().catch((e) => {
  console.error(`[${SERVICE}] fatal:`, e);
  process.exit(1);
});
