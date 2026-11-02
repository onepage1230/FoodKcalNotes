import test from 'node:test';
import assert from 'node:assert/strict';
import { createJournal } from '../server/journal.js';
import { analyzeMeal } from '../server/food-analysis.js';

// ticket 03：LLM 估算熱量時，同一次呼叫一併估出五項營養素。
const NK = ['proteinPer100g', 'fatPer100g', 'carbsPer100g', 'sugarPer100g', 'sodiumMgPer100g'];
const nutr = { proteinPer100g: 2.5, fatPer100g: 0.3, carbsPer100g: 28, sugarPer100g: 0.1, sodiumMgPer100g: 1 };
const recognized = { name: '測試午餐', note: '', items: [{ name: '測試白飯', grams: 200, aliases: [], confidence: 'medium', portionNote: '估計200g' }] };
const tea = { name: '加多寶涼茶（含糖）', aliases: ['加多寶植物飲料'], kcalPer100g: 34, source: 'manual' };
const canned = { name: '測試餐', items: [{ name: '加多寶有糖罐裝涼茶', aliases: ['加多寶罐裝涼茶'], grams: 310, confidence: 'high', portionNote: '一罐' }] };
const answer = data => ({ text: JSON.stringify(data), searched: false, citations: [] });
const estimateMeal = async (reply, fallback = 'llm') => {
  const db = createJournal(':memory:'); let calls = 0; const bodies = [];
  const result = await analyzeMeal({ text: '測試餐', photo: '', fallback, journal: db, emit() {}, infer: async body => {
    bodies.push(body); return answer(calls++ === 0 ? recognized : reply);
  } });
  return { item: result.items[0], calls, bodies, db };
};

test('LLM 估算：熱量與五項營養素同一次回傳，全部列入 estimated，呼叫次數不變', async () => {
  const { item, calls, bodies, db } = await estimateMeal({ kcalPer100g: 130, notes: '估算', ...nutr });
  assert.equal(calls, 2); assert.equal(item.source, 'llm');
  for (const k of NK) assert.equal(item[k], nutr[k], k);
  assert.deepEqual(item.estimated, NK);
  assert.match(bodies[1].instructions, /蛋白質/); assert.match(bodies[1].instructions, /mg/); assert.match(bodies[1].instructions, /估計值/);
  db.close();
});
test('LLM 估算：估不出的營養素保留 null，只有有值的列入 estimated', async () => {
  const { item, db } = await estimateMeal({ kcalPer100g: 130, ...nutr, fatPer100g: null, sodiumMgPer100g: null });
  assert.equal(item.fatPer100g, null); assert.equal(item.sodiumMgPer100g, null);
  assert.deepEqual(item.estimated, ['proteinPer100g', 'carbsPer100g', 'sugarPer100g']); db.close();
});
test('LLM 估算：缺欄位、非數字、負數、超出範圍的營養素各自當 null，其他照用；邊界值有效', async () => {
  const { item, db } = await estimateMeal({ kcalPer100g: 130, proteinPer100g: '5', fatPer100g: -1, carbsPer100g: 20, sodiumMgPer100g: 40001 });
  for (const k of ['proteinPer100g', 'fatPer100g', 'sugarPer100g', 'sodiumMgPer100g']) assert.equal(item[k], null, k);
  assert.equal(item.carbsPer100g, 20); assert.deepEqual(item.estimated, ['carbsPer100g']); db.close();
  const ok = await estimateMeal({ kcalPer100g: 884, proteinPer100g: 0, fatPer100g: 100, carbsPer100g: 0, sugarPer100g: 0, sodiumMgPer100g: 40000 });
  assert.deepEqual(ok.item.estimated, NK); ok.db.close();
});
test('LLM 估算：三大營養素加總超過 101 時三項都當 null，整餐仍可保存', async () => {
  const { item, db } = await estimateMeal({ kcalPer100g: 130, ...nutr, proteinPer100g: 50, fatPer100g: 40, carbsPer100g: 30 });
  for (const k of ['proteinPer100g', 'fatPer100g', 'carbsPer100g']) assert.equal(item[k], null, k);
  assert.equal(item.sugarPer100g, 0.1); assert.deepEqual(item.estimated, ['sugarPer100g', 'sodiumMgPer100g']);
  assert.doesNotThrow(() => db.saveMeal({ name: '測試餐', day: '2026-10-02', time: '12:30', photo: '', items: [item] })); db.close();
});
test('sameAs 命中食物庫時不使用估算的營養素，使用庫裡的資料', async () => {
  const db = createJournal(':memory:'); const id = db.putFood({ ...tea, proteinPer100g: 0.2 }); let calls = 0;
  const result = await analyzeMeal({ text: '一罐加多寶', photo: '', fallback: 'llm', journal: db, emit() {}, infer: async () =>
    answer(calls++ === 0 ? canned : { sameAs: id, kcalPer100g: 999, ...nutr }) });
  const hit = result.items[0];
  assert.equal(calls, 3); assert.equal(hit.matched, true); assert.equal(hit.kcalPer100g, 34); assert.equal(hit.proteinPer100g, 0.2);
  assert.equal(hit.carbsPer100g, null); assert.deepEqual(hit.estimated, []); db.close();
});
test('判斷為不同種時照常使用估算的營養素', async () => {
  const db = createJournal(':memory:'); db.putFood(tea); let calls = 0;
  const result = await analyzeMeal({ text: '一罐加多寶', photo: '', fallback: 'llm', journal: db, emit() {}, infer: async () =>
    answer(calls++ === 0 ? canned : { sameAs: null, kcalPer100g: 40, ...nutr }) });
  assert.equal(result.items[0].matched, false); assert.deepEqual(result.items[0].estimated, NK); db.close();
});
test('網路搜尋成功的項目採用來源營養素，不列入 estimated（ticket 04）', async () => {
  const url = 'https://example.org/nutrition'; const db = createJournal(':memory:'); let calls = 0;
  const result = await analyzeMeal({ text: '測試餐', photo: '', fallback: 'web', journal: db, emit() {}, infer: async body => {
    if (calls++ === 0) return answer(recognized);
    return { ...answer({ kcalPer100g: 135, sourceUrl: url, ...nutr }), searched: true, citations: [{ url, title: '測試來源' }] };
  } });
  const item = result.items[0]; assert.equal(item.source, 'web');
  for (const k of NK) assert.equal(item[k], nutr[k], k);
  assert.deepEqual(item.estimated, []); db.close();
});
