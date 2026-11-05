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
import { movingAverage, trendChart, dayIndex, dayLabel, TREND_DAYS } from '../client/weight.js';
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
  assert.equal(trendChart({ weights: [], today: T, spec: null }), null);
});
test('圖表模型：只有今天一筆——一個點，x 軸至少 6 天寬，y 軸 78–82 整數刻度，無 NaN', () => {
  const m = trendChart({ weights: [rec(T, 80)], today: T, spec: null });
  assert.equal(m.x1 - m.x0, 6);
  assert.deepEqual(m.points.map(p => p.kg), [80]);
  assert.deepEqual(m.avg.map(p => p.avg), [80]);
  assert.equal(m.plan, null);
  assert.deepEqual(m.y, { min: 78, max: 82, ticks: [78, 79, 80, 81, 82] });
  assert.equal(m.summary, '近 90 天體重：最新 80 公斤，7 天平均 80.0 公斤');
});
test('圖表模型：所有體重相同，y 軸仍有高度', () => {
  const m = trendChart({ weights: [rec('2026-11-01', 75), rec(T, 75)], today: T, spec: null });
  assert.deepEqual(m.y, { min: 73, max: 77, ticks: [73, 74, 75, 76, 77] });
});
test('圖表模型：x 軸從最早一筆到今天，不留空白；2 筆資料', () => {
  const m = trendChart({ weights: [rec('2026-10-20', 84), rec('2026-11-02', 82)], today: T, spec: null });
  assert.equal(m.x1 - m.x0, 16);
  assert.equal(dayLabel(m.x0), '10/20');
  assert.equal(dayLabel(m.x1), '11/5');
});
test('圖表模型：近 90 天——第 89 天前算、第 90 天前不畫點，但仍參與平均；刻度為整數公斤', () => {
  const m = trendChart({ weights: [rec('2026-08-07', 95), rec('2026-08-08', 90), rec(T, 82)], today: T, spec: null });
  assert.deepEqual(m.points.map(p => p.day), ['2026-08-08', T]);
  assert.equal(m.x1 - m.x0, 89);
  assert.equal(m.avg[0].avg, 92.5); // 08/08 的窗口含 08/07
  assert.deepEqual(m.y, { min: 80, max: 95, ticks: [80, 85, 90, 95] });
});
test('圖表模型：目前體重文字用最新原始值、7 天平均另列', () => {
  const m = trendChart({ weights: [rec('2026-11-04', 80), rec(T, 79)], today: T, spec: null });
  assert.equal(m.summary, '近 90 天體重：最新 79 公斤，7 天平均 79.5 公斤');
});
test('圖表模型：計劃線從開始日起點直線下降（範圍外的部分截到今天）', () => {
  const spec = { startDay: '2026-10-06', startKg: 90, targetKg: 60, weekly: 0.41 };
  const m = trendChart({ weights: [rec('2026-10-06', 90), rec(T, 89)], today: T, spec });
  assert.deepEqual(m.plan.map(p => [p.x - m.x0, Math.round(p.kg * 100) / 100]), [[0, 90], [30, 88.24]]);
});
test('圖表模型：計劃線到達目標後在到達日截止', () => {
  const spec = { startDay: '2026-10-06', startKg: 90, targetKg: 88, weekly: 0.87 };
  const m = trendChart({ weights: [rec('2026-10-06', 90), rec(T, 89)], today: T, spec });
  assert.equal(m.plan[1].kg, 88);
  assert.equal(Math.round((m.plan[1].x - m.plan[0].x) * 100) / 100, 16.09);
});
test('圖表模型：計劃開始日比最早紀錄早時 x 軸涵蓋計劃線起點；計劃線不撐大不相干的 y 軸', () => {
  const spec = { startDay: '2026-10-01', startKg: 90, targetKg: 60, weekly: 0.41 };
  const m = trendChart({ weights: [rec('2026-10-20', 88), rec(T, 87)], today: T, spec });
  assert.equal(dayLabel(m.x0), '10/1');
  assert.ok(m.y.min > 80); // 目標 60 公斤不在視窗內，不納入
});
