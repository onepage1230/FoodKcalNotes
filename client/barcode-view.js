// 條碼查詢的前端純函式（ADR 0013）：不碰瀏覽器 API，node --test 可直接匯入。
// 手動輸入或掃描到的條碼：去掉空白與連字號，8～14 位數字才合法（與伺服器端點相同），否則 null。
export function normalizeBarcode(input) {
  if (typeof input !== 'string') return null;
  const code = input.replace(/[\s-]/g, '');
  return /^\d{8,14}$/.test(code) ? code : null;
}
// 預設克數（spec 使用者故事 7）：整包淨重 → 一份 → 100；本機庫命中的項目沒有這兩個欄位，用 100。
const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
export const defaultGrams = item => [item?.packageGrams, item?.servingGrams].find(positive) ?? 100;
// GET /api/barcode/:code 命中的結果 → 確認畫面用的草稿（沿用一般「記一餐」草稿與保存流程）。
// 警告移到草稿層顯示；本機庫命中的項目帶著食物的 id，換成新的項目 id（foodId 保留）。
export function barcodeDraft({ item: { warnings = [], ...item } }, { day, time, id }) {
  return { name: '', day, time, photo: '', note: '', warnings, items: [{ ...item, id, grams: defaultGrams(item) }] };
}
// AI 查條碼確認品名後的分析結果：只有一個項目時才帶條碼，保存時伺服器才會把條碼寫入食物庫；拆成多項時不知道哪項是這個商品，都不帶。
export const withBarcode = (items, barcode) => items.length === 1 ? [{ ...items[0], barcode }] : items;
// 遠端裝置（例如手機經 Tailscale）無法設定 AI 服務（ChatGPT 登入只限本機）：電腦端沒有可用服務時，AI 查條碼要停用並說明。
// 本機沒有服務時不擋（可以去設定頁）；舊版伺服器沒有 providersReady 時也不擋。
export const aiBlockedReason = status => status?.remote && status.providersReady === false ? '電腦尚未設定 AI 服務，請在執行服務的電腦上開啟 127.0.0.1 登入 ChatGPT 或設定 Claude API key。' : '';
