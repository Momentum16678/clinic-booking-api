// Vercel entry point: vercel.json rewrites /api/* and /web/* here, app.js rebuilds the URL.
// The web page itself is served straight from /public.
import { handler } from '../src/app.js';

export default handler;
