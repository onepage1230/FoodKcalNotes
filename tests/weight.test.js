import test from 'node:test';
import assert from 'node:assert/strict';
import { daysSinceWeight, latestWeightDay, weightStale, weightHint, weightCheck, WEIGHT_MIN, WEIGHT_MAX } from '../client/weight.js';

test('距離上次紀錄：同一天為 0，跨月、跨年照日曆天數算；沒有紀錄為 null', () => {
  assert.equal(daysSinceWeight('2026-11-05', '2026-11-05'), 0);
  assert.equal(daysSinceWeight('2026-11-01', '2026-11-05'), 4);
  assert.equal(daysSinceWeight('2026-10-30', '2026-11-05'), 6);
  assert.equal(daysSinceWeight('2025-12-30', '2026-01-02'), 3);
  assert.equal(daysSinceWeight(null, '2026-11-05'), null);
});
test('距離上次紀錄：最新紀錄晚於前端今天（時區落後）不回負數，視同今天', () => {
  assert.equal(daysSinceWeight('2026-11-06', '2026-11-05'), 0);
  assert.equal(weightHint(daysSinceWeight('2026-11-06', '2026-11-05')), '今天已記錄');
});
test('提醒色：超過 7 天才算久沒量（7 天不算、8 天算），沒有紀錄不算', () => {
  assert.equal(weightStale(daysSinceWeight('2026-10-29', '2026-11-05')), false);
  assert.equal(weightStale(daysSinceWeight('2026-10-28', '2026-11-05')), true);
  assert.equal(weightStale(null), false);
});
test('提示文案：沒有紀錄／今天已記錄／距離上次 N 天', () => {
  assert.equal(weightHint(null), '還沒有體重紀錄，從今天開始記吧。');
  assert.equal(weightHint(0), '今天已記錄');
  assert.equal(weightHint(3), '距離上次紀錄 3 天');
});
test('最新紀錄日期不依賴清單排序', () => {
  assert.equal(latestWeightDay([{ day: '2026-11-03' }, { day: '2026-11-05' }, { day: '2026-11-01' }]), '2026-11-05');
  assert.equal(latestWeightDay([]), null);
});
test('輸入檢查：範圍、最多一位小數、不得未來；錯誤時給簡短提示', () => {
  const check = (kg, day = '2026-11-05') => weightCheck(kg, day, '2026-11-05');
  assert.equal(check('70').ok, true); assert.equal(check(' 70.2 ').ok, true); assert.equal(check(String(WEIGHT_MIN)).ok, true); assert.equal(check(String(WEIGHT_MAX)).ok, true);
  assert.equal(check('').ok, false); assert.equal(check('').message, '');
  assert.equal(check('abc').ok, false); assert.equal(check('24.9').ok, false); assert.equal(check('300.1').ok, false);
  const two = check('70.25'); assert.equal(two.ok, false); assert.match(two.message, /一位小數/);
  assert.equal(check('70', '2026-11-06').ok, false); assert.match(check('70', '2026-11-06').message, /未來/);
});

test('latest：只有最後一次開始的請求算數，較早的回應晚到會被丟棄', async () => {
  const { latest } = await import('../client/latest.js');
  const seq = latest();
  const a = seq.begin(), b = seq.begin();
  assert.equal(seq.isCurrent(a), false);
  assert.equal(seq.isCurrent(b), true);
  seq.begin(); // 例如體重卡片本身更新了體重，之前尚未回來的請求作廢
  assert.equal(seq.isCurrent(b), false);
});

// ---- 趨勢圖（ticket 04）：移動平均、圖表模型 ----
import { movingAverage, trendChart, trendSummary, trendState, TREND_LABELS, TREND_NOTICE_OLD, TREND_DAYS, AVG_DAYS } from '../client/weight.js';
import { dayIndex, dayLabel } from '../client/dates.js';
const rec = (day, kg) => ({ day, kg });

test('7 天移動平均：只有一筆就是它自己', () => {
  assert.deepEqual(movingAverage([rec('2026-11-05', 80)]), [{ day: '2026-11-05', kg: 80, avg: 80 }]);
  assert.deepEqual(movingAverage([]), []);
});
test('7 天移動平均：缺日不補值，只對有紀錄的日子算，取窗口內所有紀錄的平均', () => {
  const r = movingAverage([rec('2026-11-01', 82), rec('2026-11-04', 80), rec('2026-11-05', 79)]);
  assert.deepEqual(r.map(p => p.avg), [82, 81, 80.33]);
});
test('7 天移動平均：窗口邊界——前 6 天算，前 7 天不算', () => {
  const r = movingAverage([rec('2026-11-01', 70), rec('2026-11-07', 80), rec('2026-11-08', 90)]);
  assert.equal(r[1].avg, 75); // 11/07 的窗口是 11/01–11/07，含 11/01
  assert.equal(r[2].avg, 85); // 11/08 的窗口是 11/02–11/08，11/01 掉出，只剩 80 與 90
});
test('7 天移動平均：跨月、跨年照日曆日', () => {
  assert.equal(movingAverage([rec('2026-10-30', 81), rec('2026-11-02', 80)])[1].avg, 80.5);
  assert.equal(movingAverage([rec('2025-12-31', 80), rec('2026-01-03', 79)])[1].avg, 79.5);
});
test('7 天移動平均：輸入未排序也正確，輸出依日期排序且不改動輸入', () => {
  const input = [rec('2026-11-05', 79), rec('2026-11-01', 82), rec('2026-11-04', 80)];
  const r = movingAverage(input);
  assert.deepEqual(r.map(p => p.day), ['2026-11-01', '2026-11-04', '2026-11-05']);
  assert.deepEqual(r.map(p => p.avg), [82, 81, 80.33]);
  assert.equal(input[0].day, '2026-11-05');
});

test('日期工具：日期轉序號與標籤，跨月跨年連續', () => {
  assert.equal(dayIndex('2026-03-01') - dayIndex('2026-02-28'), 1);
  assert.equal(dayIndex('2026-01-01') - dayIndex('2025-12-31'), 1);
  assert.equal(dayLabel(dayIndex('2026-01-05')), '1/5');
  assert.equal(TREND_DAYS, 90);
});

const T = '2026-11-05';
test('圖表模型：沒有紀錄為 null（卡片顯示既有提示，不畫空圖）', () => {
  assert.equal(trendChart({ weights: [], today: T, planLine: null }), null);
});
test('圖表模型：只有今天一筆——一個點，x 軸至少 6 天寬，y 軸 78–82 整數刻度，無 NaN', () => {
  const m = trendChart({ weights: [rec(T, 80)], today: T, planLine: null });
  assert.equal(m.x1 - m.x0, 6);
  assert.deepEqual(m.points.map(p => p.kg), [80]);
  assert.deepEqual(m.avg.map(p => p.avg), [80]);
  assert.equal(m.plan, null);
  assert.deepEqual(m.y, { min: 78, max: 82, ticks: [78, 79, 80, 81, 82] });
  assert.equal(trendSummary(m, null), '近 90 天體重：最新 80 公斤，7 天平均 80.0 公斤');
});
test('圖表模型：所有體重相同，y 軸仍有高度', () => {
  const m = trendChart({ weights: [rec('2026-11-01', 75), rec(T, 75)], today: T, planLine: null });
  assert.deepEqual(m.y, { min: 73, max: 77, ticks: [73, 74, 75, 76, 77] });
});
test('圖表模型：x 軸從最早一筆到今天，不留空白；2 筆資料', () => {
  const m = trendChart({ weights: [rec('2026-10-20', 84), rec('2026-11-02', 82)], today: T, planLine: null });
  assert.equal(m.x1 - m.x0, 16);
  assert.equal(dayLabel(m.x0), '10/20');
  assert.equal(dayLabel(m.x1), '11/5');
});
test('圖表模型：近 90 天——第 89 天前算、第 90 天前不畫點，但仍參與平均；刻度為整數公斤', () => {
  const m = trendChart({ weights: [rec('2026-08-07', 95), rec('2026-08-08', 90), rec(T, 82)], today: T, planLine: null });
  assert.deepEqual(m.points.map(p => p.day), ['2026-08-08', T]);
  assert.equal(m.x1 - m.x0, 89);
  assert.equal(m.avg[0].avg, 92.5); // 08/08 的窗口含 08/07
  assert.deepEqual(m.y, { min: 80, max: 95, ticks: [80, 85, 90, 95] });
});
test('圖表模型：目前體重文字用最新原始值、7 天平均另列', () => {
  const m = trendChart({ weights: [rec('2026-11-04', 80), rec(T, 79)], today: T, planLine: null });
  assert.equal(trendSummary(m, null), '近 90 天體重：最新 79 公斤，7 天平均 79.5 公斤');
});
test('圖表模型：計劃線從開始日起點直線下降（範圍外的部分截到今天）', () => {
  const planLine = { startDay: '2026-10-06', startKg: 90, targetKg: 60, weekly: 0.41 };
  const m = trendChart({ weights: [rec('2026-10-06', 90), rec(T, 89)], today: T, planLine });
  assert.deepEqual(m.plan.map(p => [p.x - m.x0, Math.round(p.kg * 100) / 100]), [[0, 90], [30, 88.24]]);
});
test('圖表模型：計劃線到達目標後在到達日截止', () => {
  const planLine = { startDay: '2026-10-06', startKg: 90, targetKg: 88, weekly: 0.87 };
  const m = trendChart({ weights: [rec('2026-10-06', 90), rec(T, 89)], today: T, planLine });
  assert.equal(m.plan[1].kg, 88);
  assert.equal(Math.round((m.plan[1].x - m.plan[0].x) * 100) / 100, 16.09);
});
test('圖表模型：計劃開始日比最早紀錄早時 x 軸涵蓋計劃線起點；計劃線不撐大不相干的 y 軸', () => {
  const planLine = { startDay: '2026-10-01', startKg: 90, targetKg: 60, weekly: 0.41 };
  const m = trendChart({ weights: [rec('2026-10-20', 88), rec(T, 87)], today: T, planLine });
  assert.equal(dayLabel(m.x0), '10/1');
  assert.ok(m.y.min > 80); // 目標 60 公斤不在視窗內，不納入
});

// ---- 趨勢圖補測（review T8）：y 軸步長、小數、計劃線範圍外、未排序／晚於今天 ----
const two = (a, b) => trendChart({ weights: [rec('2026-10-30', a), rec(T, b)], today: T, planLine: null }).y;
test('y 軸步長：1／2／5／10／20／50 各一個代表案例；恰好 5 格仍用較小的步長，6 格才換大一級', () => {
  assert.deepEqual(two(80, 84), { min: 80, max: 84, ticks: [80, 81, 82, 83, 84] }); // 步長 1
  assert.deepEqual(two(80, 85), { min: 80, max: 85, ticks: [80, 81, 82, 83, 84, 85] }); // 步長 1，恰好 5 格
  assert.deepEqual(two(80, 86), { min: 80, max: 86, ticks: [80, 82, 84, 86] }); // 6 格 → 步長 2
  assert.deepEqual(two(80, 90), { min: 80, max: 90, ticks: [80, 82, 84, 86, 88, 90] }); // 步長 2，恰好 5 格
  assert.deepEqual(two(80, 92), { min: 80, max: 95, ticks: [80, 85, 90, 95] }); // 步長 5
  assert.deepEqual(two(80, 120), { min: 80, max: 120, ticks: [80, 90, 100, 110, 120] }); // 步長 10
  assert.deepEqual(two(40, 120), { min: 40, max: 120, ticks: [40, 60, 80, 100, 120] }); // 步長 20
  assert.deepEqual(two(40, 160), { min: 0, max: 200, ticks: [0, 50, 100, 150, 200] }); // 步長 50
});
test('y 軸小數：均值 75.3 的中心 ±2 取整刻度；移動平均 round2 的浮點結果', () => {
  const flat = trendChart({ weights: [rec('2026-11-04', 75.3), rec(T, 75.3)], today: T, planLine: null });
  assert.deepEqual(flat.y, { min: 73, max: 78, ticks: [73, 74, 75, 76, 77, 78] }); // 73.3–77.3
  const m = trendChart({ weights: [rec('2026-11-03', 75.3), rec('2026-11-04', 75.4), rec(T, 75.4)], today: T, planLine: null });
  assert.deepEqual(m.avg.map(p => p.avg), [75.3, 75.35, 75.37]);
  assert.deepEqual(m.y, { min: 73, max: 78, ticks: [73, 74, 75, 76, 77, 78] });
});
test('計劃線 null 分支：到達日早於 x 軸起點、開始日在未來；開始日早於近 90 天時從 x0 的線上值接起', () => {
  const ws = [rec('2026-10-20', 88), rec(T, 87)];
  assert.equal(trendChart({ weights: ws, today: T, planLine: { startDay: '2026-01-01', startKg: 90, targetKg: 88, weekly: 7 } }).plan, null); // 1/3 就到達
  assert.equal(trendChart({ weights: ws, today: T, planLine: { startDay: '2026-11-20', startKg: 90, targetKg: 60, weekly: 0.41 } }).plan, null);
  const m = trendChart({ weights: ws, today: T, planLine: { startDay: '2026-01-01', startKg: 90, targetKg: 60, weekly: 0.41 } });
  assert.equal(m.plan[0].x, m.x0);
  assert.deepEqual(m.plan.map(p => Math.round(p.kg * 100) / 100), [72.9, 71.96]); // 90 − 0.41 × 292 ÷ 7、× 308 ÷ 7
  assert.equal(m.y.min, 70);
});
test('圖表模型：weights 未排序結果相同；紀錄晚於今天（時區落後）時 x1 取最新一筆', () => {
  const sorted = trendChart({ weights: [rec('2026-11-01', 82), rec(T, 80)], today: T, planLine: null });
  assert.deepEqual(trendChart({ weights: [rec(T, 80), rec('2026-11-01', 82)], today: T, planLine: null }), sorted);
  const m = trendChart({ weights: [rec('2026-11-01', 82), rec('2026-11-08', 80)], today: T, planLine: null });
  assert.equal(dayLabel(m.x1), '11/8');
  assert.equal(dayLabel(m.x0), '11/1');
  const one = trendChart({ weights: [rec('2026-11-08', 80)], today: T, planLine: null });
  assert.equal(one.x1 - one.x0, 6);
  assert.equal(dayLabel(one.x1), '11/8');
});

// ---- review T3／P1／P2：文案集中、圖的三種狀態、摘要的計劃句 ----
test('圖文案集中一處：圖例標籤與摘要都由 AVG_DAYS、TREND_DAYS 組成', () => {
  assert.deepEqual(TREND_LABELS, { raw: '每日體重', avg: '7 天平均', plan: '計劃線', range: '近 90 天' });
  assert.equal(AVG_DAYS, 7);
  const m = trendChart({ weights: [rec(T, 80)], today: T, planLine: null });
  assert.equal(trendSummary(m, null), `${TREND_LABELS.range}體重：最新 80 公斤，${TREND_LABELS.avg} 80.0 公斤`);
});
test('摘要的計劃句：有計劃線才附加，沒有就不提', () => {
  const m = trendChart({ weights: [rec(T, 80)], today: T, planLine: null });
  assert.equal(trendSummary(m, '計劃線：預計 2026.12.20 達成；實際比計劃線高 1.2 公斤'), '近 90 天體重：最新 80 公斤，7 天平均 80.0 公斤。計劃線：預計 2026.12.20 達成；實際比計劃線高 1.2 公斤');
  assert.ok(!trendSummary(m, null).includes('計劃'));
});
test('圖的狀態：沒有紀錄／全部早於近 90 天／有圖；只有「全部太舊」給提示', () => {
  const old = [rec('2026-01-10', 90), rec('2026-08-07', 88)]; // 08/07 是第 91 天前
  assert.equal(trendState([], trendChart({ weights: [], today: T, planLine: null })), 'empty');
  assert.equal(trendState(old, trendChart({ weights: old, today: T, planLine: null })), 'old');
  const ok = [...old, rec('2026-08-08', 87)];
  assert.equal(trendState(ok, trendChart({ weights: ok, today: T, planLine: null })), 'chart');
  assert.equal(TREND_NOTICE_OLD, '近 90 天沒有體重紀錄，下方清單可看較早的紀錄。');
});
