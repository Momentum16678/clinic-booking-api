// Vercel entry point for the web page's /web/* calls.
// vercel.json rewrites /web/<x> to /api/web?path=<x>. Without this, the handler
// would see an /api path and demand the API key. We restore the /web/ path here.
import { handler } from '../src/app.js';

export default function webHandler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const sub = url.searchParams.get('path') || '';
  url.searchParams.delete('path');
  req.url = `/web/${sub}${url.search}`;
  return handler(req, res);
}
