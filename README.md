# ArticleSwap

Distributed event-driven article exchange platform built with **SvelteKit**, **Node.js microservices**, **Apache Kafka**, **PostgreSQL**, **MinIO**, and **Nginx**. Submitted articles flow through an asynchronous pipeline that stems text, generates a word cloud, and pushes the result to the recipient in real time.

> Project brief: `docs/project (1).pdf`. Per-service docs live under `docs/0X-*.md`.

## High-Level Architecture

```
┌──────────┐  POST /api/articles   ┌──────────────────┐
│ Frontend │ ────────────────────► │ API Gateway × N   │  Nginx LB → /api/*
│ (Svelte) │                       │ + Article Service│
└────┬─────┘                       └────────┬─────────┘
     │  GET /api/receive (SSE)            │ publish
     │◄───────────────────────────────────┤
     │                                    ▼
     │                         ┌────────────────────┐
     │                         │ Kafka: article-    │
     │                         │  submissions        │
     │                         └────────┬───────────┘
     │                                  ▼
     │                         ┌────────────────────┐
     │                         │ Stemming Service   │  SastrawiJS + Porter
     │                         └────────┬───────────┘
     │                                  │  article-stemmed
     │                                  ▼
     │                         ┌────────────────────┐
     │                         │ Word Cloud Service │  → MinIO bucket
     │                         └────────┬───────────┘
     │                                  │  article-wordcloud-generated
     │                                  ▼
     │                         ┌────────────────────┐
     │  SSE push: "artikel     │ Forwarding-Inbox   │  marks DELIVERED
     │  delivered"             │ Service            │
     │◄────────────────────────┴────────┬───────────┘
     │                                   │  article-delivered
     ▼
 Receiver sees full article + stemmed text + wordcloud image
```

### Article status state machine

```
PENDING ──► STEMMED ──► WORDCLOUD_GENERATED ──► DELIVERED
   │           │                │                  │
   └─► FAILED ◄┴────────────────┴──────────────────┘
```

## Repository Layout

| Path | Role | Notes |
|---|---|---|
| `api-gateway/` | SvelteKit UI + SSE + Kafka consumer | Port 5173, scaled to 2 instances behind Nginx |
| `services/article-service/` | Express HTTP entry + Kafka producer | Port 3000 |
| `services/stemming-service/` | Mixed ID/EN per-token stemmer | SastrawiJS + natural Porter |
| `services/wordcloud-service/` | SVG word cloud generator + MinIO upload | |
| `services/forwarding-inbox-service/` | Final delivery + DB write | |
| `nginx/` | LB config | `proxy_buffering off` for SSE |
| `docker-compose.yml` | Full stack orchestration | Kafka KRaft, Postgres, Redis, MinIO, Kafka UI |
| `docs/` | Per-service spec, project brief, stress test script | |
| `.github/workflows/` | CI/CD pipelines | See *CI / CD* below |

## Services Overview

| Service | Owner (per project brief) | Inputs | Outputs | Tests |
|---|---|---|---|---|
| API Gateway + Article Service | Anggota 1 | `POST /api/articles` (text or PDF) | Kafka `article-submissions`, SSE to receiver | svelte-check, manual |
| Stemming Service | Anggota 2 | Kafka `article-submissions` | DB row, Kafka `article-stemmed` | `node --test` |
| Word Cloud Service | Anggota 3 | Kafka `article-stemmed` | MinIO object, Kafka `article-wordcloud-generated` | manual |
| Forwarding + Inbox Service | Anggota 4 | Kafka `article-wordcloud-generated` | DB row, Kafka `article-delivered` | manual |
| Infrastructure | Anggota 5 | – | Kafka, Postgres, Redis, MinIO, Nginx, Kafka UI | manual |

## Stemming (mixed ID/EN)

`services/stemming-service/src/usecases/StemArticle.js` exposes:

- `tokenizeText(text)` — keeps punctuation, URLs, emails, code-like chunks.
- `detectTokenLanguage(token)` — per-token score using ID/EN stopword lists, common-word sets, and affix patterns (`me-`, `ber-`, `ter-`, `pe-`, `-kan`, `-nya`, `-lah`, `-ing`, `-ed`, `-ly`, `-tion`, `-s`).
- `stemToken(token, fallback)` — runs SastrawiJS for ID, natural Porter for EN, preserves technical terms (`kafka`, `redis`, `docker`, `postgres`, `scalable`, `storage`, `recycle`, …).
- `stemMixedLanguageText(text)` — tokenizes, detects majority language, stems per token.

Example:

```text
"Pengembangan aplikasi scalable sangat menyenangkan karena users can share articles quickly."
→ "kembang aplikasi scalable sangat senang karena user can share article quick."
```

Run unit tests:

```bash
cd services/stemming-service
npm test
```

## Performance & Safety Add-Ons

- **IP rate limit on `POST /api/articles`** via `express-rate-limit` (`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS`).
- **`TRUST_PROXY`** opt-in for `X-Forwarded-For` behind Nginx.
- **In-memory TTL cache** (LRU) for `GET /api/articles` and `GET /api/articles/:id`; POST invalidates only `list:*` keys.
- **Circuit breaker** around `KafkaEventPublisher.publish` (cooldown + failure threshold) in `article-service`.
- **Parallel startup** — topic ensure + producer connect run via `Promise.all`; worker topic ensure pairs parallelized.
- **Mixed-language stemming** preserves readability (URLs, emails, code, technical terms).

## Running Locally

### Docker (recommended)

```bash
docker compose up --build
```

Access:

| URL | What |
|---|---|
| http://localhost:8080 | Dashboard (load-balanced) |
| http://localhost:8081 | Kafka UI |
| http://localhost:9001 | MinIO console (`articleswap` / `articleswap123`) |
| `localhost:5432` | Postgres |
| `localhost:6379` | Redis |

Stop and clean:

```bash
docker compose down        # stop containers
docker compose down -v     # drop volumes (Kafka state, Postgres, MinIO)
```

### Native (no Docker)

```bash
./run.sh          # starts 2 gateway instances + Nginx
```

Or manually in separate terminals:

```bash
cd api-gateway && npm run dev -- --port 5173
cd api-gateway && npm run dev -- --port 5174
nginx -p <path> -c <path>/nginx.conf
```

## Environment Variables

Each service ships its own `.env.example`:

- `api-gateway/.env.example`
- `services/article-service/.env.example`
- `services/stemming-service/.env.example`
- `services/wordcloud-service/.env.example`
- `services/forwarding-inbox-service/.env.example`

## API Endpoints

### `POST /api/articles`

Accepts text or PDF payloads.

```json
{
  "title": "Judul Artikel",
  "content": "Isi artikel...",
  "sender": "alice",
  "receiver": "bob"
}
```

For PDF: include `fileData` (base64) and `fileName` ending in `.pdf`. Returns `202 Accepted` with `{ articleId, status: "PENDING" }`.

### `GET /api/articles`

List articles with `limit`, `offset`, `sender`, `receiver`, `status` filters.

### `GET /api/articles/:id`

Fetch one article; includes `stemmed_content`, `wordcloud_url`, and delivery info.

### `GET /api/receive?receiver=<username>`

SSE stream of newly delivered articles.

### `GET /health`

Liveness probe.

## Stress Testing (k6)

`docs/stress-article-submissions.k6.js` posts PDFs from `docs/` as base64 with the k6 `setResponseCallback(expectedStatuses({min:200,max:202}, 429))` so `429` rate-limit responses are expected and not counted as failures.

```bash
cd docs
k6 inspect stress-article-submissions.k6.js
k6 run stress-article-submissions.k6.js
```

Override defaults via env:

```bash
STRESS_URL=http://localhost:8080/api/articles \
STRESS_VUS=50 STRESS_RAMP_UP=30s STRESS_HOLD=2m STRESS_RAMP_DOWN=30s \
k6 run stress-article-submissions.k6.js
```

## CI / CD (GitHub Actions + GHCR)

`.github/workflows/images.yml` builds every Dockerfile on push/PR to `main`, tags images with the commit SHA, branch name, and `latest`, then pushes to `ghcr.io/<owner>/articleswap-<service>`. Each service image is independently pullable:

```bash
docker pull ghcr.io/<owner>/articleswap-api-gateway:latest
docker pull ghcr.io/<owner>/articleswap-article-service:latest
docker pull ghcr.io/<owner>/articleswap-stemming-service:latest
docker pull ghcr.io/<owner>/articleswap-wordcloud-service:latest
docker pull ghcr.io/<owner>/articleswap-forwarding-inbox-service:latest
```

Required secret: `GITHUB_TOKEN` (provided automatically). The workflow uses it to authenticate to GHCR.

## Project Brief Reference

| Spec area | Where in repo |
|---|---|
| Anggota 1 — API gateway & article service | `api-gateway/`, `services/article-service/`, `docs/01-api-gateway-article-service.md` |
| Anggota 2 — Stemming | `services/stemming-service/`, `docs/02-stemming-service.md` |
| Anggota 3 — Word cloud | `services/wordcloud-service/`, `docs/03-wordcloud-service.md` |
| Anggota 4 — Forwarding & inbox | `services/forwarding-inbox-service/`, `docs/04-forwarding-inbox-service.md` |
| Anggota 5 — Infrastructure | `docker-compose.yml`, `nginx/`, `docs/05-infrastructure.md` |

## Pitfalls & Notes

- **SSE behind Nginx** requires `proxy_buffering off` and a long `proxy_read_timeout` (already set in `nginx/nginx.conf`).
- **SvelteKit in container** runs Vite dev with bind-mounted source for HMR. For production, install `@sveltejs/adapter-node` and run `node build/index.js`.
- **Mixed-language stemming** is heuristic; tokens with neither ID nor EN cues fall back to a majority-language pass (default `id`).
- **Rate limit on POST** is per-IP. Set `TRUST_PROXY` to the number of trusted proxies (typically `1` behind Nginx).
- **First publish** to a new Kafka topic can race; `KafkaTopicEnsurer.ensure()` runs at startup.
