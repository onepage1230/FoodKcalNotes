import { NUTRIENTS } from '../client/nutrients.js';
import { canonicalBarcode } from './journal.js';

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
  // 三大營養素加總不可能超過 100 g（容許 1 g 誤差，與 validateFood 相同）：OFF 的資料有誤時三項都丟掉，免得整餐保存失敗。
  if (['proteinPer100g', 'fatPer100g', 'carbsPer100g'].every(k => nutrients[k] !== null) && nutrients.proteinPer100g + nutrients.fatPer100g + nutrients.carbsPer100g > 101) {
    for (const k of ['proteinPer100g', 'fatPer100g', 'carbsPer100g']) nutrients[k] = null;
    warnings.push('蛋白質、脂肪、碳水化合物加總超過每 100g，資料可能有誤，三項已捨棄，請對照包裝。');
  }
  const { proteinPer100g: P, fatPer100g: F, carbsPer100g: C } = nutrients;
  if (P !== null && F !== null && C !== null) {
    const energy = 4 * P + 4 * C + 9 * F;
    if (Math.abs(kcal - energy) > Math.max(MISMATCH_KCAL, MISMATCH_RATIO * kcal)) warnings.push(`熱量（${kcal} kcal）與營養素換算（約 ${Math.round(energy)} kcal）不吻合，資料可能有誤，請對照包裝。`);
  }
  const grams = num(p.product_quantity);
  const serving = /(\d+(?:\.\d+)?)\s*(?:g|ml|公克|毫升)/i.exec(typeof p.serving_size === 'string' ? p.serving_size : ''); // 例如「250 ml」「1 瓶 (330ml)」
  const servingGrams = serving && Number(serving[1]) > 0 && Number(serving[1]) <= 5000 ? Number(serving[1]) : null;
  return { name: name.slice(0, 100), kcalPer100g: kcal, ...nutrients, source: 'barcode', barcode, matched: false, cache: true, sourceUrl: `${OFF_PRODUCT_URL}${barcode}`, sourceTitle: BARCODE_SOURCE_TITLE,
    packageGrams: grams !== null && grams > 0 && grams <= 5000 ? grams : null, servingGrams, warnings };
}

const NOT_AVAILABLE = '暫時無法查詢條碼資料庫，請稍後再試，或改用拍營養標示、手動新增。';
const unavailable = status => Object.assign(new Error(NOT_AVAILABLE), { status });
// OFF 限速為每 IP 每分鐘 15 次；伺服器端所有身分共用一個視窗，留餘裕只用 10 次，其中朋友合計最多 6 次，免得朋友用光擁有者的名額。
// 命中快取 24 小時、未命中 1 小時（商品資料可能被補上）；失敗不快取。User-Agent 預設只放通用專案名稱，不含個人資訊；部署者可用 BARCODE_CONTACT 加上自己的聯絡信箱（OFF 建議格式 AppName/Version (ContactEmail)），信箱只存在環境變數，不進程式碼。
export const OFF_LIMIT = 10, FRIEND_OFF_LIMIT = 6, OFF_WINDOW = 60_000, HIT_TTL = 24 * 3600_000, MISS_TTL = 3600_000, CACHE_MAX = 1000;
const userAgent = contact => contact ? `FoodKcalNotes/1.0 (${contact})` : 'FoodKcalNotes/1.0';
// 只要 offToItem 用到的欄位，回應小、也不洩漏多餘資料。
const OFF_FIELDS = 'product_name,product_name_zh,nutriments,product_quantity,serving_size';
// 條碼查詢：本機庫（以條碼比對）→ Open Food Facts。fetcher 與 now 由呼叫端注入（測試用假的）。
// lookup(code, journal, { friend })：friend 為朋友身分（占用朋友的 OFF 名額）；快取命中與合併進行中的要求都不計額度。
export function createBarcodeLookup({ fetcher = fetch, now = () => new Date(), contact = '' }) {
  const USER_AGENT = userAgent(contact);
  const cache = new Map(); const inflight = new Map(); const sent = [], friendSent = []; // sent：最近送出的 OFF 要求時間（毫秒）
  const prune = (list, at) => { while (list.length && list[0] <= at - OFF_WINDOW) list.shift(); };
  async function fromOff(code, friend) {
    const at = now().getTime(); prune(sent, at); prune(friendSent, at);
    if (sent.length >= OFF_LIMIT || (friend && friendSent.length >= FRIEND_OFF_LIMIT)) throw unavailable(503);
    sent.push(at); if (friend) friendSent.push(at);
    let response;
    try { response = await fetcher(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${OFF_FIELDS}`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(8000) }); } catch { throw unavailable(503); }
    let item = null;
    if (response.status !== 404) {
      if (!response.ok) throw unavailable(503);
      let body; try { body = await response.json(); } catch { throw unavailable(503); }
      item = offToItem(body, code);
    }
    cache.delete(code); cache.set(code, { item, until: now().getTime() + (item ? HIT_TTL : MISS_TTL) });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return item;
  }
  // 同一條碼的並行要求共用一次 OFF 要求（只扣一次額度）；完成（成功或失敗）後清除。
  const query = (code, friend) => {
    if (!inflight.has(code)) inflight.set(code, fromOff(code, friend).finally(() => inflight.delete(code)));
    return inflight.get(code);
  };
  return async function lookup(input, journal, { friend = false } = {}) {
    const code = canonicalBarcode(input);
    const food = journal.findByBarcode(code);
    if (food) return { found: true, origin: 'library', item: { ...food, foodId: food.id, matched: true } };
    const cached = cache.get(code);
    const item = cached && cached.until > now().getTime() ? cached.item : await query(code, friend);
    return item ? { found: true, origin: 'barcode', item: structuredClone(item) } : { found: false };
  };
}
