// 減重目標：Mifflin-St Jeor 估算 BMR/TDEE，以每日目標 goal 推算每週減重 weekly 與預計達成日
// （1 kg 脂肪 ≈ 7700 kcal）；total 為整個計劃的天數。
import { assertPlanContext } from './plan-context.js';
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ctx 是 planContext(plan, current)：目前體重用於 BMR、TDEE、最低攝取與每週減重量；沒有目前體重時 planContext 已退回計劃體重。
// 預計達成日與總天數仍以計劃的體重（起始體重）與起點每日目標（plan.startGoal；舊計劃沒有時退回目前每日目標 goal）推算（docs/specs/weight-tracking.md）；「已達標」（lose <= 0）看起始體重 ≤ 目標，
// 與 nutrient-goals.js 看目前體重的 inDeficit 基準不同、刻意分開。goal 永遠是使用者設定的每日熱量目標，不會被改動。
const energy = (plan, kg) => { const bmr = 10 * kg + 6.25 * plan.height - 5 * plan.age + (plan.sex === 'm' ? 5 : -161); return { bmr, tdee: bmr * plan.activity }; };
const weeklyLoss = (tdee, goal) => Math.round(Math.max(0, tdee - goal) * 7 / 7700 * 100) / 100;
// 原計劃的每週預計減重量：起始體重的 TDEE 減起點每日目標；之後改每日目標不影響它。
const startWeekly = (plan, goal) => weeklyLoss(energy(plan, plan.weight).tdee, plan.startGoal ?? goal);

export function planGoal(ctx, goal, today = new Date()) {
  const { plan, current } = assertPlanContext('planGoal', ctx);
  if (!(today instanceof Date)) throw new TypeError('planGoal：第三個參數是日期 Date（體重請放進 planContext）');
  const { bmr, tdee } = energy(plan, current);
  const floor = Math.max(bmr, plan.sex === 'm' ? 1500 : 1200);
  const result = { bmr: Math.round(bmr), tdee: Math.round(tdee), floor: Math.round(floor) };
  const lose = plan.weight - plan.target;
  if (lose <= 0) return { ...result, days: 0, date: ymd(today) };
  const weekly = weeklyLoss(tdee, goal), planWeekly = startWeekly(plan, goal);
  if (!planWeekly) return { ...result, weekly, days: null, date: null, total: null };
  // 有 startDate（已存計劃）時從開始日推算，剩餘天數才會每天倒數；沒有則從今天起算。
  const total = Math.ceil(lose / planWeekly * 7);
  const now = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const [y, m, d] = plan.startDate ? plan.startDate.split('-').map(Number) : [now.getFullYear(), now.getMonth() + 1, now.getDate()];
  const end = new Date(y, m - 1, d + total);
  return { ...result, weekly, days: Math.max(0, Math.round((end - now) / 864e5)), date: ymd(end), total };
}

// 計劃進度（spec weight-tracking）：recordDay 是最新一筆體重紀錄的日期，沒有紀錄為 null（此時 ctx.current 就是計劃體重）。
// 有紀錄時 pct =（起始體重 − 目前體重）÷（起始體重 − 目標體重），限制 0–100%。
// 儲存計劃表單（plan 的 weight 語意是起始體重）：saved 是已存計劃（可為 null），form 是表單數值，recordKg 是最新體重紀錄（沒有為 null），
// today 是 YYYY-MM-DD，goal 是目前每日目標。有紀錄時表單體重唯讀不採用：已有計劃保留起始體重，還沒有計劃以最新紀錄為起點。
// 起始體重沒變且有開始日就保留起點（開始日、起點每日目標原值；舊計劃沒有起點每日目標就維持沒有），否則重設起點：今天、目前每日目標。
export function planToSave(saved, form, recordKg, today, goal) {
  const weight = recordKg != null ? (saved ? saved.weight : recordKg) : form.weight;
  if (saved?.startDate && weight === saved.weight) return { ...form, weight, startDate: saved.startDate, ...(saved.startGoal !== undefined && { startGoal: saved.startGoal }) };
  return { ...form, weight, startDate: today, startGoal: goal };
}
// 「重新開始計劃」：以目前體重（最新紀錄，沒有紀錄時是計劃體重）、今天與目前每日目標為新起點，其餘欄位不變。
export const restartPlan = (saved, currentKg, today, goal) => ({ ...saved, weight: currentKg, startDate: today, startGoal: goal });

// 計劃線：從開始日的起始體重，依原計劃的每週預計減重量（起始體重的 TDEE 減起點每日目標）直線下降到目標，與預計達成日同一套語意。line 是最新紀錄日的計劃線體重，diff = 實際 − 計劃線，皆到一位小數；
// 沒有紀錄、沒有開始日、起始體重不高於目標或依起始體重不會減重時為 null。
const round1 = n => Math.round(n * 10) / 10;
const dayIndex = s => Date.parse(s) / 864e5;
export function planProgress(ctx, goal, recordDay, today = new Date()) {
  const g = planGoal(ctx, goal, today), { plan, current } = ctx, lose = plan.weight - plan.target;
  const kg = recordDay ? current : plan.weight;
  const planWeekly = lose > 0 ? startWeekly(plan, goal) : 0;
  let line = null, diff = null;
  if (recordDay && plan.startDate && planWeekly) {
    const exact = Math.max(plan.target, plan.weight - planWeekly * Math.max(0, dayIndex(recordDay) - dayIndex(plan.startDate)) / 7);
    line = round1(exact); diff = round1(kg - exact);
  }
  // 達成判定每次即時看最新體重（沒有紀錄時看起始體重），不鎖定。
  if (kg <= plan.target) return { ...g, reached: true, pct: 100, line, diff };
  // 沒有紀錄時沿用以天數計算的舊進度（升級後不跳變）；起始體重不高於目標（lose ≤ 0）而目前高於目標時為 0，不除以 0。
  const pct = !recordDay ? (g.total ? Math.round((g.total - g.days) / g.total * 100) : 0)
    : lose > 0 ? Math.min(100, Math.max(0, Math.round((plan.weight - kg) / lose * 100))) : 0;
  return { ...g, reached: false, pct, line, diff };
}
