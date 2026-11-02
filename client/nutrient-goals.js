// 每日營養目標建議值（ADR 0010「目標與提示」，依國健署 DRIs 第八版與國民飲食指標）。純函式，伺服器與前端共用。
// type：min 下限、range 範圍、max 上限。建議值不存，每次依計劃與每日熱量目標即時計算；設定只存覆寫值。
// limit：覆寫值允許的範圍（伺服器驗證用）。
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

const kcalShare = (kcal, pct, perGram) => Number.isFinite(kcal) && kcal > 0 ? Math.round(kcal * pct / perGram) : null;

// plan 可為 null（沒有計劃）：依賴體重的蛋白質為 null，其餘只看每日熱量目標 kcal。
export function suggestedGoals(plan, kcal) {
  const weight = Number.isFinite(plan?.weight) && plan.weight > 0 ? plan.weight : null;
  return {
    protein: { type: 'min', min: weight && Math.round(weight * (plan.age >= 71 ? 1.2 : 1.1)) },
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

// 實際目標 = 覆寫值 ?? 建議值；覆寫以整項為單位（範圍型 min、max 一起覆寫）。
export function nutrientGoals(plan, kcal, overrides = {}) {
  const suggested = suggestedGoals(plan, kcal);
  return Object.fromEntries(NUTRIENT_GOALS.map(({ total }) => {
    const { type, ...values } = suggested[total]; const own = overrides?.[total];
    return [total, { type, ...(own || values), overridden: !!own, suggested: values }];
  }));
}
