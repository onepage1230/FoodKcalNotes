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
import { dayIndex } from './dates.js';
import { planLineKg, planLineEndX } from './plan-line.js';
export const TREND_DAYS = 90; // 圖預設顯示近幾天（含今天）；紀錄清單不受影響
export const AVG_DAYS = 7; // 移動平均窗口：該日與前 AVG_DAYS − 1 天
const MIN_SPAN_DAYS = 6; // x 軸最少寬度（天），只有一兩筆時圖仍有寬度
const Y_MIN_HEIGHT = 4, Y_PAD = Y_MIN_HEIGHT / 2; // y 軸最小高度（公斤）；不足時以中心上下各擴 Y_PAD
const Y_STEPS = [1, 2, 5, 10, 20, 50], Y_STEP_LAST = 100, Y_MAX_INTERVALS = 5; // y 軸刻度步長候選（公斤）、都不合時的備用步長、刻度間隔最多幾格
const round2 = n => Math.round(n * 100) / 100;

// 圖的文案只在這裡組：圖例、摘要（aria-label／<title>）共用。
export const TREND_LABELS = { raw: '每日體重', avg: `${AVG_DAYS} 天平均`, plan: '計劃線', range: `近 ${TREND_DAYS} 天` };
export const TREND_NOTICE_OLD = `${TREND_LABELS.range}沒有體重紀錄，下方清單可看較早的紀錄。`;
// 摘要：planNote 是計劃卡片同一組數字的計劃句（plan.js 的 planTrendNote），沒有計劃線為 null。
export const trendSummary = (m, planNote) => `${TREND_LABELS.range}體重：最新 ${m.last.kg} 公斤，${TREND_LABELS.avg} ${m.last.avg.toFixed(1)} 公斤${planNote ? '。' + planNote : ''}`;
// 圖的區塊該顯示什麼：empty 沒有任何紀錄（卡片已有既有提示）、old 有紀錄但全部早於近 TREND_DAYS 天（圖是 null，要補說明）、chart 畫圖。m 是 trendChart 的結果。
export const trendState = (weights, m) => !weights.length ? 'empty' : m ? 'chart' : 'old';

// 移動平均（AVG_DAYS 天）：對每個有紀錄的日子，取該日與前 AVG_DAYS − 1 個日曆日內所有紀錄的平均（缺日不補值）。回傳依日期排序的 [{ day, kg, avg }]，avg 到兩位小數；不改動輸入。
export function movingAverage(list) {
  const sorted = [...list].sort((a, b) => a.day < b.day ? -1 : a.day > b.day ? 1 : 0), idx = sorted.map(w => dayIndex(w.day));
  return sorted.map((w, i) => {
    const inWindow = sorted.filter((_, j) => j <= i && idx[j] > idx[i] - AVG_DAYS);
    return { day: w.day, kg: w.kg, avg: round2(inWindow.reduce((s, v) => s + v.kg, 0) / inWindow.length) };
  });
}

// y 軸：整數公斤刻度。範圍小於 Y_MIN_HEIGHT 時以中心擴成該高度（所有體重相同也有高度）；挑最小的步長使刻度間隔不超過 Y_MAX_INTERVALS 格。
function yAxis(values) {
  let lo = Math.min(...values), hi = Math.max(...values);
  if (hi - lo < Y_MIN_HEIGHT) { const mid = (lo + hi) / 2; lo = mid - Y_PAD; hi = mid + Y_PAD; }
  const step = Y_STEPS.find(s => Math.ceil(hi / s) - Math.floor(lo / s) <= Y_MAX_INTERVALS) ?? Y_STEP_LAST;
  const min = Math.floor(lo / step) * step, max = Math.ceil(hi / step) * step, ticks = [];
  for (let t = min; t <= max; t += step) ticks.push(t);
  return { min, max, ticks };
}

// 趨勢圖的資料模型（純函式，SVG 只負責換算成像素）。weights 是全部紀錄；planLine 是 planLineSpec 的結果或 null；today 是前端今天。
// 只畫近 TREND_DAYS 天（平均仍用全部紀錄算）；x 軸從最早一筆（有計劃線時含開始日，若在範圍內）到今天，至少 MIN_SPAN_DAYS 天寬。沒有可畫的紀錄回傳 null（trendState 區分沒有紀錄與全部太舊）。
// 計劃線只畫 x 範圍內的部分，到達目標後在到達日截止，與計劃卡片用 plan-line.js 同一份算法；y 軸只計入實際畫出的點與線。last 是最新一筆的原始值與其移動平均（摘要用）。
export function trendChart({ weights, today, planLine }) {
  const t = dayIndex(today), from = t - (TREND_DAYS - 1);
  const avgAll = movingAverage(weights), vis = avgAll.filter(p => dayIndex(p.day) >= from);
  if (!vis.length) return null;
  const points = vis.map(p => ({ x: dayIndex(p.day), day: p.day, kg: p.kg })), avg = vis.map(p => ({ x: dayIndex(p.day), day: p.day, avg: p.avg }));
  const x1 = Math.max(t, points[points.length - 1].x), startX = planLine ? dayIndex(planLine.startDay) : null;
  let x0 = Math.min(points[0].x, startX !== null && startX >= from ? startX : Infinity);
  if (x1 - x0 < MIN_SPAN_DAYS) x0 = x1 - MIN_SPAN_DAYS;
  let plan = null;
  if (planLine) {
    const a = Math.max(startX, x0), b = Math.min(planLineEndX(planLine), x1);
    if (a <= b && startX <= x1) plan = [{ x: a, kg: planLineKg(planLine, a) }, { x: b, kg: planLineKg(planLine, b) }];
  }
  const y = yAxis([...points.map(p => p.kg), ...avg.map(p => p.avg), ...(plan ? plan.map(p => p.kg) : [])]);
  return { x0, x1, points, avg, plan, y, last: { kg: points[points.length - 1].kg, avg: avg[avg.length - 1].avg } };
}
