import { NUTRIENTS } from '../client/nutrients.js';

export const OFF_PRODUCT_URL = 'https://world.openfoodfacts.org/product/';
export const BARCODE_SOURCE_TITLE = '條碼資料庫（社群提供）';
// 熱量與 4×蛋白質＋4×碳水＋9×脂肪 的差距超過這個門檻（取絕對值與比例中較大者）就警告。
const MISMATCH_KCAL = 40, MISMATCH_RATIO = 0.3;
const num = value => { const n = typeof value === 'string' && value.trim() ? Number(value) : value; return typeof n === 'number' && Number.isFinite(n) ? n : null; };
// 品名空白、含取代字元（U+FFFD）或沒有任何文字／數字（例如只有問號與符號）都視為亂碼。
const garbled = name => !name || /�/.test(name) || !/[\p{L}\p{N}]/u.test(name);

// Open Food Facts 單品回應 → 項目；缺熱量、品名空白或亂碼、查無商品回傳 null（視為未命中）。
// 100g 與 100ml 一律視為每 100 單位（OFF 的 *_100g 欄位兩者共用）；缺或不合理的營養素為 null，不補 0、不估算。
export function offToItem(response, barcode) {
  const p = response?.status === 1 ? response.product : null;
  if (!p) return null;
  const name = [p.product_name_zh, p.product_name].map(v => typeof v === 'string' ? v.trim() : '').find(v => !garbled(v));
  const kcal = num(p.nutriments?.['energy-kcal_100g']);
  if (!name || kcal === null || kcal < 0 || kcal > 1000) return null;
  const n = p.nutriments;
  const raw = { proteinPer100g: num(n.proteins_100g), fatPer100g: num(n.fat_100g), carbsPer100g: num(n.carbohydrates_100g), sugarPer100g: num(n.sugars_100g),
    sodiumMgPer100g: num(n.sodium_100g) === null ? null : Math.round(num(n.sodium_100g) * 1000) }; // OFF 的鈉以 g 計
  const nutrients = Object.fromEntries(NUTRIENTS.map(({ key, max }) => [key, raw[key] !== null && raw[key] >= 0 && raw[key] <= max ? raw[key] : null]));
  const warnings = [];
  const { proteinPer100g: P, fatPer100g: F, carbsPer100g: C } = nutrients;
  if (P !== null && F !== null && C !== null) {
    const energy = 4 * P + 4 * C + 9 * F;
    if (Math.abs(kcal - energy) > Math.max(MISMATCH_KCAL, MISMATCH_RATIO * kcal)) warnings.push(`熱量（${kcal} kcal）與營養素換算（約 ${Math.round(energy)} kcal）不吻合，資料可能有誤，請對照包裝。`);
  }
  const grams = num(p.product_quantity);
  return { name: name.slice(0, 100), kcalPer100g: kcal, ...nutrients, source: 'barcode', barcode, sourceUrl: `${OFF_PRODUCT_URL}${barcode}`, sourceTitle: BARCODE_SOURCE_TITLE,
    packageGrams: grams !== null && grams > 0 && grams <= 5000 ? grams : null, warnings };
}

const NOT_AVAILABLE = '暫時無法查詢條碼資料庫，請稍後再試，或改用拍營養標示、手動新增。';
const unavailable = status => Object.assign(new Error(NOT_AVAILABLE), { status });
// OFF 限速為每 IP 每分鐘 15 次；伺服器端所有身分共用一個視窗，留餘裕只用 10 次。
// 命中快取 24 小時、未命中 1 小時（商品資料可能被補上）；失敗不快取。User-Agent 只放通用專案名稱，不含個人資訊。
export const OFF_LIMIT = 10, OFF_WINDOW = 60_000, HIT_TTL = 24 * 3600_000, MISS_TTL = 3600_000, CACHE_MAX = 1000;
const USER_AGENT = 'FoodKcalNotes/1.0';
// 條碼查詢：本機庫（以條碼比對）→ Open Food Facts。fetcher 與 now 由呼叫端注入（測試用假的）。
export function createBarcodeLookup({ fetcher = fetch, now = () => new Date() }) {
  const cache = new Map(); const sent = []; // sent：最近送出的 OFF 要求時間（毫秒）
  async function fromOff(code) {
    const at = now().getTime();
    while (sent.length && sent[0] <= at - OFF_WINDOW) sent.shift();
    if (sent.length >= OFF_LIMIT) throw unavailable(503);
    sent.push(at);
    let response;
    try { response = await fetcher(`https://world.openfoodfacts.org/api/v2/product/${code}.json`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(8000) }); } catch { throw unavailable(503); }
    if (response.status === 404) return null;
    if (!response.ok) throw unavailable(503);
    let body; try { body = await response.json(); } catch { throw unavailable(503); }
    return offToItem(body, code);
  }
  return async function lookup(code, journal) {
    const food = journal.findByBarcode(code);
    if (food) return { found: true, origin: 'library', item: { ...food, foodId: food.id, matched: true } };
    const at = now().getTime(); const cached = cache.get(code);
    let item;
    if (cached && cached.until > at) item = cached.item;
    else {
      item = await fromOff(code);
      cache.delete(code); cache.set(code, { item, until: at + (item ? HIT_TTL : MISS_TTL) });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
    return item ? { found: true, origin: 'barcode', item: structuredClone(item) } : { found: false };
  };
}
