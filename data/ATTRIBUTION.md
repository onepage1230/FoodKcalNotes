# 資料來源與授權標示

> The data files under `data/` are **not** covered by the project's MIT license. They are provided under the terms of their respective sources listed below.

`data/` 內的資料檔**不適用**專案的 MIT 授權，依各自來源的條款提供。程式執行時不會讀取這些檔案；它們只供 `scripts/import-foods.mjs` 匯入本機食物庫。

## tfda-common.json（137 筆）

衛生福利部食品藥物管理署 2025 年 食品營養成分資料集 2025版UPDATE1，依政府資料開放授權條款－第1版（https://data.gov.tw/license）提供

- 查詢頁面：https://consumer.fda.gov.tw/Food/TFND.aspx?nodeID=178
- 本專案擷取常見食物的「每 100g 修正熱量」，並整理名稱與同義名；原始樣品編號與說明保留在每筆的 `notes`。數值未經修改。
- 營養素（2026-11-02 補入）：依 `notes` 中的整合編號，從政府資料開放平台（https://data.gov.tw/dataset/8543 ，平台 2026-10-05 更新之 JSON）擷取每 100g 的「粗蛋白」「粗脂肪」「總碳水化合物」「糖質總量」（g）與「鈉」（mg），對應 `proteinPer100g`、`fatPer100g`、`carbsPer100g`、`sugarPer100g`、`sodiumMgPer100g`。數值未經修改；原始資料未分析的項目為 `null`。137 筆的修正熱量與該版本一致。

## hpa-2018-dishes.json（22 筆）

資料原刊載於衛生福利部國民健康署網站「熱量知多少」，依該署〈政府網站資料開放宣告〉（https://www.hpa.gov.tw/Pages/Detail.aspx?nodeid=92&pid=5141）提供。

| 項目 | 網址 |
| --- | --- |
| 原始網址（中式） | https://www.hpa.gov.tw/Pages/Detail.aspx?nodeid=1658&pid=9704 |
| 網頁封存（Wayback Machine，2024-10-04 快照） | https://web.archive.org/web/20241004020240/https://www.hpa.gov.tw/Pages/Detail.aspx?nodeid=1658&pid=9704 |

- 資料為 2018 年版本，原頁面已下架，本專案引用上述封存快照。
- 原資料為「每份」熱量與重量，本專案換算為每 100g，原始份量寫在每筆的 `notes`。份量與配方可能已改變。
- 原資料另列每份蛋白質、脂肪、醣類（整數公克），沒有糖與鈉；換算每 100g 精度過粗，本專案不採用，營養素留空，由 app 的 AI 補估並標示為估算。

## 說明

- 營養數值僅供參考，實際熱量會因品牌、份量、配方與烹調方式不同而有差異；不構成醫療或營養建議。
- 本專案與上述機關無關聯，亦未獲其背書。
- 自行匯入其他資料（例如品牌官網的營養標示）時，請自行確認來源的使用條款。
