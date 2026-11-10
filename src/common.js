export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const encoder = new TextEncoder();
export const BODY_STORAGE_LIMIT = 256 * 1024;

export function statement(db, sql, ...params) {
  return db.prepare(sql).bind(...params);
}

export async function readLimited(body, limit) {
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > limit) throw new HttpError(413, 'Body is too large');
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function objectJson(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Expected a JSON object');
  }
  return value;
}

export async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function randomToken() {
  return 'gr_' + [...crypto.getRandomValues(new Uint8Array(32))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function adminAuthorized(secret, supplied) {
  if (!secret || secret.length < 32 || !supplied) return false;
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
  const proof = await crypto.subtle.sign('HMAC', key, encoder.encode(secret));
  return crypto.subtle.verify('HMAC', key, proof, encoder.encode(supplied));
}

function base64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function decode64(text) {
  return Uint8Array.from(atob(text), char => char.charCodeAt(0));
}

async function encryptionKey(secret) {
  const bytes = decode64(secret);
  if (bytes.length !== 32) throw new Error('Invalid encryption key length');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encrypt(secret, id, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(secret);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(id) }, key, encoder.encode(text)
  );
  return base64(iv) + '.' + base64(ciphertext);
}

export async function decrypt(secret, id, encrypted) {
  const [iv, ciphertext] = encrypted.split('.');
  const key = await encryptionKey(secret);
  const cleartext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decode64(iv), additionalData: encoder.encode(id) }, key, decode64(ciphertext)
  );
  return new TextDecoder().decode(cleartext);
}

const pacific = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', dateStyle: 'short' });

export function pacificDayStart(now) {
  const day = pacific.format(now);
  let lower = now - 25 * 60 * 60 * 1000;
  let upper = now;
  while (upper - lower > 1) {
    const middle = Math.floor((lower + upper) / 2);
    if (pacific.format(middle) === day) upper = middle;
    else lower = middle;
  }
  return upper;
}
