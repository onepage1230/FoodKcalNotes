import test from 'node:test';
import assert from 'node:assert/strict';
import { repeatCandidates, medianTime, candidateKey, localDay, shiftDay } from '../server/repeat-candidates.js';
import { showCandidates } from '../client/candidate-view.js';

// repeat-meals ticket 02：候選歸納（純函式），輸入「餐點清單＋現在」。
// 「現在」固定為 2026-11-05（週四）13:00 本地時間；往前第 30 天是 10-06（週二），第 31 天是 10-05（週一）。
const NOW = new Date(2026, 10, 5, 13, 0);
let seq = 0;
// names 可為字串陣列或 [名稱, 克數] 陣列；每 100g 熱量固定 100，方便算總熱量。
const meal = (day, time, names, extra = {}) => ({ id: 'm' + (++seq), day, time, name: extra.name || names.map(n => [].concat(n)[0]).join('、'),
  items: names.map(n => { const [name, grams = 100] = [].concat(n); return { name, grams, kcalPer100g: 100 }; }), ...extra });
const toast = (day, time, extra) => meal(day, time, ['吐司', '豆漿'], extra);
const pick = (list, now = NOW) => repeatCandidates(list, now);

test('時間工具：本地日期、日期位移、中位數（奇數取中間、偶數取中間兩筆平均四捨五入）', () => {
  assert.equal(localDay(NOW), '2026-11-05'); assert.equal(shiftDay('2026-11-05', -30), '2026-10-06'); assert.equal(shiftDay('2026-03-01', -1), '2026-02-28');
  assert.equal(medianTime(['08:00']), '08:00');
  assert.equal(medianTime(['07:00', '10:30', '08:00']), '08:00'); // 奇數：排序後中間那筆，不受極端值影響
  assert.equal(medianTime(['08:00', '08:30', '07:00', '23:00']), '08:15'); // 偶數：08:00 與 08:30 的平均
  assert.equal(medianTime(['08:00', '08:01']), '08:01'); // 480.5 分四捨五入成 481
  assert.equal(medianTime(['08:00', '08:03']), '08:02'); // 481.5 → 482
});

test('合併鍵：名稱正規化、忽略順序、重複名稱與克數；空名稱項目略過，全空則沒有鍵', () => {
  const key = names => candidateKey({ items: names.map(name => ({ name, grams: 1 })) });
  assert.equal(key(['吐司', '豆漿']), key(['豆漿', ' 吐司 ']));
  assert.equal(key(['Toast', '豆漿']), key(['toast', '豆漿！']));
  assert.equal(key(['吐司', '吐司', '豆漿']), key(['吐司', '豆漿'])); // 集合
  assert.notEqual(key(['吐司']), key(['吐司', '豆漿']));
  assert.equal(key(['吐司', '！？', '豆漿']), key(['吐司', '豆漿'])); // 正規化後為空的名稱不參與合併鍵
  assert.equal(key(['！？']), ''); assert.equal(key([]), '');
});

test('名稱順序不同、克數不同視為同一種，複製採最近一次（項目、克數與餐點 id）', () => {
  const older = meal('2026-11-03', '08:00', [['吐司', 60], ['豆漿', 250]]);
  const latest = meal('2026-11-04', '08:20', [['豆漿', 300], ['吐司', 90]], { name: '最近的早餐' });
  const [c, ...rest] = pick([older, latest]);
  assert.equal(rest.length, 0);
  assert.deepEqual(c, { mealId: latest.id, name: '最近的早餐', items: [{ name: '豆漿', grams: 300 }, { name: '吐司', grams: 90 }], kcal: 390, time: '08:10', count: 2 });
});

test('名稱全部正規化為空的餐點不成為候選', () => {
  assert.deepEqual(pick([meal('2026-11-03', '08:00', ['！']), meal('2026-11-04', '08:00', ['！'])]), []);
});

test('30 天邊界：往前第 30 天計入，第 31 天不計；未來日期不計', () => {
  assert.equal(pick([toast('2026-10-06', '08:00'), toast('2026-11-04', '08:00')])[0]?.count, 2);
  assert.deepEqual(pick([toast('2026-10-05', '08:00'), toast('2026-11-04', '08:00')]), []);
  assert.deepEqual(pick([toast('2026-11-06', '08:00'), toast('2026-11-04', '08:00')]), []);
});

test('刪除的餐點不計：只看傳入的餐點（呼叫端只傳仍存在的）', () => {
  const list = [toast('2026-11-03', '08:00'), toast('2026-11-04', '08:00')];
  assert.equal(pick(list).length, 1); assert.deepEqual(pick(list.slice(1)), []);
});

test('平日只算過去的平日；至少出現 2 次', () => {
  // 週六、週日的同一餐不計，只剩 1 次平日 → 不是候選
  assert.deepEqual(pick([toast('2026-10-31', '08:00'), toast('2026-11-01', '08:00'), toast('2026-11-04', '08:00')]), []);
  assert.equal(pick([toast('2026-10-30', '08:00'), toast('2026-11-04', '08:00')])[0].count, 2);
  // 今天自己的餐點不列入歸納
  assert.deepEqual(pick([toast('2026-11-04', '08:00'), toast('2026-11-05', '07:00')]), []);
});

test('假日（週六、日）本張先回傳空清單（ticket 03 補）', () => {
  const list = [toast('2026-11-03', '08:00'), toast('2026-11-04', '08:00')];
  assert.deepEqual(pick(list, new Date(2026, 10, 7, 13, 0)), []);
  assert.deepEqual(pick(list, new Date(2026, 10, 8, 13, 0)), []);
});

test('常見時間：奇數筆取中位數、偶數筆取中間兩筆平均', () => {
  assert.equal(pick([toast('2026-11-02', '07:00'), toast('2026-11-03', '10:30'), toast('2026-11-04', '08:00')])[0].time, '08:00');
  assert.equal(pick([toast('2026-11-03', '08:00'), toast('2026-11-04', '08:31')])[0].time, '08:16'); // 495.5 → 496
});

test('常見時間晚於現在不顯示；等於現在顯示', () => {
  const list = [meal('2026-11-03', '13:00', ['便當']), meal('2026-11-04', '13:00', ['便當']), meal('2026-11-03', '13:01', ['麵']), meal('2026-11-04', '13:01', ['麵'])];
  assert.deepEqual(pick(list).map(c => c.name), ['便當']);
});

test('今天前後 90 分鐘內（含 90）已有任何餐點就不顯示；91 分鐘仍顯示', () => {
  const history = [toast('2026-11-03', '08:00'), toast('2026-11-04', '08:00')];
  const withToday = time => pick([...history, meal('2026-11-05', time, ['別的東西'])]);
  assert.deepEqual(withToday('09:30'), []); assert.deepEqual(withToday('06:30'), []); assert.deepEqual(withToday('08:00'), []);
  assert.equal(withToday('09:31').length, 1); assert.equal(withToday('06:29').length, 1);
});

test('先過濾、依出現次數取前 5 個（同次數最近的優先），最後依時間由早到晚', () => {
  const list = [];
  const add = (name, time, days) => days.forEach(d => list.push(meal(`2026-11-0${d}`, time, [name])));
  add('A', '12:00', [2, 3, 4]); add('B', '07:00', [2, 3, 4]); add('C', '11:00', [2, 3, 4]); add('D', '09:00', [2, 3, 4]);
  add('H', '06:00', [2, 3, 4]); add('E', '10:00', [2, 3]); add('F', '10:30', [3, 4]); // 同為 2 次：F 最近一次較近，優先
  add('G', '12:30', [2, 3, 4, 2, 3]); // 次數最多，但今天 12:45 已有餐點 → 先被過濾，不佔名額
  list.push(meal('2026-11-05', '12:45', ['點心']));
  // 12:45 也擋掉 A（12:00 差 45 分）；C（11:00 差 105 分）不擋。剩 B/C/D/H 各 3 次、E/F 各 2 次，取 5 個時 F 勝過 E。
  assert.deepEqual(pick(list).map(c => `${c.time} ${c.name}`), ['06:00 H', '07:00 B', '09:00 D', '10:30 F', '11:00 C']);
  const noSnack = list.filter(m => m.day !== '2026-11-05');
  assert.deepEqual(pick(noSnack).map(c => c.name), ['B', 'D', 'C', 'A', 'G']); // G 5 次；A/B/C/D/H 各 3 次，同次數依最近一次（A 12:00 > C > D > B > H），H、E、F 被擠掉
});

test('一整天沒記：早餐與午餐同時列出並依時間排序；補記早餐後早餐消失', () => {
  const list = [toast('2026-11-03', '10:30'), toast('2026-11-04', '10:30'), meal('2026-11-03', '12:30', ['便當']), meal('2026-11-04', '12:30', ['便當'])];
  assert.deepEqual(pick(list).map(c => `${c.time} ${c.name}`), ['10:30 吐司、豆漿', '12:30 便當']);
  assert.deepEqual(pick([...list, toast('2026-11-05', '10:30')], NOW).map(c => c.name), ['便當']); // 10:30 與 12:30 相差 120 分
});

test('前端：只在檢視今天且有候選時顯示候選區', () => {
  const c = [{ mealId: 'x' }];
  assert.equal(showCandidates({ day: '2026-11-05', today: '2026-11-05', candidates: c }), true);
  assert.equal(showCandidates({ day: '2026-11-04', today: '2026-11-05', candidates: c }), false);
  assert.equal(showCandidates({ day: '2026-11-05', today: '2026-11-05', candidates: [] }), false);
  assert.equal(showCandidates({ day: '2026-11-05', today: '2026-11-05', candidates: undefined }), false);
});
