import { rateLimit } from 'express-rate-limit';

export function createArticleSubmitRateLimiter() {
  const windowMs = readPositiveInteger(process.env.RATE_LIMIT_WINDOW_MS, 60_000);
  const limit = readPositiveInteger(process.env.RATE_LIMIT_MAX_REQUESTS, 30);

  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ipv6Subnet: 56,
    message: {
      error: 'Too many article submissions from this IP. Please retry later.',
      retryAfterMs: windowMs
    }
  });
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
