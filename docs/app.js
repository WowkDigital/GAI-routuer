import { workerOrigin } from './config.js';

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

function status(message, error = false) {
  get('status').textContent = message;
  get('status').classList.toggle('error', error);
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
  for (const id of ['quotas', 'apps', 'keys', 'recent']) get(id).replaceChildren();
  get('connect').hidden = false;
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
  session = await api('auth/' + purpose + '/verify', {
    method: 'POST', token: enrollment, body: { id, credential }
  });
  get('register').hidden = true;
  get('connect').hidden = true;
  expiryTimer = setTimeout(() => {
    clearSession();
    status('Sesja wygasła. Zaloguj się ponownie.');
  }, Math.max(0, session.expiresAt - Date.now()));
  try {
    await refresh();
    get('dashboard').hidden = false;
  } catch (error) {
    clearSession();
    throw error;
  }
}

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

get('refresh').addEventListener('click', () => void perform(refresh));
get('disconnect').addEventListener('click', () => void perform(async () => {
  const token = session?.token;
  clearSession();
  await api('auth/logout', { method: 'POST', token });
  status('Wylogowano.');
}));
get('hide-token').addEventListener('click', clearIssuedToken);
get('close-detail').addEventListener('click', clearDetail);
get('detail').addEventListener('close', clearDetail);
get('close-settings').addEventListener('click', () => get('app-settings').close());

function action(text, handle) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary';
  button.textContent = text;
  button.addEventListener('click', () => void perform(handle));
  return button;
}

function table(id, columns, rows) {
  const container = get(id);
  if (rows.length === 0) {
    container.textContent = 'Brak danych.';
    return;
  }
  const grid = document.createElement('table');
  const header = grid.createTHead().insertRow();
  for (const column of columns) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = column;
    header.append(cell);
  }
  const body = grid.createTBody();
  for (const values of rows) {
    const row = body.insertRow();
    for (const value of values) {
      const cell = row.insertCell();
      if (value instanceof Node) cell.append(value);
      else cell.textContent = value ?? '—';
    }
  }
  container.replaceChildren(grid);
}

function quota(limit, remaining, known, missing) {
  if (limit === null) return '—';
  if (remaining === null) return 'brak estymacji (' + known + ' zliczonych, ' + missing + ' bez danych)';
  return remaining + ' / ' + limit;
}

async function refresh() {
  const data = await api('overview');
  const projects = new Map(data.projects.map(project => [project.id, project.name]));
  for (const select of document.querySelectorAll('select[name="project_id"]')) {
    const previous = select.value;
    select.replaceChildren(new Option('Wybierz projekt', ''));
    for (const project of data.projects) select.add(new Option(project.name + ' · ' + project.id, project.id));
    select.value = projects.has(previous) ? previous : '';
  }
  table('quotas', ['Projekt', 'Model', 'RPM pozostało', 'TPM pozostało', 'RPD pozostało'], data.quotas.map(q => [
    projects.get(q.project_id), q.model, quota(q.rpm, q.remaining_rpm),
    quota(q.tpm, q.remaining_tpm, q.known_tpm, q.missing_tpm), quota(q.rpd, q.remaining_rpd)
  ]));
  table('apps', ['Aplikacja', 'Projekt', 'Żądania', 'Do Google', 'Cache', 'Błędy', 'Tokeny¹', 'Zapis treści', 'Dostęp'], data.apps.map(a => [
    a.name, projects.get(a.project_id), a.requests, a.google_calls, a.hits, a.errors, a.tokens,
    a.log_bodies ? 'włączony' : 'wyłączony',
    a.revoked_at ? 'unieważniony' : action('Ustawienia', () => editApp(a))
  ]));
  table('keys', ['Etykieta', 'Projekt', 'Dodano', 'Stan'], data.keys.map(k => [
    k.label, projects.get(k.project_id), date.format(k.created_at),
    k.active ? action('Wyłącz', () => revoke('keys', k.id, k.label)) : 'wyłączony'
  ]));
  table('recent', ['Czas', 'Aplikacja', 'Model', 'Źródło', 'Status', 'Czas (ms)', 'Tokeny¹', 'Szczegóły'], data.recent.map(r => [
    date.format(r.started_at), r.app_name, r.model, r.source, r.status, r.latency_ms, r.total_tokens,
    action('Otwórz', () => showDetail(r.id))
  ]));
  status('Zalogowano. Dane odświeżone o ' + date.format(Date.now()) + '.');
}

async function revoke(resource, id, label) {
  if (!window.confirm('Wyłączyć dostęp dla „' + label + '”?')) return;
  await api(resource + '/' + id, { method: 'DELETE' });
  clearIssuedToken();
  await refresh();
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
      const result = await api(resource, { method: 'POST', body: data });
      form.reset();
      if (result.token) showIssuedToken(result.token);
      await refresh();
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
  });
});

get('rotate-app').addEventListener('click', () => void perform(async () => {
  if (!window.confirm('Wygenerować nowy token? Obecny token aplikacji przestanie działać.')) return;
  const result = await api('apps/' + editedApp.id + '/rotate', { method: 'POST' });
  get('app-settings').close();
  showIssuedToken(result.token);
  await refresh();
}));

get('revoke-app').addEventListener('click', () => void perform(async () => {
  if (!window.confirm('Unieważnić token aplikacji „' + editedApp.name + '”?')) return;
  await api('apps/' + editedApp.id, { method: 'DELETE' });
  get('app-settings').close();
  clearIssuedToken();
  await refresh();
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
  const { enrolled } = await api('auth/status');
  get('connect').hidden = !enrolled;
  get('register').hidden = enrolled;
  status(enrolled ? 'Zaloguj się swoim kluczem dostępu.' : 'Zarejestruj pierwszy klucz administratora.');
});
