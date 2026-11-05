// 序號防護：begin() 開始一次請求並回傳序號，isCurrent(序號) 只對最後一次開始的請求為真，
// 較早送出的回應晚到時就不採用，避免舊資料蓋掉新資料。
export function latest() { let n = 0; return { begin: () => ++n, isCurrent: id => id === n }; }
