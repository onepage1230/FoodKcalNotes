**English** below · [繁體中文](#繁體中文)

# Server flags: other Tailscale identities

The server identifies each remote request by the `Tailscale-User-Login` header that Tailscale serve adds.

- **Your own devices** (any request whose login equals `OWNER_LOGIN`) and the computer itself share the main journal. **No flag is needed for this.** With `OWNER_TOKEN=1` they must also carry the paired `owner_token` cookie; without it they only see the pairing screen.
- **Any other login** gets its own separate journal file (`friends/meals-<hash>.sqlite`). Meals, settings and plans are kept apart; the food library is the owner's.

This exists so that a **single user** can record from several devices and test, for example with a second Tailscale test account, that journals and the food library do not get mixed up. It is **not** a feature for sharing the app with other people.

| Variable | Default | Effect |
|---|---|---|
| `OWNER_TOKEN` | off (`1` in `docker-compose.yml`) | When `1`, being the owner (local `127.0.0.1` or `OWNER_LOGIN`) also requires an `owner_token` cookie matching the random pairing code in `<data dir>/owner.token` (created on first start, 0600). Checked on every request (SHA-256, constant-time compare). Unpaired requests get only the page, static files, a minimal `/api/status` and `POST /api/pair`; every other `/api` and `/auth` path returns 401. Pairing URLs and the code are printed at startup (visible in `docker-compose logs`). Failed pairings: at most 5 per minute for the whole process, then 429. Other logins never need the token, and carrying it does not make them the owner. Only `1` or `0`/empty are accepted. |
| `CHATGPT_SHARED` | off | When `1`, requests from other logins may use the ChatGPT sign-in. When off, the ChatGPT provider is skipped for them and only API-key providers (e.g. Claude) are used. |
| `FRIENDS_CACHE` | off | When `1`, meals saved by other logins may add foods and aliases to the food library. When off, they never write to it. |
| Photo cap | 100 | Each other login's journal keeps at most 100 meal photos. Saving more clears the photo of the earliest-saved meal (the meal and its items stay); the journal file uses incremental auto-vacuum so the space is returned to disk. The owner's journal is not limited. Fixed in `server/server.js` (`FRIEND_PHOTO_LIMIT`), not an environment variable. |
| `FRIENDS_DAILY_LIMIT` | `30` | AI requests (analyze, re-lookup, AI estimate) each other login may make per day, by server local date; `0` means no daily limit. Each other login may also have at most 2 AI requests running at once. Counts are kept in memory and reset when the server restarts. The owner is not limited. Over the limit the request is refused with HTTP 429. |

**ChatGPT policy.** OpenAI's terms do not allow sharing a ChatGPT account or its usage with other people. The "Sign in with ChatGPT" login is only for your own account, used by you. Leave `CHATGPT_SHARED` off unless every login it applies to is you, for example your own test account. Turning it on for other people is against OpenAI's terms and at your own risk.

The read-only admin view that lists every journal is available only on the computer itself (`127.0.0.1`), never remotely.

Code: `server/server.js` (reads the flags), `server/storage.js` (`owner.token`), `server/app.js` (owner check, pairing, ChatGPT availability), `server/food-routes.js` (usage limits) and `server/journal.js` (food-library writes).

---

## 繁體中文

# 伺服器旗標：其他 Tailscale 身分

伺服器依 Tailscale serve 附上的 `Tailscale-User-Login` 標頭，辨識每個遠端請求是誰。

- **你自己的裝置**（登入帳號等於 `OWNER_LOGIN` 的請求）和電腦本機共用主日誌，**不需要任何旗標**。設 `OWNER_TOKEN=1` 時還要帶配對過的 `owner_token` cookie，沒有就只看得到配對畫面。
- **其他登入身分**會各自有一本獨立的日誌檔（`friends/meals-<hash>.sqlite`）。餐點、設定、計劃彼此分開；食物庫用的是擁有者那一份。

這個機制是為了讓**同一位使用者**能從多台裝置記錄，並實際測試資料不會混在一起，例如用第二個 Tailscale 測試帳號確認日誌和食物庫是分開的。它**不是**用來把 App 分享給其他人的功能。

| 變數 | 預設 | 作用 |
|---|---|---|
| `OWNER_TOKEN` | 關閉（`docker-compose.yml` 為 `1`） | 設為 `1` 時，擁有者（本機 `127.0.0.1` 或 `OWNER_LOGIN`）還必須帶 `owner_token` cookie，且與 `<資料夾>/owner.token` 的隨機配對碼相符（第一次啟動時產生，0600）。每次要求都比對（SHA-256、固定時間比較）。未配對的要求只能取得頁面、靜態檔、精簡的 `/api/status` 與 `POST /api/pair`，其他 `/api`、`/auth` 一律 401。配對網址與配對碼在啟動時印出（`docker-compose logs` 看得到）。配對失敗全程序每分鐘最多 5 次，超過回 429。其他登入身分不需要 token，帶了也不會變成擁有者。只接受 `1` 或 `0`／空白。 |
| `CHATGPT_SHARED` | 關閉 | 設為 `1` 時，其他登入身分的請求也能使用 ChatGPT 登入。關閉時，對它們會略過 ChatGPT，只使用 Claude 這類 API key 服務。 |
| `FRIENDS_CACHE` | 關閉 | 設為 `1` 時，其他登入身分存的餐點可以新增食物和同義名到食物庫。關閉時完全不寫入。 |
| 照片上限 | 100 | 每個其他登入身分的日誌最多保留 100 張餐點照片；再存新照片時會清掉最早存入那筆餐點的照片（餐點與品項保留），日誌檔使用 incremental auto_vacuum，空間會還給磁碟。擁有者的日誌不受限。上限寫在 `server/server.js`（`FRIEND_PHOTO_LIMIT`），不是環境變數。 |
| `FRIENDS_DAILY_LIMIT` | `30` | 其他登入身分每天可送出的 AI 要求次數（分析、重新查詢、AI 估算各算一次），以伺服器本地日期計算；`0` 表示不限每日次數。每個其他身分同時也最多只能有 2 個 AI 要求在進行。計數存在記憶體，伺服器重啟就歸零。擁有者不受限。超過上限時以 HTTP 429 拒絕。 |

**ChatGPT 政策。** 依 OpenAI 使用條款，ChatGPT 帳號和額度不可分享給其他人。「Sign in with ChatGPT」登入只供你本人使用自己的帳號。除非這個旗標涵蓋的每個登入身分都是你自己（例如你的測試帳號），否則請保持 `CHATGPT_SHARED` 關閉。為其他人開啟違反 OpenAI 條款，風險自負。

列出所有日誌的唯讀管理員檢視，只能在電腦本機（`127.0.0.1`）開啟，遠端一律無法使用。

程式位置：`server/server.js`（讀取旗標）、`server/storage.js`（`owner.token`）、`server/app.js`（擁有者判斷、配對、ChatGPT 是否可用）、`server/food-routes.js`（用量限制）與 `server/journal.js`（食物庫寫入）。
