// 候選餐點歸納（spec repeat-meals「候選的選取與顯示規則」、ADR 0011）。純函式：不碰資料庫與時鐘，「現在」由呼叫端傳入。
import { normalize, kcal } from './journal.js';

export const RANGE_DAYS = 30; // 今天往前第 1～30 天計入，第 31 天起不計；今天自己的餐點不歸納，只用來判斷是否已記
export const WINDOW_MINUTES = 90; // 今天在常見時間前後 90 分鐘內（含）已有任何餐點就不顯示
export const LIMIT = 5;
export const WEEKDAY_MIN_COUNT = 2;

const pad = n => String(n).padStart(2, '0');
export const localDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const shiftDay = (day, n) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekday = day => new Date(day + 'T12:00:00Z').getUTCDay(); // 0 週日～6 週六
const isWeekday = day => weekday(day) >= 1 && weekday(day) <= 5;
const toMinutes = time => { const [h, m] = time.split(':').map(Number); return h * 60 + m; };
const toTime = minutes => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
// 常見時間：各次時分的中位數；偶數筆取中間兩筆的平均，四捨五入到分鐘。
export function medianTime(times) {
  const list = times.map(toMinutes).sort((a, b) => a - b); const mid = list.length >> 1;
  return toTime(list.length % 2 ? list[mid] : Math.round((list[mid - 1] + list[mid]) / 2));
}
// 合併鍵：項目名稱正規化後的集合（忽略順序、重複與克數）；正規化為空的名稱不參與，全部為空回傳 ''（不成為候選）。
export const candidateKey = meal => [...new Set(meal.items.map(i => normalize(i.name ?? '')).filter(Boolean))].sort().join('|');
const later = (a, b) => a.day !== b.day ? a.day > b.day : a.time > b.time; // a 是否比 b 晚

// 兩種日子共用的收尾：ranked 為已排好優先順序的 { latest, times, time }。先過濾（不晚於現在、今天前後 90 分鐘內沒有餐點），再取前 5 個，最後依時間由早到晚。
function finalize(ranked, todays, nowMinutes) {
  return ranked.filter(c => toMinutes(c.time) <= nowMinutes && !todays.some(t => Math.abs(t - toMinutes(c.time)) <= WINDOW_MINUTES))
    .slice(0, LIMIT).sort((a, b) => toMinutes(a.time) - toMinutes(b.time))
    .map(({ latest: m, times, time }) => ({ mealId: m.id, name: m.name, items: m.items.map(i => ({ name: i.name, grams: i.grams })),
      kcal: m.items.reduce((s, i) => s + kcal(i), 0), time, count: times.length }));
}
// 依合併鍵分組；每組記錄最近一次（latest）與所有出現的時間（times）。
function group(meals) {
  const groups = new Map();
  for (const m of meals) {
    const key = candidateKey(m); if (!key) continue;
    const g = groups.get(key); if (!g) groups.set(key, { latest: m, times: [m.time] });
    else { g.times.push(m.time); if (later(m, g.latest)) g.latest = m; } // 同日同時刻以先出現者為準（呼叫端依新到舊傳入）
  }
  return [...groups.values()];
}
const byLatest = (a, b) => later(a.latest, b.latest) ? -1 : later(b.latest, a.latest) ? 1 : 0;

// meals：仍存在的餐點（含 id、day、time、name、items）；now：伺服器本地的「現在」。回傳依時間由早到晚的候選清單。
export function repeatCandidates(meals, now) {
  const today = localDay(now), from = shiftDay(today, -RANGE_DAYS), nowMinutes = now.getHours() * 60 + now.getMinutes();
  const todays = meals.filter(m => m.day === today).map(m => toMinutes(m.time));
  const past = meals.filter(m => m.day >= from && m.day < today);
  if (!isWeekday(today)) { // 假日：30 天內所有日子，不要求次數；依最近一次由近到遠；時間用最近一次實際的時間
    const ranked = group(past).map(g => ({ ...g, time: g.latest.time })).sort(byLatest);
    return finalize(ranked, todays, nowMinutes);
  }
  // 平日：只算過去的平日、至少 2 次；依次數多到少（同次數最近的優先）；時間用中位數
  const ranked = group(past.filter(m => isWeekday(m.day))).filter(g => g.times.length >= WEEKDAY_MIN_COUNT)
    .map(g => ({ ...g, time: medianTime(g.times) })).sort((a, b) => b.times.length - a.times.length || byLatest(a, b));
  return finalize(ranked, todays, nowMinutes);
}
