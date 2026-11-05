// 體重紀錄的前端純函式（spec weight-tracking）；伺服器也 import 這裡的範圍常數。日期都是 YYYY-MM-DD 的日曆日，用 UTC 換算避免夏令時間影響。
export const WEIGHT_MIN = 25, WEIGHT_MAX = 300; // 體重（公斤）可接受的範圍，體重紀錄與減重計劃共用
export const STALE_DAYS = 7; // 超過這個天數沒記，卡片用提醒色

// 距離上次紀錄的日曆天數；沒有紀錄回傳 null。裝置時區落後伺服器時最新紀錄可能晚於「今天」，一律視為 0，不顯示負數。
export function daysSinceWeight(lastDay, today) {
  if (!lastDay) return null;
  return Math.max(0, Math.round((Date.parse(today) - Date.parse(lastDay)) / 864e5));
}
// 紀錄清單中最新的日期（不假設清單已排序）；沒有紀錄為 null。
export const latestWeightDay = list => list.reduce((max, w) => (!max || w.day > max ? w.day : max), null);
export const weightStale = days => days !== null && days > STALE_DAYS;
export const weightHint = days => days === null ? '還沒有體重紀錄，從今天開始記吧。' : days === 0 ? '今天已記錄' : `距離上次紀錄 ${days} 天`;

// 輸入檢查：{ ok, message }；message 只在有具體可改的問題時給（空白輸入不提示）。伺服器對一位小數以外的值會四捨五入，前端先擋掉。
export function weightCheck(kgText, day, today) {
  const text = kgText.trim();
  if (!text) return { ok: false, message: '' };
  if (!/^\d+(\.\d+)?$/.test(text)) return { ok: false, message: '請輸入數字。' };
  if (!/^\d+(\.\d)?$/.test(text)) return { ok: false, message: '體重最多一位小數。' };
  const kg = Number(text);
  if (kg < WEIGHT_MIN || kg > WEIGHT_MAX) return { ok: false, message: `請輸入 ${WEIGHT_MIN}–${WEIGHT_MAX} 公斤。` };
  if (day > today) return { ok: false, message: '不能記錄未來的日期。' };
  return { ok: true, message: '' };
}
