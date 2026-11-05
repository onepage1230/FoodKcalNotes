// 「減重計劃＋目前體重」的包裝（GLOSSARY：目前體重），planGoal、suggestedGoals、nutrientGoals、goalInfo 都吃它，
// 不再各自傳 (plan, current)。這裡是「沒有目前體重時退回計劃體重」規則的唯一來源：
// 目前體重省略、尚未載入或無效（非有限數字、0、負數）時一律用計劃的體重（與「沒有紀錄時目前體重 = 計劃體重」一致）；
// 沒有計劃時兩者都是 null。App 建立一次再往下傳；只有 planContext() 建出來的物件會被接受，漏包或位置傳錯會丟錯。
const made = new WeakSet();
const validKg = kg => typeof kg === 'number' && Number.isFinite(kg) && kg > 0 ? kg : null;

export function planContext(plan, current) {
  const ctx = Object.freeze(plan ? { plan, current: validKg(current) ?? validKg(plan.weight) } : { plan: null, current: null });
  made.add(ctx); return ctx;
}
export function assertPlanContext(fn, ctx) {
  if (!made.has(ctx)) throw new TypeError(`${fn}：需要 planContext(plan, current) 建立的物件，不能直接傳計劃或體重`);
  return ctx;
}
