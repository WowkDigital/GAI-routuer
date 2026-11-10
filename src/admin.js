import {
  HttpError, encrypt, objectJson, pacificDayStart, randomToken, readLimited, sha256, statement
} from './common.js';

function required(value, label, pattern = /^.{1,100}$/u) {
  if (typeof value !== 'string' || !pattern.test(value.trim())) {
    throw new HttpError(400, 'Invalid ' + label);
  }
  return value.trim();
}

function integer(value, name, maximum, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new HttpError(400, 'Invalid ' + name);
  }
  return value;
}

async function existingProject(db, projectId) {
  if (!await statement(db, 'SELECT id FROM projects WHERE id = ?', projectId).first()) {
    throw new HttpError(404, 'Project not found');
  }
}

async function overview(db) {
  const now = Date.now();
  const minute = now - 60_000;
  const day = pacificDayStart(now);
  const [projects, keys, apps, quotas, recent] = await db.batch([
    statement(db, 'SELECT id, name FROM projects ORDER BY name'),
    statement(db, `
      SELECT id, project_id, label, encrypted_key IS NOT NULL AS active, created_at
      FROM google_keys ORDER BY created_at DESC LIMIT 200
    `),
    statement(db, `
      WITH counts AS (
        SELECT app_id, COUNT(*) AS requests,
          SUM(source = 'google') AS google_calls, SUM(source = 'cache') AS hits,
          SUM(COALESCE(status >= 400, 0)) AS errors, SUM(COALESCE(total_tokens, 0)) AS tokens
        FROM requests WHERE started_at >= ? GROUP BY app_id
      )
      SELECT apps.id, name, project_id, cache_seconds, log_bodies, revoked_at,
        COALESCE(requests, 0) AS requests, COALESCE(google_calls, 0) AS google_calls,
        COALESCE(hits, 0) AS hits, COALESCE(errors, 0) AS errors, COALESCE(tokens, 0) AS tokens
      FROM apps LEFT JOIN counts ON counts.app_id = apps.id ORDER BY name
    `, now - 86_400_000),
    statement(db, `
      WITH usage AS (
        SELECT project_id, model,
          SUM(started_at >= ?) AS used_rpm,
          SUM(CASE WHEN started_at >= ? THEN COALESCE(input_tokens, 0) ELSE 0 END) AS known_tpm,
          SUM(started_at >= ? AND input_tokens IS NULL) AS missing_tpm,
          SUM(started_at >= ?) AS used_rpd
        FROM requests
        WHERE source = 'google' AND action != 'countTokens' AND started_at >= ?
        GROUP BY project_id, model
      )
      SELECT quotas.*, COALESCE(used_rpm, 0) AS used_rpm, COALESCE(known_tpm, 0) AS known_tpm,
        COALESCE(missing_tpm, 0) AS missing_tpm, COALESCE(used_rpd, 0) AS used_rpd
      FROM quotas LEFT JOIN usage USING (project_id, model) ORDER BY project_id, model
    `, minute, minute, minute, day, Math.min(minute, day)),
    statement(db, `
      SELECT requests.id, app_id, apps.name AS app_name, model, action, started_at, source,
        status, latency_ms, input_tokens, total_tokens, body_state
      FROM requests JOIN apps ON apps.id = requests.app_id ORDER BY started_at DESC, requests.id DESC LIMIT 100
    `)
  ]);
  return {
    projects: projects.results, keys: keys.results, apps: apps.results, recent: recent.results,
    quotas: quotas.results.map(q => ({
      ...q,
      remaining_rpm: q.rpm === null ? null : Math.max(0, q.rpm - q.used_rpm),
      remaining_tpm: q.tpm === null || q.missing_tpm ? null : Math.max(0, q.tpm - q.known_tpm),
      remaining_rpd: q.rpd === null ? null : Math.max(0, q.rpd - q.used_rpd)
    }))
  };
}

export async function routeAdmin(request, env, pathname) {
  const db = env.DB;
  const method = request.method;
  const path = pathname.slice('/admin/'.length);
  if (method === 'GET' && path === 'overview') return Response.json(await overview(db));

  const detail = path.match(/^requests\/([0-9a-f-]{36})$/);
  if (method === 'GET' && detail) {
    const row = await statement(db, `
      SELECT id, app_id, project_id, key_id, model, action, started_at, source, status, latency_ms,
        input_tokens, total_tokens, body_state,
        CASE WHEN started_at >= ? THEN request_body END AS request_body,
        CASE WHEN started_at >= ? THEN response_body END AS response_body
      FROM requests WHERE id = ?
    `, Date.now() - 86_400_000, Date.now() - 86_400_000, detail[1]).first();
    if (!row) throw new HttpError(404, 'Request not found');
    return Response.json(row);
  }

  if (method === 'POST' && ['projects', 'keys', 'apps', 'quotas'].includes(path)) {
    const data = objectJson(await readLimited(request.body, 8192));
    const projectId = required(data.project_id, 'Google Cloud project ID', /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
    if (path === 'projects') {
      const name = required(data.name, 'project name');
      const result = await statement(db, 'INSERT INTO projects VALUES (?, ?) ON CONFLICT DO NOTHING',
        projectId, name).run();
      if (!result.meta.changes) throw new HttpError(409, 'Project already exists');
      return Response.json({ id: projectId }, { status: 201 });
    }
    await existingProject(db, projectId);
    if (path === 'quotas') {
      const model = required(data.model, 'model', /^[A-Za-z0-9_.-]{1,100}$/);
      const limits = ['rpm', 'tpm', 'rpd'].map(name =>
        data[name] == null ? null : integer(data[name], name, 1_000_000_000, 1));
      await statement(db, `
        INSERT INTO quotas VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (project_id, model) DO UPDATE SET
        rpm = excluded.rpm, tpm = excluded.tpm, rpd = excluded.rpd, updated_at = excluded.updated_at
      `, projectId, model, ...limits, Date.now()).run();
      return Response.json({ model });
    }

    const id = crypto.randomUUID();
    if (path === 'keys') {
      const key = required(data.api_key, 'Google auth key', /^[A-Za-z0-9_-]{20,256}$/);
      const label = required(data.label, 'key label');
      await statement(db, 'INSERT INTO google_keys VALUES (?, ?, ?, ?, ?)',
        id, projectId, label, await encrypt(env.KEY_ENCRYPTION_KEY, id, key), Date.now()).run();
      return Response.json({ id }, { status: 201 });
    }

    const name = required(data.name, 'app name');
    const ttl = integer(data.cache_seconds ?? 0, 'cache TTL', 86_400);
    const appToken = randomToken();
    await statement(db, `
      INSERT INTO apps (id, name, project_id, token_hash, cache_seconds, log_bodies) VALUES (?, ?, ?, ?, ?, ?)
    `, id, name, projectId, await sha256(appToken), ttl, data.log_bodies === true ? 1 : 0).run();
    return Response.json({ id, token: appToken }, { status: 201 });
  }

  const app = path.match(/^apps\/([0-9a-f-]{36})$/);
  const rotate = path.match(/^apps\/([0-9a-f-]{36})\/rotate$/);
  const key = path.match(/^keys\/([0-9a-f-]{36})$/);
  if (method === 'PATCH' && app) {
    const data = objectJson(await readLimited(request.body, 8192));
    const ttl = integer(data.cache_seconds, 'cache TTL', 86_400);
    if (typeof data.log_bodies !== 'boolean') throw new HttpError(400, 'Invalid log_bodies');
    const result = await statement(db, `
      UPDATE apps SET cache_seconds = ?, log_bodies = ? WHERE id = ? AND revoked_at IS NULL
    `, ttl, Number(data.log_bodies), app[1]).run();
    if (!result.meta.changes) throw new HttpError(404, 'Active app not found');
    return new Response(null, { status: 204 });
  }
  if (method === 'POST' && rotate) {
    const appToken = randomToken();
    const result = await statement(db, `
      UPDATE apps SET token_hash = ? WHERE id = ? AND revoked_at IS NULL
    `, await sha256(appToken), rotate[1]).run();
    if (!result.meta.changes) throw new HttpError(404, 'Active app not found');
    return Response.json({ id: rotate[1], token: appToken });
  }
  if (method === 'DELETE' && (app || key)) {
    const result = app
      ? await statement(db, 'UPDATE apps SET revoked_at = ? WHERE id = ?', Date.now(), app[1]).run()
      : await statement(db, 'UPDATE google_keys SET encrypted_key = NULL WHERE id = ?', key[1]).run();
    if (!result.meta.changes) throw new HttpError(404, 'Record not found');
    return new Response(null, { status: 204 });
  }
  throw new HttpError(404, 'Unknown admin endpoint');
}

export async function prune(db) {
  const now = Date.now();
  for (let batch = 0; batch < 10; batch++) {
    const results = await db.batch([
      statement(db, `
        DELETE FROM response_cache WHERE id IN (
          SELECT id FROM response_cache WHERE expires_at <= ? LIMIT 1000
        )
      `, now),
      statement(db, `
        DELETE FROM requests WHERE id IN (
          SELECT id FROM requests WHERE started_at < ? LIMIT 1000
        )
      `, now - 14 * 86_400_000),
      statement(db, `
        UPDATE requests SET request_body = NULL, response_body = NULL, body_state = 'expired'
        WHERE id IN (
          SELECT id FROM requests WHERE started_at < ?
          AND (request_body IS NOT NULL OR response_body IS NOT NULL) LIMIT 1000
        )
      `, now - 86_400_000)
    ]);
    if (results.every(result => result.meta.changes < 1000)) return;
  }
}
