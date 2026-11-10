import { workerOrigin } from './config.js';
import { workspace } from './workspace.js';

const get = id => document.getElementById(id);
if (window.top !== window.self) {
  get('status').textContent = 'Otwórz panel w osobnej karcie.';
  throw new Error('Embedded panel is disabled');
}
const date = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'short', timeStyle: 'medium' });
let session = null;
let pending = false;
let editedApp = null;
let expiryTimer;
let passwordEnabled = false;
const panel = workspace({
  openRequest: id => void perform(() => showDetail(id)),
  editApp,
  disableKey: key => void perform(() => disableKey(key))
});

function status(message, error = false) {
  get('status').textContent = message;
  get('status').classList.toggle('error', error);
  get('notice').textContent = message;
  get('notice').hidden = !message;
  get('notice').classList.toggle('error', error);
  if (get('app-settings').open && error) get('settings-status').textContent = message;
}

async function api(path, options = {}) {
  if (!workerOrigin) throw new Error('Adres API Workera nie został jeszcze ustawiony.');
  const admin = !path.startsWith('auth/');
  const currentSession = session;
  const token = options.token ?? (admin ? currentSession?.token : null);
  const response = await fetch(workerOrigin + '/' + (admin ? 'admin/' : '') + path, {
    method: options.method || 'GET',
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000)
  });
  if (admin && currentSession !== session) throw new Error('Sesja wygasła. Zaloguj się ponownie.');
  if (response.status === 204) return null;
  const data = await response.json();
  if (admin && currentSession !== session) throw new Error('Sesja wygasła. Zaloguj się ponownie.');
  if (admin && response.status === 401) clearSession();
  if (!response.ok) throw new Error(data.error?.message || 'HTTP ' + response.status);
  return data;
}

function clearIssuedToken() {
  get('issued-token').value = '';
  get('new-token').hidden = true;
}

function showIssuedToken(token) {
  get('issued-token').value = token;
  get('new-token').hidden = false;
  get('issued-token').focus();
  get('issued-token').select();
}

function clearDetail() {
  if (get('detail').open) get('detail').close();
  for (const id of ['detail-meta', 'detail-request', 'detail-response']) get(id).textContent = '';
}

function clearSession() {
  clearTimeout(expiryTimer);
  session = null;
  clearIssuedToken();
  clearDetail();
  if (get('app-settings').open) get('app-settings').close();
  get('dashboard').hidden = true;
  get('auth-panel').hidden = false;
  panel.clear();
  get('connect').hidden = false;
  get('password-login').hidden = !passwordEnabled;
  get('password-settings').hidden = true;
  get('set-password').reset();
}

async function perform(task) {
  if (pending) return;
  pending = true;
  const buttons = [...document.querySelectorAll('button')].filter(button => !button.disabled);
  buttons.forEach(button => { button.disabled = true; });
  try {
    await task();
  } catch (error) {
    status(error.message, true);
  } finally {
    pending = false;
    buttons.forEach(button => { button.disabled = false; });
  }
}

async function startPasskey(purpose, enrollment) {
  const browser = globalThis.SimpleWebAuthnBrowser;
  if (!browser?.browserSupportsWebAuthn()) {
    throw new Error('Ta przeglądarka nie obsługuje kluczy dostępu.');
  }
  const { id, options } = await api('auth/' + purpose + '/options', { method: 'POST', token: enrollment });
  const usePasskey = purpose === 'register' ? browser.startRegistration : browser.startAuthentication;
  const credential = await usePasskey({ optionsJSON: options });
  await completeLogin(await api('auth/' + purpose + '/verify', {
    method: 'POST', token: enrollment, body: { id, credential }
  }));
}

async function completeLogin(result) {
  session = result;
  get('register').hidden = true;
  get('connect').hidden = true;
  get('password-login').hidden = true;
  get('password-settings').hidden = session.authMethod !== 'passkey';
  get('session-method').textContent = session.authMethod === 'passkey'
    ? 'Zalogowano kluczem dostępu.' : 'Zalogowano hasłem. Ustawienia hasła są dostępne po zalogowaniu kluczem dostępu.';
  get('session-expiry').textContent = 'Sesja wygaśnie: ' + date.format(session.expiresAt);
  expiryTimer = setTimeout(() => {
    clearSession();
    status('Sesja wygasła. Zaloguj się ponownie.');
  }, Math.max(0, session.expiresAt - Date.now()));
  try {
    await refresh();
    get('auth-panel').hidden = true;
    get('dashboard').hidden = false;
    status('');
  } catch (error) {
    clearSession();
    throw error;
  }
}

function hex(bytes) {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function passwordProof(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const saltBytes = Uint8Array.from(salt.match(/../g), pair => Number.parseInt(pair, 16));
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2', hash: 'SHA-256', iterations: 600_000, salt: saltBytes
  }, key, 256);
  return hex(new Uint8Array(bits));
}

function renderPasswordState() {
  get('password-state').textContent = passwordEnabled ? 'Logowanie hasłem jest włączone.' : 'Logowanie hasłem jest wyłączone.';
  get('disable-password').hidden = !passwordEnabled;
}

get('password-login').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const password = form.elements.password.value;
  form.reset();
  void perform(async () => {
    const { salt } = await api('auth/password/options', { method: 'POST' });
    const proof = await passwordProof(password, salt);
    await completeLogin(await api('auth/password/verify', { method: 'POST', body: { salt, proof } }));
  });
});

get('set-password').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const { password, confirmation } = form.elements;
  if (password.value !== confirmation.value) {
    status('Wpisane hasła różnią się.', true);
    return;
  }
  const value = password.value;
  form.reset();
  void perform(async () => {
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    const proof = await passwordProof(value, salt);
    await api('password', { method: 'PUT', body: { salt, proof } });
    passwordEnabled = true;
    renderPasswordState();
    status('Hasło zostało zapisane.');
  });
});

get('disable-password').addEventListener('click', () => void perform(async () => {
  if (!window.confirm('Wyłączyć logowanie hasłem? Aktywne sesje zalogowane hasłem zostaną zakończone.')) return;
  await api('password', { method: 'DELETE' });
  passwordEnabled = false;
  renderPasswordState();
  status('Logowanie hasłem zostało wyłączone.');
}));

get('connect').addEventListener('submit', event => {
  event.preventDefault();
  void perform(() => startPasskey('login'));
});

get('register').addEventListener('submit', event => {
  event.preventDefault();
  const field = event.currentTarget.elements.enrollment;
  const enrollment = field.value.trim();
  field.value = '';
  void perform(() => startPasskey('register', enrollment));
});

get('refresh').addEventListener('click', () => void perform(async () => {
  await refresh();
  status('Dane zostały odświeżone.');
}));
get('disconnect').addEventListener('click', () => void perform(async () => {
  const token = session?.token;
  clearSession();
  await api('auth/logout', { method: 'POST', token });
  status('Wylogowano.');
}));
get('hide-token').addEventListener('click', clearIssuedToken);
get('copy-token').addEventListener('click', () => void perform(async () => {
  await navigator.clipboard.writeText(get('issued-token').value);
  status('Token został skopiowany.');
}));
get('close-detail').addEventListener('click', clearDetail);
get('detail').addEventListener('close', clearDetail);
get('close-settings').addEventListener('click', () => get('app-settings').close());

async function refresh(project) {
  panel.load(await api('overview'), project);
}

async function disableKey(key) {
  if (!window.confirm('Wyłączyć klucz „' + key.label + '”?')) return;
  await api('keys/' + key.id, { method: 'DELETE' });
  await refresh();
  status('Klucz został wyłączony.');
}

for (const form of document.querySelectorAll('form[data-resource]')) {
  form.addEventListener('submit', event => {
    event.preventDefault();
    void perform(async () => {
      const resource = form.dataset.resource;
      const data = Object.fromEntries(new FormData(form));
      for (const name of ['rpm', 'tpm', 'rpd', 'cache_seconds']) {
        if (name in data) data[name] = data[name] === '' ? null : Number(data[name]);
      }
      if (resource === 'apps') data.log_bodies = form.elements.log_bodies.checked;
      if (resource === 'keys') {
        data.create_project = true;
        data.label = data.label.trim();
        form.elements.api_key.value = '';
      }
      const result = await api(resource, { method: 'POST', body: data });
      form.reset();
      if (result.token) showIssuedToken(result.token);
      await refresh(resource === 'keys' ? result.project_id : resource === 'quotas' ? data.project_id : undefined);
      const messages = {
        keys: 'Klucz dodany. Od teraz router używa go w tym projekcie.',
        projects: 'Projekt został dodany.',
        apps: 'Aplikacja została utworzona. Skopiuj jej token.',
        quotas: 'Limity projektu zostały zapisane.'
      };
      status(messages[resource]);
    });
  });
}

function editApp(app) {
  editedApp = app;
  const form = get('edit-app');
  form.elements.cache_seconds.value = app.cache_seconds;
  form.elements.log_bodies.checked = Boolean(app.log_bodies);
  get('app-settings-title').textContent = 'Ustawienia aplikacji · ' + app.name;
  get('settings-status').textContent = '';
  get('app-settings').showModal();
}

get('edit-app').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  void perform(async () => {
    await api('apps/' + editedApp.id, { method: 'PATCH', body: {
      cache_seconds: Number(form.elements.cache_seconds.value),
      log_bodies: form.elements.log_bodies.checked
    } });
    get('app-settings').close();
    await refresh();
    status('Ustawienia aplikacji zostały zapisane.');
  });
});

get('rotate-app').addEventListener('click', () => void perform(async () => {
  if (!window.confirm('Wygenerować nowy token? Obecny token aplikacji przestanie działać.')) return;
  const result = await api('apps/' + editedApp.id + '/rotate', { method: 'POST' });
  get('app-settings').close();
  showIssuedToken(result.token);
  await refresh();
  status('Nowy token jest gotowy do skopiowania.');
}));

get('revoke-app').addEventListener('click', () => void perform(async () => {
  if (!window.confirm('Unieważnić token aplikacji „' + editedApp.name + '”?')) return;
  await api('apps/' + editedApp.id, { method: 'DELETE' });
  get('app-settings').close();
  clearIssuedToken();
  await refresh();
  status('Token aplikacji został unieważniony.');
}));

function formatBody(raw) {
  if (raw === null) return 'Brak zapisanej treści.';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

async function showDetail(id) {
  const { request_body, response_body, ...meta } = await api('requests/' + id);
  get('detail-meta').textContent = JSON.stringify(meta, null, 2);
  get('detail-request').textContent = formatBody(request_body);
  get('detail-response').textContent = formatBody(response_body);
  get('detail').showModal();
}

void perform(async () => {
  const { enrolled, passwordEnabled: enabled } = await api('auth/status');
  passwordEnabled = enabled;
  renderPasswordState();
  get('connect').hidden = !enrolled;
  get('password-login').hidden = !passwordEnabled;
  get('register').hidden = enrolled;
  status(enrolled ? 'Zaloguj się swoim kluczem dostępu.' : 'Zarejestruj pierwszy klucz administratora.');
});
