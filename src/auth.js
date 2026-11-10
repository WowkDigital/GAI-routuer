import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { HttpError, adminAuthorized, objectJson, readLimited, sha256, statement } from './common.js';
import { loadPassword, routePassword } from './password.js';

const SESSION_MS = 30 * 60_000;
const CHALLENGE_MS = 5 * 60_000;
const SESSION_PATTERN = /^gs_[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-f0-9]{64}$/;

function nonce() {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function bearer(request) {
  return request.headers.get('Authorization')?.match(/^Bearer (\S+)$/i)?.[1];
}

async function sessionHash(request) {
  const token = bearer(request);
  if (!token || !SESSION_PATTERN.test(token)) throw new HttpError(401, 'Sesja wygasła. Zaloguj się ponownie.');
  return sha256(token);
}

export async function requireSession(request, db) {
  const hash = await sessionHash(request);
  const session = await statement(db, 'SELECT auth_method FROM admin_sessions WHERE token_hash = ? AND expires_at > ?',
    hash, Date.now()).first();
  if (!session) {
    throw new HttpError(401, 'Sesja wygasła. Zaloguj się ponownie.');
  }
  return session;
}

async function createSession(db, authMethod = 'passkey', passwordVerifier = null) {
  const token = 'gs_' + nonce();
  const expiresAt = Date.now() + SESSION_MS;
  const result = await statement(db, `
    INSERT INTO admin_sessions (token_hash, expires_at, auth_method)
    SELECT ?, ?, ? WHERE ? IS NULL OR EXISTS (SELECT 1 FROM admin_password WHERE verifier = ?)
  `, await sha256(token), expiresAt, authMethod, passwordVerifier, passwordVerifier).run();
  if (!result.meta.changes) throw new HttpError(401, 'Hasło zmieniło się. Zaloguj się ponownie.');
  return Response.json({ token, expiresAt, authMethod });
}

async function enrollmentAuthorized(request, env) {
  const token = bearer(request);
  const [hash, expiresAt] = (env.ADMIN_ENROLLMENT || '').split('.');
  if (!token || !ID_PATTERN.test(token) || !ID_PATTERN.test(hash) ||
    !Number.isSafeInteger(Number(expiresAt)) || Number(expiresAt) <= Date.now() ||
    !await adminAuthorized(hash, await sha256(token))) {
    throw new HttpError(403, 'Kod rejestracji jest nieprawidłowy lub wygasł.');
  }
}

function configuredOrigin(env) {
  let url;
  try {
    url = new URL(env.PANEL_ORIGIN);
  } catch {
    throw new HttpError(503, 'Ustaw adres panelu na Workerze.');
  }
  if (url.origin !== env.PANEL_ORIGIN ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost'))) {
    throw new HttpError(503, 'Nieprawidłowy origin panelu.');
  }
  return url;
}

async function loadPasskey(db) {
  return statement(db, 'SELECT credential_id, public_key, counter FROM admin_passkey WHERE singleton = 1').first();
}

async function storeChallenge(db, purpose, options) {
  const id = nonce();
  await statement(db, 'INSERT INTO admin_challenges VALUES (?, ?, ?, ?)',
    id, purpose, options.challenge, Date.now() + CHALLENGE_MS).run();
  return Response.json({ id, options });
}

async function verificationInput(request, db, purpose) {
  const { id, credential } = objectJson(await readLimited(request.body, 64 * 1024));
  if (typeof id !== 'string' || !ID_PATTERN.test(id) || !credential || typeof credential !== 'object') {
    throw new HttpError(400, 'Nieprawidłowa odpowiedź klucza dostępu.');
  }
  const row = await statement(db, `
    DELETE FROM admin_challenges WHERE id = ? AND purpose = ? AND expires_at > ? RETURNING challenge
  `, id, purpose, Date.now()).first();
  if (!row) throw new HttpError(401, 'Wyzwanie wygasło. Spróbuj ponownie.');
  return { credential, challenge: row.challenge };
}

export async function routeAuth(request, env, path) {
  const url = configuredOrigin(env);
  const db = env.DB;
  if (request.method === 'GET' && path === '/auth/status') {
    const [passkey, password] = await Promise.all([loadPasskey(db), loadPassword(db)]);
    return Response.json({ enrolled: Boolean(passkey), passwordEnabled: Boolean(password) });
  }
  if (request.method !== 'POST') throw new HttpError(405, 'Use POST');
  if (path === '/auth/logout') {
    await statement(db, 'DELETE FROM admin_sessions WHERE token_hash = ?', await sessionHash(request)).run();
    return new Response(null, { status: 204 });
  }
  const passwordStep = path.match(/^\/auth\/password\/(options|verify)$/);
  if (passwordStep) return routePassword(request, env, passwordStep[1], createSession);
  const endpoint = path.match(/^\/auth\/(register|login)\/(options|verify)$/);
  if (!endpoint) throw new HttpError(404, 'Unknown authentication endpoint');
  const rate = await env.AUTH_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'local' });
  if (!rate.success) throw new HttpError(429, 'Za dużo prób. Odczekaj minutę.');
  const [, purpose, step] = endpoint;
  const rpID = url.hostname;
  if (purpose === 'register') {
    await enrollmentAuthorized(request, env);
    if (await loadPasskey(db)) throw new HttpError(409, 'Klucz administratora jest już zarejestrowany.');
    if (step === 'options') {
      const options = await generateRegistrationOptions({
        rpName: 'Gemini Router',
        rpID,
        userID: crypto.getRandomValues(new Uint8Array(32)),
        userName: 'administrator',
        userDisplayName: 'Administrator Gemini Router',
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
      });
      return storeChallenge(db, purpose, options);
    }
    const { credential, challenge } = await verificationInput(request, db, purpose);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: credential, expectedChallenge: challenge, expectedOrigin: url.origin,
        expectedRPID: rpID, requireUserVerification: true
      });
    } catch {
      throw new HttpError(401, 'Weryfikacja klucza dostępu nie powiodła się.');
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new HttpError(401, 'Weryfikacja klucza dostępu nie powiodła się.');
    }
    const passkey = verification.registrationInfo.credential;
    const result = await statement(db, `
      INSERT INTO admin_passkey VALUES (1, ?, ?, ?, ?) ON CONFLICT (singleton) DO NOTHING
    `, passkey.id, isoBase64URL.fromBuffer(passkey.publicKey), passkey.counter, Date.now()).run();
    if (!result.meta.changes) throw new HttpError(409, 'Klucz administratora jest już zarejestrowany.');
    return createSession(db);
  }

  const passkey = await loadPasskey(db);
  if (!passkey) throw new HttpError(409, 'Najpierw zarejestruj klucz administratora.');
  if (step === 'options') {
    return storeChallenge(db, purpose, await generateAuthenticationOptions({
      rpID, allowCredentials: [{ id: passkey.credential_id }], userVerification: 'required'
    }));
  }
  const { credential, challenge } = await verificationInput(request, db, purpose);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: credential, expectedChallenge: challenge, expectedOrigin: url.origin,
      expectedRPID: rpID, requireUserVerification: true,
      credential: {
        id: passkey.credential_id, publicKey: isoBase64URL.toBuffer(passkey.public_key), counter: passkey.counter
      }
    });
  } catch {
    throw new HttpError(401, 'Weryfikacja klucza dostępu nie powiodła się.');
  }
  if (!verification.verified) throw new HttpError(401, 'Weryfikacja klucza dostępu nie powiodła się.');
  const result = await statement(db, `
    UPDATE admin_passkey SET counter = ? WHERE singleton = 1 AND credential_id = ? AND counter = ?
  `, verification.authenticationInfo.newCounter, passkey.credential_id, passkey.counter).run();
  if (!result.meta.changes) throw new HttpError(401, 'Klucz zmienił się. Spróbuj ponownie.');
  return createSession(db);
}
