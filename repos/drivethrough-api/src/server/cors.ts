// CORS for the cross-origin two-repo boundary (tech.md §1, §8).
// Allows only the frontend origin(s); handles preflight for chunk PUT (Content-Range)
// and Range downloads. No wildcard, no credentials (bearer auth).

// PATCH is required: rename (files+folders), restore-from-trash, and every other
// mutable control-plane op sends it. Missing it made the browser block those calls
// ("Failed to fetch") while direct-API e2e stayed green — caught in a real browser
// 2026-10-23; guard test exists.
const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Authorization, Content-Type, Content-Range, Range, X-Client-Upload-Id';
const EXPOSED_HEADERS = 'Content-Range, Content-Length, Accept-Ranges';

function allowedOrigins(): string[] {
  const raw = process.env.CORS_ALLOW_ORIGIN ?? '';
  // Normalize: trim whitespace AND strip trailing slashes — browser Origin headers never
  // carry a trailing slash, so an env value like "https://app.example.com/" (copy-pasted
  // from the address bar) must still match. Caught live in prod 2026-10-20; guard test exists.
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/** Returns CORS headers if the request origin is allowed; null if not allowed. */
export function corsHeaders(origin: string | null): Record<string, string> | null {
  if (!origin) return null;
  if (!allowedOrigins().includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Expose-Headers': EXPOSED_HEADERS,
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** Handle a preflight OPTIONS request. Returns a Response or null if origin not allowed. */
export function handlePreflight(req: Request): Response | null {
  if (req.method !== 'OPTIONS') return null;
  const headers = corsHeaders(req.headers.get('origin'));
  if (!headers) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers });
}

/** Wrap a response with CORS headers (no-op for disallowed origins — caller should 403 earlier). */
export function withCors(req: Request, res: Response): Response {
  const headers = corsHeaders(req.headers.get('origin'));
  if (!headers) return res;
  const merged = new Headers(res.headers);
  for (const [k, v] of Object.entries(headers)) merged.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: merged });
}
