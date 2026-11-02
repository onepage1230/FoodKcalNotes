import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestedGoals, nutrientGoals, NUTRIENT_GOALS } from '../client/nutrient-goals.js';
import { createJournal } from '../server/journal.js';

const plan = { sex: 'f', age: 28, height: 165, weight: 60, target: 55, activity: 1.2 };

test('建議目標：蛋白質依體重 1.1 g/kg 為下限，脂肪與碳水依熱量比例為範圍，糖與鈉為上限', () => {
  assert.deepEqual(suggestedGoals(plan, 1300), {
    protein: { type: 'min', min: 66 },
    fat: { type: 'range', min: 29, max: 43 }, // 1300×20%÷9、1300×30%÷9
    carbs: { type: 'range', min: 163, max: 211 }, // 1300×50%÷4、1300×65%÷4
    sugar: { type: 'max', max: 33 }, // 1300×10%÷4
    sodiumMg: { type: 'max', max: 2300 },
  });
  const g = suggestedGoals({ ...plan, sex: 'm', weight: 90 }, 2000);
  assert.equal(g.protein.min, 99); assert.deepEqual([g.fat.min, g.fat.max], [44, 67]);
  assert.deepEqual([g.carbs.min, g.carbs.max], [250, 325]); assert.equal(g.sugar.max, 50);
});
test('建議目標：71 歲以上蛋白質 1.2 g/kg；70 歲仍為 1.1 g/kg', () => {
  assert.equal(suggestedGoals({ ...plan, age: 71 }, 1300).protein.min, 72);
  assert.equal(suggestedGoals({ ...plan, age: 70 }, 1300).protein.min, 66);
  assert.equal(suggestedGoals({ ...plan, weight: 72.5 }, 1300).protein.min, 80); // 79.75 四捨五入
});
test('建議目標：沒有計劃時蛋白質為 null，其餘照熱量計算；熱量目標無效時只剩鈉', () => {
  const g = suggestedGoals(null, 1800);
  assert.deepEqual(g.protein, { type: 'min', min: null });
  assert.deepEqual(g.fat, { type: 'range', min: 40, max: 60 }); assert.equal(g.sugar.max, 45); assert.equal(g.sodiumMg.max, 2300);
  const none = suggestedGoals(undefined, undefined);
  assert.deepEqual(none.carbs, { type: 'range', min: null, max: null }); assert.equal(none.sugar.max, null); assert.equal(none.sodiumMg.max, 2300);
});
test('實際目標：覆寫值優先，標記 overridden 並保留建議值', () => {
  const goals = nutrientGoals(plan, 1300, { protein: { min: 90 }, sodiumMg: { max: 2000 } });
  assert.deepEqual(goals.protein, { type: 'min', min: 90, overridden: true, suggested: { min: 66 } });
  assert.deepEqual(goals.sodiumMg, { type: 'max', max: 2000, overridden: true, suggested: { max: 2300 } });
  assert.deepEqual(goals.fat, { type: 'range', min: 29, max: 43, overridden: false, suggested: { min: 29, max: 43 } });
  assert.deepEqual(Object.keys(goals), NUTRIENT_GOALS.map(n => n.total));
  assert.deepEqual(nutrientGoals(plan, 1300).sugar, nutrientGoals(plan, 1300, {}).sugar); // 沒有覆寫物件也可以
});
test('計劃或熱量改變時只有未覆寫的項目跟著變', () => {
  const overrides = { protein: { min: 90 }, carbs: { min: 120, max: 180 } };
  const before = nutrientGoals(plan, 1300, overrides);
  const after = nutrientGoals({ ...plan, weight: 70 }, 1600, overrides);
  assert.equal(after.protein.min, 90); assert.deepEqual([after.carbs.min, after.carbs.max], [120, 180]);
  assert.equal(after.protein.suggested.min, 77); // 建議值仍即時重算，只是不採用
  assert.notDeepEqual([after.fat.min, after.fat.max], [before.fat.min, before.fat.max]);
  assert.deepEqual([after.fat.min, after.fat.max], [36, 53]); assert.equal(after.sugar.max, 40);
  assert.equal(after.sodiumMg.max, 2300);
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
