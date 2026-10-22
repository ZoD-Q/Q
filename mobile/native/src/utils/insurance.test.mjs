import test from 'node:test';
import assert from 'node:assert/strict';
import { groups, insuranceTypes, findInsurance, sources } from '../prototype/insurance/catalog.ts';

test('every insurance entry has a valid group and reading guidance', () => {
  assert.equal(new Set(insuranceTypes.map(item => item.id)).size, insuranceTypes.length);
  for (const item of insuranceTypes) {
    const group = groups.find(group => group.id === item.group);
    assert.ok(group && group.questions.every(Boolean) && group.claims.every(Boolean));
    assert.ok(item.title.every(Boolean) && item.coverage.every(Boolean) && item.caution);
  }
  for (const group of groups) assert.ok(findInsurance('', group.id).length > 0);
  assert.ok(sources.every(source => new URL(source.url).protocol === 'https:'));
});

test('insurance discovery supports Chinese, English, whitespace and category intersections', () => {
  assert.equal(findInsurance('宠物')[0].id, 'pet');
  assert.equal(findInsurance('  ELECTRIC  vehicle ')[0].id, 'ev');
  assert.ok(findInsurance('医疗', 'health').length > 1);
  assert.equal(findInsurance('医疗', 'motor').length, 0);
  assert.equal(findInsurance('does-not-exist').length, 0);
  assert.equal(findInsurance('   ').length, insuranceTypes.length);
  assert.equal(findInsurance('', 'unknown').length, 0);
});
