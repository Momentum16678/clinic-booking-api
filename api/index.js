// Vercel entry point. vercel.json rewrites /api/* and /web/* here (passing the
// original group and path in the query; src/app.js rebuilds the real URL).
// The web page itself is served straight from /public.
import { handler } from '../src/app.js';

export default handler;
