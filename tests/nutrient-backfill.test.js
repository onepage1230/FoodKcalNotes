import test from 'node:test';
import assert from 'node:assert/strict';
import { createJournal } from '../server/journal.js';
import { analyzeMeal } from '../server/food-analysis.js';

// ticket 05：熱量已有來源但營養素缺值的項目，同一餐合併成一次補估呼叫。
const NK = ['proteinPer100g', 'fatPer100g', 'carbsPer100g', 'sugarPer100g', 'sodiumMgPer100g'];
const full = { proteinPer100g: 3, fatPer100g: 2, carbsPer100g: 20, sugarPer100g: 1, sodiumMgPer100g: 50 };
const answer = data => ({ text: JSON.stringify(data), searched: false, citations: [] });
const rec = items => ({ name: '測試餐', note: '', items: items.map(name => ({ name, grams: 100, aliases: [], confidence: 'high', portionNote: '100g' })) });
const ids = body => JSON.parse(body.input[0].content).items.map(i => i.id);
const fillReply = (body, patch) => answer({ items: ids(body).map(id => ({ id, ...Object.fromEntries(NK.map(k => [k, null])), ...patch })) });
// names 都在食物庫（foods）；reply 是補估呼叫的回應函式。
const run = async ({ names, foods = [], reply, signal }) => {
  const db = createJournal(':memory:'); foods.forEach(f => db.putFood(f)); const fills = [];
  const result = await analyzeMeal({ text: '餐', photo: '', fallback: 'llm', journal: db, signal, emit() {}, infer: async body => {
    if (body.schema?.name === 'nutrient_fill') { fills.push(body); return reply(body); }
    return answer(rec(names));
  } });
  return { result, fills, db };
};
const manual = (name, extra = {}) => ({ name, kcalPer100g: 100, source: 'manual', ...extra });

test('補估：多個缺值項目只呼叫一次，缺欄位補上並列入 estimated，熱量不變', async () => {
  const { result, fills, db } = await run({ names: ['甲', '乙'], foods: [manual('甲'), { ...manual('乙'), kcalPer100g: 200 }], reply: body => fillReply(body, full) });
  assert.equal(fills.length, 1);
  for (const [k, kcal] of [[0, 100], [1, 200]]) {
    const it = result.items[k]; assert.equal(it.kcalPer100g, kcal);
    for (const key of NK) assert.equal(it[key], full[key], key);
    assert.deepEqual(it.estimated, NK);
  }
  assert.deepEqual(result.warnings, []); db.close();
});
test('補估：零缺值不呼叫', async () => {
  const { fills, db } = await run({ names: ['甲'], foods: [manual('甲', full)], reply: body => fillReply(body, full) });
  assert.equal(fills.length, 0); db.close();
});
test('補估：結構化輸出不含熱量欄位，提示詞要求不得改熱量，並提供已知營養素作參考', async () => {
  const { fills, db } = await run({ names: ['甲'], foods: [manual('甲', { proteinPer100g: 7 })], reply: body => fillReply(body, full) });
  const schema = fills[0].schema.schema; const props = schema.properties.items.items.properties;
  assert.ok(!Object.keys(props).some(k => /kcal/i.test(k)), '不應有熱量欄位');
  assert.deepEqual(schema.required, ['items']); assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.items.items.required, Object.keys(props)); assert.equal(schema.properties.items.items.additionalProperties, false);
  assert.match(fills[0].instructions, /估計值/); assert.match(fills[0].instructions, /mg/); assert.match(fills[0].instructions, /不得修改熱量/);
  assert.match(fills[0].input[0].content, /"proteinPer100g":7/); assert.match(fills[0].input[0].content, /"kcalPer100g":100/); db.close();
});
test('補估：回傳含熱量欄位也不影響熱量；只補 null 欄位，已有值不被改動', async () => {
  const { result, db } = await run({ names: ['甲'], foods: [manual('甲', { proteinPer100g: 7, estimated: ['proteinPer100g'] })], reply: body => fillReply(body, { ...full, kcalPer100g: 999 }) });
  const it = result.items[0]; assert.equal(it.kcalPer100g, 100); assert.equal(it.proteinPer100g, 7);
  assert.equal(it.fatPer100g, 2); assert.deepEqual(it.estimated, NK); db.close();
});
test('補估：無效值的欄位保持 null 不列入 estimated；補上後三大營養素加總超過 101 時捨棄補上的三項', async () => {
  const a = await run({ names: ['甲'], foods: [manual('甲')], reply: body => fillReply(body, { sugarPer100g: -3, sodiumMgPer100g: 10 }) });
  assert.deepEqual(a.result.items[0].estimated, ['sodiumMgPer100g']); assert.equal(a.result.items[0].sugarPer100g, null); a.db.close();
  const b = await run({ names: ['甲'], foods: [manual('甲', { proteinPer100g: 60 })], reply: body => fillReply(body, { proteinPer100g: 1, fatPer100g: 30, carbsPer100g: 30, sodiumMgPer100g: 10 }) });
  const it = b.result.items[0]; assert.equal(it.proteinPer100g, 60); assert.equal(it.fatPer100g, null); assert.equal(it.carbsPer100g, null);
  assert.deepEqual(it.estimated, ['sodiumMgPer100g']); b.db.close();
});
test('補估：營養標示、本機食物庫命中、網路資料三種來源都納入，LLM 估算的不納入', async () => {
  const db = createJournal(':memory:'); db.putFood(manual('庫內', { kcalPer100g: 50 })); const fills = [];
  const url = 'https://consumer.fda.gov.tw/x';
  const one = name => ({ name, grams: 100, aliases: [], confidence: 'high', portionNote: '' });
  const result = await analyzeMeal({ text: '餐', photo: '', fallback: 'web', journal: db, emit() {}, infer: async body => {
    if (body.schema?.name === 'meal_recognition') return answer({ name: '餐', note: '', items: [
      { ...one('標示品'), labelKcalPer100g: 300, labelProteinPer100g: 5, labelFatPer100g: null, labelCarbsPer100g: null, labelSugarPer100g: null, labelSodiumMgPer100g: null },
      one('庫內'), one('網路品'), one('估算品')] });
    if (body.schema?.name === 'nutrient_fill') { fills.push(body); return fillReply(body, full); }
    if (body.tools) return /網路品/.test(body.input[0].content)
      ? { text: JSON.stringify({ kcalPer100g: 120, sourceUrl: url, sourceTitle: 'FDA', notes: '', servingGrams: null }), searched: true, citations: [{ url, title: 'FDA' }] }
      : { text: 'x', searched: false, citations: [] };
    return answer({ kcalPer100g: 70, sourceUrl: '', sourceTitle: '', notes: '', servingGrams: null, sameAs: null, ...Object.fromEntries(NK.map(k => [k, 1])) });
  } });
  assert.deepEqual(result.items.map(i => i.source), ['label', 'manual', 'web', 'llm']);
  assert.equal(fills.length, 1);
  assert.deepEqual(JSON.parse(fills[0].input[0].content).items.map(i => i.name), ['標示品', '庫內', '網路品']);
  const [label, local, web, llm] = result.items;
  assert.equal(label.proteinPer100g, 5); assert.deepEqual(label.estimated, NK.filter(k => k !== 'proteinPer100g'));
  assert.deepEqual(local.estimated, NK); assert.deepEqual(web.estimated, NK); assert.deepEqual(llm.estimated, NK); assert.equal(llm.proteinPer100g, 1);
  assert.deepEqual(result.items.map(i => i.kcalPer100g), [300, 50, 120, 70]); db.close();
});
test('補估失敗：整餐照常回傳，營養素保留 null，加一則警告', async () => {
  const { result, db } = await run({ names: ['甲'], foods: [manual('甲')], reply: () => { throw new Error('所有服務都失敗'); } });
  assert.equal(result.items[0].kcalPer100g, 100); for (const k of NK) assert.equal(result.items[0][k], null);
  assert.deepEqual(result.items[0].estimated, []); assert.equal(result.warnings.length, 1); assert.match(result.warnings[0], /營養素/); db.close();
});
test('補估回傳格式不正確：整餐照常回傳並加警告', async () => {
  const { result, db } = await run({ names: ['甲'], foods: [manual('甲')], reply: () => ({ text: '不是 JSON', searched: false, citations: [] }) });
  assert.equal(result.items.length, 1); assert.equal(result.warnings.length, 1); db.close();
});
test('補估期間使用者中止：AbortError 照常拋出', async () => {
  const ctl = new AbortController();
  await assert.rejects(run({ names: ['甲'], foods: [manual('甲')], signal: ctl.signal,
    reply: () => { ctl.abort(); throw new DOMException('Aborted', 'AbortError'); } }), { name: 'AbortError' });
});
test('補估：分析步驟訊息包含「補估營養素」', async () => {
  const db = createJournal(':memory:'); db.putFood(manual('甲')); const labels = [];
  await analyzeMeal({ text: '餐', photo: '', fallback: 'llm', journal: db, emit: e => labels.push(e.label), infer: async body =>
    body.schema?.name === 'nutrient_fill' ? fillReply(body, full) : answer(rec(['甲'])) });
  assert.ok(labels.includes('補估營養素')); db.close();
});
