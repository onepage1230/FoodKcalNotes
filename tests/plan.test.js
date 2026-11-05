import test from 'node:test';
import assert from 'node:assert/strict';
import { planGoal, planProgress, planToSave, restartPlan } from '../client/plan.js';
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

// 計劃進度（ticket 03）：起始 90 → 目標 60，開始日 2026-10-01，每日 1500 kcal（起始體重的每週預計減重 0.41 公斤）
const started = { sex: 'f', age: 28, height: 165, weight: 90, target: 60, activity: 1.2, startDate: '2026-10-01' };
const nov26 = new Date(2026, 10, 26);
test('planProgress：有紀錄時進度以體重計算，回升時下降，限制 0–100%', () => {
  assert.equal(planProgress(planContext(started, 85), 1500, '2026-11-26', nov26).pct, 17); // 5 ÷ 30
  assert.equal(planProgress(planContext(started, 75), 1500, '2026-11-26', nov26).pct, 50);
  assert.equal(planProgress(planContext(started, 95), 1500, '2026-11-26', nov26).pct, 0); // 比起始重
  assert.equal(planProgress(planContext(started, 58), 1500, '2026-11-26', nov26).pct, 100); // 低於目標
});
test('planProgress：沒有體重紀錄時沿用以天數計算的舊進度', () => {
  // 2026-11-05：總天數 513、剩 478 → 35 ÷ 513 ≈ 7%
  const p = planProgress(planContext(started), 1500, null, new Date(2026, 10, 5));
  assert.equal(p.pct, 7); assert.equal(p.days, 478); assert.equal(p.total, 513);
  assert.equal(planProgress(planContext(started), 1600, null, new Date(2026, 10, 5)).pct, 5); // 每週 0.32 → 總 657 天，35 ÷ 657 ≈ 5%
  assert.equal(planProgress(planContext(started), 2000, null, new Date(2026, 10, 5)).pct, 0); // 不會減重：沒有總天數
});
test('planProgress：起始體重不高於目標時不除以 0', () => {
  const flat = { ...started, weight: 60 };
  assert.equal(planProgress(planContext(flat, 62), 1500, '2026-11-26', nov26).pct, 0);
  assert.equal(planProgress(planContext(flat, 59), 1500, '2026-11-26', nov26).pct, 100);
  assert.equal(planProgress(planContext(flat), 1500, null, nov26).pct, 100);
});
test('planProgress：最新體重 ≤ 目標即已達成，回升到目標之上回到進行中；沒有紀錄時看起始體重', () => {
  assert.equal(planProgress(planContext(started, 58), 1500, '2026-11-26', nov26).reached, true);
  assert.equal(planProgress(planContext(started, 60), 1500, '2026-11-26', nov26).reached, true);
  const back = planProgress(planContext(started, 65), 1500, '2026-11-27', nov26);
  assert.equal(back.reached, false); assert.equal(back.pct, 83); // 25 ÷ 30
  assert.equal(planProgress(planContext(started), 1500, null, nov26).reached, false);
  assert.equal(planProgress(planContext({ ...started, weight: 60 }), 1500, null, nov26).reached, true);
  // 起始體重已達標，但之後紀錄回升到目標之上：不算達成
  assert.equal(planProgress(planContext({ ...started, weight: 60 }, 62), 1500, '2026-11-26', nov26).reached, false);
});
test('planProgress：計劃線從開始日的起始體重依每週預計減重直線下降，回傳最新紀錄日對照的差距', () => {
  // 2026-10-01 → 11-26 共 56 天（8 週）：90 − 0.41 × 8 = 86.72
  const below = planProgress(planContext(started, 85), 1500, '2026-11-26', nov26);
  assert.equal(below.line, 86.7); assert.equal(below.diff, -1.7);
  assert.equal(planProgress(planContext(started, 88), 1500, '2026-11-26', nov26).diff, 1.3);
  // 計劃線不低於目標體重；紀錄早於開始日時計劃線是起始體重
  const far = planProgress(planContext(started, 61), 1500, '2030-01-01', new Date(2030, 0, 1));
  assert.equal(far.line, 60); assert.equal(far.diff, 1);
  assert.equal(planProgress(planContext(started, 92), 1500, '2026-09-20', nov26).diff, 2);
});
test('planProgress：沒有紀錄、沒有開始日或依起始體重不會減重時沒有計劃線', () => {
  for (const p of [planProgress(planContext(started), 1500, null, nov26),
    planProgress(planContext({ ...started, startDate: undefined }, 85), 1500, '2026-11-26', nov26),
    planProgress(planContext(started, 85), 2000, '2026-11-26', nov26)]) { assert.equal(p.line, null); assert.equal(p.diff, null); }
});
// startGoal：起點設定當下的每日熱量目標（GLOSSARY：起點每日目標）；起點設定或重設時寫入目前每日目標，其餘儲存保留原值。
const fixed = { ...started, startGoal: 1500 };
test('planToSave：有紀錄時改活動量、目標等不動起始體重、開始日與起點每日目標（表單體重欄位唯讀，不採用）', () => {
  const form = { sex: 'f', age: 29, height: 166, weight: 85, target: 58, activity: 1.375 };
  assert.deepEqual(planToSave(fixed, form, 85, '2026-11-26', 1700),
    { sex: 'f', age: 29, height: 166, weight: 90, target: 58, activity: 1.375, startDate: '2026-10-01', startGoal: 1500 });
});
test('planToSave：沒有紀錄時體重沒改就保留起點，改了體重視為重設起點（開始日今天、起點每日目標為目前每日目標）', () => {
  const same = { sex: 'f', age: 28, height: 165, weight: 90, target: 55, activity: 1.2 };
  assert.deepEqual(planToSave(fixed, same, null, '2026-11-26', 1700), { ...same, startDate: '2026-10-01', startGoal: 1500 });
  assert.deepEqual(planToSave(fixed, { ...same, weight: 88 }, null, '2026-11-26', 1700), { ...same, weight: 88, startDate: '2026-11-26', startGoal: 1700 });
});
test('planToSave：舊計劃沒有起點每日目標時，不動起點的儲存不補寫；重設起點才寫入', () => {
  const same = { sex: 'f', age: 28, height: 165, weight: 90, target: 55, activity: 1.375 };
  assert.deepEqual(planToSave(started, same, null, '2026-11-26', 1700), { ...same, startDate: '2026-10-01' });
  assert.deepEqual(planToSave(started, { ...same, weight: 88 }, null, '2026-11-26', 1700), { ...same, weight: 88, startDate: '2026-11-26', startGoal: 1700 });
});
test('planToSave：還沒有計劃時從今天開始並寫入目前每日目標；先記過體重則以最新紀錄為起始體重', () => {
  const form = { sex: 'f', age: 28, height: 165, weight: 70, target: 60, activity: 1.2 };
  assert.deepEqual(planToSave(null, form, 85, '2026-11-26', 1600), { ...form, weight: 85, startDate: '2026-11-26', startGoal: 1600 });
  assert.deepEqual(planToSave(null, form, null, '2026-11-26', 1600), { ...form, startDate: '2026-11-26', startGoal: 1600 });
});
test('restartPlan：以目前體重、今天與目前每日目標為新的起點，其餘欄位不變', () => {
  assert.deepEqual(restartPlan(fixed, 85, '2026-11-26', 1700),
    { sex: 'f', age: 28, height: 165, weight: 85, target: 60, activity: 1.2, startDate: '2026-11-26', startGoal: 1700 });
  assert.equal(restartPlan(started, 85, '2026-11-26', 1600).startGoal, 1600); // 舊計劃也寫入
});
test('planProgress：預計達成日、總天數與計劃線用起點每日目標，之後改每日目標不變；目前每週減重量用目前每日目標', () => {
  const at1500 = planProgress(planContext(fixed, 85), 1500, '2026-11-26', nov26);
  const at1700 = planProgress(planContext(fixed, 85), 1700, '2026-11-26', nov26);
  for (const p of [at1500, at1700]) assert.deepEqual([p.date, p.total, p.line, p.diff], ['2028-02-26', 513, 86.7, -1.7]);
  // 目前體重 85：BMR 1580、TDEE 1896；目標 1700 → (1896 − 1700) × 7 ÷ 7700 = 0.18
  assert.equal(at1700.weekly, 0.18);
  // 目標 2000 高於目前 TDEE：目前不會再減重，但原計劃仍在
  const at2000 = planProgress(planContext(fixed, 85), 2000, '2026-11-26', nov26);
  assert.deepEqual([at2000.weekly, at2000.total, at2000.line], [0, 513, 86.7]);
});
test('planProgress：舊計劃沒有起點每日目標時退回目前每日目標（預計達成日隨每日目標變動）', () => {
  // 目標 1700、起始體重 TDEE 1956：每週 0.23 → 30 公斤需 914 天
  assert.equal(planProgress(planContext(started), 1700, null, nov26).total, 914);
  assert.equal(planProgress(planContext(fixed), 1700, null, nov26).total, 513);
});
test('planProgress：記體重前後預計達成日與總天數相同', () => {
  const before = planProgress(planContext(started), 1500, null, new Date(2026, 10, 5));
  const after = planProgress(planContext(started, 85), 1500, '2026-11-05', new Date(2026, 10, 5));
  assert.deepEqual([before.date, before.total, before.days], ['2028-02-26', 513, 478]);
  assert.deepEqual([after.date, after.total, after.days], ['2028-02-26', 513, 478]);
});
