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

// ---- 趨勢圖（ticket 04）----
export const TREND_DAYS = 90; // 圖預設顯示近幾天（含今天）；紀錄清單不受影響
export const AVG_DAYS = 7; // 移動平均窗口：該日與前 6 天
export const dayIndex = s => Date.parse(s) / 864e5; // YYYY-MM-DD → UTC 日序號（可為小數的 x 座標也沿用）
export const dayLabel = idx => { const d = new Date(idx * 864e5); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
const round2 = n => Math.round(n * 100) / 100;

// 7 天移動平均：對每個有紀錄的日子，取該日與前 6 個日曆日內所有紀錄的平均（缺日不補值）。回傳依日期排序的 [{ day, kg, avg }]，avg 到兩位小數；不改動輸入。
export function movingAverage(list) {
  const sorted = [...list].sort((a, b) => a.day < b.day ? -1 : a.day > b.day ? 1 : 0), idx = sorted.map(w => dayIndex(w.day));
  return sorted.map((w, i) => {
    const inWindow = sorted.filter((_, j) => j <= i && idx[j] > idx[i] - AVG_DAYS);
    return { day: w.day, kg: w.kg, avg: round2(inWindow.reduce((s, v) => s + v.kg, 0) / inWindow.length) };
  });
}

// y 軸：整數公斤刻度。範圍小於 4 公斤時以中心擴成 4 公斤（所有體重相同也有高度）；挑最小的步長 1/2/5/10/20/50 使刻度間隔不超過 5 格。
function yAxis(values) {
  let lo = Math.min(...values), hi = Math.max(...values);
  if (hi - lo < 4) { const mid = (lo + hi) / 2; lo = mid - 2; hi = mid + 2; }
  const step = [1, 2, 5, 10, 20, 50].find(s => Math.ceil(hi / s) - Math.floor(lo / s) <= 5) ?? 100;
  const min = Math.floor(lo / step) * step, max = Math.ceil(hi / step) * step, ticks = [];
  for (let t = min; t <= max; t += step) ticks.push(t);
  return { min, max, ticks };
}

// 趨勢圖的資料模型（純函式，SVG 只負責換算成像素）。weights 是全部紀錄；spec 是 planLineSpec 的結果或 null；today 是前端今天。
// 只畫近 TREND_DAYS 天（平均仍用全部紀錄算）；x 軸從最早一筆（有計劃線時含開始日，若在範圍內）到今天，至少 6 天寬。沒有紀錄回傳 null。
// 計劃線只畫 x 範圍內的部分，到達目標後在到達日截止；y 軸只計入實際畫出的點與線。
export function trendChart({ weights, today, spec }) {
  const t = dayIndex(today), from = t - (TREND_DAYS - 1);
  const avgAll = movingAverage(weights), vis = avgAll.filter(p => dayIndex(p.day) >= from);
  if (!vis.length) return null;
  const points = vis.map(p => ({ x: dayIndex(p.day), day: p.day, kg: p.kg })), avg = vis.map(p => ({ x: dayIndex(p.day), day: p.day, avg: p.avg }));
  const x1 = Math.max(t, points[points.length - 1].x), startX = spec ? dayIndex(spec.startDay) : null;
  let x0 = Math.min(points[0].x, startX !== null && startX >= from ? startX : Infinity);
  if (x1 - x0 < 6) x0 = x1 - 6;
  let plan = null;
  if (spec) {
    const endX = startX + (spec.startKg - spec.targetKg) / spec.weekly * 7, kgAt = x => x >= endX ? spec.targetKg : spec.startKg - spec.weekly * Math.max(0, x - startX) / 7;
    const a = Math.max(startX, x0), b = Math.min(endX, x1);
    if (a <= b && startX <= x1) plan = [{ x: a, kg: kgAt(a) }, { x: b, kg: kgAt(b) }];
  }
  const y = yAxis([...points.map(p => p.kg), ...avg.map(p => p.avg), ...(plan ? plan.map(p => p.kg) : [])]);
  const last = points[points.length - 1], lastAvg = avg[avg.length - 1];
  return { x0, x1, points, avg, plan, y, summary: `近 ${TREND_DAYS} 天體重：最新 ${last.kg} 公斤，7 天平均 ${lastAvg.avg.toFixed(1)} 公斤` };
}
