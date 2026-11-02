import test from 'node:test';
import assert from 'node:assert/strict';
import { createJournal } from '../server/journal.js';

// 食物庫的營養素補值與覆蓋（ADR 0010 的快取例外）。
const N = { proteinPer100g: null, fatPer100g: null, carbsPer100g: null, sugarPer100g: null, sodiumMgPer100g: null };
const day = { day: '2026-10-01', time: '12:00' };
const save = (db, items, options) => db.saveMeal({ ...day, items }, options);
// 既有食物：蛋白質有出處、脂肪是估算、其餘未知。
function seeded(t, journal = createJournal(':memory:')) {
  t.after(() => journal.close());
  const id = journal.putFood({ name: '雞肉飯', kcalPer100g: 180, source: 'web', sourceUrl: 'https://example.com/rice', aliases: ['火雞肉飯'],
    ...N, proteinPer100g: 8, fatPer100g: 5, estimated: ['fatPer100g'] });
  return { journal, id, food: () => journal.foods().find(f => f.id === id) };
}
const matched = (id, extra = {}) => ({ name: '雞肉飯', grams: 200, kcalPer100g: 180, source: 'web', matched: true, cache: false, foodId: id, ...N, ...extra });
const auto = (extra = {}) => ({ name: '雞肉飯', grams: 200, kcalPer100g: 999, source: 'label', cache: true, ...N, estimated: [], ...extra });

test('食物庫營養素：新食物寫入時連同五項營養素與估算標記一起保存', t => {
  const db = createJournal(':memory:'); t.after(() => db.close());
  const meal = save(db, [{ name: '新湯', grams: 100, kcalPer100g: 40, source: 'llm', cache: true, ...N, proteinPer100g: 2, sodiumMgPer100g: 300, estimated: ['proteinPer100g', 'sodiumMgPer100g'] },
    { name: '標示餅', grams: 50, kcalPer100g: 450, source: 'label', cache: true, ...N, fatPer100g: 20, estimated: [] }]);
  const soup = db.findFood(['新湯']); const cake = db.findFood(['標示餅']);
  assert.deepEqual([soup.proteinPer100g, soup.sodiumMgPer100g, soup.fatPer100g, soup.estimated], [2, 300, null, ['proteinPer100g', 'sodiumMgPer100g']]);
  assert.deepEqual([cake.fatPer100g, cake.estimated], [20, []]);
  assert.equal(meal.items[0].foodId, soup.id);
});

test('食物庫營養素：既有寫入條件不變——未開 cache、命中項目、手動來源都不新增食物', t => {
  const db = createJournal(':memory:'); t.after(() => db.close());
  save(db, [{ name: '不快取', grams: 100, kcalPer100g: 40, source: 'web', cache: false, ...N, fatPer100g: 1 },
    { name: '手填', grams: 100, kcalPer100g: 40, source: 'manual', cache: true, ...N, fatPer100g: 1 },
    { name: '命中', grams: 100, kcalPer100g: 40, source: 'web', cache: true, matched: true, ...N, fatPer100g: 1 }]);
  assert.deepEqual(db.foods(), []);
});

test('食物庫營養素：nutrientsEdited 只存在餐點項目，不寫入食物庫', t => {
  const db = createJournal(':memory:'); t.after(() => db.close());
  const meal = save(db, [{ name: '新湯', grams: 100, kcalPer100g: 40, source: 'web', cache: true, nutrientsEdited: true, ...N }]);
  assert.equal(meal.items[0].nutrientsEdited, true);
  assert.equal(save(db, [{ name: '別的', grams: 100, kcalPer100g: 40, source: 'manual' }]).items[0].nutrientsEdited, false);
  assert.equal('nutrientsEdited' in db.foods()[0], false); // 這筆因為 cache=true 仍寫入，但不帶標記
});

test('食物庫營養素：庫裡為 null 的欄位可被估算值補上，並列入 estimated', t => {
  const { journal, id, food } = seeded(t);
  save(journal, [matched(id, { proteinPer100g: 8, fatPer100g: 5, carbsPer100g: 30, sugarPer100g: 2, estimated: ['fatPer100g', 'carbsPer100g', 'sugarPer100g'] })]);
  const f = food();
  assert.deepEqual([f.carbsPer100g, f.sugarPer100g, f.sodiumMgPer100g], [30, 2, null]);
  assert.deepEqual(f.estimated.sort(), ['carbsPer100g', 'fatPer100g', 'sugarPer100g']);
});

test('食物庫營養素：庫裡為 null 的欄位可被有出處的值補上，不列入 estimated', t => {
  const { journal, food } = seeded(t);
  save(journal, [auto({ sodiumMgPer100g: 400 })]);
  assert.equal(food().sodiumMgPer100g, 400); assert.deepEqual(food().estimated, ['fatPer100g']);
});

test('食物庫營養素：估算欄位可被營養標示或網路資料覆蓋，覆蓋後移出 estimated', t => {
  const { journal, food } = seeded(t);
  save(journal, [auto({ fatPer100g: 3 })]);
  assert.deepEqual([food().fatPer100g, food().estimated], [3, []]);
  const second = seeded(t);
  save(second.journal, [auto({ source: 'web', sourceUrl: 'https://example.com/b', fatPer100g: 4 })]);
  assert.deepEqual([second.food().fatPer100g, second.food().estimated], [4, []]);
});

test('食物庫營養素：估算欄位不會被另一個估算值覆蓋（含有出處熱量所附的估算營養素）', t => {
  const { journal, food } = seeded(t);
  save(journal, [auto({ fatPer100g: 9, estimated: ['fatPer100g'] })]);
  save(journal, [{ ...auto({ source: 'llm', fatPer100g: 9, estimated: ['fatPer100g'] }) }]);
  assert.deepEqual([food().fatPer100g, food().estimated], [5, ['fatPer100g']]);
});

test('食物庫營養素：命中項目的值只是沿用庫裡的估算，不會被當成有出處而覆蓋', t => {
  const { journal, id, food } = seeded(t);
  // 命中項目的來源是食物庫的 web，但脂肪不在項目的 estimated 中（例如舊快照）：命中不是新的出處。
  save(journal, [matched(id, { fatPer100g: 7, estimated: [] })]);
  assert.deepEqual([food().fatPer100g, food().estimated], [5, ['fatPer100g']]);
});

test('食物庫營養素：有出處的欄位、熱量、名稱、來源與別名永不改變', t => {
  const { journal, id, food } = seeded(t);
  const before = food();
  save(journal, [auto({ proteinPer100g: 20 }), matched(id, { name: '雞肉飯', kcalPer100g: 300, proteinPer100g: 30, recognizedName: '' })]);
  const f = food();
  assert.deepEqual([f.proteinPer100g, f.kcalPer100g, f.name, f.source, f.sourceUrl, f.aliases], [8, 180, '雞肉飯', 'web', 'https://example.com/rice', ['火雞肉飯']]);
  assert.equal(before.kcalPer100g, f.kcalPer100g);
});

test('食物庫營養素：使用者改過熱量（manual）的項目不參與補值', t => {
  const { journal, id, food } = seeded(t);
  save(journal, [matched(id, { source: 'manual', matched: false, sodiumMgPer100g: 400 }), { ...auto({ source: 'manual', sodiumMgPer100g: 400 }) }]);
  assert.equal(food().sodiumMgPer100g, null);
});

test('食物庫營養素：命中維護者匯入的 manual 食物時，source 只是食物庫的來源，仍可補 null', t => {
  const db = createJournal(':memory:'); t.after(() => db.close());
  const id = db.putFood({ name: '共用飯', kcalPer100g: 130, source: 'manual', ...N });
  save(db, [matched(id, { name: '共用飯', kcalPer100g: 130, source: 'manual', sodiumMgPer100g: 2, estimated: ['sodiumMgPer100g'] })]);
  assert.deepEqual([db.findFood(['共用飯']).sodiumMgPer100g, db.findFood(['共用飯']).estimated], [2, ['sodiumMgPer100g']]);
});

test('食物庫營養素：使用者改過營養素（nutrientsEdited）的項目不參與補值', t => {
  const { journal, id, food } = seeded(t);
  save(journal, [matched(id, { sodiumMgPer100g: 400, nutrientsEdited: true })]);
  save(journal, [auto({ nutrientsEdited: true, fatPer100g: 1 })]); // 即使帶 cache=true 也不補
  assert.deepEqual([food().sodiumMgPer100g, food().fatPer100g], [null, 5]);
});

test('食物庫營養素：背景自動存檔的 LLM 估算（cache=false）不參與補值', t => {
  const { journal, food } = seeded(t);
  save(journal, [auto({ source: 'llm', cache: false, sodiumMgPer100g: 400, estimated: ['sodiumMgPer100g'] })]);
  assert.equal(food().sodiumMgPer100g, null);
  // 使用者按「AI 估算」並保存（cache=true）：可補 null。
  save(journal, [auto({ source: 'llm', sodiumMgPer100g: 400, estimated: ['sodiumMgPer100g'] })]);
  assert.equal(food().sodiumMgPer100g, 400); assert.ok(food().estimated.includes('sodiumMgPer100g'));
});

test('食物庫營養素：命中來源為 LLM 估算的食物（背景存檔 cache=false）仍可補 null，因為熱量來自庫而非這次估算', t => {
  const db = createJournal(':memory:'); t.after(() => db.close());
  const id = db.putFood({ name: '估算湯', kcalPer100g: 40, source: 'llm', ...N });
  save(db, [{ ...matched(id, { name: '估算湯', kcalPer100g: 40, source: 'llm', sodiumMgPer100g: 300, estimated: ['sodiumMgPer100g'] }) }]);
  const f = db.findFood(['估算湯']); assert.deepEqual([f.sodiumMgPer100g, f.estimated, f.kcalPer100g], [300, ['sodiumMgPer100g'], 40]);
});

test('食物庫營養素：沒有對應食物庫項目（非命中、未寫入）的項目不參與', t => {
  const { journal, id, food } = seeded(t);
  save(journal, [{ ...auto({ cache: false, sodiumMgPer100g: 400 }), foodId: id }]);
  assert.equal(food().sodiumMgPer100g, null);
});

test('食物庫營養素：朋友日誌在開啟共用時補值寫入主日誌；FRIENDS_CACHE 關閉時不新增也不補值', t => {
  const { journal: owner, id, food } = seeded(t);
  const friend = createJournal(':memory:', { foods: owner }); t.after(() => friend.close());
  save(friend, [matched(id, { sodiumMgPer100g: 400, estimated: ['sodiumMgPer100g'] }), auto({ name: '新餅', fatPer100g: 2 })], { shareFoods: false });
  assert.equal(food().sodiumMgPer100g, null); assert.deepEqual(owner.foods().map(f => f.name), ['雞肉飯']);
  save(friend, [matched(id, { sodiumMgPer100g: 400, estimated: ['sodiumMgPer100g'] })]);
  assert.equal(food().sodiumMgPer100g, 400);
});

test('食物庫營養素：合併後三大營養素加總超過 100 g 時不補，餐點照常保存', t => {
  const db = createJournal(':memory:'); t.after(() => db.close());
  const id = db.putFood({ name: '花生醬', kcalPer100g: 600, source: 'web', ...N, fatPer100g: 50, proteinPer100g: 25 });
  const meal = save(db, [matched(id, { name: '花生醬', carbsPer100g: 40, estimated: ['carbsPer100g'] })]);
  assert.equal(meal.items.length, 1); assert.equal(db.findFood(['花生醬']).carbsPer100g, null);
});
