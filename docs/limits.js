import { categories, models } from './catalog.js';

export const number = new Intl.NumberFormat('pl-PL');
const metrics = [
  ['rpm', 'used_rpm'],
  ['tpm', 'known_tpm'],
  ['rpd', 'used_rpd']
];

export function limitModels(data, project, category = '', query = '') {
  const own = new Map(data.quotas.filter(row => row.project_id === project).map(row => [row.model, row]));
  const usage = new Map(data.usage.filter(row => row.project_id === project).map(row => [row.model, row]));
  const catalogIds = new Set(models.map(model => model.id));
  const custom = [...own.keys()].filter(id => !catalogIds.has(id)).map(id => ({
    id, name: id, category: 'other', limits: null
  }));
  return [...models, ...custom]
    .filter(model => (!category || category === model.category) &&
      (model.name + ' ' + (model.id ?? '')).toLocaleLowerCase('pl-PL').includes(query.trim().toLocaleLowerCase('pl-PL')))
    .map(model => {
      const actual = usage.get(model.id);
      const override = own.get(model.id);
      const tracked = Boolean(project && model.id && (!model.externalApi ||
        (model.externalApi === 'Interactions API' && actual)));
      const hasOverride = metrics.some(([key]) => override?.[key] != null);
      return {
        ...model,
        tracked,
        hasOverride,
        metrics: metrics.map(([key, usageKey]) => {
          const configured = override?.[key];
          const value = configured ?? model.limits?.[key];
          const unlimited = configured == null && model.limits?.[key] === null;
          const used = actual?.[usageKey] ?? 0;
          const missing = key === 'tpm' ? actual?.missing_tpm ?? 0 : 0;
          return {
            key, value, unlimited, used, missing,
            remaining: tracked && value != null && !missing ? Math.max(0, value - used) : null
          };
        })
      };
    });
}

function element(tag, className, label) {
  const node = document.createElement(tag);
  node.className = className;
  if (label != null) node.textContent = label;
  return node;
}

function metricCell(metric, model, daily = false) {
  const cell = element('td', daily ? 'quota-day' : 'quota-minute');
  if (metric.unlimited) {
    cell.append(element('span', 'muted', 'Bez limitu'));
  } else if (metric.remaining !== null) {
    const amount = element('div', 'quota-amount');
    amount.append(element('strong', '', number.format(metric.remaining)),
      element('span', 'muted', ' / ' + number.format(metric.value)));
    cell.append(amount);
    if (daily) {
      const meter = element('meter', metric.remaining / metric.value <= 0.2 ? 'low' : '');
      meter.max = metric.value;
      meter.value = metric.remaining;
      meter.setAttribute('aria-label', model.name + ', pozostałe wywołania dzisiaj');
      cell.append(meter);
    }
  } else {
    const label = metric.value == null ? '—' : model.tracked ? '— / ' + number.format(metric.value) : number.format(metric.value);
    cell.append(element('span', 'muted', label));
  }
  if (metric.missing > 0 && model.tracked && !metric.unlimited) {
    cell.append(element('small', 'quota-note', 'Brak pełnych danych'));
  }
  return cell;
}

export function renderLimitTable(container, rows, onEdit) {
  if (!rows.length) {
    container.replaceChildren(element('p', 'quota-empty muted', 'Brak modeli pasujących do filtrów.'));
    return;
  }

  const categoriesById = new Map(categories);
  const table = element('table', 'quota-table');
  table.setAttribute('aria-label', 'Limity modeli');
  const header = table.createTHead().insertRow();
  for (const label of ['Model', 'Dziś · RPD', 'RPM', 'TPM', 'Ustawienia']) {
    const heading = element('th', '', label);
    heading.scope = 'col';
    header.append(heading);
  }
  const body = table.createTBody();
  for (const model of rows) {
    const row = body.insertRow();
    const title = element('th', 'quota-model', model.name);
    title.scope = 'row';
    let description = model.id ?? categoriesById.get(model.category);
    if (!model.tracked) description += model.externalApi ? ' · ' + model.externalApi + ' · poza pomiarem' : ' · referencja';
    if (model.hasOverride) description += ' · limit projektu';
    title.append(element('small', 'quota-note', description));
    const [rpm, tpm, rpd] = model.metrics;
    row.append(title, metricCell(rpd, model, true), metricCell(rpm, model), metricCell(tpm, model));
    const actions = row.insertCell();
    if (model.tracked) {
      const edit = element('button', 'quiet', 'Edytuj');
      edit.type = 'button';
      edit.setAttribute('aria-label', 'Edytuj limity ' + model.name);
      edit.addEventListener('click', () => onEdit(model.id));
      actions.append(edit);
    }
  }
  container.replaceChildren(table);
}
