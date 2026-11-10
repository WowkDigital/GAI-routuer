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

function metricCell(metric, tracked) {
  const wrap = element('div', 'metric');
  wrap.append(element('p', 'metric-label', metric.key.toUpperCase()));
  const count = element('p', 'metric-value');
  if (metric.unlimited) {
    count.textContent = 'Bez limitu';
  } else if (metric.remaining !== null) {
    count.append(element('strong', '', number.format(metric.remaining)),
      element('span', '', ' / ' + number.format(metric.value)));
  } else {
    count.textContent = metric.value == null ? '—' : tracked ? '— / ' + number.format(metric.value) : number.format(metric.value);
  }
  wrap.append(count);
  if (metric.remaining !== null) {
    const percent = metric.remaining / metric.value;
    const meter = element('progress', percent <= 0.2 ? 'low' : '');
    meter.max = metric.value;
    meter.value = metric.remaining;
    meter.setAttribute('aria-label', 'Pozostało ' + metric.key.toUpperCase());
    wrap.append(meter);
  } else if (tracked && metric.missing > 0) {
    wrap.append(element('small', 'metric-hint', 'Brak pełnych danych'));
    wrap.title = 'Google zwrócił tokeny tylko dla części żądań; zliczono ' + number.format(metric.used) + '.';
  }
  return wrap;
}

export function renderLimitCards(container, rows, onEdit) {
  const categoryNames = new Map(categories);
  const cards = rows.map(model => {
    const card = element('article', 'card model-card');
    const top = element('div', 'model-top');
    const labels = element('div', 'chips');
    labels.append(element('span', 'pill', categoryNames.get(model.category)));
    const status = model.tracked ? 'Pomiar routera' : model.externalApi ? 'Poza pomiarem' : 'Referencja';
    labels.append(element('span', model.tracked ? 'pill positive' : 'pill subtle', status));
    top.append(labels, element('h3', '', model.name));
    if (model.id) top.append(element('p', 'model-code', model.id));
    card.append(top);
    const counters = element('div', 'model-metrics');
    counters.append(...model.metrics.map(metric => metricCell(metric, model.tracked)));
    card.append(counters);

    const foot = element('div', 'model-foot');
    const source = model.externalApi && !model.tracked ? model.externalApi :
      model.hasOverride ? (model.limits ? 'Limity projektu / katalog' : 'Limity projektu') : 'Limity z podanej listy';
    foot.append(element('span', 'caption muted', source));
    if (model.tracked) {
      const edit = element('button', 'quiet', 'Ustaw limit');
      edit.type = 'button';
      edit.addEventListener('click', () => onEdit(model.id));
      foot.append(edit);
    }
    card.append(foot);
    return card;
  });
  container.replaceChildren(...(cards.length ? cards : [element('p', 'empty card', 'Brak modeli pasujących do filtrów.')]));
}
