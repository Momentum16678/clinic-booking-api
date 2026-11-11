// Vercel entry point. vercel.json rewrites /api/* and /web/* to this function and
// passes which group (scope) and which sub-path in the query string, because the
// function can't reliably see the original URL. We rebuild it here for the handler.
// The web page itself is served straight from /public.
import { handler } from '../src/app.js';

export default function vercelHandler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const scope = url.searchParams.get('scope');
  if (scope === 'api' || scope === 'web') {
    const sub = url.searchParams.get('path') || '';
    url.searchParams.delete('scope');
    url.searchParams.delete('path');
    req.url = `/${scope}/${sub}${url.search}`;
  }
  return handler(req, res);
}
