import test from 'node:test';
import assert from 'node:assert/strict';
import { groups, insuranceTypes, findInsurance, sources, regClasses, regSubLabels, formTags, CATALOG_UPDATED_AT } from '../prototype/insurance/catalog.ts';

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

test('every entry carries a non-empty regulatory classification and every group a basis note', () => {
  assert.equal(regClasses.life[0], '人身保险');
  assert.equal(regClasses.property[0], '财产保险');
  for (const item of insuranceTypes) {
    assert.ok(item.regClass === 'life' || item.regClass === 'property', item.id);
    assert.ok(Object.hasOwn(regSubLabels, item.regSub), item.id);
    assert.ok(regSubLabels[item.regSub].every(Boolean), item.id);
  }
  for (const group of groups) assert.ok(group.regBasis && group.regBasis.length > 10, group.id);
});

test('form tags are mutually exclusive and form entries stay flagged as non-standalone', () => {
  for (const item of insuranceTypes) {
    assert.ok(Object.hasOwn(formTags, item.formTag), item.id);
    if (item.formTag !== 'main') assert.match(item.caution, /独立|依附/);
  }
  const participating = insuranceTypes.filter(item => item.formTag === 'form-only');
  assert.deepEqual(participating.map(item => item.id), ['participating']);
  const riders = insuranceTypes.filter(item => item.formTag === 'rider');
  assert.deepEqual(riders.map(item => item.id), ['motor-riders']);
});

test('every entry has a review date and https official sources', () => {
  assert.equal(CATALOG_UPDATED_AT, '2026-10-22');
  for (const item of insuranceTypes) {
    assert.match(item.updatedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(item.sources.length > 0, item.id);
    assert.ok(item.sources.every(source => new URL(source.url).protocol === 'https:'), item.id);
    assert.ok(item.sources.every(source => sources.some(official => official.url === source.url)), item.id);
  }
});

test('classification snapshot keeps the documented catalogue inventory', () => {
  assert.equal(insuranceTypes.length, 43);
  assert.equal(insuranceTypes.filter(item => item.formTag === 'main').length, 41);
  assert.equal(findInsurance('', 'all', 'life').length, 19);
  assert.equal(findInsurance('', 'all', 'property').length, 24);
  const businessLife = insuranceTypes.filter(item => item.group === 'business' && item.regClass === 'life');
  assert.deepEqual(businessLife.map(item => item.id), ['group']);
});

test('discovery combines regulatory class, form filters and new vocabulary', () => {
  assert.equal(findInsurance('医疗', 'health', 'property').length, 0);
  assert.deepEqual(findInsurance('', 'business', 'life').map(item => item.id), ['group']);
  assert.deepEqual(findInsurance('', 'all', 'all', 'form-only').map(item => item.id), ['participating']);
  assert.equal(findInsurance('', 'all', 'all', 'rider')[0].id, 'motor-riders');
  assert.ok(findInsurance('医疗保险', 'health').every(item => ['medical', 'outpatient', 'premium-medical', 'city-medical', 'special-drug'].includes(item.id)));
  assert.ok(findInsurance('责任保险').length > 3);
  assert.equal(findInsurance('宠物', 'home', 'property').length, 1);
});
