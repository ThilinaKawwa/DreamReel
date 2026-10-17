// Which deployment am I, and where is MY worker? Pure functions over an env object,
// so the isolation rules are unit-tested (test/env-isolation.test.mjs).
//
// Rules:
//   production  → this project's production domain (or a validated REEL_WORKER_URL)
//   preview     → THIS deployment's own URL (VERCEL_URL). Never a production host.
//   development → only an explicit localhost REEL_WORKER_URL; otherwise run in-process.
// NEXT_PUBLIC_SITE_URL is never used for routing work.

export function deploymentEnv(env = process.env) {
  if (env.VERCEL_ENV === 'production') return 'production';
  if (env.VERCEL_ENV === 'preview') return 'preview';
  return 'development';
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function parse(u) {
  try { return new URL(u); } catch { return null; }
}

/** Hosts that belong to production and must never receive preview/dev work. */
function productionHosts(env) {
  const hosts = new Set();
  if (env.VERCEL_PROJECT_PRODUCTION_URL) hosts.add(env.VERCEL_PROJECT_PRODUCTION_URL.toLowerCase());
  for (const h of String(env.PRODUCTION_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) hosts.add(h);
  const site = parse(env.NEXT_PUBLIC_SITE_URL || '');
  if (site) hosts.add(site.host.toLowerCase());
  return hosts;
}

/**
 * @returns {{ env: string, url: string|null, headers: object, reason: string }}
 *   url === null means "do not call a worker over the network".
 */
export function resolveWorkerTarget(env = process.env) {
  const which = deploymentEnv(env);
  const headers = {};
  const explicit = env.REEL_WORKER_URL ? parse(env.REEL_WORKER_URL) : null;
  const prodHosts = productionHosts(env);

  if (which === 'production') {
    if (explicit) {
      if (explicit.protocol !== 'https:') return { env: which, url: null, headers, reason: 'REEL_WORKER_URL must be https in production' };
      return { env: which, url: explicit.origin, headers, reason: 'explicit production worker' };
    }
    if (env.VERCEL_PROJECT_PRODUCTION_URL) return { env: which, url: `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`, headers, reason: 'production domain' };
    return { env: which, url: null, headers, reason: 'no production worker address' };
  }

  if (which === 'preview') {
    const own = env.VERCEL_URL ? env.VERCEL_URL.toLowerCase() : null;
    if (!own) return { env: which, url: null, headers, reason: 'preview without VERCEL_URL' };
    if (prodHosts.has(own)) return { env: which, url: null, headers, reason: 'preview resolved to a production host — refused' };
    let host = own;
    if (explicit) {
      const allowed = [own, (env.VERCEL_BRANCH_URL || '').toLowerCase()].filter(Boolean);
      // An explicit URL is only honoured if it is THIS preview; anything else is ignored.
      if (allowed.includes(explicit.host.toLowerCase()) && !prodHosts.has(explicit.host.toLowerCase())) host = explicit.host.toLowerCase();
    }
    // Preview deployments are usually behind Vercel Deployment Protection; the automation
    // bypass secret (a Vercel system variable) lets our own server reach its own worker.
    if (env.VERCEL_AUTOMATION_BYPASS_SECRET) headers['x-vercel-protection-bypass'] = env.VERCEL_AUTOMATION_BYPASS_SECRET;
    return { env: which, url: `https://${host}`, headers, reason: 'this preview deployment' };
  }

  // development
  if (explicit && LOCAL_HOSTS.has(explicit.hostname.toLowerCase())) {
    return { env: which, url: explicit.origin, headers, reason: 'explicit local worker' };
  }
  return { env: which, url: null, headers, reason: explicit ? 'non-local REEL_WORKER_URL refused in development' : 'run in-process' };
}
