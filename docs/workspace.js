import { categories } from './catalog.js';
import { limitModels, number, renderLimitCards } from './limits.js';

const get = id => document.getElementById(id);
const date = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'short', timeStyle: 'short' });
const time = new Intl.DateTimeFormat('pl-PL', { timeStyle: 'medium' });
const views = {
  przeglad: ['Przegląd', 'Najważniejsze liczby i szybki dostęp do modułów.'],
  limity: ['Limity modeli', 'Wybierz projekt i sprawdź szacowany zapas dla każdego modelu.'],
  klucze: ['Klucze API', 'Dodawaj klucze Google i zarządzaj projektami w jednym miejscu.'],
  aplikacje: ['Aplikacje', 'Zarządzaj tokenami, cache i zapisywaniem treści do debugowania.'],
  historia: ['Historia zapytań', 'Ostatnie 100 żądań, z filtrowaniem po modelu, aplikacji i źródle.'],
  bezpieczenstwo: ['Bezpieczeństwo', 'Zarządzaj dostępem do panelu administratora.']
};

function node(tag, className = '', text) {
  const result = document.createElement(tag);
  result.className = className;
  if (text != null) result.textContent = text;
  return result;
}

function button(text, action, className = 'secondary') {
  const element = node('button', className, text);
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
}

function table(container, columns, rows) {
  if (!rows.length) {
    container.replaceChildren(node('p', 'muted', 'Brak zapytań pasujących do filtrów.'));
    return;
  }
  const grid = node('table');
  const header = grid.createTHead().insertRow();
  for (const column of columns) {
    const cell = node('th', '', column);
    cell.scope = 'col';
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

export function workspace({ openRequest, editApp, disableKey }) {
  let data;
  let category = '';
  const navigation = [...document.querySelectorAll('[data-nav]')];
  const sections = [...document.querySelectorAll('[data-view]')];

  function renderNavigation(focus = false) {
    const requested = window.location.hash.slice(1);
    const active = Object.hasOwn(views, requested) ? requested : 'przeglad';
    for (const section of sections) section.hidden = section.dataset.view !== active;
    for (const link of navigation) {
      if (link.dataset.nav === active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    const [title, description] = views[active];
    get('page-title').textContent = title;
    get('page-description').textContent = description;
    if (focus && !get('dashboard').hidden) {
      get('page-title').focus({ preventScroll: true });
      window.scrollTo({ top: 0 });
    }
  }

  window.addEventListener('hashchange', () => {
    get('notice').hidden = true;
    renderNavigation(true);
  });
  renderNavigation();

  const filters = [['', 'Wszystkie'], ...categories].map(([id, name]) => {
    const control = button(name, () => {
      category = id;
      renderLimits();
    });
    control.dataset.category = id;
    return control;
  });
  get('limit-filters').append(...filters);
  get('limit-project').addEventListener('change', renderLimits);
  get('limit-search').addEventListener('input', renderLimits);
  get('history-search').addEventListener('input', renderHistory);
  get('history-source').addEventListener('change', renderHistory);

  function editLimit(model) {
    const details = get('custom-quota');
    const form = details.querySelector('form');
    const project = get('limit-project').value;
    const quota = data.quotas.find(row => row.project_id === project && row.model === model);
    details.open = true;
    form.elements.project_id.value = project;
    form.elements.model.value = model;
    for (const key of ['rpm', 'tpm', 'rpd']) form.elements[key].value = quota?.[key] ?? '';
    form.elements.rpm.focus();
  }

  function renderLimits() {
    if (!data) return;
    const project = get('limit-project').value;
    const rows = limitModels(data, project, category, get('limit-search').value);
    for (const control of filters) control.setAttribute('aria-pressed', String(control.dataset.category === category));
    get('limit-note').textContent = project
      ? 'Pozostało / limit. Szacunek obejmuje próby wysłania do Google przez router. Karty poza pomiarem pokazują wartości referencyjne.'
      : 'Dodaj projekt w module Klucze API, żeby zobaczyć szacowany zapas. Poniżej są wartości z podanej listy.';
    get('limit-count').textContent = number.format(rows.length) + ' pozycji';
    renderLimitCards(get('quotas'), rows, editLimit);
  }

  function renderHistory() {
    if (!data) return;
    const query = get('history-search').value.trim().toLocaleLowerCase('pl-PL');
    const source = get('history-source').value;
    const rows = data.recent.filter(r => (!source || r.source === source) &&
      [r.app_name, r.model, r.id].some(value => value.toLocaleLowerCase('pl-PL').includes(query)));
    const labels = { google: 'Google', cache: 'Cache', router: 'Router' };
    table(get('recent'), ['Czas', 'Aplikacja', 'Model', 'Źródło', 'Status', 'Czas (ms)', 'Tokeny', 'Szczegóły'], rows.map(r => [
      date.format(r.started_at), r.app_name, r.model, labels[r.source] ?? r.source,
      r.status ?? 'W toku', r.latency_ms, r.total_tokens, button('Otwórz', () => openRequest(r.id))
    ]));
    get('history-count').textContent = 'Widoczne ' + rows.length + ' z ' + data.recent.length + ' zapytań';
  }

  function renderProjects() {
    const keysByProject = Map.groupBy(data.keys, key => key.project_id);
    const cards = data.projects.map(project => {
      const card = node('article', 'card entity-card');
      const keys = keysByProject.get(project.id) ?? [];
      const active = keys.find(key => key.active);
      card.append(node('h3', '', project.name), node('p', 'model-code', project.id));
      if (!keys.length) card.append(node('p', 'muted caption', 'Brak kluczy.'));
      const list = node('ul', 'key-list');
      for (const key of keys) {
        const item = node('li');
        const content = node('div');
        const state = key === active ? 'Używany' : key.active ? 'Zapasowy' : 'Wyłączony';
        content.append(node('strong', '', key.label), node('span', 'caption muted', state + ' · ' + date.format(key.created_at)));
        item.append(content);
        if (key.active) item.append(button('Wyłącz', () => disableKey(key), 'quiet'));
        list.append(item);
      }
      card.append(list);
      return card;
    });
    get('keys').replaceChildren(...(cards.length ? cards : [node('p', 'card empty', 'Dodaj pierwszy klucz, żeby podłączyć projekt.')]));
  }

  function renderApps() {
    const projectNames = new Map(data.projects.map(p => [p.id, p.name]));
    const cards = data.apps.map(app => {
      const card = node('article', 'card entity-card');
      const title = node('div', 'entity-info');
      title.append(node('h3', '', app.name), node('span', app.revoked_at ? 'pill subtle' : 'pill positive',
        app.revoked_at ? 'Unieważniony' : 'Aktywny'));
      card.append(title, node('p', 'caption muted', projectNames.get(app.project_id) ?? app.project_id));
      const stats = node('dl', 'app-metrics');
      for (const [name, value] of [['Żądania', app.requests], ['Google', app.google_calls],
        ['Cache', app.hits], ['Błędy', app.errors], ['Tokeny', app.tokens]]) {
        const item = node('div');
        item.append(node('dt', '', name), node('dd', '', number.format(value)));
        stats.append(item);
      }
      card.append(stats, node('p', 'caption muted', 'Cache: ' + (app.cache_seconds ? app.cache_seconds + ' s' : 'wył.') +
        ' · Treść: ' + (app.log_bodies ? 'zapis włączony' : 'zapis wyłączony')));
      if (!app.revoked_at) card.append(button('Ustawienia', () => editApp(app), 'quiet'));
      return card;
    });
    get('apps').replaceChildren(...(cards.length ? cards : [node('p', 'card empty', 'Dodaj aplikację i utwórz jej pierwszy token.')]));
  }

  function renderSummary() {
    const stats = [['Żądania', 'requests'], ['Wywołania Google', 'google_calls'],
      ['Trafienia cache', 'hits'], ['Błędy', 'errors']];
    get('summary').replaceChildren(...stats.map(([label, field]) => {
      const card = node('article', 'card summary-card');
      const total = data.apps.reduce((sum, app) => sum + app[field], 0);
      card.append(node('p', 'caption muted', label), node('strong', '', number.format(total)));
      return card;
    }));
  }

  function load(snapshot, selectedProject) {
    data = { ...snapshot, usage: snapshot.usage ?? snapshot.quotas };
    const known = new Set(data.projects.map(project => project.id));
    const picker = get('limit-project');
    const selected = selectedProject ?? picker.value;
    for (const select of [...document.querySelectorAll('select[name="project_id"]'), picker]) {
      const previous = select === picker ? selected : select.value;
      select.replaceChildren(new Option(data.projects.length ? 'Wybierz projekt' : 'Brak projektów', ''));
      for (const p of data.projects) select.add(new Option(p.name === p.id ? p.id : p.name + ' · ' + p.id, p.id));
      select.value = known.has(previous) ? previous : data.projects.length === 1 || select === picker
        ? data.projects[0]?.id ?? '' : '';
    }
    get('key-projects').replaceChildren(...data.projects.map(p => new Option(p.name, p.id)));
    get('updated-at').textContent = 'Aktualizacja ' + time.format(data.measured_at ?? Date.now());
    renderSummary();
    renderProjects();
    renderApps();
    renderLimits();
    renderHistory();
  }

  function clear() {
    data = undefined;
    for (const id of ['summary', 'quotas', 'keys', 'apps', 'recent', 'key-projects', 'limit-project']) get(id).replaceChildren();
    for (const form of document.querySelectorAll('form[data-resource]')) {
      form.reset();
      form.querySelector('select[name="project_id"]')?.replaceChildren();
    }
  }

  return { load, clear };
}
