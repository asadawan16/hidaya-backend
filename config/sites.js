/*
 * Front ends this API serves.
 *
 * Deliberately hardcoded rather than read from env: a mis-set or forgotten
 * variable on a deploy host silently CORS-blocks a live marketing site, and
 * that failure looks like "the form is broken" to everyone except whoever
 * opens the browser console. The list is short and changes once a year.
 *
 * Two properties talk to this API:
 *   hidaya.online      — the main site + student portal + the /pay pages
 *   qurantutornow.com  — a Google Ads landing site that has no checkout of its
 *                        own; it hands payers to hidaya.online/pay/:token so
 *                        every Stripe session, return URL and webhook stays on
 *                        one origin (see PAY_SITE_URL below).
 */

export const ALLOWED_ORIGINS = [
  // Production
  'https://hidaya.online',
  'https://www.hidaya.online',
  'https://qurantutornow.com',
  'https://www.qurantutornow.com',
  // Local development (Vite dev + preview, both projects)
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:4173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
]

/* Whatever FRONTEND_URL points at on this host is always allowed too, so a
 * Vercel preview deploy keeps working without editing this file. */
export function allowedOrigins() {
  const extra = (process.env.FRONTEND_URL || '').trim().replace(/\/$/, '')
  return extra && !ALLOWED_ORIGINS.includes(extra)
    ? [...ALLOWED_ORIGINS, extra]
    : ALLOWED_ORIGINS
}

export function isAllowedOrigin(origin) {
  // No Origin header at all: server-to-server, curl, or a same-origin
  // navigation. CORS is a browser policy; there is nothing to protect here.
  if (!origin) return true
  return allowedOrigins().includes(origin.replace(/\/$/, ''))
}

/*
 * Where the hosted /pay/:token pages live.
 *
 * Every checkout — including one started from qurantutornow.com — is completed
 * here, so Stripe only ever sees one set of success/cancel URLs and one origin.
 * FRONTEND_URL is what the rest of the app already builds return URLs from, so
 * it wins locally; the literal is the production last resort.
 */
export function paySiteUrl() {
  const url = (process.env.PAY_SITE_URL || process.env.FRONTEND_URL || 'https://hidaya.online').trim()
  return url.replace(/\/$/, '')
}
