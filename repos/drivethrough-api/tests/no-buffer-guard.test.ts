// Guard test (tech.md §9): NO handler may buffer file bodies — upload chunks are streamed
// end-to-end (browser → Vercel → Drive). Regression class: a well-meaning `await req.text()`
// or `arrayBuffer()` would silently buffer up to 4.5 MB per request (memory blowup + breaks
// the R1 rule that only streamed bodies may exceed platform limits).

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_ROOT = fileURLToPath(new URL('../src/app/api', import.meta.url));

function collectRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectRouteFiles(full));
    else if (entry === 'route.ts') out.push(full);
  }
  return out;
}

const FORBIDDEN: { re: RegExp; why: string }[] = [
  { re: /\.arrayBuffer\s*\(/, why: 'await req.arrayBuffer() buffers the whole body' },
  { re: /\.text\s*\(/, why: 'await req.text() buffers the whole body' },
  { re: /Buffer\.concat/, why: 'Buffer.concat collects body chunks in memory' },
  { re: /\.formData\s*\(/, why: 'multipart formData parses/buffers — chunks are raw PUT (tech §4)' },
];

/** Strip comments before scanning: rules apply to executable code, so files may *document*
 *  the ban ("NEVER await req.text()...") without tripping the guard. String literals are
 *  kept — a '.text(' inside one would still be dead code, but stripping literals risks
 *  masking real calls hidden in template churn; comments are the realistic false-positive. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const uploadRoutes = collectRouteFiles(path.join(API_ROOT, 'uploads'));
const v1UploadRoutes = collectRouteFiles(path.join(API_ROOT, 'v1', 'uploads'));
const contentRoutes = [
  path.join(API_ROOT, 'files', '[id]', 'content', 'route.ts'),
  path.join(API_ROOT, 'preview', '[token]', 'route.ts'), // public stream (P0.4)
];

describe('no-buffer guard (tech.md §9)', () => {
  it('finds the upload route surface (init/reserve/chunk/state/complete/abort)', () => {
    // 6 routes: init, reserve, chunk/[id], [id], [id]/complete, [id]/abort
    expect(uploadRoutes.length).toBeGreaterThanOrEqual(6);
  });

  it('finds the external v1 upload surface (create/state/chunk/complete/abort)', () => {
    // 5 routes: route.ts, [id], [id]/chunk, [id]/complete, [id]/abort (P0.4)
    expect(v1UploadRoutes.length).toBeGreaterThanOrEqual(5);
  });

  it('no upload route reads or buffers a request body', () => {
    for (const file of [...uploadRoutes, ...v1UploadRoutes]) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const { re, why } of FORBIDDEN) {
        expect(re.test(src), `${path.relative(API_ROOT, file)}: ${why}`).toBe(false);
      }
    }
  });

  it('the chunk route streams req.body straight through', () => {
    const chunk = uploadRoutes.find((f) => f.includes(path.join('uploads', 'chunk')));
    expect(chunk).toBeDefined();
    const src = stripComments(readFileSync(chunk!, 'utf8'));
    expect(src).toContain('req.body'); // positive: the stream is what gets forwarded
    expect(/req\.(json|arrayBuffer|text|formData)\s*\(/.test(src)).toBe(false);
  });

  it('the v1 chunk route streams req.body straight through', () => {
    const chunk = v1UploadRoutes.find((f) => f.includes(path.join('chunk', 'route.ts')));
    expect(chunk).toBeDefined();
    const src = stripComments(readFileSync(chunk!, 'utf8'));
    expect(src).toContain('req.body');
    expect(/req\.(json|arrayBuffer|text|formData)\s*\(/.test(src)).toBe(false);
  });

  it('content routes only stream (Range proxies never read a body)', () => {
    for (const file of contentRoutes) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const { re, why } of FORBIDDEN) {
        expect(re.test(src), `${path.relative(API_ROOT, file)}: ${why}`).toBe(false);
      }
      expect(/req\.(json|arrayBuffer|text|formData)\s*\(/.test(src), file).toBe(false);
    }
  });
});
