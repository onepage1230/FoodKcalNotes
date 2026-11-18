import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBarcode, defaultGrams, barcodeDraft, withBarcode } from '../client/barcode-view.js';

// 條碼查詢前端的純函式（ADR 0013、spec barcode「前端」）；相機與畫面不寫自動測試。
test('條碼格式：8～14 位數字才合法，去掉空白與連字號；其他回傳 null', () => {
  assert.equal(normalizeBarcode('4710088000011'), '4710088000011');
  assert.equal(normalizeBarcode(' 4710 0880-00011 '), '4710088000011');
  assert.equal(normalizeBarcode('12345678'), '12345678'); assert.equal(normalizeBarcode('12345678901234'), '12345678901234');
  for (const bad of ['1234567', '123456789012345', 'abc12345678', '', null, undefined, 4710088000011]) assert.equal(normalizeBarcode(bad), null);
});

test('預設克數：有整包淨重用整包，否則一份，都沒有用 100', () => {
  assert.equal(defaultGrams({ packageGrams: 330, servingGrams: 250 }), 330);
  assert.equal(defaultGrams({ packageGrams: null, servingGrams: 250 }), 250);
  assert.equal(defaultGrams({ packageGrams: null, servingGrams: null }), 100);
  assert.equal(defaultGrams({}), 100); // 本機庫命中的項目沒有這兩個欄位
  assert.equal(defaultGrams({ packageGrams: 0, servingGrams: -5 }), 100);
});

const OFF_ITEM = { name: '測試飲料', kcalPer100g: 45, proteinPer100g: 1, fatPer100g: 0, carbsPer100g: 10, sugarPer100g: null, sodiumMgPer100g: 20, source: 'barcode', barcode: '4710088000011',
  matched: false, cache: true, sourceUrl: 'https://world.openfoodfacts.org/product/4710088000011', sourceTitle: '條碼資料庫（社群提供）', packageGrams: 330, servingGrams: null, warnings: ['熱量不吻合'] };
test('確認畫面草稿：一個項目、預設克數、警告移到草稿；項目 id 是新的，未知營養素維持 null', () => {
  const draft = barcodeDraft({ found: true, origin: 'barcode', item: OFF_ITEM }, { day: '2026-11-18', time: '12:30', id: 'new-id' });
  const { warnings: _w, ...rest } = OFF_ITEM;
  assert.deepEqual(draft, { name: '', day: '2026-11-18', time: '12:30', photo: '', note: '', warnings: ['熱量不吻合'], items: [{ ...rest, id: 'new-id', grams: 330 }] });
  assert.equal(draft.items[0].sugarPer100g, null);
});
test('確認畫面草稿：本機庫命中保留 foodId 與 matched，食物的 id 不當成項目 id；沒有淨重用 100g', () => {
  const food = { id: 'food-1', foodId: 'food-1', matched: true, name: '先存的', kcalPer100g: 50, source: 'manual', barcode: '4710088000011' };
  const { items: [item], warnings } = barcodeDraft({ found: true, origin: 'library', item: food }, { day: '2026-11-18', time: '08:00', id: 'new-id' });
  assert.equal(item.id, 'new-id'); assert.equal(item.foodId, 'food-1'); assert.equal(item.matched, true); assert.equal(item.grams, 100); assert.deepEqual(warnings, []);
});
test('AI 查條碼的分析結果：只有一個項目才帶條碼（拆成多項不知道哪項是這個商品）', () => {
  assert.deepEqual(withBarcode([{ name: '某商品', source: 'web' }], '4710088000011'), [{ name: '某商品', source: 'web', barcode: '4710088000011' }]);
  const split = [{ name: '甲' }, { name: '乙' }]; assert.deepEqual(withBarcode(split, '4710088000011'), split);
});
