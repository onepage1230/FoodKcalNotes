import test from 'node:test';
import assert from 'node:assert/strict';
import { planGoal, planProgress, planToSave, restartPlan, effectiveStartGoal, planSummary, planPreviewText, planSaveNote } from '../client/plan.js';
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
  const dated = { ...sample, startDate: '2026-10-03' };
  const g = planGoal(planContext(dated), 1300, new Date(2026, 9, 10));
  assert.equal(g.weekly, 0.27); assert.equal(g.total, 130); assert.equal(g.days, 123); assert.equal(g.date, '2027-02-10');
  const late = planGoal(planContext(dated), 1300, new Date(2027, 6, 1));
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
  db.updatePreferences({ plan: sample }, { today: '2026-10-03' }); assert.deepEqual(db.preferences().plan, sample);
  db.updatePreferences({ plan: { ...sample, rate: 0.5 } }, { today: '2026-10-03' }); assert.deepEqual(db.preferences().plan, sample); // 舊版 rate 忽略不存
  for (const bad of [{ activity: 1.3 }, { age: 9 }, { age: 30.5 }, { sex: 'x' }, { weight: '60' }, { target: 20 }])
    assert.throws(() => db.updatePreferences({ plan: { ...sample, ...bad } }, { today: '2026-10-03' }), e => e.status === 400 || e.statusCode === 400 || /減重目標/.test(e.message));
  assert.deepEqual(db.preferences().plan, sample);
  db.updatePreferences({ goal: 1500 }); assert.deepEqual(db.preferences().plan, sample);
  db.updatePreferences({ plan: null }); assert.equal(db.preferences().plan, null); db.close();
});
test('偏好 plan：儲存計劃必須由呼叫端提供伺服器今天（沒有時區備援）', () => {
  const db = createJournal(':memory:');
  assert.throws(() => db.updatePreferences({ plan: sample }), /today/);
  assert.equal(db.preferences().plan, null); db.close();
});
test('偏好 plan：startDate 可選，需為有效且不在未來的日期', () => {
  const db = createJournal(':memory:'); const dated = { ...sample, startDate: '2026-01-15' };
  db.updatePreferences({ plan: dated }, { today: '2026-10-03' }); assert.deepEqual(db.preferences().plan, dated);
  for (const startDate of ['2999-01-01', '2026-02-30', '2026/01/15', 20260115])
    assert.throws(() => db.updatePreferences({ plan: { ...sample, startDate } }, { today: '2026-10-03' }), e => e.status === 400);
  assert.deepEqual(db.preferences().plan, dated);
  db.updatePreferences({ plan: sample }, { today: '2026-10-03' }); assert.deepEqual(db.preferences().plan, sample); db.close();
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
  assert.deepEqual(planToSave({ saved: fixed, form, recordKg: 85, today: '2026-11-26', goal: 1700 }),
    { sex: 'f', age: 29, height: 166, weight: 90, target: 58, activity: 1.375, startDate: '2026-10-01', startGoal: 1500 });
});
test('planToSave：沒有紀錄時體重沒改就保留起點，改了體重視為重設起點（開始日今天、起點每日目標為目前每日目標）', () => {
  const same = { sex: 'f', age: 28, height: 165, weight: 90, target: 55, activity: 1.2 };
  assert.deepEqual(planToSave({ saved: fixed, form: same, recordKg: null, today: '2026-11-26', goal: 1700 }), { ...same, startDate: '2026-10-01', startGoal: 1500 });
  assert.deepEqual(planToSave({ saved: fixed, form: { ...same, weight: 88 }, recordKg: null, today: '2026-11-26', goal: 1700 }), { ...same, weight: 88, startDate: '2026-11-26', startGoal: 1700 });
});
test('planToSave：舊計劃沒有起點每日目標時，不動起點的儲存不補寫；重設起點才寫入', () => {
  const same = { sex: 'f', age: 28, height: 165, weight: 90, target: 55, activity: 1.375 };
  assert.deepEqual(planToSave({ saved: started, form: same, recordKg: null, today: '2026-11-26', goal: 1700 }), { ...same, startDate: '2026-10-01' });
  assert.deepEqual(planToSave({ saved: started, form: { ...same, weight: 88 }, recordKg: null, today: '2026-11-26', goal: 1700 }), { ...same, weight: 88, startDate: '2026-11-26', startGoal: 1700 });
});
test('planToSave：還沒有計劃時從今天開始並寫入目前每日目標；先記過體重則以最新紀錄為起始體重', () => {
  const form = { sex: 'f', age: 28, height: 165, weight: 70, target: 60, activity: 1.2 };
  assert.deepEqual(planToSave({ saved: null, form, recordKg: 85, today: '2026-11-26', goal: 1600 }), { ...form, weight: 85, startDate: '2026-11-26', startGoal: 1600 });
  assert.deepEqual(planToSave({ saved: null, form, recordKg: null, today: '2026-11-26', goal: 1600 }), { ...form, startDate: '2026-11-26', startGoal: 1600 });
});
test('restartPlan：以目前體重、今天與目前每日目標為新的起點，其餘欄位不變', () => {
  assert.deepEqual(restartPlan({ saved: fixed, currentKg: 85, today: '2026-11-26', goal: 1700 }),
    { sex: 'f', age: 28, height: 165, weight: 85, target: 60, activity: 1.2, startDate: '2026-11-26', startGoal: 1700 });
  assert.equal(restartPlan({ saved: started, currentKg: 85, today: '2026-11-26', goal: 1600 }).startGoal, 1600); // 舊計劃也寫入
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

test('effectiveStartGoal：有起點每日目標用它，舊計劃沒有時退回目前每日目標', () => {
  assert.equal(effectiveStartGoal(fixed, 1700), 1500);
  assert.equal(effectiveStartGoal(started, 1700), 1700);
});
test('planProgress：傳入的不是 planContext 時明確丟錯', () => {
  assert.throws(() => planProgress(started, 1500, null, nov26), /planContext/);
  assert.throws(() => planProgress({ plan: started, current: 85 }, 1500, null, nov26), /planContext/);
});
test('planToSave：沒有開始日的舊計劃儲存時視為重設起點（今天、目前體重、目前每日目標），有紀錄時起始體重取最新紀錄', () => {
  const legacy = { sex: 'f', age: 28, height: 165, weight: 90, target: 60, activity: 1.2 };
  const form = { ...legacy, activity: 1.375 };
  assert.deepEqual(planToSave({ saved: legacy, form, recordKg: 85, today: '2026-11-26', goal: 1700 }), { ...form, weight: 85, startDate: '2026-11-26', startGoal: 1700 });
  assert.deepEqual(planToSave({ saved: legacy, form, recordKg: null, today: '2026-11-26', goal: 1700 }), { ...form, startDate: '2026-11-26', startGoal: 1700 });
});

// planSummary：計劃卡片的狀態與文案（JSX 只依 state 與這些字串渲染）
const summaryOf = (plan, kg, goal, recordDay, now = nov26) => planSummary({ progress: planProgress(planContext(plan, kg), goal, recordDay, now), ctx: planContext(plan, kg), goal, recordDay });
test('planSummary：active 進行中（有紀錄）', () => {
  const s = summaryOf(fixed, 85, 1500, '2026-11-26');
  assert.equal(s.state, 'active'); assert.equal(s.headline, 457); assert.equal(s.showDays, true);
  assert.equal(s.summary, '原計劃預計 2028.02.26 達成 · 17% 已完成'); assert.equal(s.pct, 17);
  assert.deepEqual(s.diff, { text: '實際比計劃線低 1.7 公斤', note: '（2026.11.26 計劃線 86.7 公斤）' });
  assert.equal(s.basis, '依目前設定（體重 85 公斤）：基礎代謝 1,580、每日消耗約 1,896 kcal，以目前每日目標 1,500 kcal 每週約減 0.36 公斤');
  assert.equal(s.original, '原計劃：起始 90 公斤（2026.10.01 開始） → 目標 60 公斤 · 每日 1,500 kcal');
  assert.deepEqual(s.notes, [{ tone: 'notice', text: '每日目標低於建議最低攝取 1,580 kcal，長期可能流失肌肉、代謝下降' }]);
});
test('planSummary：沒有紀錄時沿用天數進度，沒有計劃線差距', () => {
  const s = summaryOf(started, undefined, 1500, null, new Date(2026, 10, 5));
  assert.equal(s.state, 'active'); assert.equal(s.headline, 478); assert.equal(s.summary, '原計劃預計 2028.02.26 達成 · 7% 已完成'); assert.equal(s.diff, null);
  assert.match(s.basis, /^依目前設定（體重 90 公斤）：基礎代謝 1,630、每日消耗約 1,956 kcal/);
});
test('planSummary：reached 已達成（含剛好同時已過預計日），不顯示倒數、進度條與最低攝取提醒', () => {
  const s = summaryOf(fixed, 58, 1500, '2026-11-26');
  assert.deepEqual([s.state, s.headline, s.showDays, s.pct, s.diff, s.notes], ['reached', '已達成目標', false, null, null, []]);
  assert.equal(s.summary, '目前體重 58 公斤，已達到目標 60 公斤');
  assert.equal(s.basis, '依目前設定（體重 58 公斤）：基礎代謝 1,310、每日消耗約 1,572 kcal（維持體重約需此熱量）');
  const late = summaryOf(fixed, 58, 1500, '2030-01-01', new Date(2030, 0, 1)); // days === 0 且 reached
  assert.deepEqual([late.state, late.headline, late.showDays], ['reached', '已達成目標', false]);
});
test('planSummary：due 已過預計日但尚未達成', () => {
  const s = summaryOf(fixed, 85, 1500, '2030-01-01', new Date(2030, 0, 1));
  assert.deepEqual([s.state, s.headline, s.showDays], ['due', '已到預計日期，請更新體重', false]);
  assert.equal(s.summary, '原計劃預計 2028.02.26 達成 · 17% 已完成');
});
test('planSummary：noLoss 依起始體重與起點每日目標不會減重', () => {
  const s = summaryOf({ ...fixed, startGoal: 2000 }, 85, 1500, '2026-11-26');
  assert.deepEqual([s.state, s.headline, s.showDays, s.summary, s.pct], ['noLoss', '—', false, null, null]);
  assert.deepEqual(s.notes[0], { tone: 'plain', text: '原計劃（每日 2,000 kcal）不會減重，可按「重新開始計劃」' });
});
test('planSummary：regrown 起始體重已不高於目標而體重回升到目標之上', () => {
  const s = summaryOf({ ...started, weight: 60 }, 62, 1500, '2026-11-26');
  assert.deepEqual([s.state, s.headline, s.showDays, s.summary, s.pct], ['regrown', '—', false, null, null]);
  assert.deepEqual(s.notes, [{ tone: 'muted', text: '起始體重已不高於目標，可按「重新開始計劃」重設起點。' }]);
});
test('planSummary：目前每日目標高於目前 TDEE 時提醒預計達成日只是原計劃', () => {
  const s = summaryOf(fixed, 85, 2000, '2026-11-26');
  assert.equal(s.state, 'active');
  assert.deepEqual(s.notes, [{ tone: 'notice', text: '照目前設定（85 公斤、每日 2,000 kcal）不會再減重；預計達成日是原計劃的推算。' }]);
  assert.match(s.basis, /^依目前設定（體重 85 公斤）：基礎代謝 1,580、每日消耗約 1,896 kcal$/);
});
test('planSummary：舊計劃沒有起點每日目標時，說明行標明隨目前每日目標；沒有開始日不顯示開始日', () => {
  assert.equal(summaryOf(started, 85, 1700, '2026-11-26').original, '原計劃：起始 90 公斤（2026.10.01 開始） → 目標 60 公斤 · 每日 1,700 kcal（舊計劃：隨目前每日目標）');
  assert.equal(summaryOf({ ...started, startDate: undefined }, 85, 1700, '2026-11-26').original, '原計劃：起始 90 公斤 → 目標 60 公斤 · 每日 1,700 kcal（舊計劃：隨目前每日目標）');
});
test('planSummary：傳入的不是 planContext 時丟錯', () => {
  const progress = planProgress(planContext(fixed, 85), 1500, null, nov26);
  assert.throws(() => planSummary({ progress, ctx: fixed, goal: 1500, recordDay: null }), /planContext/);
});
test('planPreviewText：計劃表單步驟 3 的預覽句', () => {
  const p = (plan, kg, goal, recordDay, now = nov26) => planPreviewText(planProgress(planContext(plan, kg), goal, recordDay, now), effectiveStartGoal(plan, goal));
  assert.equal(p(fixed, 85, 1500, '2026-11-26'), '原計劃每日 1,500 kcal：預計 457 天後（2028.02.26）達成');
  assert.equal(p(fixed, 58, 1500, '2026-11-26'), '已達成目標');
  assert.equal(p(fixed, 85, 1500, '2030-01-01', new Date(2030, 0, 1)), '已到預計日期');
  assert.equal(p({ ...started, weight: 60 }, 62, 1500, '2026-11-26'), '起始體重已不高於目標');
  assert.equal(p({ ...fixed, startGoal: 2000 }, 85, 1500, '2026-11-26'), '原計劃每日 2,000 kcal 不會減重');
});
test('planSaveNote：儲存計劃前說明預計達成日會不會變', () => {
  const resetNote = '預計達成日以目前每日目標為起點固定，之後改每日目標不會改變它；可以先修改上方的「每日熱量目標」預覽。';
  const form = { sex: 'f', age: 28, height: 165, weight: 90, target: 60, activity: 1.2 };
  const keep = { ...form, startDate: '2026-10-01', startGoal: 1500 };
  assert.equal(planSaveNote({ saved: null, toSave: { ...keep, startDate: '2026-11-26' } }), resetNote);
  assert.equal(planSaveNote({ saved: fixed, toSave: { ...keep, startDate: '2026-11-26' } }), resetNote); // 重設起點
  assert.equal(planSaveNote({ saved: fixed, toSave: keep }), '起點不變，預計達成日沿用原計劃；要依目前每日目標重算請用「重新開始計劃」。');
  const retune = '起始體重、開始日與起點每日目標不變，但改了性別、年齡、身高、活動量或目標體重，預計達成日會重新估算。';
  for (const patch of [{ activity: 1.375 }, { sex: 'm' }, { age: 29 }, { height: 170 }, { target: 58 }]) assert.equal(planSaveNote({ saved: fixed, toSave: { ...keep, ...patch } }), retune, JSON.stringify(patch));
});
