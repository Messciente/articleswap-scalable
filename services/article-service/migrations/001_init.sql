-- 001_init.sql: initial schema for article-service
-- Runs on every service startup via runMigrations() in src/infrastructure/persistence/migrate.js
-- Idempotent: safe to re-run (uses IF NOT EXISTS)

CREATE TABLE IF NOT EXISTS articles (
  id           UUID PRIMARY KEY,
  title        VARCHAR(255) NOT NULL,
  content      TEXT,
  file_name    VARCHAR(255),
  file_data    TEXT,
  file_size    INT,
  sender       VARCHAR(50)  NOT NULL,
  receiver     VARCHAR(50)  NOT NULL,
  status       VARCHAR(20)  NOT NULL DEFAULT 'PENDING'
               CHECK (status IN ('PENDING','STEMMED','WORDCLOUD_GENERATED','DELIVERED','FAILED')),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_articles_sender   ON articles(sender, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_receiver ON articles(receiver, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_status   ON articles(status);

CREATE TABLE IF NOT EXISTS article_processing (
  id              SERIAL PRIMARY KEY,
  article_id      UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  stage           VARCHAR(24) NOT NULL CHECK (stage IN ('STEMMED','WORDCLOUD_GENERATED')),
  stemmed_content TEXT,
  wordcloud_url   TEXT,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (article_id, stage)
);

CREATE INDEX IF NOT EXISTS idx_processing_article ON article_processing(article_id);

CREATE TABLE IF NOT EXISTS article_delivery (
  id           SERIAL PRIMARY KEY,
  article_id   UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  receiver     VARCHAR(50) NOT NULL,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at      TIMESTAMPTZ,
  UNIQUE (article_id, receiver)
);

CREATE INDEX IF NOT EXISTS idx_delivery_receiver ON article_delivery(receiver, delivered_at DESC);
