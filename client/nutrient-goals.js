// 每日營養目標建議值（ADR 0010「目標與提示」，依國健署 DRIs 第八版與國民飲食指標）。純函式，伺服器與前端共用。
// type：min 下限、range 範圍、max 上限。建議值不存，每次依計劃與每日熱量目標即時計算；設定只存覆寫值。
// limit：覆寫值允許的範圍（伺服器驗證用）。
import { assertPlanContext } from './plan-context.js';

// 蛋白質建議的係數（ADR 0010、0012）。說明文字與計算都從這組常數來，不在兩處各寫一份。
const RDA_G_PER_KG = 1.1, RDA_G_PER_KG_71 = 1.2; // 國健署 DRIs 第八版 RDA；71 歲以上較高
const DEFICIT_G_PER_KG = 1.4; // 減重期每公斤基準體重（只有間接出處，見 ADR 0012）
const REFERENCE_BMI = 25; // 參考體重 = BMI 25 對應的體重
const EXCESS_SHARE = 0.33; // 超過參考體重的部分只計入這個比例（ESPEN/UEG 調整體重係數）
export const NUTRIENT_GOALS = [
  { total: 'protein', label: '蛋白質', unit: 'g', type: 'min', limit: [1, 500],
    basis: `每公斤體重 ${RDA_G_PER_KG} g（71 歲以上 ${RDA_G_PER_KG_71} g）`, source: '國健署 DRIs 第八版 蛋白質 RDA' },
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
  basis: `減重期每公斤基準體重 ${DEFICIT_G_PER_KG} g，且不低於 ${RDA_G_PER_KG} g（71 歲以上 ${RDA_G_PER_KG_71} g）× 起始與目前較大的體重；基準體重取起始與目前較大者，超過 BMI ${REFERENCE_BMI} 對應體重的部分只計入 ${EXCESS_SHARE}（約三分之一）`,
  source: '間接依據：ISSN 立場聲明 1.4–2.0 g/kg 範圍下緣；調整體重依 ESPEN/UEG 指引；下限依國健署 DRIs 第八版 RDA',
  note: '腎功能不佳者請先諮詢醫師或營養師',
};
// 目標說明文字：赤字期的蛋白質換成 ADR 0012 的說明，其餘照 NUTRIENT_GOALS。ctx 是 planContext() 的結果。
export function goalInfo(total, ctx) {
  const { basis, source, note } = NUTRIENT_GOALS.find(g => g.total === total);
  if (total === 'protein' && inDeficit(assertPlanContext('goalInfo', ctx))) return DEFICIT_PROTEIN;
  return { basis, source, ...(note ? { note } : {}) };
}

const kcalShare = (kcal, pct, perGram) => Number.isFinite(kcal) && kcal > 0 ? Math.round(kcal * pct / perGram) : null;

// 減重計劃進行中（ADR 0012，營養目標用）：有計劃且「目前體重」> 目標體重，因為蛋白質下限要隨實際進度在達成後回到維持期。
// plan.js 的「已達標」（lose <= 0）則看「起始體重」≤ 目標，是計劃本身是否有東西要減；兩者基準不同、刻意分開（合併屬 docs/specs/weight-tracking.md 的後續範圍）。
const inDeficit = ({ plan, current }) => !!plan && current !== null && current > plan.target;

// 蛋白質下限（ADR 0010、0012）。plan.weight 是起始體重，current 是目前體重（planContext 已保證有效）。
function proteinMin({ plan, current }) {
  if (!plan) return null;
  const rdaPerKg = plan.age >= 71 ? RDA_G_PER_KG_71 : RDA_G_PER_KG;
  if (!inDeficit({ plan, current })) return Math.round(current * rdaPerKg);
  const actualKg = Math.max(plan.weight, current), referenceKg = REFERENCE_BMI * (plan.height / 100) ** 2;
  const baseKg = actualKg <= referenceKg ? actualKg : referenceKg + EXCESS_SHARE * (actualKg - referenceKg); // 基準體重
  return Math.round(Math.max(DEFICIT_G_PER_KG * baseKg, rdaPerKg * actualKg));
}

// ctx 是 planContext()；沒有計劃時依賴體重的蛋白質為 null，其餘只看每日熱量目標 kcal。
export function suggestedGoals(ctx, kcal) {
  return {
    protein: { type: 'min', min: proteinMin(assertPlanContext('suggestedGoals', ctx)) },
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

// ctx 是 planContext()（目前體重的退回規則在那裡）；overrides 是使用者的逐項覆寫。
// 實際目標 = 覆寫值 ?? 建議值；覆寫以整項為單位（範圍型 min、max 一起覆寫）。
export function nutrientGoals(ctx, kcal, overrides = {}) {
  if (overrides === null || typeof overrides !== 'object') throw new TypeError('nutrientGoals：第三個參數是覆寫物件（體重請放進 planContext）');
  const suggested = suggestedGoals(ctx, kcal);
  return Object.fromEntries(NUTRIENT_GOALS.map(({ total }) => {
    const { type, ...values } = suggested[total]; const own = overrides?.[total];
    return [total, { type, ...(own || values), overridden: !!own, suggested: values }];
  }));
}
