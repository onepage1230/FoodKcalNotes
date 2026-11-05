// 具名選項物件的檢查：只接受純物件與已知的鍵。舊式位置參數（日期、體重數字、覆寫物件）或拼錯的名稱會直接丟錯，
// 不會靜默落回預設值而算出錯誤的數字。
export function readOptions(fn, opts, keys) {
  if (opts === undefined) return {};
  if (opts === null || typeof opts !== 'object' || Object.getPrototypeOf(opts) !== Object.prototype) throw new TypeError(`${fn}：第三個參數必須是選項物件 { ${keys.join(', ')} }`);
  const unknown = Object.keys(opts).filter(k => !keys.includes(k));
  if (unknown.length) throw new TypeError(`${fn}：不認得的選項 ${unknown.join(', ')}（可用：${keys.join(', ')}）`);
  return opts;
}
// 有效的體重（公斤）：有限且大於 0；否則 undefined。
export const validKg = kg => Number.isFinite(kg) && kg > 0 ? kg : undefined;
