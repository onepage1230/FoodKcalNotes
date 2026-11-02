# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 指令

需要 Node.js 24 以上（使用 `node:sqlite`）。沒有 lint、沒有 TypeScript。

```sh
npm ci
npm test                                   # node --test，OAuth 與模型都是模擬的，不耗額度
node --test tests/food.test.js             # 單一測試檔
node --test --test-name-pattern="關鍵字" tests/app.test.js   # 單一測試
npm run build                              # vite build → dist/（npm start 需要它）
npm start                                  # http://127.0.0.1:3000，PORT 可覆寫
npm run dev                                # Vite middleware 模式；拒絕所有遠端（Tailscale）要求
npm run import-foods -- data/xxx.json [--dry-run]
npm run fill-nutrients -- data/tfda-common.json [--dry-run]   # 用內附資料補既有食物庫的營養素（Docker 要在容器內執行）
docker-compose up -d --build               # 見 README「Docker／群暉 NAS 部署」
```

環境變數：`PORT`、`MEAL_JOURNAL_DATA_DIR`（預設 `~/.my-chatgpt-local`）、`REMOTE_ORIGINS` + `OWNER_LOGIN`（兩者必須同時設定）、`CHATGPT_SHARED`、`FRIENDS_CACHE`（見 `server/README.md`）、`TZ`。

## 架構

單一 Express 程序同時提供 API 與 Vite 建置的 React SPA（`client/`、根目錄 `index.html`，沒有 vite.config）。

- `server/server.js`：讀環境變數、開資料庫、組裝 `createApp`，**只綁 127.0.0.1**。
- `server/app.js`：`createApp(...)` 以依賴注入接收 `store`、`oauth`、`fetcher`、`anthropicFactory`、`journalFor` 等，測試靠替換這些物件來模擬，不打真實網路。這裡負責安全層（session、CSRF、本機／遠端判斷）、ChatGPT OAuth、AI 服務順序與備援（`providerChain`）。
- `server/food-routes.js`：日誌 API 與背景工作（`/api/analyze` 建立 job → 背景執行 → 自動存成餐點）；`fallbackWorthy` 決定哪些錯誤換下一個 AI 服務，`retryOnTimeout` 逾時重試一次。
- `server/food-analysis.js`：辨識與查熱量流程。`analyzeMeal`：一次辨識呼叫（JSON Schema 結構化輸出）→ 包裝營養標示 → 本機食物庫 → 未命中項目最多 3 個並行 `lookupItem`（網路搜尋，引用網址必須出現在工具的 citation 中才算 `web`；否則 LLM 估算）。
- `server/journal.js`：`node:sqlite` 資料層（餐點、照片、設定、jobs、食物庫）。`EXCLUSIVE` 互斥詞規則與 `conflicts()` 擋下炸≠蒸、無糖≠含糖等，模型無法推翻。
- `server/claude.js`：Claude API 的 `infer` 實作，與 ChatGPT（Responses API + SSE，`sse.js`）對外介面一致，所以分析流程不知道是哪個服務在處理。
- `server/storage.js`：`credentials.json`。Windows 用 DPAPI 保護的 AES-256-GCM，其他平台明文 0600，並會對資料夾 `chmod 0700`（資料夾擁有者不對時啟動即失敗）。

### 身分與日誌

- 經 Tailscale serve 的請求（帶 `Tailscale-User-Login` 或 `X-Forwarded-*`）一律視為遠端，即使 `Host` 是 127.0.0.1。安全模型依賴這點，**不要**加入其他反向代理或改綁 0.0.0.0。
- 本機與 `OWNER_LOGIN` 共用主日誌 `meals.sqlite`；其他登入身分各自一本 `friends/meals-<sha256前16碼>.sqlite`，食物庫共用主日誌。
- ChatGPT 登入、切換、登出、`/api/providers`、管理員檢視都只限本機，因為 OAuth 回程網址固定是 `http://127.0.0.1:<PORT>`。

### 不可違反的設計原則（見 `docs/decisions/` ADR）

判斷原則：**準確優先，其次省 token。**

- 熱量 = 克數 × 每100g熱量 ÷ 100，由程式計算（`journal.js` 的 `kcal`、前端 `energy`），模型只給克數與每100g熱量，不給總熱量。
- 每項都有 `source`：`label`／本機庫（`matched`）／`web`／`llm`。只有引用經驗證的才能標 `web`。
- 食物庫快取：未經修改的 `web` 與 `label` 結果保存時寫入，同名不覆蓋；背景自動存檔的 `llm` 估算與使用者改過的項目不寫入；朋友日誌預設不寫入。
- 營養素（蛋白質、脂肪、碳水、糖、鈉，每 100g）：`null` 是未知，不等於 0；總計回傳已知總量與未知數（顯示「至少」）。補估呼叫只填營養素、不改熱量，補的欄位列入 `estimated`（畫面標「估」）。`web` 的營養素只取與熱量同一個被引用的來源；引用驗證失敗降級為 `llm` 時，回應中的營養素全部捨棄。
- 營養素的食物庫快取例外（`journal.js` 的 `mergeNutrients`）：庫裡 `null` 的欄位可被補上；`estimated` 的欄位只能被有出處（非命中的 `web`／`label`）的值覆蓋；有出處的永不覆蓋；熱量、名稱、來源不動。使用者改過營養素的項目（`nutrientsEdited`）與預設的朋友日誌不寫入。連勝只看熱量，不看營養素。
- 日期、時間、用餐時段（`mealTimeContext`）、連勝的「今天」都用**伺服器本地時間**，容器內必須設 `TZ`。

## 慣例

- 程式註解、錯誤訊息、UI 文字一律繁體中文；README 有中（`README.md`）英（`README.en.md`）兩份，修改時兩份同步。
- ES modules，程式碼風格偏緊湊（多個敘述寫在同一行），沿用既有風格。
- `data/` 是內附的營養資料（git 追蹤），不是執行期資料夾。
