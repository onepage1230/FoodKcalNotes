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
