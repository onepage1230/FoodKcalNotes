import test from 'node:test';
import assert from 'node:assert/strict';
import { daysSinceWeight, STALE_DAYS } from '../client/weight.js';

test('距離上次紀錄：同一天為 0，跨月、跨年照日曆天數算；沒有紀錄為 null', () => {
  assert.equal(daysSinceWeight('2026-11-05', '2026-11-05'), 0);
  assert.equal(daysSinceWeight('2026-11-01', '2026-11-05'), 4);
  assert.equal(daysSinceWeight('2026-10-30', '2026-11-05'), 6);
  assert.equal(daysSinceWeight('2025-12-30', '2026-01-02'), 3);
  assert.equal(daysSinceWeight(null, '2026-11-05'), null);
});
test('提醒門檻：超過 7 天才算久沒量', () => {
  assert.equal(STALE_DAYS, 7);
  assert.equal(daysSinceWeight('2026-10-29', '2026-11-05') > STALE_DAYS, false); // 剛好 7 天
  assert.equal(daysSinceWeight('2026-10-28', '2026-11-05') > STALE_DAYS, true);
});
