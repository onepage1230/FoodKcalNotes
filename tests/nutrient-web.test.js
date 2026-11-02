import test from 'node:test';
import assert from 'node:assert/strict';
import { createJournal } from '../server/journal.js';
import { analyzeMeal } from '../server/food-analysis.js';

// ticket 04：網路搜尋同一次呼叫取得熱量與五項營養素，驗證通過才採用。
const NK = ['proteinPer100g', 'fatPer100g', 'carbsPer100g', 'sugarPer100g', 'sodiumMgPer100g'];
const webN = { proteinPer100g: 2.7, fatPer100g: 0.3, carbsPer100g: 28, sugarPer100g: 0.1, sodiumMgPer100g: 1 };
const estN = { proteinPer100g: 2.5, fatPer100g: 0.2, carbsPer100g: 27, sugarPer100g: 0, sodiumMgPer100g: 2 };
const url = 'https://example.org/nutrition';
const recognized = { name: '測試午餐', note: '', items: [{ name: '測試白飯', grams: 200, aliases: [], confidence: 'medium', portionNote: '估計200g' }] };
const answer = (data, extra = {}) => ({ text: JSON.stringify(data), searched: false, citations: [], ...extra });
// 第 3 次之後若是補估呼叫（ticket 05），回傳 fill 指定的值。
const run = async (search, { cite = true, estimate = { kcalPer100g: 120, ...estN }, fill = {} } = {}) => {
  const db = createJournal(':memory:'); let calls = 0; const bodies = [];
  const result = await analyzeMeal({ text: '測試餐', photo: '', fallback: 'web', journal: db, emit() {}, infer: async body => {
    bodies.push(body); const n = calls++;
    if (n === 0) return answer(recognized);
    if (n === 1) return answer({ sourceUrl: url, ...search }, { searched: true, citations: cite ? [{ url, title: '測試來源' }] : [] });
    if (body.schema?.name === 'nutrient_fill') return answer({ items: JSON.parse(body.input[0].content).items.map(i => ({ ...i, ...fill })) });
    return answer(estimate);
  } });
  return { item: result.items[0], calls, bodies, db };
};

test('驗證通過：採用同一來源的營養素，不列入 estimated，搜尋提示詞要求同一來源', async () => {
  const { item, calls, bodies, db } = await run({ kcalPer100g: 135, ...webN });
  assert.equal(item.source, 'web'); assert.equal(calls, 2);
  for (const k of NK) assert.equal(item[k], webN[k], k);
  assert.deepEqual(item.estimated, []);
  assert.match(bodies[1].instructions, /sodiumMgPer100g/); assert.match(bodies[1].instructions, /同一個來源/); db.close();
});
test('驗證通過：來源缺的欄位不拿搜尋以外的值；之後由合併補估補上並標為估算', async () => {
  const { item, calls, bodies, db } = await run({ kcalPer100g: 135, ...webN, sugarPer100g: null, sodiumMgPer100g: undefined },
    { fill: { proteinPer100g: 9, sugarPer100g: 0.2, sodiumMgPer100g: 3 } });
  assert.equal(item.source, 'web'); assert.equal(calls, 3); assert.equal(bodies[2].schema.name, 'nutrient_fill');
  assert.equal(item.sugarPer100g, 0.2); assert.equal(item.sodiumMgPer100g, 3);
  assert.equal(item.proteinPer100g, 2.7); assert.deepEqual(item.estimated, ['sugarPer100g', 'sodiumMgPer100g']); db.close();
});
test('虛構引用：搜尋回應的營養素捨棄，改用估算值並列入 estimated', async () => {
  const { item, calls, db } = await run({ kcalPer100g: 135, ...webN }, { cite: false });
  assert.equal(item.source, 'llm'); assert.equal(calls, 3); assert.equal(item.kcalPer100g, 120);
  for (const k of NK) assert.equal(item[k], estN[k], k);
  assert.deepEqual(item.estimated, NK); db.close();
});
test('虛構引用且估算缺欄位：不拿搜尋的值補', async () => {
  const { item, db } = await run({ kcalPer100g: 135, ...webN }, { cite: false, estimate: { kcalPer100g: 120, proteinPer100g: 2.5 } });
  assert.equal(item.proteinPer100g, 2.5); assert.equal(item.fatPer100g, null); assert.deepEqual(item.estimated, ['proteinPer100g']); db.close();
});
test('營養素無效值不影響熱量的 web 來源，只有該欄位當 null', async () => {
  const { item, calls, db } = await run({ kcalPer100g: 135, ...webN, proteinPer100g: -3, sodiumMgPer100g: 99999, sugarPer100g: '5' });
  assert.equal(item.source, 'web'); assert.equal(calls, 3); assert.equal(item.kcalPer100g, 135);
  // 無效值當 null，再由補估（這裡回傳空值）處理；網路來源的有效值不受影響。
  for (const k of ['proteinPer100g', 'sodiumMgPer100g', 'sugarPer100g']) assert.equal(item[k], null, k);
  assert.equal(item.carbsPer100g, 28); assert.deepEqual(item.estimated, []); db.close();
});
test('三大營養素加總超過 101：三項當 null，熱量仍為 web，可保存', async () => {
  const { item, db } = await run({ kcalPer100g: 135, ...webN, proteinPer100g: 50, fatPer100g: 40, carbsPer100g: 30 });
  assert.equal(item.source, 'web');
  for (const k of ['proteinPer100g', 'fatPer100g', 'carbsPer100g']) assert.equal(item[k], null, k);
  assert.doesNotThrow(() => db.saveMeal({ name: '測試餐', day: '2026-10-02', time: '12:30', photo: '', items: [item] })); db.close();
});
