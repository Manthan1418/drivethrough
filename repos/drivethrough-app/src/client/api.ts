// client/api.ts — the SINGLE network choke-point for the whole frontend (tech.md §2).
// Every backend call funnels through here: attaches the bearer ID token, targets
// NEXT_PUBLIC_API_URL, parses { code, message } errors. Restructuring the UI must never
// touch this file's contract; conversely, no component should call fetch() directly.

import type { ApiError } from '@drivethrough/contracts';

// Trailing slashes are stripped — pasting "https://api.example.com/" from a browser bar is
// the single most common env mistake, and it would otherwise produce `…//api/…` 404s.
// Scheme is NOT auto-rewritten: http://localhost:3001 must keep working in local dev even
// though prod requires https (mixed content is blocked by the browser regardless of us).
const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/+$/, '');

let tokenGetter: () => string | null | Promise<string | null> = () => null;
/** Injected once at app boot from the Firebase client SDK (sign-in lives in the frontend only).
 *  May return a Promise — the ID token is fetched fresh (auto-refreshed) at call time. */
export function setTokenGetter(fn: () => string | null | Promise<string | null>): void {
  tokenGetter = fn;
}

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

interface ApiOptions extends Omit<RequestInit, 'body'> {
  json?: unknown;
  body?: BodyInit | null;
  auth?: boolean; // default true
}

/** Core request helper. Returns parsed JSON; throws ApiRequestError on non-2xx. */
export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const { json, auth = true, headers, ...rest } = opts;
  const h = new Headers(headers);
  if (json !== undefined) h.set('Content-Type', 'application/json');
  if (auth) {
    const tok = await tokenGetter();
    if (tok) h.set('Authorization', `Bearer ${tok}`);
  }
  const res = await fetch(`${API_URL}${path}`, {
    ...rest,
    headers: h,
    body: json !== undefined ? JSON.stringify(json) : (opts.body ?? undefined),
  });
  if (!res.ok) {
    let err: ApiError = { code: 'INTERNAL_ERROR', message: res.statusText };
    try { err = (await res.json()) as ApiError; } catch { /* non-JSON error body */ }
    throw new ApiRequestError(err.code, err.message, res.status);
  }
  return (await res.json()) as T;
}

/** Raw fetch for streaming/binary routes (chunk PUT, Range download) — auth header attached. */
export async function apiRaw(path: string, init: RequestInit = {}): Promise<Response> {
  const h = new Headers(init.headers);
  const tok = await tokenGetter();
  if (tok) h.set('Authorization', `Bearer ${tok}`);
  return fetch(`${API_URL}${path}`, { ...init, headers: h });
}

/** Absolute URL for a backend path — for capability URLs that a media element fetches
 *  directly (<img src>, <video src>, share-page downloads): no Authorization header can
 *  ride along, the token in the URL IS the credential. Origin derivation still lives only
 *  here, so this file remains the single network choke-point. */
export function apiUrl(path: string): string {
  return `${API_URL}${path}`;
}
