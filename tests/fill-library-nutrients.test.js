import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createJournal } from '../server/journal.js';

// fill-library-nutrients 腳本：既有食物庫只補空白或標為估算的營養素，熱量與其他欄位不動。
const script = path.resolve('scripts/fill-library-nutrients.mjs');
function setup(t, rows, seed = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-nutrients-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = createJournal(path.join(dir, 'meals.sqlite')); seed.forEach(f => db.putFood(f)); db.close();
  const file = path.join(dir, 'in.json'); fs.writeFileSync(file, JSON.stringify(rows));
  const run = (...flags) => spawnSync(process.execPath, [script, file, ...flags], { env: { ...process.env, MEAL_JOURNAL_DATA_DIR: dir }, encoding: 'utf8' });
  const foods = () => { const j = createJournal(path.join(dir, 'meals.sqlite')); const list = j.foods(); j.close(); return Object.fromEntries(list.map(f => [f.name, f])); };
  const backups = () => fs.readdirSync(dir).filter(n => n.startsWith('meals-backup-'));
  return { run, foods, backups };
}
const full = { proteinPer100g: 3.1, fatPer100g: 0.3, carbsPer100g: 41, sugarPer100g: null, sodiumMgPer100g: 2 };

test('補營養素：空白欄位補上實測值；估算欄位被實測值覆蓋並移除「估」；有出處的欄位與熱量不變', t => {
  const { run, foods, backups } = setup(t, [{ name: '白飯（熟）', kcalPer100g: 182, source: 'web', ...full }],
    [{ name: '白飯（熟）', kcalPer100g: 182, source: 'web', proteinPer100g: 2.5, fatPer100g: 9, carbsPer100g: null, sodiumMgPer100g: 5, estimated: ['proteinPer100g', 'sodiumMgPer100g'] }]);
  const r = run(); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /更新 1/);
  const rice = foods()['白飯（熟）'];
  assert.equal(rice.proteinPer100g, 3.1); assert.equal(rice.sodiumMgPer100g, 2); // 估算 → 實測
  assert.equal(rice.carbsPer100g, 41); // 空白 → 實測
  assert.equal(rice.fatPer100g, 9); // 有出處的值不覆蓋
  assert.equal(rice.sugarPer100g, null); assert.deepEqual(rice.estimated, []); assert.equal(rice.kcalPer100g, 182);
  assert.equal(backups().length, 1);
});

test('補營養素：別名也能對應；熱量不同的同名食物略過並列出；食物庫沒有的不新增', t => {
  const { run, foods } = setup(t, [
    { name: '白飯（熟）', aliases: ['白米飯（熟）'], kcalPer100g: 182, source: 'web', ...full },
    { name: '茶葉蛋', kcalPer100g: 145, source: 'web', ...full },
    { name: '庫裡沒有', kcalPer100g: 100, source: 'web', ...full }],
  [{ name: '白米飯（熟）', kcalPer100g: 182, source: 'web' }, { name: '茶葉蛋', kcalPer100g: 160, source: 'label' }]);
  const r = run(); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /更新 1/); assert.match(r.stdout, /略過 茶葉蛋：熱量不同/); assert.match(r.stdout, /食物庫沒有 1/);
  const all = foods();
  assert.equal(all['白米飯（熟）'].proteinPer100g, 3.1);
  assert.equal(all['茶葉蛋'].proteinPer100g, null); assert.equal(all['茶葉蛋'].kcalPer100g, 160);
  assert.equal(all['庫裡沒有'], undefined);
});

test('補營養素：--dry-run 只回報、不寫入、不備份', t => {
  const { run, foods, backups } = setup(t, [{ name: '白飯（熟）', kcalPer100g: 182, source: 'web', ...full }],
    [{ name: '白飯（熟）', kcalPer100g: 182, source: 'web' }]);
  const r = run('--dry-run'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /將更新 1/);
  assert.equal(foods()['白飯（熟）'].proteinPer100g, null); assert.equal(backups().length, 0);
});
