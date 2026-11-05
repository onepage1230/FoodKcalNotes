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

test('中位數跨午夜：叢集在午夜前後時以圓周計算，結果落在午夜附近', () => {
  assert.equal(medianTime(['23:50', '00:10']), '00:00'); // 偶數：23:50 與 24:10 的平均取模
  assert.equal(medianTime(['00:10', '23:50']), '00:00'); // 與輸入順序無關
  assert.equal(medianTime(['23:59', '00:00']), '00:00'); // 1439.5 四捨五入成 1440，再取模
  assert.equal(medianTime(['23:40', '00:20', '23:55']), '23:55'); // 奇數：中間那筆在午夜前
  assert.equal(medianTime(['23:50', '00:10', '00:30']), '00:10'); // 奇數：中間那筆在午夜後
  assert.equal(medianTime(['23:30', '23:50', '00:20', '00:40']), '00:05'); // 偶數：23:50 與 24:20 的平均
  assert.equal(medianTime(['22:00', '00:30']), '23:15');
});
test('中位數不跨午夜：維持一般時間軸的結果；單筆原樣', () => {
  assert.equal(medianTime(['00:30']), '00:30'); assert.equal(medianTime(['23:50']), '23:50');
  assert.equal(medianTime(['01:00', '02:00']), '01:30'); assert.equal(medianTime(['21:00', '23:30']), '22:15');
  assert.equal(medianTime(['00:10', '00:40', '01:30']), '00:40');
  assert.equal(medianTime(['07:00', '08:00', '23:00']), '08:00'); // 23:00 與 07:00 隔著午夜相距 8 小時，不算叢集在午夜前後
  assert.equal(medianTime(['08:00', '08:30', '07:00', '23:00']), '08:15');
});

// 「不晚於現在」與 90 分鐘視窗仍以當天時分比較（不繞圓周）：常見時間 00:00 的宵夜候選從 00:00 起整天都會出現，
// 直到今天 00:00～01:30 之間有餐點；今天 23:xx 的餐點不會讓它消失。
test('跨午夜的候選：常見時間 00:00，以當天時分比較，13:00 仍顯示；今天 00:30 有餐點就不顯示', () => {
  const late = [meal('2026-11-03', '23:50', ['鹹酥雞']), meal('2026-11-04', '00:10', ['鹹酥雞'])];
  assert.deepEqual(pick(late).map(c => [c.time, c.count]), [['00:00', 2]]);
  assert.deepEqual(pick([...late, meal('2026-11-05', '00:30', ['泡麵'])]), []);
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

// 假日規則（ticket 03）：週六 2026-11-07、週日 11-08 的 13:00。統計 30 天內所有日子，依最近一次由近到遠，時間用最近一次實際時間。
const SAT = new Date(2026, 10, 7, 13, 0), SUN = new Date(2026, 10, 8, 13, 0);
test('假日：候選包含平日吃過的餐點，且只出現一次也成為候選（count 為 1）', () => {
  const only = toast('2026-11-04', '08:00'); // 週三，僅 1 次
  for (const at of [SAT, SUN]) assert.deepEqual(pick([only], at).map(c => [c.mealId, c.count, c.time]), [[only.id, 1, '08:00']]);
});
test('假日：統計平日與假日所有日子，count 為 30 天內所有日子的出現次數', () => {
  const list = [toast('2026-11-06', '08:00'), toast('2026-11-01', '09:00'), toast('2026-10-28', '07:00')]; // 週五、週日、週三
  assert.equal(pick(list, SAT)[0].count, 3);
});
test('假日：30 天邊界以假日當天往前算；今天（假日）自己的餐點不歸納、未來不計', () => {
  assert.equal(pick([toast('2026-10-08', '08:00')], SAT)[0].count, 1); // 週六往前第 30 天
  assert.deepEqual(pick([toast('2026-10-07', '08:00')], SAT), []); // 第 31 天
  assert.deepEqual(pick([toast('2026-11-07', '07:00'), toast('2026-11-09', '08:00')], SAT), []);
});
test('假日：時間用最近一次實際時間，不用中位數', () => {
  const list = [toast('2026-11-02', '07:00'), toast('2026-11-03', '07:10'), toast('2026-11-06', '11:20')];
  assert.equal(pick(list, SAT)[0].time, '11:20'); // 中位數會是 07:10
  assert.equal(pick(list, SAT)[0].mealId, list[2].id);
});
test('假日：依最近一次由近到遠選取（同日看時間，同日同時刻以先出現者為準）', () => {
  const rank = list => pick(list, SAT).map(x => x.name);
  const six = ['F', 'G', 'H', 'I', 'J', 'K'].map((n, i) => meal(`2026-11-0${6 - i}`, '08:00', [n]));
  assert.deepEqual(rank(six).sort(), ['F', 'G', 'H', 'I', 'J']); // K（11-01）最舊，被擠掉
  const sameDay = ['P', 'Q', 'R', 'S', 'T', 'U'].map((n, i) => meal('2026-11-06', `0${i + 1}:00`, [n]));
  assert.deepEqual(rank(sameDay), ['Q', 'R', 'S', 'T', 'U']); // 同一天看時間：01:00 的 P 最舊
  const tie = rank(['X', 'Y1', 'Y2', 'Y3', 'Y4', 'Y5'].map(n => meal('2026-11-04', '09:30', [n])));
  assert.deepEqual(tie, ['X', 'Y1', 'Y2', 'Y3', 'Y4']); // 同日同時刻：先出現者優先，Y5 被擠掉
});
test('假日：同一組合以最近一次為代表（項目、克數、名稱）', () => {
  const old = meal('2026-11-03', '08:00', [['吐司', 60], ['豆漿', 250]], { name: '舊' });
  const latest = meal('2026-11-06', '09:15', [['豆漿', 300], ['吐司', 90]], { name: '新' });
  assert.deepEqual(pick([latest, old], SUN), [{ mealId: latest.id, name: '新', items: [{ name: '豆漿', grams: 300 }, { name: '吐司', grams: 90 }], kcal: 390, time: '09:15', count: 2 }]);
});
test('假日：套用不晚於現在與 90 分鐘內已有餐點則排除，並先過濾再取前 5 個', () => {
  const late = meal('2026-11-06', '13:01', ['晚於現在']), onTime = meal('2026-11-06', '13:00', ['剛好現在']);
  assert.deepEqual(pick([late, onTime], SAT).map(c => c.name), ['剛好現在']);
  const history = [toast('2026-11-06', '08:00')];
  const withToday = (time, at = SAT) => pick([...history, meal(at === SAT ? '2026-11-07' : '2026-11-08', time, ['別的'])], at);
  assert.deepEqual(withToday('09:30'), []); assert.deepEqual(withToday('06:30', SUN), []); assert.equal(withToday('09:31').length, 1); assert.equal(withToday('06:29', SUN).length, 1);
  // 先過濾：最近的三種被今天 11:30 的餐點擋掉，不佔 5 個名額
  const near = ['N1', 'N2', 'N3'].map((n, i) => meal(`2026-11-0${6 - i}`, '11:00', [n]));
  const far = ['F1', 'F2', 'F3', 'F4', 'F5'].map((n, i) => meal(`2026-10-${20 - i}`, `0${5 + i}:00`, [n]));
  assert.deepEqual(pick([...near, ...far, meal('2026-11-07', '11:30', ['點心'])], SAT).map(c => c.name), ['F1', 'F2', 'F3', 'F4', 'F5']);
});
test('假日：最多 5 個，輸出依時間由早到晚', () => {
  const names = ['A', 'B', 'C', 'D', 'E', 'F'], times = ['12:00', '07:00', '10:00', '08:30', '09:00', '06:00'];
  const list = names.map((n, i) => meal(`2026-11-0${6 - i}`, times[i], [n])); // A 最近、F 最舊
  assert.deepEqual(pick(list, SAT).map(c => `${c.time} ${c.name}`), ['07:00 B', '08:30 D', '09:00 E', '10:00 C', '12:00 A']);
});
test('平日、假日切換邊界：週五、週一用平日規則（至少 2 次、只算平日、中位數），週六、週日用假日規則', () => {
  const list = [toast('2026-11-02', '07:00'), toast('2026-11-03', '08:00'), toast('2026-11-06', '10:00')]; // 週一、週二、週五
  const single = [meal('2026-11-04', '08:00', ['單次'])];
  const FRI = new Date(2026, 10, 6, 13, 0), MON = new Date(2026, 10, 9, 13, 0);
  assert.deepEqual(pick(single, FRI), []); assert.deepEqual(pick(single, MON), []); // 平日：1 次不算
  assert.equal(pick(single, SAT).length, 1); assert.equal(pick(single, SUN).length, 1); // 假日：1 次也算
  assert.equal(pick(list, FRI)[0].time, '07:30'); // 週五看不到當天的餐點，只剩週一、週二兩次：中位數 07:30
  assert.equal(pick(list, MON)[0].count, 3); assert.equal(pick(list, MON)[0].time, '08:00');
  assert.equal(pick(list, SAT)[0].time, '10:00'); assert.equal(pick(list, SUN)[0].time, '10:00'); // 假日用最近一次
  assert.deepEqual(pick([toast('2026-11-07', '08:00'), toast('2026-11-08', '08:00')], MON), []); // 週一不計上週六、日
  assert.deepEqual(pick([toast('2026-11-05', '08:00')], FRI), []); assert.equal(pick([toast('2026-11-05', '08:00')], SAT).length, 1);
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
