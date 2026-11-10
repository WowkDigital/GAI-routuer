import assert from 'node:assert/strict';
import { test } from 'node:test';
import { limitModels } from '../docs/limits.js';

test('catalog keeps all reference models and separates measured, missing, and unlimited quotas', () => {
  const data = {
    quotas: [{ project_id: 'project-a', model: 'gemini-2.5-flash', rpm: 8, tpm: null, rpd: null }],
    usage: [
      { project_id: 'project-a', model: 'gemini-2.5-flash', used_rpm: 2, known_tpm: 450, missing_tpm: 1, used_rpd: 5 },
      { project_id: 'project-b', model: 'gemini-2.5-flash', used_rpm: 3, known_tpm: 100, missing_tpm: 0, used_rpd: 12 }
    ]
  };
  const all = limitModels(data, 'project-a');
  assert.equal(all.length, 24);
  assert.deepEqual(all[0].metrics.map(metric => metric.remaining), [6, null, 15]);
  assert.equal(all[0].metrics[1].value, 250000);
  assert.equal(all[0].metrics[1].missing, 1);
  assert.deepEqual(limitModels(data, 'project-b', 'text', 'gemini-2.5-flash')[0].metrics.map(metric => metric.remaining),
    [2, 249900, 8]);
  assert.equal(limitModels(data, '')[0].metrics[0].remaining, null);
  const audio = limitModels(data, 'project-a', 'audio', 'native audio')[0];
  assert.equal(audio.tracked, false);
  assert.equal(audio.metrics[0].unlimited, true);
  assert.equal(audio.metrics[1].remaining, null);
  assert.equal(audio.metrics[1].value, 1_000_000);
});
