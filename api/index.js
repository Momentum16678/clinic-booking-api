// Vercel entry point. vercel.json sends /api/* and /web/* here;
// the web page itself is served straight from /public.
import { handler } from '../src/app.js';

export default handler;
