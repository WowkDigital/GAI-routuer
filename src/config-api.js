import { routeAdmin } from './admin.js';
import { HttpError, randomToken, sha256, statement } from './common.js';

const prefix = '/config/v1';
const tokenLifetime = 90 * 24 * 60 * 60 * 1000;

export async function manageConfigToken(request, db) {
  if (request.method === 'GET') {
    const row = await statement(db, 'SELECT expires_at FROM config_token WHERE singleton = 1').first();
    return Response.json({ expires_at: row?.expires_at ?? null });
  }
  if (request.method === 'POST') {
    const token = 'gc_' + randomToken().slice(3);
    const expiresAt = Date.now() + tokenLifetime;
    await statement(db, `
      INSERT INTO config_token VALUES (1, ?, ?) ON CONFLICT (singleton) DO UPDATE SET
      token_hash = excluded.token_hash, expires_at = excluded.expires_at
    `, await sha256(token), expiresAt).run();
    return Response.json({ token, expires_at: expiresAt }, { status: 201 });
  }
  if (request.method === 'DELETE') {
    await statement(db, 'DELETE FROM config_token WHERE singleton = 1').run();
    return new Response(null, { status: 204 });
  }
  throw new HttpError(405, 'Method not allowed');
}

export async function routeConfig(request, env, pathname) {
  const token = request.headers.get('Authorization')?.match(/^Bearer (gc_[a-f0-9]{64})$/i)?.[1];
  if (!token || !await statement(env.DB, `
    SELECT 1 FROM config_token WHERE singleton = 1 AND token_hash = ? AND expires_at > ?
  `, await sha256(token), Date.now()).first()) {
    throw new HttpError(401, 'Invalid or expired configuration token');
  }

  const path = pathname.slice(prefix.length);
  const method = request.method;
  if (method === 'GET' && (path === '' || path === '/')) {
    return routeAdmin(request, env, '/admin/overview', { includeRecent: false });
  }
  if ((method === 'POST' && /^\/(projects|keys|apps|quotas)$/.test(path)) ||
      (method === 'PATCH' && /^\/apps\/[0-9a-f-]{36}$/.test(path))) {
    return routeAdmin(request, env, '/admin' + path);
  }
  throw new HttpError(404, 'Unknown configuration endpoint');
}
