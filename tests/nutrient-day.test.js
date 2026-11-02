import test from 'node:test';
import assert from 'node:assert/strict';
import { createJournal } from '../server/journal.js';

// ticket 10：當日營養素總計（所有餐點的所有項目；未知數是項目數）。
const N = { proteinPer100g: null, fatPer100g: null, carbsPer100g: null, sugarPer100g: null, sodiumMgPer100g: null };
const item = (name, grams, extra = {}) => ({ name, grams, kcalPer100g: 100, source: 'manual', ...N, ...extra });
const setup = t => { const db = createJournal(':memory:'); t.after(() => db.close()); return db; };
const save = (db, day, items, time = '12:00') => db.saveMeal({ day, time, items });

test('當日營養素：單餐總量由克數與每100g換算', t => {
  const db = setup(t); save(db, '2026-10-01', [item('雞胸', 200, { proteinPer100g: 20, fatPer100g: 2, carbsPer100g: 0, sugarPer100g: 0, sodiumMgPer100g: 50 })]);
  assert.deepEqual(db.dayNutrients('2026-10-01'), { protein: { known: 40, unknown: 0 }, fat: { known: 4, unknown: 0 }, carbs: { known: 0, unknown: 0 }, sugar: { known: 0, unknown: 0 }, sodiumMg: { known: 100, unknown: 0 } });
});

test('當日營養素：跨多餐加總，未知項目數跨餐累計', t => {
  const db = setup(t);
  save(db, '2026-10-01', [item('甲', 100, { proteinPer100g: 10 }), item('乙', 100)], '08:00');
  save(db, '2026-10-01', [item('丙', 50, { proteinPer100g: 20 })], '12:00');
  const d = db.dayNutrients('2026-10-01');
  assert.deepEqual(d.protein, { known: 20, unknown: 1 });
  assert.deepEqual(d.fat, { known: 0, unknown: 3 });
});

test('當日營養素：舊格式餐點（項目沒有營養素欄位）算全部未知', t => {
  const db = setup(t); save(db, '2026-10-01', [{ name: '舊', grams: 100, kcalPer100g: 100, source: 'manual' }]);
  assert.deepEqual(db.dayNutrients('2026-10-01').sugar, { known: 0, unknown: 1 });
});

test('當日營養素：其他日期不混入；沒有餐點時為 0 與 0 項未知', t => {
  const db = setup(t); save(db, '2026-10-02', [item('明天', 100, { proteinPer100g: 50 })]);
  assert.deepEqual(db.dayNutrients('2026-10-01').protein, { known: 0, unknown: 0 });
  assert.deepEqual(db.dayNutrients('2026-10-02').protein, { known: 50, unknown: 0 });
});
