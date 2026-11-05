// 減重目標：Mifflin-St Jeor 估算 BMR/TDEE，以每日目標 goal 推算每週減重 weekly 與預計達成日
// （1 kg 脂肪 ≈ 7700 kcal）；total 為整個計劃的天數。
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// current：目前體重（伺服器提供；省略時用計劃的體重，例如表單預覽）。BMR、TDEE、最低攝取與每週減重量用它；
// 預計達成日與總天數仍以計劃的體重（起始體重）推算（ticket 03 再處理）。
const energy = (plan, kg) => { const bmr = 10 * kg + 6.25 * plan.height - 5 * plan.age + (plan.sex === 'm' ? 5 : -161); return { bmr, tdee: bmr * plan.activity }; };
const weeklyLoss = (tdee, goal) => Math.round(Math.max(0, tdee - goal) * 7 / 7700 * 100) / 100;

export function planGoal(plan, goal, today = new Date(), current = plan.weight) {
  const { bmr, tdee } = energy(plan, current);
  const floor = Math.max(bmr, plan.sex === 'm' ? 1500 : 1200);
  const result = { bmr: Math.round(bmr), tdee: Math.round(tdee), floor: Math.round(floor) };
  const lose = plan.weight - plan.target;
  if (lose <= 0) return { ...result, days: 0, date: ymd(today) };
  const weekly = weeklyLoss(tdee, goal), planWeekly = weeklyLoss(energy(plan, plan.weight).tdee, goal);
  if (!planWeekly) return { ...result, weekly, days: null, date: null, total: null };
  // 有 startDate（已存計劃）時從開始日推算，剩餘天數才會每天倒數；沒有則從今天起算。
  const total = Math.ceil(lose / planWeekly * 7);
  const now = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const [y, m, d] = plan.startDate ? plan.startDate.split('-').map(Number) : [now.getFullYear(), now.getMonth() + 1, now.getDate()];
  const end = new Date(y, m - 1, d + total);
  return { ...result, weekly, days: Math.max(0, Math.round((end - now) / 864e5)), date: ymd(end), total };
}
