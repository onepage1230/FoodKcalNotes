import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { goalStatus, GOAL_STATUS_TEXT } from '../client/nutrient-goals.js';
import { createJournal } from '../server/journal.js';

// ticket 12：當日目標狀態（純函式）。輸入已知總量 { known, unknown }、目標 { type, min, max }。
const s = (known, unknown, goal) => goalStatus({ known, unknown }, goal);
const MIN = { type: 'min', min: 60 }; const RANGE = { type: 'range', min: 40, max: 70 }; const MAX = { type: 'max', max: 2300 };

test('狀態：下限 × 無未知', () => {
  assert.equal(s(60, 0, MIN), 'ok'); assert.equal(s(80, 0, MIN), 'ok'); assert.equal(s(59, 0, MIN), 'low');
});
test('狀態：下限 × 有未知', () => {
  assert.equal(s(60, 2, MIN), 'ok'); // 已知已達下限，未知只會增加
  assert.equal(s(30, 1, MIN), 'maybeLow'); assert.equal(s(0, 3, MIN), 'maybeLow');
});
test('狀態：上限 × 無未知', () => {
  assert.equal(s(2300, 0, MAX), 'ok'); assert.equal(s(100, 0, MAX), 'ok'); assert.equal(s(2301, 0, MAX), 'over');
});
test('狀態：上限 × 有未知（已知超過才提示，未超不能說達標）', () => {
  assert.equal(s(2301, 1, MAX), 'over'); assert.equal(s(100, 1, MAX), 'unknown'); assert.equal(s(2300, 2, MAX), 'unknown');
});
test('狀態：範圍 × 無未知', () => {
  assert.equal(s(39, 0, RANGE), 'low'); assert.equal(s(40, 0, RANGE), 'ok'); assert.equal(s(70, 0, RANGE), 'ok'); assert.equal(s(71, 0, RANGE), 'outOfRange');
});
test('狀態：範圍 × 有未知', () => {
  assert.equal(s(39, 1, RANGE), 'maybeLow'); assert.equal(s(71, 1, RANGE), 'outOfRange');
  assert.equal(s(50, 1, RANGE), 'unknown'); // 範圍內但上方可能被未知推高，不說達標
});
test('狀態：目標為 null（沒有計劃的蛋白質、沒有目標值）時無法判斷', () => {
  assert.equal(s(10, 0, { type: 'min', min: null }), 'unknown'); assert.equal(s(10, 0, { type: 'max', max: null }), 'unknown');
  assert.equal(s(10, 0, { type: 'range', min: null, max: null }), 'unknown'); assert.equal(s(10, 0, undefined), 'unknown');
  assert.equal(s(10, 0, { type: 'range', min: null, max: 70 }), 'ok'); assert.equal(s(80, 0, { type: 'range', min: null, max: 70 }), 'outOfRange');
});
test('狀態：每個狀態都有顯示文字', () => {
  for (const k of ['ok', 'low', 'maybeLow', 'outOfRange', 'over', 'unknown']) assert.ok(k in GOAL_STATUS_TEXT);
});

const today = () => { const n = new Date(); return new Date(n - n.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
test('上線日期：第一次開啟寫入伺服器本地今天，已存在不覆蓋', t => {
  const db = createJournal(':memory:'); t.after(() => db.close());
  assert.equal(db.getMeta('nutrientGoalsSince'), today());
  db.setMeta('nutrientGoalsSince', '2026-01-01');
  assert.equal(db.getMeta('nutrientGoalsSince'), '2026-01-01');
});
test('上線日期：重新開啟既有資料庫不覆蓋；朋友日誌各自記錄', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ndg-')); t.after(() => rmSync(dir, { recursive: true }));
  const f = join(dir, 'a.sqlite'); const a = createJournal(f); a.setMeta('nutrientGoalsSince', '2026-02-02'); a.close();
  const b = createJournal(f); t.after(() => b.close()); assert.equal(b.getMeta('nutrientGoalsSince'), '2026-02-02');
  const c = createJournal(join(dir, 'b.sqlite')); t.after(() => c.close()); assert.equal(c.getMeta('nutrientGoalsSince'), today());
});
test('連勝仍只看熱量：營養素超標不影響', t => {
  const db = createJournal(':memory:'); t.after(() => db.close()); const d = today();
  db.saveMeal({ day: d, time: '12:00', items: [{ name: '鹹', grams: 100, kcalPer100g: 100, source: 'manual', sodiumMgPer100g: 30000 }] });
  assert.equal(db.streak(d), 1);
});
