import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createJournal } from '../server/journal.js';

const nutrients = { proteinPer100g: 2.5, fatPer100g: 0.3, carbsPer100g: 41, sugarPer100g: 0.1, sodiumMgPer100g: 2 };
const rice = { name: '測試白飯', aliases: [], kcalPer100g: 182, source: 'manual', grams: 200, ...nutrients };
const meal = items => ({ name: '測試餐', day: '2026-11-02', time: '12:00', photo: '', items });

test('營養素：保存後保留每100g數值與估算標記；未提供的欄位為 null', () => {
  const db = createJournal(':memory:');
  const saved = db.saveMeal(meal([{ ...rice, estimated: ['sugarPer100g', 'sodiumMgPer100g'] }, { name: '測試湯', kcalPer100g: 20, grams: 300 }]));
  const [a, b] = db.meal(saved.id).items;
  assert.equal(a.proteinPer100g, 2.5); assert.equal(a.sodiumMgPer100g, 2);
  assert.deepEqual(a.estimated, ['sugarPer100g', 'sodiumMgPer100g']);
  assert.equal(b.proteinPer100g, null); assert.equal(b.sodiumMgPer100g, null); assert.deepEqual(b.estimated, []);
  db.close();
});

test('營養素：未知（null）不等於 0；0 是已知值', () => {
  const db = createJournal(':memory:');
  const saved = db.saveMeal(meal([{ ...rice, sugarPer100g: 0 }, { name: '測試湯', kcalPer100g: 20, grams: 300, sugarPer100g: null }]));
  assert.equal(saved.items[0].sugarPer100g, 0);
  assert.deepEqual(saved.nutrients.sugar, { known: 0, unknown: 1 });
  db.close();
});

test('營養素：拒絕超出範圍、非數字，以及三大營養素加總明顯超過 100 g', () => {
  const db = createJournal(':memory:');
  for (const bad of [{ proteinPer100g: -1 }, { fatPer100g: 101 }, { sodiumMgPer100g: 40001 }, { carbsPer100g: '41' }, { sugarPer100g: Number.NaN },
    { proteinPer100g: 40, fatPer100g: 40, carbsPer100g: 30 }])
    assert.throws(() => db.saveMeal(meal([{ ...rice, ...bad }])), /營養素/);
  // 四捨五入誤差：純油脂類加總可能略超過 100。
  assert.doesNotThrow(() => db.saveMeal(meal([{ ...rice, proteinPer100g: 0.3, fatPer100g: 99.9, carbsPer100g: 0.2 }])));
  db.close();
});

test('營養素：估算標記只保留有值的營養素欄位', () => {
  const db = createJournal(':memory:');
  const saved = db.saveMeal(meal([{ ...rice, sugarPer100g: null, estimated: ['sugarPer100g', 'fatPer100g', 'kcalPer100g', 'fatPer100g', 7] }]));
  assert.deepEqual(saved.items[0].estimated, ['fatPer100g']);
  db.close();
});

test('營養素：整餐總計回傳已知總量與未知項目數，改克數時重算', () => {
  const db = createJournal(':memory:');
  const saved = db.saveMeal(meal([rice, { name: '測試湯', kcalPer100g: 20, grams: 300, proteinPer100g: 1, sodiumMgPer100g: 300 }]));
  assert.deepEqual(saved.nutrients, {
    protein: { known: 8, unknown: 0 }, fat: { known: 0.6, unknown: 1 }, carbs: { known: 82, unknown: 1 },
    sugar: { known: 0.2, unknown: 1 }, sodiumMg: { known: 904, unknown: 0 } });
  const edited = db.saveMeal({ ...saved, items: saved.items.map((i, k) => k ? i : { ...i, grams: 100 }) });
  assert.equal(edited.nutrients.protein.known, 5.5); assert.equal(edited.nutrients.sodiumMg.known, 902);
  assert.equal(db.meals('2026-11-02')[0].nutrients.carbs.known, 41);
  db.close();
});

test('營養素：舊格式餐點（沒有營養素欄位）照常讀取、編輯與匯出', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nutrient-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'old.sqlite');
  createJournal(filename).close();
  const raw = new DatabaseSync(filename);
  raw.prepare('INSERT INTO meals VALUES(?,?,?,?,?,?,?)').run('old-1', '2026-10-01', '08:00', '舊早餐',
    JSON.stringify([{ id: 'i1', name: '舊蛋餅', aliases: [], kcalPer100g: 223, source: 'web', sourceUrl: '', sourceTitle: '', notes: '', grams: 117 }]), '', '2026-10-01T00:00:00Z');
  raw.close();
  const db = createJournal(filename);
  const old = db.meal('old-1');
  assert.equal(old.kcal, 261);
  assert.deepEqual(old.nutrients.protein, { known: 0, unknown: 1 });
  const edited = db.saveMeal({ ...old, items: [{ ...old.items[0], grams: 100 }] });
  assert.equal(edited.kcal, 223); assert.equal(edited.items[0].fatPer100g, null);
  const exported = db.exportData();
  assert.equal(exported.meals[0].items[0].proteinPer100g, null);
  assert.deepEqual(exported.meals[0].nutrients.protein, { known: 0, unknown: 1 });
  db.close();
});

test('營養素：匯出包含營養素與估算標記', () => {
  const db = createJournal(':memory:');
  db.saveMeal(meal([{ ...rice, estimated: ['sodiumMgPer100g'] }]));
  const [item] = db.exportData().meals[0].items;
  assert.equal(item.carbsPer100g, 41); assert.deepEqual(item.estimated, ['sodiumMgPer100g']);
  db.close();
});
