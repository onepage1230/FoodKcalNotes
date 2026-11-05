// 減重目標：Mifflin-St Jeor 估算 BMR/TDEE，以每日目標 goal 推算每週減重 weekly 與預計達成日
// （1 kg 脂肪 ≈ 7700 kcal）；total 為整個計劃的天數。
import { assertPlanContext } from './plan-context.js';
import { dayIndex } from './dates.js';
import { planLineKg } from './plan-line.js';
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ctx 是 planContext(plan, current)：目前體重用於 BMR、TDEE、最低攝取與每週減重量；沒有目前體重時 planContext 已退回計劃體重。
// 預計達成日與總天數仍以計劃的體重（起始體重）與起點每日目標（plan.startGoal；舊計劃沒有時退回目前每日目標 goal）推算（docs/specs/weight-tracking.md）；「已達標」（lose <= 0）看起始體重 ≤ 目標，
// 與 nutrient-goals.js 看目前體重的 inDeficit 基準不同、刻意分開。goal 永遠是使用者設定的每日熱量目標，不會被改動。
const energy = (plan, kg) => { const bmr = 10 * kg + 6.25 * plan.height - 5 * plan.age + (plan.sex === 'm' ? 5 : -161); return { bmr, tdee: bmr * plan.activity }; };
const weeklyLoss = (tdee, goal) => Math.round(Math.max(0, tdee - goal) * 7 / 7700 * 100) / 100;
// 原計劃的每週預計減重量：起始體重的 TDEE 減起點每日目標；之後改每日目標不影響它。
// 原計劃用的每日目標：起點每日目標 startGoal；舊計劃沒有時退回目前每日目標 goal（唯一的退回規則）。
export const effectiveStartGoal = (plan, goal) => plan.startGoal ?? goal;
const startWeekly = (plan, goal) => weeklyLoss(energy(plan, plan.weight).tdee, effectiveStartGoal(plan, goal));

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
// 沒有開始日的舊計劃視為重設起點：有紀錄時起始體重取最新紀錄（與紀錄連續），沒有紀錄時取表單體重。
export function planToSave({ saved, form, recordKg, today, goal }) {
  const weight = recordKg != null ? (saved?.startDate ? saved.weight : recordKg) : form.weight;
  if (saved?.startDate && weight === saved.weight) return { ...form, weight, startDate: saved.startDate, ...(saved.startGoal !== undefined && { startGoal: saved.startGoal }) };
  return { ...form, weight, startDate: today, startGoal: goal };
}
// 「重新開始計劃」：以目前體重（最新紀錄，沒有紀錄時是計劃體重）、今天與目前每日目標為新起點，其餘欄位不變。
export const restartPlan = ({ saved, currentKg, today, goal }) => ({ ...saved, weight: currentKg, startDate: today, startGoal: goal });

// 計劃線：從開始日的起始體重，依原計劃的每週預計減重量（起始體重的 TDEE 減起點每日目標）直線下降到目標，與預計達成日同一套語意。line 是最新紀錄日的計劃線體重，diff = 實際 − 計劃線，皆到一位小數；
// 沒有紀錄、沒有開始日、起始體重不高於目標或依起始體重不會減重時為 null。
const round1 = n => Math.round(n * 10) / 10;
// 計劃線的描述（趨勢圖與計劃卡片共用，只有這裡算）：{ startDay, startKg, targetKg, weekly }；沒有開始日、起始體重不高於目標或依起始體重不會減重時為 null。
export function planLineSpec(ctx, goal) {
  const { plan } = assertPlanContext('planLineSpec', ctx);
  if (!plan?.startDate || plan.weight - plan.target <= 0) return null;
  const weekly = startWeekly(plan, goal);
  return weekly ? { startDay: plan.startDate, startKg: plan.weight, targetKg: plan.target, weekly } : null;
}
// 某一天的計劃線體重（精確值，不四捨五入）：核心算法在 plan-line.js，趨勢圖共用。
export const planLineAt = (planLine, day) => planLineKg(planLine, dayIndex(day));
export function planProgress(ctx, goal, recordDay, today = new Date()) {
  const { plan, current } = assertPlanContext('planProgress', ctx), g = planGoal(ctx, goal, today), lose = plan.weight - plan.target;
  const kg = recordDay ? current : plan.weight;
  const planLine = recordDay ? planLineSpec(ctx, goal) : null;
  let line = null, diff = null;
  if (planLine) { const exact = planLineAt(planLine, recordDay); line = round1(exact); diff = round1(kg - exact); }
  // 達成判定每次即時看最新體重（沒有紀錄時看起始體重），不鎖定。
  if (kg <= plan.target) return { ...g, reached: true, pct: 100, line, diff };
  // 沒有紀錄時沿用以天數計算的舊進度（升級後不跳變）；起始體重不高於目標（lose ≤ 0）而目前高於目標時為 0，不除以 0。
  const pct = !recordDay ? (g.total ? Math.round((g.total - g.days) / g.total * 100) : 0)
    : lose > 0 ? Math.min(100, Math.max(0, Math.round((plan.weight - kg) / lose * 100))) : 0;
  return { ...g, reached: false, pct, line, diff };
}

// 計劃卡片的狀態與文案（純函式，JSX 只依 state 與這些字串渲染）。state：
// reached 已達成（最新體重 ≤ 目標，優先於其他狀態）、due 已過預計日期、noLoss 原計劃不會減重、regrown 起始體重已不高於目標而體重回升、active 進行中。
// 回傳 headline（大字：天數或文字）、showDays（天數後接「天」）、summary（一行摘要）、pct（有值才畫進度條）、diff（對照計劃線）、
// notes（提醒，tone：plain／muted／notice）、basis（依目前設定的 BMR／TDEE）、original（原計劃一行，舊計劃標明隨目前每日目標）。
const fmt = n => Math.round(n).toLocaleString('en-US');
const dot = s => s.replace(/-/g, '.');
const diffText = p => p.diff === 0 ? '實際與計劃線相同' : `實際比計劃線${p.diff > 0 ? '高' : '低'} ${Math.abs(p.diff).toFixed(1)} 公斤`; // 計劃卡片與趨勢圖摘要共用
// 趨勢圖摘要的計劃句（與計劃卡片同一組數字）；已達成、沒有計劃線或沒有預計達成日的部分不提，什麼都沒有為 null。
export function planTrendNote(p) {
  const parts = [];
  if (!p.reached && p.total > 0) parts.push(`預計 ${dot(p.date)} 達成`);
  if (!p.reached && p.diff !== null) parts.push(diffText(p));
  return parts.length ? `計劃線：${parts.join('；')}` : null;
}
export function planSummary({ progress: p, ctx, goal, recordDay }) {
  const { plan, current } = assertPlanContext('planSummary', ctx);
  const state = p.reached ? 'reached' : p.days === null ? 'noLoss' : p.days === 0 ? (p.total ? 'due' : 'regrown') : 'active';
  const notes = [];
  if (state === 'noLoss') notes.push({ tone: 'plain', text: `原計劃（每日 ${fmt(effectiveStartGoal(plan, goal))} kcal）不會減重，可按「重新開始計劃」` });
  if (state === 'regrown') notes.push({ tone: 'muted', text: '起始體重已不高於目標，可按「重新開始計劃」重設起點。' });
  if (!p.reached && p.total > 0 && p.weekly === 0) notes.push({ tone: 'notice', text: `照目前設定（${current} 公斤、每日 ${fmt(goal)} kcal）不會再減重；預計達成日是原計劃的推算。` });
  if (!p.reached && goal < p.floor) notes.push({ tone: 'notice', text: `每日目標低於建議最低攝取 ${fmt(p.floor)} kcal，長期可能流失肌肉、代謝下降` });
  return {
    state,
    headline: state === 'reached' ? '已達成目標' : state === 'due' ? '已到預計日期，請更新體重' : state === 'active' ? p.days : '—',
    showDays: state === 'active',
    summary: state === 'reached' ? `目前體重 ${current} 公斤，已達到目標 ${plan.target} 公斤` : p.total > 0 ? `原計劃預計 ${dot(p.date)} 達成 · ${p.pct}% 已完成` : null,
    pct: !p.reached && p.total > 0 ? p.pct : null,
    diff: !p.reached && p.diff !== null ? { text: diffText(p), note: `（${dot(recordDay)} 計劃線 ${p.line} 公斤）` } : null,
    notes,
    basis: `依目前設定（體重 ${current} 公斤）：基礎代謝 ${fmt(p.bmr)}、每日消耗約 ${fmt(p.tdee)} kcal${p.reached ? '（維持體重約需此熱量）' : p.weekly > 0 ? `，以目前每日目標 ${fmt(goal)} kcal 每週約減 ${p.weekly} 公斤` : ''}`,
    original: `原計劃：起始 ${plan.weight} 公斤${plan.startDate ? `（${dot(plan.startDate)} 開始）` : ''} → 目標 ${plan.target} 公斤 · 每日 ${fmt(effectiveStartGoal(plan, goal))} kcal${plan.startGoal === undefined ? '（舊計劃：隨目前每日目標）' : ''}`,
  };
}
// 計劃表單步驟 3 的預覽句（progress 是要儲存的計劃的 planProgress，startGoal 是它的 effectiveStartGoal）。
export const planPreviewText = (p, startGoal) => p.reached ? '已達成目標'
  : p.days === 0 ? (p.total ? '已到預計日期' : '起始體重已不高於目標')
  : p.days === null ? `原計劃每日 ${fmt(startGoal)} kcal 不會減重`
  : `原計劃每日 ${fmt(startGoal)} kcal：預計 ${p.days} 天後（${dot(p.date)}）達成`;
// 步驟 3 的儲存說明：起點被重設時預計達成日以目前每日目標為準；起點不變時，改了影響 TDEE 或總減重量的欄位會重新估算，否則沿用原計劃。
const ESTIMATE_FIELDS = ['sex', 'age', 'height', 'activity', 'target'];
export function planSaveNote({ saved, toSave }) {
  if (!saved || toSave.startDate !== saved.startDate) return '預計達成日以目前每日目標為起點固定，之後改每日目標不會改變它；可以先修改上方的「每日熱量目標」預覽。';
  return ESTIMATE_FIELDS.some(k => toSave[k] !== saved[k])
    ? '起始體重、開始日與起點每日目標不變，但改了性別、年齡、身高、活動量或目標體重，預計達成日會重新估算。'
    : '起點不變，預計達成日沿用原計劃；要依目前每日目標重算請用「重新開始計劃」。';
}
