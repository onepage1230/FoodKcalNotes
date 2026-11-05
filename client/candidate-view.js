// 首頁候選餐點區：只在檢視今天、且伺服器回傳至少一個候選時顯示；否則整區不顯示（spec repeat-meals）。
export const showCandidates = ({ day, today, candidates }) => day === today && Array.isArray(candidates) && candidates.length > 0;
