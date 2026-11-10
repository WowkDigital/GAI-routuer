import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError, objectJson, readLimited, statement } from './common.js';

const SALT_PATTERN = /^[a-f0-9]{32}$/;
const PROOF_PATTERN = /^[a-f0-9]{64}$/;

function passwordVerifier(env, salt, proof) {
  const pepper = Buffer.from(env.PASSWORD_PEPPER || '', 'base64');
  if (pepper.length !== 32) throw new HttpError(503, 'Logowanie hasłem nie zostało skonfigurowane.');
  return createHmac('sha256', pepper)
    .update('gai-routuer/password/v1:' + salt + ':' + proof)
    .digest();
}

export function loadPassword(db) {
  return statement(db, 'SELECT salt, verifier FROM admin_password WHERE singleton = 1').first();
}

export async function routePassword(request, env, step, createSession) {
  const db = env.DB;
  const current = await loadPassword(db);
  if (!current) throw new HttpError(401, 'Logowanie hasłem jest wyłączone.');
  if (step === 'options') return Response.json({ salt: current.salt });

  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const limit = await env.PASSWORD_LIMITER.limit({ key: ip });
  if (!limit.success) throw new HttpError(429, 'Za dużo prób logowania hasłem. Odczekaj minutę.');
  const { salt, proof } = objectJson(await readLimited(request.body, 1024));
  if (typeof proof !== 'string' || !PROOF_PATTERN.test(proof) || salt !== current.salt ||
    !timingSafeEqual(passwordVerifier(env, current.salt, proof), Buffer.from(current.verifier, 'hex'))) {
    throw new HttpError(401, 'Nieprawidłowe hasło.');
  }
  return createSession(db, 'password', current.verifier);
}

export async function updatePassword(request, env, session) {
  if (session.auth_method !== 'passkey') throw new HttpError(403, 'Zaloguj się kluczem dostępu, aby zmienić hasło.');
  const db = env.DB;
  let change;
  if (request.method === 'PUT') {
    const { salt, proof } = objectJson(await readLimited(request.body, 1024));
    if (typeof salt !== 'string' || !SALT_PATTERN.test(salt) ||
        typeof proof !== 'string' || !PROOF_PATTERN.test(proof)) {
      throw new HttpError(400, 'Nieprawidłowy zapis hasła.');
    }
    change = statement(db, `
      INSERT INTO admin_password VALUES (1, ?, ?) ON CONFLICT (singleton) DO UPDATE SET
      salt = excluded.salt, verifier = excluded.verifier
    `, salt, passwordVerifier(env, salt, proof).toString('hex'));
  } else if (request.method === 'DELETE') {
    change = statement(db, 'DELETE FROM admin_password WHERE singleton = 1');
  } else {
    throw new HttpError(405, 'Use PUT or DELETE');
  }
  await db.batch([change, statement(db, "DELETE FROM admin_sessions WHERE auth_method = 'password'")]);
  return new Response(null, { status: 204 });
}
