import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestedGoals, nutrientGoals, NUTRIENT_GOALS, goalInfo } from '../client/nutrient-goals.js';
import { createJournal } from '../server/journal.js';

// 維持期（目前體重 ≤ 目標）：蛋白質照 ADR 0010 的 RDA × 目前體重。第三個參數是伺服器提供的目前體重。
const plan = { sex: 'f', age: 28, height: 165, weight: 60, target: 60, activity: 1.2 };

test('建議目標：蛋白質依體重 1.1 g/kg 為下限，脂肪與碳水依熱量比例為範圍，糖與鈉為上限', () => {
  assert.deepEqual(suggestedGoals(plan, 1300, 60), {
    protein: { type: 'min', min: 66 },
    fat: { type: 'range', min: 29, max: 43 }, // 1300×20%÷9、1300×30%÷9
    carbs: { type: 'range', min: 163, max: 211 }, // 1300×50%÷4、1300×65%÷4
    sugar: { type: 'max', max: 33 }, // 1300×10%÷4
    sodiumMg: { type: 'max', max: 2300 },
  });
  const g = suggestedGoals({ ...plan, sex: 'm', weight: 90, target: 90 }, 2000, 90);
  assert.equal(g.protein.min, 99); assert.deepEqual([g.fat.min, g.fat.max], [44, 67]);
  assert.deepEqual([g.carbs.min, g.carbs.max], [250, 325]); assert.equal(g.sugar.max, 50);
});
test('建議目標：71 歲以上蛋白質 1.2 g/kg；70 歲仍為 1.1 g/kg', () => {
  assert.equal(suggestedGoals({ ...plan, age: 71 }, 1300, 60).protein.min, 72);
  assert.equal(suggestedGoals({ ...plan, age: 70 }, 1300, 60).protein.min, 66);
  assert.equal(suggestedGoals({ ...plan, weight: 72.5, target: 72.5 }, 1300, 72.5).protein.min, 80); // 79.75 四捨五入
});
test('建議目標：沒有計劃時蛋白質為 null，其餘照熱量計算；熱量目標無效時只剩鈉', () => {
  const g = suggestedGoals(null, 1800);
  assert.deepEqual(g.protein, { type: 'min', min: null });
  assert.deepEqual(g.fat, { type: 'range', min: 40, max: 60 }); assert.equal(g.sugar.max, 45); assert.equal(g.sodiumMg.max, 2300);
  const none = suggestedGoals(undefined, undefined);
  assert.deepEqual(none.carbs, { type: 'range', min: null, max: null }); assert.equal(none.sugar.max, null); assert.equal(none.sodiumMg.max, 2300);
});
test('實際目標：覆寫值優先，標記 overridden 並保留建議值', () => {
  const goals = nutrientGoals(plan, 1300, 60, { protein: { min: 90 }, sodiumMg: { max: 2000 } });
  assert.deepEqual(goals.protein, { type: 'min', min: 90, overridden: true, suggested: { min: 66 } });
  assert.deepEqual(goals.sodiumMg, { type: 'max', max: 2000, overridden: true, suggested: { max: 2300 } });
  assert.deepEqual(goals.fat, { type: 'range', min: 29, max: 43, overridden: false, suggested: { min: 29, max: 43 } });
  assert.deepEqual(Object.keys(goals), NUTRIENT_GOALS.map(n => n.total));
  assert.deepEqual(nutrientGoals(plan, 1300, 60).sugar, nutrientGoals(plan, 1300, 60, {}).sugar); // 沒有覆寫物件也可以
});
test('計劃或熱量改變時只有未覆寫的項目跟著變', () => {
  const overrides = { protein: { min: 90 }, carbs: { min: 120, max: 180 } };
  const before = nutrientGoals(plan, 1300, 60, overrides);
  const after = nutrientGoals({ ...plan, weight: 70, target: 70 }, 1600, 70, overrides);
  assert.equal(after.protein.min, 90); assert.deepEqual([after.carbs.min, after.carbs.max], [120, 180]);
  assert.equal(after.protein.suggested.min, 77); // 建議值仍即時重算，只是不採用
  assert.notDeepEqual([after.fat.min, after.fat.max], [before.fat.min, before.fat.max]);
  assert.deepEqual([after.fat.min, after.fat.max], [36, 53]); assert.equal(after.sugar.max, 40);
  assert.equal(after.sodiumMg.max, 2300);
});

// ADR 0012：減重計劃進行中（目前體重 > 目標）蛋白質下限 = max(1.4 × 基準體重, RDA × max(起始, 目前))。
// 身高 165 cm、BMI 25 對應 68.06 kg；預期值取自 ADR 0012 的對照表。
const tall165 = kg => ({ sex: 'f', age: 28, height: 165, weight: kg, target: 60, activity: 1.2 });
test('赤字期蛋白質：取 1.4 × 基準體重與 RDA 的較大者，BMI 約 36.8 以上等於 RDA（ADR 0012 對照表）', () => {
  assert.equal(suggestedGoals(tall165(70), 1500, 70).protein.min, 96);
  assert.equal(suggestedGoals(tall165(90), 1500, 90).protein.min, 105);
  assert.equal(suggestedGoals(tall165(100), 1500, 100).protein.min, 110);
  assert.equal(suggestedGoals(tall165(120), 1500, 120).protein.min, 132);
});
test('赤字期蛋白質：71 歲以上 RDA 倍率 1.2，門檻降到 BMI 約 31.8', () => {
  const old = kg => ({ ...tall165(kg), age: 71 });
  // 80 kg（BMI 29.4）：1.4 ×（68.06 + 0.33 × 11.94）= 100.8 > 1.2 × 80 = 96
  assert.equal(suggestedGoals(old(80), 1500, 80).protein.min, 101);
  // 90 kg（BMI 33.1）：1.4 × 75.30 = 105.4 < 1.2 × 90 = 108
  assert.equal(suggestedGoals(old(90), 1500, 90).protein.min, 108);
  assert.equal(suggestedGoals({ ...old(90), age: 70 }, 1500, 90).protein.min, 105); // 70 歲仍為 1.1
});
test('赤字期蛋白質：起始體重大於目前體重時用起始體重，下限不隨減重下降；體重回升超過起始才跟著升', () => {
  assert.equal(suggestedGoals(tall165(90), 1500, 80).protein.min, 105);
  assert.equal(suggestedGoals(tall165(90), 1500, 61).protein.min, 105);
  assert.equal(suggestedGoals(tall165(90), 1500, 100).protein.min, 110);
  assert.equal(suggestedGoals(tall165(60.5), 1500, 60.5).protein.min, 85); // 低於 BMI 25：1.4 × 60.5 = 84.7
});
test('達成目標（目前體重 ≤ 目標）回到 RDA × 目前體重；沒有計劃為 null', () => {
  assert.equal(suggestedGoals(tall165(90), 1500, 60).protein.min, 66); // 1.1 × 60
  assert.equal(suggestedGoals(tall165(90), 1500, 58).protein.min, 64); // 1.1 × 58 = 63.8
  assert.equal(suggestedGoals({ ...tall165(90), age: 75 }, 1500, 58).protein.min, 70); // 1.2 × 58 = 69.6
  assert.equal(suggestedGoals(null, 1500, 80).protein.min, null);
  assert.equal(suggestedGoals(null, 1500, null).protein.min, null);
});

test('赤字期覆寫過的蛋白質目標不受影響，建議值仍即時重算；其餘四項不變', () => {
  const goals = nutrientGoals(tall165(90), 1500, 80, { protein: { min: 80 } });
  assert.deepEqual(goals.protein, { type: 'min', min: 80, overridden: true, suggested: { min: 105 } });
  assert.deepEqual(goals.fat, nutrientGoals(null, 1500, null).fat);
  assert.deepEqual([goals.carbs.min, goals.carbs.max, goals.sugar.max, goals.sodiumMg.max], [188, 244, 38, 2300]);
});
test('目標說明：赤字期蛋白質說明算法、間接出處與腎功能提醒；維持期與沒有計劃顯示原本的 DRIs 說明', () => {
  const dris = { basis: '每公斤體重 1.1 g（71 歲以上 1.2 g）', source: '國健署 DRIs 第八版 蛋白質 RDA' };
  const deficit = goalInfo('protein', tall165(90), 80);
  assert.match(deficit.basis, /1\.4 g/); assert.match(deficit.basis, /BMI 25/); assert.match(deficit.basis, /三分之一/);
  assert.match(deficit.source, /ISSN/); assert.match(deficit.source, /1\.4–2\.0/); assert.match(deficit.source, /間接/);
  assert.match(deficit.note, /腎功能不佳者請先諮詢醫師或營養師/);
  assert.deepEqual(goalInfo('protein', tall165(90), 60), dris); // 達成目標
  assert.deepEqual(goalInfo('protein', null, null), dris); // 沒有計劃
  assert.deepEqual(goalInfo('sugar', tall165(90), 80), { basis: '添加糖不超過每日熱量的 10%（每 g 4 kcal）', source: '國健署 國民飲食指標',
    note: '記錄的是總糖（含水果、牛奶的天然糖），用添加糖上限比對可能高估' }); // 其他項目不隨情境變
});
test('偏好 nutrientGoals：舊設定沒有此欄位時預設為空物件', () => {
  const db = createJournal(':memory:');
  assert.deepEqual(db.preferences().nutrientGoals, {});
  db.updatePreferences({ goal: 1500, plan }); assert.deepEqual(db.preferences().nutrientGoals, {}); db.close();
});
test('偏好 nutrientGoals：逐項覆寫、合併保存，null 清除單項或全部', () => {
  const db = createJournal(':memory:');
  db.updatePreferences({ nutrientGoals: { protein: { min: 80 } } });
  db.updatePreferences({ nutrientGoals: { fat: { min: 40, max: 55.5 }, sodiumMg: { max: 2000 } } });
  assert.deepEqual(db.preferences().nutrientGoals, { protein: { min: 80 }, fat: { min: 40, max: 55.5 }, sodiumMg: { max: 2000 } });
  db.updatePreferences({ nutrientGoals: { protein: null } });
  assert.deepEqual(db.preferences().nutrientGoals, { fat: { min: 40, max: 55.5 }, sodiumMg: { max: 2000 } });
  db.updatePreferences({ plan: null, goal: 1200 }); assert.deepEqual(Object.keys(db.preferences().nutrientGoals), ['fat', 'sodiumMg']); // 清除計劃不影響覆寫
  db.updatePreferences({ nutrientGoals: null }); assert.deepEqual(db.preferences().nutrientGoals, {}); db.close();
});
test('偏好 nutrientGoals：數值、範圍、欄位與 min ≤ max 驗證，失敗時不改動', () => {
  const db = createJournal(':memory:'); db.updatePreferences({ nutrientGoals: { sugar: { max: 30 } } });
  for (const bad of [
    { protein: { min: '80' } }, { protein: { min: 0 } }, { protein: { min: 501 } }, { protein: { max: 80 } }, { protein: {} },
    { fat: { min: 60, max: 40 } }, { fat: { min: 40 } }, { carbs: { max: 200 } }, { sugar: { max: -1 } }, { sugar: { max: NaN } },
    { sodiumMg: { max: 50 } }, { sodiumMg: { max: 20000 } }, { fiber: { min: 20 } }, { sugar: 30 }, [], 'x',
  ]) assert.throws(() => db.updatePreferences({ nutrientGoals: bad }), e => e.status === 400 && /營養目標/.test(e.message), JSON.stringify(bad));
  assert.deepEqual(db.preferences().nutrientGoals, { sugar: { max: 30 } });
  db.updatePreferences({ nutrientGoals: { fat: { min: 50, max: 50 } } }); // min = max 允許
  assert.deepEqual(db.preferences().nutrientGoals.fat, { min: 50, max: 50 }); db.close();
});
