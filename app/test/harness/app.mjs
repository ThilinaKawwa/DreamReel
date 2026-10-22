// Test harness: the real app (next dev) on a real Postgres/PostgREST, with stand-ins for
// Supabase Auth and OpenAI only. Used by test/route-integration.mjs and test/ui-screens.mjs.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { startDatabase, jwt, verify, A, B } from './pg.mjs';
import { pcm16ToWav } from '../../lib/audio/wav.js';

export { A, B, jwt };

const MEMORIES = [
  [/silver door/, { title: 'The Silver Door', summary: 'You found a silver door in a forest.', cleaned_text: 'I was walking through a forest and saw a silver door. I felt curious, not scared.', emotions: ['curious'], places: [{ label: 'a forest' }], objects: [{ label: 'a silver door' }] }],
  [/station with my brother/, { title: 'The Station', summary: 'You were at a station with your brother, trying to leave.', cleaned_text: 'I was at a train station with my brother, trying to leave.', emotions: ['anxious'], people: [{ label: 'my brother' }], places: [{ label: 'a train station' }] }],
  [/beach/, { title: 'Beach', summary: 'Your brother at the beach; the sea was calm.', cleaned_text: 'My brother was there again, this time at the beach. The sea was calm.', emotions: ['calm'], people: [{ label: 'my brother' }], places: [{ label: 'the beach' }], themes: ['water'] }],
];

/** FAKE OpenAI chat: memory extraction and Orin's replies, decided by the prompt. */
function fakeChat(body, prompts) {
  const sys = body.messages[0].content;
  const user = body.messages[body.messages.length - 1].content;
  if (sys.startsWith('You record dreams')) {
    const hit = MEMORIES.find(([re]) => re.test(user));
    return { dream_type: 'story', events: [], details: [], people: [], places: [], objects: [], creatures: [], themes: [], emotions: [], ...(hit ? hit[1] : { title: 'A dream', summary: 'A dream.', cleaned_text: 'A dream.' }) };
  }
  prompts.push({ sys, user });
  const retry = body.messages.some((m, i) => i > 0 && m.role === 'system');
  if (/FAKE_PAST/.test(user)) return { text: 'You’ve dreamed about this before, again.', expression: 'warm' }; // always invents a past
  const ids = [...sys.matchAll(/\[(D\d+)\]/g)].map((m) => m[1]);
  if (/ARCHIVE RESULTS/.test(sys)) {
    const n = Number((sys.match(/ARCHIVE RESULTS for their question — (\d+) matching/) || [])[1] || 0);
    return n ? { text: `Yes — I found ${n} dreams with your brother.`, cited_dream_ids: ids.slice(0, 2), expression: 'thoughtful' } : { text: 'I can’t find any dreams like that in your journal yet.', expression: 'warm' };
  }
  if (/answering your question/.test(sys)) return { text: 'Curious rather than afraid — that matters.', dream_complete: true, expression: 'warm' };
  if (/first dream they have shared/.test(sys)) return { text: 'A silver door in a forest — I’ve kept this one. How did you feel when you saw it?', asked_question: true, expression: 'curious' };
  return { text: ids.length ? 'This sounds similar to an earlier dream.' : 'I’ve kept this dream.', cited_dream_ids: ids.slice(0, 1), dream_complete: !retry, expression: 'warm' };
}

export async function startStack({ PG_HOST, PG_PORT = '5432', BIN, env = {}, browserUser = A }) {
  const db = await startDatabase({ PG_HOST, PG_PORT, BIN });
  const prompts = [];
  const state = { transcription: '' };
  const wav = pcm16ToWav(Buffer.alloc(24000), 24000); // half a second of silence

  const fake = http.createServer(async (req, res) => {
    const cors = { 'access-control-allow-origin': req.headers.origin || '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const send = (status, data, type = 'application/json') => { res.writeHead(status, { 'content-type': type, ...cors }); res.end(type === 'application/json' ? JSON.stringify(data) : data); };
    const user = (id) => ({ id, aud: 'authenticated', role: 'authenticated', is_anonymous: true, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() });
    if (req.url.startsWith('/auth/v1/user')) {
      const claims = verify((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
      return claims?.sub ? send(200, user(claims.sub)) : send(401, { msg: 'bad token' });
    }
    if (req.url.startsWith('/auth/v1/signup') || req.url.startsWith('/auth/v1/token')) {
      return send(200, { access_token: jwt(browserUser), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: user(browserUser) });
    }
    if (req.url.startsWith('/rest/v1/')) {
      const headers = { ...req.headers }; delete headers.host; delete headers['content-length']; delete headers.apikey; delete headers.origin;
      const r = await fetch(`${db.url}${req.url.slice('/rest/v1'.length)}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
      res.writeHead(r.status, { ...Object.fromEntries([...r.headers].filter(([k]) => !['content-encoding', 'transfer-encoding'].includes(k))), ...cors });
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    if (req.url.startsWith('/storage/v1/')) return send(200, []);
    if (req.url === '/openai/v1/chat/completions') {
      const reply = fakeChat(JSON.parse(body.toString()), prompts);
      return send(200, { id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(reply) }, finish_reason: 'stop' }], usage: { prompt_tokens: 800, completion_tokens: 80 } });
    }
    if (req.url === '/openai/v1/audio/transcriptions') return send(200, { text: state.transcription });
    if (req.url === '/openai/v1/audio/speech') return send(200, wav, 'audio/wav');
    send(404, { error: 'not faked' });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const FAKE = `http://127.0.0.1:${fake.address().port}`;

  const port = 31000 + Math.floor(Math.random() * 9000);
  const app = spawn('npx', ['next', 'dev', '-p', String(port)], {
    cwd: new URL('../..', import.meta.url).pathname, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1',
      NEXT_PUBLIC_SUPABASE_URL: FAKE, NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt(null, 'anon'), SUPABASE_SERVICE_ROLE_KEY: jwt(null, 'service_role'),
      OPENAI_API_KEY: 'test', OPENAI_BASE_URL: `${FAKE}/openai/v1`, FAL_KEY: '', REEL_WORKER_SECRET: '', STRIPE_SECRET_KEY: '',
      TTS_FALLBACK_MODEL: '', ...env,
    },
  });
  let log = '';
  app.stdout.on('data', (d) => { log += d; });
  app.stderr.on('data', (d) => { log += d; });
  const stop = () => { try { process.kill(-app.pid, 'SIGTERM'); } catch {} fake.close(); db.stop(); };
  process.on('exit', stop);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 240; i++) { try { await fetch(`${base}/api/me/entitlements`); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }

  async function talk(who, fields) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v != null) form.append(k, v);
    const r = await fetch(`${base}/api/guru/talk`, { method: 'POST', headers: { Authorization: `Bearer ${jwt(who)}` }, body: form });
    return { status: r.status, ...(await r.json()) };
  }
  async function call(who, path, method = 'GET', json) {
    const r = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${jwt(who)}`, ...(json ? { 'content-type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }
  const q1 = (sql) => db.psql(`copy (${sql}) to stdout`).trim();
  const waitFor = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 400)); } return false; };
  return { base, talk, call, q1, psql: db.psql, waitFor, prompts, state, stop, log: () => log };
}
