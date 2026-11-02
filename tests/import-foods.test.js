import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createJournal } from '../server/journal.js';

// import-foods 腳本：以暫存資料夾與 MEAL_JOURNAL_DATA_DIR 實際執行。
const script = path.resolve('scripts/import-foods.mjs');
function setup(t, rows, seed = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-foods-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (seed.length) { const db = createJournal(path.join(dir, 'meals.sqlite')); seed.forEach(f => db.putFood(f)); db.close(); }
  const file = path.join(dir, 'in.json'); fs.writeFileSync(file, JSON.stringify(rows));
  const run = (...flags) => spawnSync(process.execPath, [script, file, ...flags], { env: { ...process.env, MEAL_JOURNAL_DATA_DIR: dir }, encoding: 'utf8' });
  const foods = () => { const db = createJournal(path.join(dir, 'meals.sqlite')); const list = db.foods(); db.close(); return list; };
  return { run, foods };
}
const full = { proteinPer100g: 3, fatPer100g: 1, carbsPer100g: 40, sugarPer100g: 0.5, sodiumMgPer100g: 2 };

test('匯入：含營養素與 estimated 的資料原樣寫入，舊格式（只有熱量）照常匯入', t => {
  const { run, foods } = setup(t, [
    { name: '白飯', kcalPer100g: 182, source: 'web', ...full },
    { name: '估算湯', kcalPer100g: 40, source: 'web', proteinPer100g: 2, estimated: ['proteinPer100g'] },
    { name: '舊格式', kcalPer100g: 100, source: 'web' }]);
  const r = run(); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /新增 3，略過 0，無效 0/);
  const by = Object.fromEntries(foods().map(f => [f.name, f]));
  assert.deepEqual([by['白飯'].proteinPer100g, by['白飯'].sodiumMgPer100g, by['白飯'].estimated], [3, 2, []]);
  assert.deepEqual([by['估算湯'].proteinPer100g, by['估算湯'].fatPer100g, by['估算湯'].estimated], [2, null, ['proteinPer100g']]);
  assert.equal(by['舊格式'].proteinPer100g, null);
});

test('匯入：名稱或別名已存在就略過，不覆蓋也不補值', t => {
  const { run, foods } = setup(t, [{ name: '白飯', kcalPer100g: 999, ...full }, { name: '新飯', aliases: ['米飯'], kcalPer100g: 1, ...full }],
    [{ name: '米飯', kcalPer100g: 180, source: 'web' }]);
  const r = run(); assert.match(r.stdout, /新增 1，略過 1，無效 0/);
  const rice = foods().find(f => f.name === '米飯'); assert.equal(rice.kcalPer100g, 180); assert.equal(rice.proteinPer100g, null);
  assert.equal(foods().find(f => f.name === '白飯').kcalPer100g, 999);
});

test('匯入：無效的營養素值計入無效並說明原因', t => {
  const { run, foods } = setup(t, [
    { name: '負值', kcalPer100g: 10, proteinPer100g: -1 },
    { name: '字串', kcalPer100g: 10, sodiumMgPer100g: '5' },
    { name: '超過百克', kcalPer100g: 10, proteinPer100g: 60, fatPer100g: 60 },
    { name: '正常', kcalPer100g: 10, fatPer100g: 1 }]);
  const r = run(); assert.match(r.stdout, /新增 1，略過 0，無效 3/);
  assert.match(r.stdout, /無效 #0 負值：營養素「蛋白質」/); assert.match(r.stdout, /無效 #1 字串：營養素「鈉」/); assert.match(r.stdout, /無效 #2 超過百克：.*加總超過/);
  assert.deepEqual(foods().map(f => f.name), ['正常']);
});

test('--dry-run：不寫入，並回報含營養素的筆數（五項齊全、部分、皆無）', t => {
  const { run, foods } = setup(t, [
    { name: 'A', kcalPer100g: 10, ...full }, { name: 'B', kcalPer100g: 10, ...full, sugarPer100g: null },
    { name: 'C', kcalPer100g: 10, fatPer100g: 1 }, { name: 'D', kcalPer100g: 10 }, { name: 'E', kcalPer100g: 10 },
    { name: '壞', kcalPer100g: 10, fatPer100g: -5 }]);
  const r = run('--dry-run'); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /新增 5，略過 0，無效 1/);
  assert.match(r.stdout, /含營養素：五項齊全 1，部分 2，皆無 2/);
  assert.equal(foods().length, 0);
});
