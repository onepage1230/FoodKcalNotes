import test from 'node:test';
import assert from 'node:assert/strict';
import { planGoal } from '../client/plan.js';
import { planContext } from '../client/plan-context.js';
import { createJournal } from '../server/journal.js';

const today = new Date(2026, 9, 3);
const sample = { sex: 'f', age: 28, height: 165, weight: 60, target: 55, activity: 1.2 };

test('planGoal：以目前每日目標推算每週減重與預計日', () => {
  const g = planGoal(planContext(sample), 1300, today);
  assert.deepEqual(g, { bmr: 1330, tdee: 1596, floor: 1330, weekly: 0.27, days: 130, date: '2027-02-10', total: 130 });
  assert.equal(planGoal(planContext(sample), 1100, today).days, Math.ceil(5 / 0.45 * 7));
  const m = planGoal(planContext({ sex: 'm', age: 30, height: 180, weight: 90, target: 80, activity: 1.55 }), 2364, today);
  assert.deepEqual(m, { bmr: 1880, tdee: 2914, floor: 1880, weekly: 0.5, days: 140, date: '2027-02-20', total: 140 });
  assert.equal(planGoal(planContext({ sex: 'f', age: 60, height: 150, weight: 40, target: 35, activity: 1.2 }), 1000, today).floor, 1200);
});
test('planGoal：目標不低於消耗不會減重；已達標為 0 天', () => {
  const none = planGoal(planContext(sample), 1600, today);
  assert.equal(none.weekly, 0); assert.equal(none.days, null); assert.equal(none.date, null); assert.equal(none.total, null);
  const done = planGoal(planContext({ ...sample, target: 60 }), 1300, today);
  assert.equal(done.days, 0); assert.equal(done.date, '2026-10-03');
});
test('planGoal：有 startDate 時從開始日倒數，過了預計日為 0', () => {
  const started = { ...sample, startDate: '2026-10-03' };
  const g = planGoal(planContext(started), 1300, new Date(2026, 9, 10));
  assert.equal(g.weekly, 0.27); assert.equal(g.total, 130); assert.equal(g.days, 123); assert.equal(g.date, '2027-02-10');
  const late = planGoal(planContext(started), 1300, new Date(2027, 6, 1));
  assert.equal(late.days, 0); assert.equal(late.total, 130); assert.equal(late.date, '2027-02-10');
  const none = planGoal(planContext(sample), 1300, new Date(2026, 9, 10));
  assert.equal(none.days, 130); assert.equal(none.total, 130); assert.equal(none.date, '2027-02-17');
});
test('planGoal：BMR、TDEE、最低攝取與每週預計減重量用目前體重；預計達成日與總天數仍以計劃體重推算', () => {
  const plan = { sex: 'f', age: 28, height: 165, weight: 90, target: 60, activity: 1.2, startDate: '2026-10-01' };
  const now = new Date(2026, 10, 5);
  // 起始體重 90：BMR 1630、TDEE 1956、每週 0.41 公斤 → 513 天，2028-02-26
  assert.deepEqual(planGoal(planContext(plan, 90), 1500, now), { bmr: 1630, tdee: 1956, floor: 1630, weekly: 0.41, days: 478, date: '2028-02-26', total: 513 });
  // 目前體重 80：BMR 10×80 + 6.25×165 − 5×28 − 161 = 1530、TDEE 1836、每週 (1836.3 − 1500) × 7 ÷ 7700 = 0.31
  assert.deepEqual(planGoal(planContext(plan, 80), 1500, now), { bmr: 1530, tdee: 1836, floor: 1530, weekly: 0.31, days: 478, date: '2028-02-26', total: 513 });
});
test('偏好 plan：預設 null、驗證、保存與清除', () => {
  const db = createJournal(':memory:'); assert.equal(db.preferences().plan, null);
  db.updatePreferences({ plan: sample }); assert.deepEqual(db.preferences().plan, sample);
  db.updatePreferences({ plan: { ...sample, rate: 0.5 } }); assert.deepEqual(db.preferences().plan, sample); // 舊版 rate 忽略不存
  for (const bad of [{ activity: 1.3 }, { age: 9 }, { age: 30.5 }, { sex: 'x' }, { weight: '60' }, { target: 20 }])
    assert.throws(() => db.updatePreferences({ plan: { ...sample, ...bad } }), e => e.status === 400 || e.statusCode === 400 || /減重目標/.test(e.message));
  assert.deepEqual(db.preferences().plan, sample);
  db.updatePreferences({ goal: 1500 }); assert.deepEqual(db.preferences().plan, sample);
  db.updatePreferences({ plan: null }); assert.equal(db.preferences().plan, null); db.close();
});
test('偏好 plan：startDate 可選，需為有效且不在未來的日期', () => {
  const db = createJournal(':memory:'); const started = { ...sample, startDate: '2026-01-15' };
  db.updatePreferences({ plan: started }); assert.deepEqual(db.preferences().plan, started);
  for (const startDate of ['2999-01-01', '2026-02-30', '2026/01/15', 20260115])
    assert.throws(() => db.updatePreferences({ plan: { ...sample, startDate } }), e => e.status === 400);
  assert.deepEqual(db.preferences().plan, started);
  db.updatePreferences({ plan: sample }); assert.deepEqual(db.preferences().plan, sample); db.close();
});
test('planContext：省略、尚未載入或無效的目前體重一律退回計劃體重；沒有計劃時為 null', () => {
  const plan = { sex: 'f', age: 28, height: 165, weight: 90, target: 60, activity: 1.2 };
  assert.equal(planContext(plan, 80).current, 80);
  for (const bad of [undefined, NaN, 0, -5, null, '80', Infinity]) assert.equal(planContext(plan, bad).current, 90, String(bad));
  assert.equal(planContext(plan).current, 90);
  assert.equal(planContext(plan, 80).plan, plan);
  assert.deepEqual([planContext(null, 80).plan, planContext(null, 80).current], [null, null]);
  assert.deepEqual([planContext(undefined).plan, planContext(undefined).current], [null, null]);
});
test('planGoal：省略目前體重等同以計劃體重推算', () => {
  const plan = { sex: 'f', age: 28, height: 165, weight: 90, target: 60, activity: 1.2, startDate: '2026-10-01' };
  const now = new Date(2026, 10, 5);
  const same = { bmr: 1630, tdee: 1956, floor: 1630, weekly: 0.41, days: 478, date: '2028-02-26', total: 513 };
  assert.deepEqual(planGoal(planContext(plan), 1500, now), same);
  assert.deepEqual(planGoal(planContext(plan, NaN), 1500, now), same);
  assert.deepEqual(planGoal(planContext(plan, 90), 1500, now), same);
});
test('planGoal：目前體重較輕、每日目標高於目前 TDEE 時 weekly 為 0，但倒數仍以計劃體重推算', () => {
  const plan = { sex: 'f', age: 28, height: 165, weight: 90, target: 60, activity: 1.2, startDate: '2026-10-01' };
  // 目前體重 70：BMR 1430、TDEE 1716；目標 1800 > 1716 → 目前不會減重。計劃體重 90 的 TDEE 1956 → 每週 0.14 公斤 → 30 公斤需 1500 天。
  assert.deepEqual(planGoal(planContext(plan, 70), 1800, new Date(2026, 10, 5)), { bmr: 1430, tdee: 1716, floor: 1430, weekly: 0, days: 1465, date: '2030-11-09', total: 1500 });
});
test('planGoal：傳入的不是 planContext 或日期時明確丟錯，不靜默退回預設', () => {
  assert.throws(() => planGoal(sample, 1300, today), /planContext/); // 忘了包裝
  assert.throws(() => planGoal(planContext(sample, 80), 1300, 80), /planGoal/); // 第三參數傳體重
  assert.throws(() => planGoal(planContext(sample, 80), 1300, { today }), /planGoal/); // 舊式選項物件
  assert.throws(() => planGoal({ plan: sample, current: 80 }, 1300, today), /planContext/); // 手寫物件不算
});
test('偏好 plan：預設 null、驗證、保存與清除', () => {
  const db = createJournal(':memory:'); assert.equal(db.preferences().plan, null);
  db.updatePreferences({ plan: sample }); assert.deepEqual(db.preferences().plan, sample);
  db.updatePreferences({ plan: { ...sample, rate: 0.5 } }); assert.deepEqual(db.preferences().plan, sample); // 舊版 rate 忽略不存
  for (const bad of [{ activity: 1.3 }, { age: 9 }, { age: 30.5 }, { sex: 'x' }, { weight: '60' }, { target: 20 }])
    assert.throws(() => db.updatePreferences({ plan: { ...sample, ...bad } }), e => e.status === 400 || e.statusCode === 400 || /減重目標/.test(e.message));
  assert.deepEqual(db.preferences().plan, sample);
  db.updatePreferences({ goal: 1500 }); assert.deepEqual(db.preferences().plan, sample);
  db.updatePreferences({ plan: null }); assert.equal(db.preferences().plan, null); db.close();
});
test('偏好 plan：startDate 可選，需為有效且不在未來的日期', () => {
  const db = createJournal(':memory:'); const started = { ...sample, startDate: '2026-01-15' };
  db.updatePreferences({ plan: started }); assert.deepEqual(db.preferences().plan, started);
  for (const startDate of ['2999-01-01', '2026-02-30', '2026/01/15', 20260115])
    assert.throws(() => db.updatePreferences({ plan: { ...sample, startDate } }), e => e.status === 400);
  assert.deepEqual(db.preferences().plan, started);
  db.updatePreferences({ plan: sample }); assert.deepEqual(db.preferences().plan, sample); db.close();
});
