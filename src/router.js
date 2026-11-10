import {
  BODY_STORAGE_LIMIT, HttpError, decrypt, objectJson, readLimited, sha256, statement
} from './common.js';

const GOOGLE = 'https://generativelanguage.googleapis.com';
const REQUEST_LIMIT = 1024 * 1024;
const RESPONSE_INSPECTION_LIMIT = 1024 * 1024;
const MAX_UPSTREAM_MS = 180_000;

function googleResponse(body, status, headers, id, cache) {
  const result = new Headers({
    'Content-Type': headers.get('Content-Type') || 'application/json',
    'Cache-Control': 'no-store',
    'X-Request-Id': id,
    'X-Router-Cache': cache
  });
  const retryAfter = headers.get('Retry-After');
  if (retryAfter) result.set('Retry-After', retryAfter);
  return new Response(body, { status, headers: result });
}

function usageOf(text) {
  try {
    const data = JSON.parse(text);
    return {
      input: safeTokenCount(data.usageMetadata?.promptTokenCount),
      total: safeTokenCount(data.usageMetadata?.totalTokenCount),
      cacheable: Array.isArray(data.candidates) && data.candidates.length > 0 &&
        data.candidates.every(candidate => candidate.finishReason === 'STOP')
    };
  } catch {
    return {};
  }
}

function safeTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function observe(body, sse, onFinish) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  let bytes = 0;
  let capture = '';
  let lineBuffer = '';
  let usage = {};
  let skipLine = false;
  let finished = false;

  function processLines(text) {
    const lines = text.split('\n');
    lineBuffer += lines[0];
    if (lines.length === 1) {
      if (lineBuffer.length > RESPONSE_INSPECTION_LIMIT) {
        skipLine = true;
        lineBuffer = '';
      }
      return;
    }
    if (!skipLine) processLine(lineBuffer);
    for (const line of lines.slice(1, -1)) processLine(line);
    lineBuffer = lines.at(-1);
    skipLine = false;
  }

  function processLine(line) {
    if (!line.startsWith('data:')) return;
    const chunkUsage = usageOf(line.slice(5));
    usage.input = chunkUsage.input ?? usage.input;
    usage.total = chunkUsage.total ?? usage.total;
  }

  function finish(state) {
    if (finished) return;
    finished = true;
    const tail = decoder.decode();
    if (sse) processLines(tail + '\n');
    if (capture !== null) capture += tail;
    if (!sse && capture !== null && state === 'complete') usage = usageOf(capture);
    onFinish(state, usage, bytes <= BODY_STORAGE_LIMIT ? capture : null);
  }

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish('complete');
          controller.close();
          return;
        }
        bytes += value.byteLength;
        if (sse || bytes <= RESPONSE_INSPECTION_LIMIT) {
          const text = decoder.decode(value, { stream: true });
          if (sse) processLines(text);
          if (capture !== null && bytes <= (sse ? BODY_STORAGE_LIMIT : RESPONSE_INSPECTION_LIMIT)) {
            capture += text;
          } else {
            capture = null;
          }
        } else {
          capture = null;
        }
        controller.enqueue(value);
      } catch (error) {
        finish('upstream_error');
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish('cancelled');
      await reader.cancel(reason);
    }
  });
}

export async function routeGemini(request, env, ctx, path, url) {
  if (request.method !== 'POST') throw new HttpError(405, 'Use POST');
  const [, version, model, action] = path;
  const sse = action === 'streamGenerateContent';
  if (url.search && (!sse || url.search !== '?alt=sse')) {
    throw new HttpError(400, 'Unsupported query string');
  }
  const token = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/i)?.[1] ??
    request.headers.get('x-goog-api-key');
  if (!token || !/^gr_[a-f0-9]{64}$/.test(token)) throw new HttpError(401, 'Invalid app token');
  const db = env.DB;
  const app = await statement(db, `
    SELECT id, project_id, cache_seconds, log_bodies FROM apps
    WHERE token_hash = ? AND revoked_at IS NULL
  `, await sha256(token)).first();
  if (!app) throw new HttpError(401, 'Invalid app token');

  let raw;
  try {
    raw = await readLimited(request.body, REQUEST_LIMIT);
  } catch (error) {
    if (error instanceof TypeError) throw new HttpError(400, 'Invalid UTF-8');
    throw error;
  }
  const payload = objectJson(raw);
  const id = crypto.randomUUID();
  const started = Date.now();
  const requestBody = app.log_bodies && new TextEncoder().encode(raw).byteLength <= BODY_STORAGE_LIMIT
    ? raw : null;
  const cacheEnabled = action === 'generateContent' && app.cache_seconds > 0 &&
    !payload.tools && !payload.toolConfig && !payload.cachedContent;
  const cacheId = cacheEnabled
    ? await sha256(JSON.stringify([app.id, app.project_id, version, model, raw]))
    : null;
  const cache = cacheId && await statement(db,
    'SELECT body FROM response_cache WHERE id = ? AND expires_at > ?', cacheId, started).first();
  const key = !cache && await statement(db, `
    SELECT id, encrypted_key FROM google_keys WHERE project_id = ? AND encrypted_key IS NOT NULL
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `, app.project_id).first();

  await statement(db, `
    INSERT INTO requests (id, app_id, project_id, key_id, model, action, started_at, source, request_body, body_state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, id, app.id, app.project_id, key?.id ?? null, model, action, started,
  cache ? 'cache' : 'router', requestBody, app.log_bodies ? 'pending' : 'disabled').run();

  function record(status, state, usage = {}, responseBody = null, storeCache = false) {
    const queries = [statement(db, `
      UPDATE requests SET status = ?, latency_ms = ?, input_tokens = ?, total_tokens = ?,
      response_body = ?, body_state = ? WHERE id = ?
    `, status, Date.now() - started, usage.input ?? null, usage.total ?? null,
    app.log_bodies ? responseBody : null,
    !app.log_bodies ? 'disabled' :
      state === 'complete' && (requestBody === null || responseBody === null) ? 'omitted' : state, id)];
    if (storeCache) {
      queries.push(statement(db, `
        INSERT INTO response_cache (id, body, expires_at) VALUES (?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET body = excluded.body, expires_at = excluded.expires_at
      `, cacheId, responseBody, Date.now() + app.cache_seconds * 1000));
    }
    ctx.waitUntil(db.batch(queries).catch(() => console.error('request_record_failed', id)));
  }

  const jsonHeaders = new Headers({ 'Content-Type': 'application/json' });
  if (cache) {
    record(200, 'complete', {}, cache.body);
    return googleResponse(cache.body, 200, jsonHeaders, id, 'HIT');
  }
  if (!key) {
    const body = JSON.stringify({ error: { code: 503, message: 'No active Google key for this project' } });
    record(503, 'complete', {}, body);
    return googleResponse(body, 503, jsonHeaders, id, 'BYPASS');
  }

  let upstream;
  try {
    const secret = await decrypt(env.KEY_ENCRYPTION_KEY, key.id, key.encrypted_key);
    await statement(db, "UPDATE requests SET source = 'google' WHERE id = ?", id).run();
    upstream = await fetch(GOOGLE + url.pathname + (sse ? '?alt=sse' : ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': secret },
      body: raw,
      redirect: 'manual',
      signal: AbortSignal.timeout(MAX_UPSTREAM_MS)
    });
  } catch (error) {
    const status = error?.name === 'TimeoutError' ? 504 : 502;
    const body = JSON.stringify({ error: { code: status, message: 'Google upstream unavailable' } });
    record(status, 'upstream_error', {}, body);
    return googleResponse(body, status, jsonHeaders, id, cacheEnabled ? 'MISS' : 'BYPASS');
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    void upstream.body?.cancel().catch(() => {});
    const body = JSON.stringify({ error: { code: 502, message: 'Unexpected Google redirect' } });
    record(502, 'upstream_error', {}, body);
    return googleResponse(body, 502, jsonHeaders, id, 'BYPASS');
  }

  const body = upstream.body && observe(upstream.body, sse && upstream.ok, (state, usage, text) => {
    const storeCache = Boolean(cacheId && upstream.status === 200 && state === 'complete' &&
      usage.cacheable && text !== null);
    record(state === 'cancelled' ? 499 : state === 'upstream_error' ? 502 : upstream.status,
      state, upstream.ok ? usage : {}, text, storeCache);
  });
  if (!body) record(upstream.status, 'complete');
  return googleResponse(body, upstream.status, upstream.headers, id, cacheEnabled ? 'MISS' : 'BYPASS');
}
