import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, pbkdf2Sync, randomBytes, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import worker from '../src/index.js';
import { pacificDayStart } from '../src/common.js';

function sqliteBinding() {
  const database = new DatabaseSync(':memory:');
  for (const file of ['0001_initial.sql', '0002_passkey.sql', '0003_password.sql']) {
    database.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  return {
    database,
    prepare(sql) {
      return {
        bind(...params) {
          return {
            isWrite: /^\s*(INSERT|UPDATE|DELETE)/.test(sql),
            first: () => database.prepare(sql).get(...params) ?? null,
            all: () => ({ results: database.prepare(sql).all(...params) }),
            run: () => ({ meta: { changes: database.prepare(sql).run(...params).changes } })
          };
        }
      };
    },
    async batch(statements) {
      database.exec('BEGIN');
      try {
        const result = statements.map(statement => {
          if (statement.isWrite) return statement.run();
          return statement.all();
        });
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }
  };
}

const hash = value => createHash('sha256').update(value).digest();
const enrollment = 'e'.repeat(64);

function fixture({ signedIn = true } = {}) {
  const DB = sqliteBinding();
  const env = {
    DB,
    ADMIN_ENROLLMENT: hash(enrollment).toString('hex') + '.' + (Date.now() + 60_000),
    PASSWORD_PEPPER: Buffer.alloc(32, 2).toString('base64'),
    KEY_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'),
    PANEL_ORIGIN: 'https://owner.github.io',
    AUTH_LIMITER: { limit: async () => ({ success: true }) },
    PASSWORD_LIMITER: { limit: async () => ({ success: true }) }
  };
  const adminToken = 'gs_' + 'a'.repeat(64);
  if (signedIn) {
    DB.database.prepare('INSERT INTO admin_sessions (token_hash, expires_at) VALUES (?, ?)').run(
      hash(adminToken).toString('hex'), Date.now() + 60_000
    );
  }
  const pending = [];
  const ctx = { waitUntil: promise => pending.push(promise) };

  async function request(path, { method = 'GET', token, apiKey, body, origin } = {}) {
    const headers = new Headers();
    if (token) headers.set('Authorization', 'Bearer ' + token);
    if (apiKey) headers.set('x-goog-api-key', apiKey);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (origin) headers.set('Origin', origin);
    const response = await worker.fetch(new Request('https://router.example' + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    }), env, ctx);
    const text = await response.text();
    await Promise.all(pending.splice(0));
    const json = response.headers.get('Content-Type')?.includes('json') && text
      ? JSON.parse(text) : null;
    return { status: response.status, headers: response.headers, json, text };
  }

  const admin = (path, method = 'GET', body) => request('/admin/' + path, {
    method, token: adminToken, origin: env.PANEL_ORIGIN, body
  });
  return { env, ctx, pending, request, admin, adminToken };
}

const project_id = 'my-gemini-project';
const model = 'gemini-test';
const generation = '/v1beta/models/' + model + ':generateContent';
const payload = { contents: [{ parts: [{ text: 'Test' }] }] };

test('proxy, cache isolation, SSE, quotas, history, key rotation and revocation', async t => {
  const { env, request, admin, adminToken } = fixture();
  t.after(() => env.DB.database.close());
  const oldKey = 'test_google_key_not_a_real_secret';
  const newKey = 'test_google_key_second_not_real';
  const data = {
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Odpowiedź' }] } }],
    usageMetadata: { promptTokenCount: 4, totalTokenCount: 10 }
  };
  const sse = 'data: ' + JSON.stringify(data) + '\r\n\r\n';
  let upstreamStatus = 200;
  const google = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.ok(url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/'));
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), payload);
    if (upstreamStatus !== 200) {
      return Response.json({ error: { code: upstreamStatus } }, {
        status: upstreamStatus, headers: { 'Retry-After': '5' }
      });
    }
    if (url.endsWith('?alt=sse')) {
      const bytes = new TextEncoder().encode(sse);
      return new Response(new ReadableStream({
        start(controller) {
          for (let index = 0; index < bytes.length; index += 7) {
            controller.enqueue(bytes.slice(index, index + 7));
          }
          controller.close();
        }
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return Response.json(data);
  });

  assert.equal((await request('/admin/overview')).status, 401);
  assert.equal((await request('/admin/overview', { origin: 'https://other.example' })).status, 403);
  assert.equal((await request('/admin/apps', { method: 'OPTIONS', origin: env.PANEL_ORIGIN }))
    .headers.get('Access-Control-Allow-Origin'), env.PANEL_ORIGIN);
  assert.equal((await admin('projects', 'POST', { project_id, name: 'Gemini' })).status, 201);
  const key = await admin('keys', 'POST', { project_id, label: 'Pierwszy', api_key: oldKey });
  assert.equal(key.status, 201);
  const encrypted = env.DB.database.prepare('SELECT encrypted_key FROM google_keys').get().encrypted_key;
  assert.ok(!encrypted.includes(oldKey));

  const app1 = await admin('apps', 'POST', { project_id, name: 'A', cache_seconds: 120, log_bodies: true });
  const app2 = await admin('apps', 'POST', { project_id, name: 'B', cache_seconds: 120 });
  assert.equal(app1.status, 201);
  assert.equal(app2.status, 201);
  assert.equal((await admin('quotas', 'POST', { project_id, model, rpm: 10, tpm: 100, rpd: 20 })).status, 200);
  assert.equal((await request(generation, { method: 'POST', token: adminToken, body: payload })).status, 401);

  const send = (app, path = generation) => request(path, { method: 'POST', apiKey: app.json.token, body: payload });
  const first = await send(app1);
  assert.equal(first.headers.get('X-Router-Cache'), 'MISS');
  assert.deepEqual(first.json, data);
  assert.equal(google.mock.calls[0].arguments[1].headers['x-goog-api-key'], oldKey);
  assert.equal((await send(app1)).headers.get('X-Router-Cache'), 'HIT');
  assert.equal((await send(app2)).headers.get('X-Router-Cache'), 'MISS');
  assert.equal(google.mock.callCount(), 2);

  const next = await admin('keys', 'POST', { project_id, label: 'Drugi', api_key: newKey });
  const stream = await send(app1, generation.replace(':generateContent', ':streamGenerateContent?alt=sse'));
  assert.equal(stream.status, 200);
  assert.equal(stream.headers.get('X-Router-Cache'), 'BYPASS');
  assert.equal(stream.text, sse);
  assert.equal(google.mock.calls[2].arguments[1].headers['x-goog-api-key'], newKey);

  const stats = (await admin('overview')).json;
  assert.equal(stats.apps[0].requests, 3);
  assert.equal(stats.apps[0].google_calls, 2);
  assert.equal(stats.apps[0].hits, 1);
  assert.equal(stats.apps[0].tokens, 20);
  assert.equal(stats.quotas[0].remaining_rpm, 7);
  assert.equal(stats.quotas[0].remaining_tpm, 88);
  assert.equal(stats.quotas[0].remaining_rpd, 17);
  assert.deepEqual(stats.usage, [{
    project_id, model, used_rpm: 3, known_tpm: 12, missing_tpm: 0, used_rpd: 3
  }]);
  assert.equal(stats.keys.some(key => 'encrypted_key' in key), false);
  assert.equal(stats.apps.some(app => 'token_hash' in app), false);
  const detail = await admin('requests/' + first.headers.get('X-Request-Id'));
  assert.deepEqual(JSON.parse(detail.json.request_body), payload);
  assert.deepEqual(JSON.parse(detail.json.response_body), data);
  const other = await admin('requests/' + stats.recent.find(row => row.app_id === app2.json.id).id);
  assert.equal(other.json.request_body, null);
  assert.equal(other.json.response_body, null);

  assert.equal((await admin('keys/' + next.json.id, 'DELETE')).status, 204);
  upstreamStatus = 429;
  const error = await send(app1, generation.replace(':generateContent', ':streamGenerateContent'));
  assert.equal(error.status, 429);
  assert.equal(error.headers.get('Retry-After'), '5');
  assert.equal(google.mock.calls[3].arguments[1].headers['x-goog-api-key'], oldKey);
  assert.equal((await admin('overview')).json.quotas[0].remaining_tpm, null);
  const rotated = await admin('apps/' + app2.json.id + '/rotate', 'POST');
  assert.equal(rotated.status, 200);
  assert.equal((await send(app2)).status, 401);
  assert.equal((await admin('apps/' + app2.json.id, 'PATCH', {
    cache_seconds: 0, log_bodies: false
  })).status, 204);
  upstreamStatus = 200;
  const afterRotation = await send(rotated);
  assert.equal(afterRotation.status, 200);
  assert.equal(afterRotation.headers.get('X-Router-Cache'), 'BYPASS');
  assert.equal((await admin('overview')).json.apps[1].requests, 2);
  assert.equal((await admin('apps/' + app1.json.id, 'DELETE')).status, 204);
  assert.equal((await send(app1)).status, 401);
});

test('retention removes expired cache and payloads and deletes old request metadata', async t => {
  const { env, ctx, pending, admin } = fixture();
  t.after(() => env.DB.database.close());
  await admin('projects', 'POST', { project_id, name: 'Gemini' });
  const app = await admin('apps', 'POST', { project_id, name: 'A' });
  const insert = env.DB.database.prepare(`
    INSERT INTO requests (id, app_id, project_id, model, action, started_at, source, request_body, response_body)
    VALUES (?, ?, ?, ?, 'generateContent', ?, 'google', 'secret prompt', 'secret output')
  `);
  insert.run('old-body', app.json.id, project_id, model, Date.now() - 2 * 86_400_000);
  insert.run('old-row', app.json.id, project_id, model, Date.now() - 15 * 86_400_000);
  env.DB.database.prepare("INSERT INTO response_cache VALUES ('old-cache', '{}', 0)").run();
  worker.scheduled({}, env, ctx);
  await Promise.all(pending);
  const rows = env.DB.database.prepare('SELECT id, request_body, response_body, body_state FROM requests').all();
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0] }, { id: 'old-body', request_body: null, response_body: null, body_state: 'expired' });
  assert.equal(env.DB.database.prepare('SELECT count(*) AS total FROM response_cache').get().total, 0);
});

test('Pacific day boundary follows daylight saving time', () => {
  assert.equal(pacificDayStart(Date.parse('2026-03-08T16:00:00Z')), Date.parse('2026-03-08T08:00:00Z'));
  assert.equal(pacificDayStart(Date.parse('2026-11-01T16:00:00Z')), Date.parse('2026-11-01T07:00:00Z'));
  assert.equal(pacificDayStart(Date.parse('2026-11-02T08:00:00Z')), Date.parse('2026-11-02T08:00:00Z'));
});


test('passkey enrollment, signed login, replay protection, expiry and logout', async t => {
  const { env, request } = fixture({ signedIn: false });
  t.after(() => env.DB.database.close());
  const origin = env.PANEL_ORIGIN;
  const rpIdHash = hash(new URL(origin).hostname);
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = isoCBOR.encode(new Map([
    [1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]
  ]));
  const credentialId = randomBytes(32);
  const id = credentialId.toString('base64url');
  const envelope = { id, rawId: id, type: 'public-key', clientExtensionResults: {} };
  const counter = number => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(number);
    return bytes;
  };
  const client = (type, challenge, assertedOrigin = origin) =>
    Buffer.from(JSON.stringify({ type, challenge, origin: assertedOrigin, crossOrigin: false }));
  const post = (path, body, token) => request('/auth/' + path, { method: 'POST', origin, body, token });
  const overview = token => request('/admin/overview', { origin, token });

  assert.equal((await overview()).status, 401);
  assert.equal((await request('/auth/status', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('register/options')).status, 403);
  assert.equal((await post('register/options', undefined, 'd'.repeat(64))).status, 403);
  assert.equal((await post('login/options')).status, 409);
  const start = await post('register/options', undefined, enrollment);
  assert.equal(start.status, 200);
  assert.equal(start.json.options.authenticatorSelection.userVerification, 'required');
  const registerData = client('webauthn.create', start.json.options.challenge);
  const authData = Buffer.concat([
    rpIdHash, Buffer.from([0x45]), counter(0), Buffer.alloc(16),
    Buffer.from([0, credentialId.length]), credentialId, cose
  ]);
  const attestationObject = Buffer.from(isoCBOR.encode(new Map([
    ['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]
  ]))).toString('base64url');
  const registered = await post('register/verify', { id: start.json.id, credential: {
    ...envelope, response: { clientDataJSON: registerData.toString('base64url'), attestationObject }
  } }, enrollment);
  assert.equal(registered.status, 200, registered.text);
  assert.equal((await overview(registered.json.token)).status, 200);
  assert.equal((await post('register/options', undefined, enrollment)).status, 409);
  assert.equal((await post('logout', undefined, registered.json.token)).status, 204);
  assert.equal((await overview(registered.json.token)).status, 401);

  function assertion(challenge, assertedOrigin) {
    const data = client('webauthn.get', challenge, assertedOrigin);
    const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([0x05]), counter(1)]);
    const signature = sign('sha256', Buffer.concat([authenticatorData, hash(data)]), privateKey);
    return { ...envelope, response: {
      clientDataJSON: data.toString('base64url'),
      authenticatorData: authenticatorData.toString('base64url'),
      signature: signature.toString('base64url')
    } };
  }

  const rejected = (await post('login/options')).json;
  assert.equal((await post('login/verify', {
    id: rejected.id, credential: assertion(rejected.options.challenge, 'https://evil.example')
  })).status, 401);
  assert.equal((await post('login/verify', {
    id: rejected.id, credential: assertion(rejected.options.challenge)
  })).status, 401);

  const login = (await post('login/options')).json;
  const proof = { id: login.id, credential: assertion(login.options.challenge) };
  const session = await post('login/verify', proof);
  assert.equal(session.status, 200, session.text);
  assert.equal((await post('login/verify', proof)).status, 401);
  assert.equal((await overview(session.json.token)).status, 200);
  env.DB.database.prepare('UPDATE admin_sessions SET expires_at = 0').run();
  assert.equal((await overview(session.json.token)).status, 401);
});

test('password login is opt-in, rate-limited and revoked when the passkey owner changes it', async t => {
  const { env, request, admin } = fixture();
  t.after(() => env.DB.database.close());
  const origin = env.PANEL_ORIGIN;
  const auth = (path, body) => request('/auth/password/' + path, { method: 'POST', origin, body });
  const status = () => request('/auth/status', { origin });
  const salt = randomBytes(16).toString('hex');
  const proof = pbkdf2Sync('a long, distinct password', Buffer.from(salt, 'hex'), 600_000, 32, 'sha256').toString('hex');
  assert.equal((await status()).json.passwordEnabled, false);
  assert.equal((await auth('options')).status, 401);
  assert.equal((await admin('password', 'PUT', { salt, proof })).status, 204);
  assert.equal((await status()).json.passwordEnabled, true);
  assert.deepEqual((await auth('options')).json, { salt });
  assert.notEqual(env.DB.database.prepare('SELECT verifier FROM admin_password').get().verifier, proof);
  assert.equal((await auth('verify', { salt, proof: '0'.repeat(64) })).status, 401);
  env.PASSWORD_LIMITER.limit = async () => ({ success: false });
  assert.equal((await auth('verify', { salt, proof })).status, 429);
  env.PASSWORD_LIMITER.limit = async () => ({ success: true });
  const login = await auth('verify', { salt, proof });
  assert.equal(login.status, 200);
  assert.equal(login.json.authMethod, 'password');
  const token = login.json.token;
  assert.equal((await request('/admin/overview', { origin, token })).status, 200);
  assert.equal((await request('/admin/password', { method: 'DELETE', origin, token })).status, 403);
  const nextSalt = randomBytes(16).toString('hex');
  assert.equal((await admin('password', 'PUT', { salt: nextSalt, proof: '1'.repeat(64) })).status, 204);
  assert.equal((await request('/admin/overview', { origin, token })).status, 401);
  assert.equal((await auth('verify', { salt, proof })).status, 401);
  assert.equal((await admin('password', 'DELETE')).status, 204);
  assert.equal((await status()).json.passwordEnabled, false);
});

test('a key can create its project in one call without changing existing project settings', async t => {
  const { env, admin } = fixture();
  t.after(() => env.DB.database.close());
  const project_id = 'create-from-key';
  const body = { project_id, create_project: true, api_key: 'test_google_key_not_a_real_secret' };
  assert.equal((await admin('keys', 'POST', { ...body, api_key: 'bad' })).status, 400);
  assert.equal((await admin('overview')).json.projects.length, 0);
  const created = await admin('keys', 'POST', body);
  assert.equal(created.status, 201);
  assert.equal(created.json.project_id, project_id);
  const first = (await admin('overview')).json;
  assert.deepEqual(first.projects, [{ id: project_id, name: project_id }]);
  assert.equal(first.keys[0].label, 'Klucz Google');

  env.DB.database.prepare('UPDATE projects SET name = ? WHERE id = ?').run('Moja nazwa', project_id);
  assert.equal((await admin('keys', 'POST', { ...body, label: 'Kolejny klucz' })).status, 201);
  assert.equal((await admin('overview')).json.projects[0].name, 'Moja nazwa');
});
