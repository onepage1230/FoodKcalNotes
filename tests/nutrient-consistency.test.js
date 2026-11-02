import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { kcalMismatch, KCAL_MISMATCH_THRESHOLD, KCAL_MISMATCH_MIN_KCAL } from '../client/nutrients.js';

// ticket 09：熱量與「蛋白質×4 + 碳水×4 + 脂肪×9」的一致性檢查（ADR 0010）。
const it = (kcal, p, c, f) => ({ kcalPer100g: kcal, proteinPer100g: p, carbsPer100g: c, fatPer100g: f });

test('一致性：門檻與最低熱量定案值', () => {
  assert.equal(KCAL_MISMATCH_THRESHOLD, 0.25);
  assert.equal(KCAL_MISMATCH_MIN_KCAL, 50);
});

test('一致性：差距在門檻內不提醒', () => {
  const r = kcalMismatch(it(100, 10, 10, 2)); // 換算 98
  assert.equal(r.exceeds, false);
  assert.ok(r.ratio < 0.05);
});

test('一致性：差距超過門檻要提醒，並回傳差距比例', () => {
  const r = kcalMismatch(it(100, 20, 20, 10)); // 換算 250，差 150%
  assert.equal(r.exceeds, true);
  assert.equal(r.ratio, 1.5);
});

test('一致性：恰好等於門檻不提醒，略超過才提醒', () => {
  assert.equal(kcalMismatch(it(100, 0, 18.75, 0)).exceeds, false); // 換算 75，差 25%
  assert.equal(kcalMismatch(it(100, 0, 18.5, 0)).exceeds, true); // 換算 74，差 26%
  assert.equal(kcalMismatch(it(100, 0, 31.25, 0)).exceeds, false); // 換算 125，差 25%
  assert.equal(kcalMismatch(it(100, 0, 31.5, 0)).exceeds, true); // 換算 126，差 26%
});

test('一致性：缺任一營養素不檢查', () => {
  assert.equal(kcalMismatch(it(200, null, 10, 2)), null);
  assert.equal(kcalMismatch(it(200, 10, null, 2)), null);
  assert.equal(kcalMismatch(it(200, 10, 10, null)), null);
  assert.equal(kcalMismatch(it(200, '', 10, 2)), null);
  assert.equal(kcalMismatch({ kcalPer100g: 200 }), null);
});

test('一致性：熱量低於最低值不檢查，等於最低值要檢查', () => {
  assert.equal(kcalMismatch(it(49, 5, 5, 5)), null);
  assert.equal(kcalMismatch(it(50, 5, 5, 5)).exceeds, true);
  assert.equal(kcalMismatch(it(0, 0, 0, 0)), null);
  assert.equal(kcalMismatch(it('', 5, 5, 5)), null);
});

test('一致性：輸入框的字串也能檢查', () => {
  assert.equal(kcalMismatch(it('100', '20', '20', '10')).exceeds, true);
  assert.equal(kcalMismatch(it('100', '10', '10', '2')).exceeds, false);
});

test('一致性：食藥署 137 筆中三項已知且達最低熱量者共 101 筆，沒有任何一筆觸發提醒', () => {
  const foods = JSON.parse(readFileSync(new URL('../data/tfda-common.json', import.meta.url), 'utf8'));
  assert.equal(foods.length, 137);
  const checked = foods.map(kcalMismatch).filter(Boolean);
  assert.equal(checked.length, 101);
  assert.deepEqual(foods.filter(f => kcalMismatch(f)?.exceeds).map(f => f.name), []);
  assert.ok(Math.max(...checked.map(r => r.ratio)) < KCAL_MISMATCH_THRESHOLD);
});
