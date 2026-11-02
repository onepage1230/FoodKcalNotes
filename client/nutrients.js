// 五項營養素（ADR 0010）：都是每 100g 可食部分；null 代表未知，不等於 0。伺服器與前端共用。
export const NUTRIENTS = [
  { key: 'proteinPer100g', total: 'protein', label: '蛋白質', unit: 'g', max: 100 },
  { key: 'fatPer100g', total: 'fat', label: '脂肪', unit: 'g', max: 100 },
  { key: 'carbsPer100g', total: 'carbs', label: '碳水化合物', unit: 'g', max: 100 },
  { key: 'sugarPer100g', total: 'sugar', label: '糖（總糖）', unit: 'g', max: 100 },
  { key: 'sodiumMgPer100g', total: 'sodiumMg', label: '鈉', unit: 'mg', max: 40000 },
];
export const NUTRIENT_KEYS = NUTRIENTS.map(n => n.key);

// 輸入框可能是字串；空字串、null、undefined、非數字都視為未知。
export function nutrientValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const round = (n, unit) => unit === 'mg' ? Math.round(n) : Math.round(n * 10) / 10;

// 各項營養素的已知總量與未知項目數：總量 = 克數 × 每100g ÷ 100，由程式計算（同熱量）。
export function nutrientTotals(items) {
  return Object.fromEntries(NUTRIENTS.map(({ key, total, unit }) => {
    let known = 0; let unknown = 0;
    for (const item of items) {
      const per100 = nutrientValue(item[key]); const grams = Number(item.grams);
      if (per100 === null || !Number.isFinite(grams)) unknown++; else known += grams * per100 / 100;
    }
    return [total, { known: round(known, unit), unknown }];
  }));
}
