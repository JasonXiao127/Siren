/**
 * Subpath base helper (Docker reverse-proxy support).
 *
 * Build-time configured via VITE_BASE_PATH (e.g. `/siren`). Defaults to `/`
 * (root), which is what Electron (`app://siren/`) and local dev always use.
 *
 * - Vite's `base` handles bundled asset URLs in dist/index.html.
 * - This helper handles runtime URLs: API base, media URLs, img src, and
 *   hard redirects (window.location.href) which BrowserRouter can't rewrite.
 */

export function getBasePath(): string {
  const raw =
    (import.meta.env.VITE_BASE_PATH as string | undefined) ?? '/';
  let base = raw.trim();
  if (!base.startsWith('/')) base = `/${base}`;
  // Collapse leading + trailing slashes (except root) so odd inputs like
  // '///siren//' can't produce '//…' URLs. Mirrors server getBasePath().
  base = base.replace(/^\/{2,}/, '/');
  if (base.length > 1) base = base.replace(/\/+$/, '');
  if (base === '') base = '/';
  return base;
}

/** Prefixes an absolute app path (`/api/...`, `/login`, `/siren.svg`) with the base. */
export function withBase(p: string): string {
  if (!p.startsWith('/')) p = `/${p}`;
  const base = getBasePath();
  if (base === '/') return p;
  return `${base}${p}`;
}
