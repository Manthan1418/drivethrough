// RFC 6266 Content-Disposition for the public download path (?download=1): quote-safe
// ASCII fallback plus the UTF-8 `filename*` form so non-ASCII names survive.

export function contentDisposition(fileName: string): string {
  const safe = fileName.replace(/[\r\n"\\]/g, '_').slice(0, 120) || 'download';
  const encoded = encodeURIComponent(fileName)
    .replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .slice(0, 300);
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}
