// 體重紀錄的前端純函式（spec weight-tracking）。日期都是 YYYY-MM-DD 的日曆日，用 UTC 換算避免夏令時間影響。
export const STALE_DAYS = 7; // 超過這個天數沒記，卡片用提醒色

// 距離上次紀錄的日曆天數；沒有紀錄回傳 null。
export function daysSinceWeight(lastDay, today) {
  if (!lastDay) return null;
  return Math.round((Date.parse(today) - Date.parse(lastDay)) / 864e5);
}
