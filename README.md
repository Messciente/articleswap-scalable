# ArticleSwap

Distributed event-driven article exchange platform built with **SvelteKit**, **Node.js microservices**, **Apache Kafka**, **PostgreSQL**, **MinIO**, and **Nginx**. Submitted articles flow through an asynchronous pipeline that stems text, generates a word cloud, and pushes the result to the recipient in real time.

## High-Level Architecture

```mermaid
flowchart LR
    User[User Browser] -- POST /api/articles --> Nginx[Nginx LB]
    Nginx -- "/api/*" --> Article[Article Service<br/>Express :3000]
    Nginx -- "/" --> Gateway[API Gateway ×N<br/>SvelteKit :5173]

    Article -- produce --> T0[(Kafka<br/>article-submissions)]
    T0 -- consume --> Stem[Stemming Service<br/>SastrawiJS + Porter]
    Stem -- produce --> T1[(Kafka<br/>article-stemmed)]
    T1 -- consume --> Word[Word Cloud Service<br/>SVG + MinIO]
    Word -- produce --> T2[(Kafka<br/>article-wordcloud-generated)]
    T2 -- consume --> Inbox[Forwarding-Inbox Service<br/>marks DELIVERED]
    Inbox -- produce --> T3[(Kafka<br/>article-delivered)]
    T3 -- consume --> Gateway
    Gateway -- SSE /api/receive --> User

    Stem --> DB[(Postgres<br/>article_processing)]
    Word --> Minio[(MinIO<br/>bucket: wordclouds)]
    Inbox --> DB
```

### Article status state machine

```mermaid
stateDiagram-v2
    [*] --> PENDING
    PENDING --> STEMMED
    STEMMED --> WORDCLOUD_GENERATED
    WORDCLOUD_GENERATED --> DELIVERED
    DELIVERED --> [*]
    PENDING --> FAILED
    STEMMED --> FAILED
    WORDCLOUD_GENERATED --> FAILED
    FAILED --> [*]
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

```mermaid
flowchart LR
    A[Raw text] --> B(tokenizeText)
    B --> C{Detect language<br/>per token}
    C -- "ID cues" --> D[SastrawiJS]
    C -- "EN cues" --> E[Porter Stemmer]
    C -- "Technical" --> F[Keep original]
    C -- "Unknown" --> G[Majority fallback]
    D --> H[stemmed text]
    E --> H
    F --> H
    G --> H
```

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

```mermaid
flowchart LR
    Client[Client IP] --> RL[Rate limit<br/>express-rate-limit]
    RL -->|Allowed| Express[Express router]
    RL -->|Throttled| E429[429 Too Many Requests]
    Express --> Cache[In-memory TTL+LRU cache]
    Cache -->|miss| DB[(Postgres)]
    Cache -->|hit| Resp[Response]
    Express --> CB[Circuit Breaker]
    CB -->|closed| KP[Kafka publisher]
    CB -->|open| Fail[Reject early]
    KP --> T0[(Kafka)]
```

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

## Production Deploy (pull from GHCR)

Use `docker-compose.prod.yml` + `scripts/deploy-prod.sh`.

```mermaid
flowchart LR
    Start[deploy-prod.sh] --> Login[docker login GHCR]
    Login --> Fresh[ensure-images-fresh.mjs]
    Fresh --> Pull[docker pull<br/>each image]
    Pull --> Digest[Compare local digest<br/>vs GHCR]
    Digest -->|changed| Up[docker compose -d up]
    Digest -->|unchanged| Skip[abort: no new image]
```

One-time setup:

```bash
cp .env.prod.example .env.prod
# adjust IMAGE_NAMESPACE, IMAGE_TAG, secrets
export GHCR_USER=feinru GHCR_TOKEN=<ghcr PAT or github token>
```

Deploy:

```bash
./scripts/deploy-prod.sh
# or pin a specific commit
IMAGE_TAG=sha-1fe398b ./scripts/deploy-prod.sh
```

The freshness check pulls every image, compares the local `RepoDigests` against GHCR, and only calls `docker compose up -d` when at least one image actually moved. If nothing changed it exits `2` and skips the restart.

`docker-compose.prod.yml` defines `image:` per service from `IMAGE_*` env vars, with `pull_policy: always`. Override at deploy time:

```bash
IMAGE_TAG=sha-1fe398b docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

## CI / CD (GitHub Actions + GHCR)

```mermaid
flowchart LR
    Push[push / pull_request] --> WF[images.yml]
    WF --> Matrix[Matrix:<br/>api-gateway, article,<br/>stemming, wordcloud,<br/>forwarding-inbox]
    Matrix --> Build[docker buildx build]
    Build -->|PR| Check[Verify build only]
    Build -->|push| Login[Login to GHCR]
    Login --> Push2[Push to ghcr.io]
```

`.github/workflows/images.yml` builds every Dockerfile on push/PR to `main`, tags images with the commit SHA, branch name, and `latest`, then pushes to `ghcr.io/<owner>/articleswap-<service>`. Each service image is independently pullable:

```bash
docker pull ghcr.io/<owner>/articleswap-api-gateway:latest
docker pull ghcr.io/<owner>/articleswap-article-service:latest
docker pull ghcr.io/<owner>/articleswap-stemming-service:latest
docker pull ghcr.io/<owner>/articleswap-wordcloud-service:latest
docker pull ghcr.io/<owner>/articleswap-forwarding-inbox-service:latest
docker pull ghcr.io/<owner>/articleswap-nginx:latest
```

Required secret: `GITHUB_TOKEN` (provided automatically). The workflow uses it to authenticate to GHCR.

## Pitfalls & Notes

- **SSE behind Nginx** requires `proxy_buffering off` and a long `proxy_read_timeout` (already set in `nginx/nginx.conf`).
- **SvelteKit in container** runs Vite dev with bind-mounted source for HMR. For production, install `@sveltejs/adapter-node` and run `node build/index.js`.
- **Mixed-language stemming** is heuristic; tokens with neither ID nor EN cues fall back to a majority-language pass (default `id`).
- **Rate limit on POST** is per-IP. Set `TRUST_PROXY` to the number of trusted proxies (typically `1` behind Nginx).
- **First publish** to a new Kafka topic can race; `KafkaTopicEnsurer.ensure()` runs at startup.
