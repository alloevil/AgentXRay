// Per-IP request limiter for every route (API, static files, SPA fallback).
//
// AgentXRay is a local dashboard bound to 127.0.0.1 by default, but every route
// reads from disk (session logs, the library repo, backups, the built UI), and
// HOST=0.0.0.0 exposes it on the LAN. The limit is deliberately generous so the UI
// (initial load, polling, SSE reconnects) and the test suite never come close:
// 600 requests per minute per client IP. Overflow gets 429 with RateLimit headers.
const { rateLimit } = require('express-rate-limit');

const WINDOW_MS = 60 * 1000;
const LIMIT = 600;

const limiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: LIMIT,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' },
});

module.exports = { limiter, WINDOW_MS, LIMIT };
