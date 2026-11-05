// 每日營養目標建議值（ADR 0010「目標與提示」，依國健署 DRIs 第八版與國民飲食指標）。純函式，伺服器與前端共用。
// type：min 下限、range 範圍、max 上限。建議值不存，每次依計劃與每日熱量目標即時計算；設定只存覆寫值。
// limit：覆寫值允許的範圍（伺服器驗證用）。
import { readOptions, validKg } from './options.js';
export const NUTRIENT_GOALS = [
  { total: 'protein', label: '蛋白質', unit: 'g', type: 'min', limit: [1, 500],
    basis: '每公斤體重 1.1 g（71 歲以上 1.2 g）', source: '國健署 DRIs 第八版 蛋白質 RDA' },
  { total: 'fat', label: '脂肪', unit: 'g', type: 'range', limit: [1, 500],
    basis: '每日熱量的 20～30%（每 g 9 kcal）', source: '國健署 DRIs 第八版 脂質 AMDR' },
  { total: 'carbs', label: '碳水化合物', unit: 'g', type: 'range', limit: [1, 1500],
    basis: '每日熱量的 50～65%（每 g 4 kcal）', source: '國健署 DRIs 第八版 碳水化合物 AMDR' },
  { total: 'sugar', label: '糖（總糖）', unit: 'g', type: 'max', limit: [1, 500],
    basis: '添加糖不超過每日熱量的 10%（每 g 4 kcal）', source: '國健署 國民飲食指標',
    note: '記錄的是總糖（含水果、牛奶的天然糖），用添加糖上限比對可能高估' },
  { total: 'sodiumMg', label: '鈉', unit: 'mg', type: 'max', limit: [100, 10000],
    basis: '每日少於 2,300 mg（約 6 g 鹽）', source: '國健署 DRIs 第八版 鈉 CDRR' },
];

// 赤字期蛋白質的說明（ADR 0012）：1.4 只有間接出處，如實寫明；附腎功能提醒。
const DEFICIT_PROTEIN = {
  basis: '減重期每公斤基準體重 1.4 g，且不低於 1.1 g（71 歲以上 1.2 g）× 起始與目前較大的體重；基準體重取起始與目前較大者，超過 BMI 25 對應體重的部分只計入三分之一',
  source: '間接依據：ISSN 立場聲明 1.4–2.0 g/kg 範圍下緣；調整體重依 ESPEN/UEG 指引；下限依國健署 DRIs 第八版 RDA',
  note: '腎功能不佳者請先諮詢醫師或營養師',
};
// 目標說明文字：赤字期的蛋白質換成 ADR 0012 的說明，其餘照 NUTRIENT_GOALS。
export function goalInfo(total, plan, current) {
  const { basis, source, note } = NUTRIENT_GOALS.find(g => g.total === total);
  if (total === 'protein' && inDeficit(plan, validKg(current) ?? plan?.weight)) return DEFICIT_PROTEIN;
  return { basis, source, ...(note ? { note } : {}) };
}

const kcalShare = (kcal, pct, perGram) => Number.isFinite(kcal) && kcal > 0 ? Math.round(kcal * pct / perGram) : null;

// 減重計劃進行中（ADR 0012）：有計劃且目前體重 > 目標體重。
const inDeficit = (plan, current) => Number.isFinite(plan?.weight) && plan.weight > 0 && Number.isFinite(current) && current > plan.target;

// 蛋白質下限（ADR 0010、0012）。plan.weight 是起始體重，current 是目前體重。
function proteinMin(plan, current) {
  const weight = Number.isFinite(plan?.weight) && plan.weight > 0 ? plan.weight : null;
  if (!weight || !(Number.isFinite(current) && current > 0)) return null;
  const rda = plan.age >= 71 ? 1.2 : 1.1;
  if (!inDeficit(plan, current)) return Math.round(current * rda);
  const actual = Math.max(weight, current), ref = 25 * (plan.height / 100) ** 2;
  const base = actual <= ref ? actual : ref + 0.33 * (actual - ref);
  return Math.round(Math.max(1.4 * base, rda * actual));
}

// plan 可為 null（沒有計劃）：依賴體重的蛋白質為 null，其餘只看每日熱量目標 kcal。current：伺服器提供的目前體重（公斤），省略或無效時用計劃體重。
export function suggestedGoals(plan, kcal, current) {
  return {
    protein: { type: 'min', min: proteinMin(plan, validKg(current) ?? plan?.weight) },
    fat: { type: 'range', min: kcalShare(kcal, 0.2, 9), max: kcalShare(kcal, 0.3, 9) },
    carbs: { type: 'range', min: kcalShare(kcal, 0.5, 4), max: kcalShare(kcal, 0.65, 4) },
    sugar: { type: 'max', max: kcalShare(kcal, 0.1, 4) },
    sodiumMg: { type: 'max', max: 2300 },
  };
}

// 當日狀態（ADR 0010「目標與提示」）：只在有把握時提示。total = { known, unknown }（未知是項目數），goal = { type, min, max }。
// ok 達標、low 不足、maybeLow 可能不足、outOfRange 超出範圍、over 超標、unknown 無法判斷（不提示）。
// 未知項目只會讓真實總量變大：已知超過上限一定超標；已知未達下限時有未知只能說「可能」不足。
// 有未知項目且已知未超上限時，上方是否超過無從得知，所以有上限的目標（上限、範圍）不說達標。
export function goalStatus(total, goal) {
  const { known, unknown } = total || {}; const lo = goal?.min ?? null, hi = goal?.max ?? null;
  if (!goal || !Number.isFinite(known) || (goal.type === 'min' ? lo : goal.type === 'max' ? hi : lo ?? hi) === null) return 'unknown';
  if (goal.type !== 'min' && hi !== null && known > hi) return goal.type === 'max' ? 'over' : 'outOfRange';
  if (goal.type !== 'max' && lo !== null && known < lo) return unknown > 0 ? 'maybeLow' : 'low';
  return unknown > 0 && hi !== null ? 'unknown' : 'ok';
}
export const GOAL_STATUS_TEXT = { ok: '達標', low: '不足', maybeLow: '可能不足', outOfRange: '超出範圍', over: '超標', unknown: '' };

// 選項 { current, overrides }：current 是目前體重，省略、尚未載入或無效時用計劃體重（與 planGoal 一致）。
// 實際目標 = 覆寫值 ?? 建議值；覆寫以整項為單位（範圍型 min、max 一起覆寫）。
export function nutrientGoals(plan, kcal, options) {
  const { current, overrides = {} } = readOptions('nutrientGoals', options, ['current', 'overrides']);
  const suggested = suggestedGoals(plan, kcal, current);
  return Object.fromEntries(NUTRIENT_GOALS.map(({ total }) => {
    const { type, ...values } = suggested[total]; const own = overrides?.[total];
    return [total, { type, ...(own || values), overridden: !!own, suggested: values }];
  }));
}
