// Test harness: a fresh local Postgres database with every migration applied, served by
// PostgREST (the REST layer Supabase uses) with real JWTs and row level security.
import { execFileSync, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostgrestClient } from '@supabase/postgrest-js';

export const MIGRATIONS = ['20261012_guru_and_premium.sql', '20261015_reels_v1.sql', '20261015_privacy_lockdown.sql', '20261017_dream_director.sql', '20261022_guru_memory.sql'];
export const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const SECRET = 'integration-test-secret-at-least-32-chars!!';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** A Supabase-style access token (HS256). role: authenticated | anon | service_role */
export function jwt(sub, role = 'authenticated') {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ ...(sub ? { sub } : {}), role, exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${head}.${body}.${createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
export function verify(token) {
  const [head, body, sig] = String(token || '').split('.');
  if (!sig || createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url') !== sig) return null;
  return JSON.parse(Buffer.from(body, 'base64url').toString());
}

export async function startDatabase({ PG_HOST, PG_PORT = '5432', BIN }) {
  const DB = `dreamreel_it_${Date.now()}`;
  const env = { ...process.env, PGOPTIONS: '-c client_min_messages=warning' };
  const run = (args) => execFileSync('psql', ['-h', PG_HOST, '-p', PG_PORT, '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', ...args], { encoding: 'utf8', env });
  const psql = (sql, db = DB) => run(['-d', db, '-c', sql]);
  run(['-d', 'postgres', '-c', `create database ${DB}`]);
  run(['-d', DB, '-f', new URL('../supabase-stub.sql', import.meta.url).pathname]);
  for (const f of MIGRATIONS) run(['-d', DB, '-f', new URL(`../../supabase/migrations/${f}`, import.meta.url).pathname]);
  psql(`do $$ begin if not exists (select from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if; end $$;
        grant anon, authenticated, service_role to authenticator;
        insert into auth.users values ('${A}'), ('${B}');`);

  const port = 30000 + Math.floor(Math.random() * 20000);
  const conf = path.join(mkdtempSync(path.join(os.tmpdir(), 'pgrst-')), 'pgrst.conf');
  writeFileSync(conf, `db-uri = "postgres://authenticator@/${DB}?host=${PG_HOST}&port=${PG_PORT}"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "${SECRET}"
server-port = ${port}
log-level = "crit"
`);
  const server = spawn(BIN, [conf], { stdio: 'ignore' });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { server.kill(); } catch {}
    try { run(['-d', 'postgres', '-c', `drop database if exists ${DB} with (force)`]); } catch {}
  };
  process.on('exit', stop);
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${url}/`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  const as = (user) => new PostgrestClient(url, { headers: { Authorization: `Bearer ${jwt(user)}` } });
  return { DB, psql, as, url, stop, A, B };
}
