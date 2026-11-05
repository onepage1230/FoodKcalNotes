// 日期工具（無依賴的底層模組）：日期都是 YYYY-MM-DD 的日曆日，用 UTC 換算避免夏令時間影響。
export const dayIndex = s => Date.parse(s) / 864e5; // YYYY-MM-DD → UTC 日序號（可為小數的 x 座標也沿用）
export const dayLabel = idx => { const d = new Date(idx * 864e5); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
