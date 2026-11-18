import test from 'node:test';
import assert from 'node:assert/strict';
import { offToItem } from '../server/barcode.js';

// OFF 單品端點回應 → 項目（純函式）。回傳 null 代表視為未命中。
const product = (nutriments, extra = {}) => ({ status: 1, code: '4710088000011', product: { product_name: '測試飲料', nutrition_data_per: '100g', nutriments, ...extra } });
const FULL = { 'energy-kcal_100g': 45, proteins_100g: 1, fat_100g: 0, carbohydrates_100g: 10, sugars_100g: 9.5, sodium_100g: 0.02 };

test('OFF 回應轉成項目：每 100 單位的熱量與營養素、來源 barcode、鈉由 g 換成 mg', () => {
  const item = offToItem(product(FULL), '4710088000011');
  assert.deepEqual(item, { name: '測試飲料', kcalPer100g: 45, proteinPer100g: 1, fatPer100g: 0, carbsPer100g: 10, sugarPer100g: 9.5, sodiumMgPer100g: 20,
    source: 'barcode', barcode: '4710088000011', matched: false, cache: true, sourceUrl: 'https://world.openfoodfacts.org/product/4710088000011', sourceTitle: '條碼資料庫（社群提供）', packageGrams: null, warnings: [] });
});
test('nutrition_data_per 為 100ml 也視為每 100 單位', () => {
  assert.equal(offToItem(product(FULL, { nutrition_data_per: '100ml' }), '4710088000011').kcalPer100g, 45);
});
test('缺的營養素是 null 不是 0；整包重量取 product_quantity', () => {
  const item = offToItem(product({ 'energy-kcal_100g': 45 }, { product_quantity: '330' }), '4710088000011');
  assert.deepEqual([item.proteinPer100g, item.fatPer100g, item.carbsPer100g, item.sugarPer100g, item.sodiumMgPer100g], [null, null, null, null, null]);
  assert.equal(item.packageGrams, 330);
});
test('缺熱量、品名空白或亂碼、查無商品都視為未命中', () => {
  assert.equal(offToItem(product({ proteins_100g: 1 }), '4710088000011'), null);
  assert.equal(offToItem(product(FULL, { product_name: '   ' }), '4710088000011'), null);
  assert.equal(offToItem(product(FULL, { product_name: '��� ��' }), '4710088000011'), null);
  assert.equal(offToItem(product(FULL, { product_name: '???' }), '4710088000011'), null);
  assert.equal(offToItem({ status: 0, status_verbose: 'product not found' }, '4710088000011'), null);
});
test('熱量與 4P+4C+9F 差距過大附警告，不阻擋；吻合則無警告', () => {
  const off = offToItem(product({ ...FULL, 'energy-kcal_100g': 400 }), '4710088000011');
  assert.equal(off.kcalPer100g, 400); assert.equal(off.warnings.length, 1); assert.match(off.warnings[0], /不吻合/);
  assert.deepEqual(offToItem(product({ ...FULL, 'energy-kcal_100g': 44 }), '4710088000011').warnings, []);
});
