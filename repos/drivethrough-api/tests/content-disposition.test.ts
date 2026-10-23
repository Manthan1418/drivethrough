// contentDisposition (P0.4) — the /api/preview/[token]?download=1 header. Malicious or
// sloppy file names must never break the header syntax (quotes/backslashes/CRLF) or
// silently drop non-ASCII names.

import { describe, it, expect } from 'vitest';
import { contentDisposition } from '../src/server/files/disposition';

describe('contentDisposition', () => {
  it('produces an attachment with both filename and filename*', () => {
    const h = contentDisposition('report.pdf');
    expect(h).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
  });

  it('neutralizes quotes, backslashes and CRLF (header injection / splitting)', () => {
    const h = contentDisposition('evil"\r\nSet-Cookie: x=1;.txt');
    expect(h).not.toMatch(/[\r\n]/);
    expect(h).toContain('filename="evil___Set-Cookie: x=1;.txt"');
  });

  it('encodes non-ASCII names in the filename* form, keeps a readable ASCII-ish fallback', () => {
    const h = contentDisposition('résumé.pdf');
    expect(h).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
    expect(h).toContain('filename="résumé.pdf"');
  });

  it('falls back gracefully on an empty/degenerate name', () => {
    expect(contentDisposition('')).toContain('filename="download"');
  });

  it('caps runaway lengths (a 5 KB name must not bloat the header)', () => {
    const h = contentDisposition('a'.repeat(5000));
    expect(h.length).toBeLessThan(600);
  });
});
