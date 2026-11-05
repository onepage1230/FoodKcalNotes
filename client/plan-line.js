// 計劃線的核心算法（無依賴的底層模組）：趨勢圖（weight.js）與計劃卡片（plan.js）共用，算法只有這一份。
// planLine 是 plan.js 的 planLineSpec 結果：{ startDay, startKg, targetKg, weekly }；x 是 UTC 日序號（dates.js 的 dayIndex，可為小數）。
import { dayIndex } from './dates.js';
// 到達目標的日序號（可為小數）。
export const planLineEndX = planLine => dayIndex(planLine.startDay) + (planLine.startKg - planLine.targetKg) / planLine.weekly * 7;
// x 當天的計劃線體重（精確值，不四捨五入）：開始日之前取起始體重，到達日起固定為目標。
export const planLineKg = (planLine, x) => x >= planLineEndX(planLine) ? planLine.targetKg : planLine.startKg - planLine.weekly * Math.max(0, x - dayIndex(planLine.startDay)) / 7;
