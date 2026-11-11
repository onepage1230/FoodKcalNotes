**English** | [繁體中文](README.md)

# 飲食日誌 · FoodKcalNotes

A meal and calorie journal that runs on your own computer (PWA; Express + `node:sqlite` + React/Vite), designed around common Taiwanese foods and portion sizes. Snap a photo or type a description on your phone; AI identifies the foods and portions, calories come first from your local food library and verifiable sources, and the final numbers are computed by code. The guiding principle is **accuracy first, fewer model calls second**.

The app's interface is in Traditional Chinese (Taiwan) and it is tuned for Taiwanese foods.

For architecture details (system, recognition pipeline, database), see [`docs/architecture.html`](docs/architecture.html).

> **License:** This project is open source under the [MIT License](LICENSE). You are free to use, modify, and redistribute it, including for commercial purposes. **If you create derivative works or redistribute it, please keep the original copyright notice and the full MIT license text.** Nutrition data in `data/` is licensed by its respective sources; please credit them as described in [`data/ATTRIBUTION.md`](data/ATTRIBUTION.md).

## Highlights

<p align="center"><img src="docs/img/highlights.svg" alt="Highlights overview" width="100%"></p>

- **Gets more accurate and cheaper the more you use it**: Web lookups and package nutrition labels are saved to your local food library automatically when you save a meal (existing entries with the same name are never overwritten; items whose name or calories you edited are not saved; later sourced data can replace estimated nutrients already in the library). The next time you log the same food it hits the library directly with no model call. When the AI judges two names to be the same food, it automatically learns the new name; you can also teach it with 「其實是同一種」("It's actually the same thing").
- **The framework is free and open source; just bring your own AI**: The app is free and MIT-licensed. Sign in with your own ChatGPT account via OAuth (no OpenAI API key needed), or enter your own Claude API key. Both can be configured at once and are used in order with automatic fallback. AI usage counts against your own plan or account.
- **Streaks and weight-loss goals**<br>`TDEE = (10 × 體重kg + 6.25 × 身高cm − 5 × 年齡 + 5〔男〕／−161〔女〕) × 活動係數`<br>(weight kg, height cm, age, +5 male / −161 female, activity factor.) Set a daily calorie target and a weight-loss plan (weekly loss and estimated goal date based on the Mifflin-St Jeor equation). Counting back from today, each day that has entries and stays within the target extends your streak, shown with a flame icon on the home screen.
- **Five nutrients and daily goals**: Besides calories, each food also records protein, fat, carbohydrate, sugar (total sugars) and sodium per 100 g, with totals computed by code. Anything that cannot be found is recorded as "unknown", never 0, and totals read "at least X g"; AI-backfilled numbers are marked 「估」(estimate). The weight-loss plan derives suggested daily nutrient goals from the HPA's DRIs (8th edition); you can override each one, and the home screen only shows a warning when it is confident.
- **Weight records and trend chart**: Record one weight per day (recording again on the same day overwrites it; you can backfill, edit or delete past days, but not future ones), with or without a weight-loss plan. The weight card in Settings draws daily weights with a 7-day moving average, adds the plan line when there is a plan, and shows how many days since your last record; every journal keeps its own records.
- **Portion estimates with a basis**: Weight is estimated from the proportions of common objects in the photo (chopsticks, rice bowls, phones), and your fist size is derived from your height, so text like 「飯一拳頭」("a fist of rice") can be converted too.
- **Package labels are more accurate**: When a nutrition label in the photo is clearly legible, values are converted straight from the label with no extra lookup.
- **Close the app right after the photo**: Analysis runs in the background and is saved as a meal automatically when done; you can edit it later. After renaming an item, 「以新名稱重新查詢」("Look up again with new name") re-queries just that item.
- **Tells pan-fried from deep-fried**: The prompt explicitly asks the model to name the visible cooking method and amount of oil (pan-fried chicken leg, fried chicken cutlet, glossy stir-fried greens, blanched, thickened sauce), and lookups must match the cooking state. Code additionally blocks mutually exclusive terms such as fried ≠ steamed, raw ≠ cooked, and unsweetened ≠ sweetened, so tea eggs, braised eggs, and boiled eggs are never mixed up. The exclusive-term list is `EXCLUSIVE` in `server/journal.js`; edit it as needed.
- **Built-in Taiwanese data**: Ships with 137 entries from the TFDA (Taiwan Food and Drug Administration) food nutrient database (including protein, fat, carbohydrate, sugar and sodium) and 22 from the HPA (Health Promotion Administration) 「熱量知多少」 calorie guide, so breakfast and street foods like egg crepes (蛋餅), xiaolongbao (小籠包), and oyster omelets (蚵仔煎) work out of the box. You can also import your own data with `npm run import-foods` (same format as data/*.json). Built-in data lives in `data/*.json`.
- **Every item is traceable to a source**: Each item is labeled with its source (nutrition label / local food library / web data / LLM estimate). Web data comes with citations you can click to verify, and a citation only counts if its URL actually appears in the search results.

## Design rationale (research)

- **Portion size is the biggest source of error, so grams can be corrected anytime and code recomputes calories instantly**: Studies show that, given the correct weight of each ingredient, a multimodal LLM's calorie error dropped from about 51% to as low as 29% ([Bhatambarekar, Virginia Tech master's thesis, 2025](https://vtechworks.lib.vt.edu/items/b67c2a61-f283-41ba-9602-9798306b9529)); ChatGPT-5's calorie MAPE was 30.5% from the photo alone and 13.9% with detailed ingredient information ([Nutrients, 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC12655113/)). In this app the grams are still estimated by the AI, but kcal per 100 g comes from verifiable data, so correcting the grams recomputes calories immediately without calling the AI again.
- **Meal time is added to the prompt**: Adding contextual information such as time and location to the prompt reduced mean portion error by about 53 g across models ([arXiv:2507.07048, 2025](https://arxiv.org/abs/2507.07048)); this app adds only the time of day and does not use location.
- **ChatGPT by default, Claude as an optional fallback**: On multi-food Nutrition5k meals, per-item gram error (PMAE) was 38.7% for GPT-5.5 versus about 51–53% for Claude Opus 4.8 and Fable 5 ([arXiv:2607.16514, 2026](https://arxiv.org/abs/2607.16514)); in another study every model underestimated grams by 12–37%, with Haiku 5.5 at about −37% ([arXiv:2610.26538, 2026](https://arxiv.org/abs/2610.26538)). The order can be changed in settings.
- **No monocular depth or 3D reconstruction**: Depth information from a single photo brought no improvement in the study above ([arXiv:2607.16514, 2026](https://arxiv.org/abs/2607.16514)). In MetaFood 2025 single-image volume estimation, the best 3D-reconstruction method had a MAPE of 0.21 versus 0.34 for GPT-5.2 estimating directly ([arXiv:2602.13041, 2026](https://arxiv.org/abs/2602.13041)). 3D reconstruction is more accurate but requires building a whole separate reconstruction pipeline, so this app estimates weight from the proportions of reference objects in the photo instead.
- **Past photos are not sent to the model as examples**: Multimodal in-context learning relies mainly on text, and images have almost no effect ([CVPR 2024 Workshop](https://arxiv.org/abs/2404.15736)); adding the 5 most similar database meals to the prompt only changed calorie MAE from 120.38 to 120.21 ([SnappyMeal, 2025](https://arxiv.org/abs/2511.03907)).

Figures are the original papers' results on their own datasets; actual results vary with how you use the app.

Architecture decision records (in Chinese) are in [`docs/decisions/`](docs/decisions/).

## Features

<p align="center">
  <img src="docs/img/screen-home.png" width="200" alt="Home: today's meals, total calories, week strip, and streak">
  <img src="docs/img/screen-result.png" width="200" alt="Result page: items, source tags, weight, and kcal per 100 g">
  <img src="docs/img/screen-plan.png" width="200" alt="Settings: daily target and weight-loss plan">
</p>
<p align="center">
  <img src="docs/img/screen-foods.png" width="200" alt="Local food library">
  <img src="docs/img/screen-home-dark.png" width="200" alt="Home (dark theme)">
</p>
<p align="center"><sub>Home · Result page · Daily target and weight-loss plan · Local food library · Dark theme (all demo data)</sub></p>

- **Logging**: Take a photo, pick one from your gallery, or type text (e.g. 「一碗滷肉飯，飯約150克」, "a bowl of braised pork rice, about 150 g of rice"). You can log a meal manually without setting up any AI.
- **Background analysis**: Runs in the background after you submit, so you can close the app; when done it is **saved as a meal automatically** (timestamped at submission) and can be edited later.
- **Calorie sources**: Package nutrition label → local food library → web search (verifiable citations required) → LLM estimate, with the source shown on every item. Calories = weight × kcal per 100 g ÷ 100, computed by code, never by the model.
- **Nutrients**: Each item records protein, fat, carbohydrate, sugar (total sugars) and sodium per 100 g, also computed by code from the grams. Sources follow the same order as calories: package label, food library, web search (only values from the same cited source as the calories are used), then AI backfill. Nutrients a source lacks are backfilled together in one AI call per meal, which fills nutrients only and never changes calories. Whatever cannot be estimated stays "unknown" rather than 0, so meal and daily totals read 「至少 X g（N 項未知）」("at least X g, N items unknown"). AI-estimated numbers are marked 「估」; editing one removes the mark. Nutrients are collapsed per item by default; tap an item to view or edit them.
- **Consistency warning**: When calories differ from "protein×4 + carbs×4 + fat×9" by more than 25% (only checked at 50 kcal per 100 g or more), a warning appears; the usual cause is a per-serving value entered as per-100 g. It only warns: it never blocks saving or edits anything.
- **Daily nutrient goals**: The weight-loss plan derives suggested goals from the HPA's DRIs (8th edition) and national dietary guidelines, each with its basis: a protein minimum (1.1 g per kg of body weight in maintenance, 1.2 g for ages 71+; while a weight-loss plan is in progress it rises to 1.4 g/kg of the larger of your starting and current weight so it does not fall as you lose weight, with only a third of the weight above the BMI 25 reference counted and never below the maintenance value; 1.4 is indirect evidence, and people with reduced kidney function are advised to ask a doctor or dietitian first), reference ranges for fat (20–30% of calories) and carbohydrate (50–65%), a sugar maximum (10% of calories; this uses the added-sugar standard but the app records total sugars, so it may overstate), and a sodium maximum of 2,300 mg. Every goal can be overridden and restored with one tap; goals you have not overridden recompute when your weight or daily calorie target changes. The home screen shows five progress rows under calories; it flags "over" only when the known total of sugar or sodium already exceeds the maximum, and says only "may be short" for protein when some items are unknown. Goals apply from the day the feature went live, so earlier meals show no warnings; streaks still look at calories only.
- **Result page**: Edit name, weight, kcal per 100 g, and date/time. 「以新名稱重新查詢」re-queries a single item in the background; items with 0 kcal can use 「AI 估算」("AI estimate"); 「其實是同一種」saves the recognized name as a synonym of a local food.
- **Home**: Each day's meals and total calories, with week-by-week navigation. Streak 🔥 = the number of consecutive days, counting back from today, that "have entries and whose daily total does not exceed the target".
- **Repeat logging**: Today's home screen lists up to 5 candidate meals you usually eat but have not logged yet. One tap saves that meal as a new meal for today (items and the grams from its most recent occurrence, at the candidate's time) without calling the AI; you can still edit it afterward on the detail page. Candidates are derived on the fly from the past 30 days of entries (meals with the same item names count as one, regardless of grams), so there is no list to maintain. On weekdays only past weekdays are counted, a meal must have been eaten at least twice, candidates are ranked by count, and the time is the median of its past times (the "usual time"). On weekends (Saturday and Sunday; public holidays are not considered) it shows what you ate most recently, regardless of weekday or weekend, at the actual time of its latest occurrence. A candidate appears only if its time is no later than now and no meal is logged within 90 minutes of it today, so logging at 13:00 still shows the 10:30 breakfast, and a day with nothing logged lists breakfast and lunch together. The detail page's 「再記一次」("Log again") copies any existing meal into a new meal for today at the current time. Neither path copies the photo, writes to the food library, or backfills nutrients; each journal computes its own candidates.
- **Weight-loss plan**: Basic info → activity level → estimated weekly loss and goal date from your daily target. Method: 1. daily expenditure TDEE = BMR (Mifflin-St Jeor) × activity factor; 2. weekly loss = (TDEE − daily target) × 7 ÷ 7,700 kcal, from which the goal date is projected (you are warned if the target is below the recommended minimum intake). The goal date and the plan line are projected from the starting weight, the start date and the daily target at the moment the plan was set, so recording weights or changing the daily target later does not move them; the progress percentage is based on weight (it drops if you regain), and the app shows how many kg you are above or below the plan line. TDEE and weekly loss are recomputed from the current weight (your latest weight record) and shown separately. Changing activity, height, age or the target weight re-estimates the goal date; press 「重新開始計劃」(restart plan) to start over from your current weight and today.
- **AI services**: ChatGPT sign-in and a Claude API key can both be configured; they are used in order with automatic fallback.
- **Mobile use**: Open the app from your own phone via Tailscale serve, sharing the same journal as your computer.
- Light/dark theme and JSON backup export.

## Architecture overview

The architecture document ([`docs/architecture.html`](docs/architecture.html)) and the highlight/diagram images are in Chinese.

### System architecture

<p align="center"><img src="docs/img/architecture.svg" alt="System architecture diagram" width="100%"></p>

The server listens only on 127.0.0.1; phones and other devices connect back to the same computer through Tailscale serve, sharing the same journal and server-side credentials.

### Recognition and calorie pipeline

<p align="center"><img src="docs/img/recognition.svg" alt="Recognition and calorie pipeline diagram" width="100%"></p>

Orange steps call a model; everything else is handled by code. Items matched by a nutrition label or the food library need no further model calls (saving tokens); items whose calories have a source but whose nutrients have gaps get at most one more batched backfill call per meal. On save, unedited "web data" and "nutrition label" results are cached into the food library automatically; LLM estimates from background auto-saves and items edited by the user are not cached (the nutrient exception is described under "Data & food library").

## Quick start

Requires **Node.js 24 or later** (uses `node:sqlite`).

**Windows**: Double-click `start.bat` in the project root. The first run does `npm ci`, then builds the UI, sets up Tailscale serve (if installed), starts the service, and opens **http://127.0.0.1:3000**. If it is already running, it just opens the page. Close the window or press `Ctrl+C` to stop.

**macOS/Linux**:

```sh
npm ci && npm run build && npm start
```

Then open http://127.0.0.1:3000. The port defaults to 3000 and can be overridden with the `PORT` environment variable.

> Credential protection: On Windows, credentials are encrypted with AES-256-GCM and the master key is protected by Windows DPAPI. macOS/Linux have no DPAPI, so `credentials.json` is stored in **plain text**, protected only by 0700 folder and 0600 file permissions.

## AI services

Configure them on your computer under 設定 → AI 服務 (Settings → AI services). You can use just one or enable both.

ChatGPT sign-in credentials and the Claude API key are stored only in `credentials.json` on your computer (encrypted on Windows; see "Credential protection" above) and are never sent to the browser or other devices. Through Tailscale serve, your devices (phone, tablet, other computers) all connect back to this computer and use the same server-side credentials. ChatGPT sign-in is for your own account only; per OpenAI's terms of use, do not share your account or quota. Claude API usage is billed to the account that owns the API key; other Tailscale identities have a daily cap on AI analyses (`FRIENDS_DAILY_LIMIT`, see [`server/README.md`](server/README.md)).

- **ChatGPT (optional)**: Click Continue with ChatGPT to sign in and authorize, then choose a recognition model (photos require a model with image input). It uses your ChatGPT plan's quota; no OpenAI API key is needed. Signing in, switching, and signing out **can only be done on the computer** at `http://127.0.0.1:3000`, because the authorization redirect URL is fixed to localhost.
- **Claude API**: In the [Claude Console](https://console.anthropic.com/), create an API key **inside a Workspace** and paste it into settings. Before saving, it is validated with the free Token Counting API (for the selected model) and is not saved if invalid; keys not tied to a workspace are rejected with an explanation. Only the last four characters are shown. Choose Haiku 5.5 (default, cheapest), Sonnet 5.5, or Opus 5.5.
- **Order and fallback**: Each call uses the first enabled, available service in the list. On expired authorization, quota or rate limits, server errors, timeouts (after 1 retry), network errors, or requests the service rejects (HTTP 400), it automatically moves to the next one. Every AI-processed item notes which service and model actually handled it (e.g. 「（由 Claude Haiku 5.5 處理）」, "(processed by Claude Haiku 5.5)").
- **Cost**: ChatGPT consumes your plan's quota; the Claude API is billed by Anthropic based on usage (per token, with web search billed separately), so set a spending limit in the Console. Each meal makes exactly 1 recognition call, and items matched in the local food library make no further model calls; when nutrients have gaps, at most 1 extra backfill call per meal.

## Using from your phone (Tailscale)

The service listens only on 127.0.0.1. To use it from your own phone, [Tailscale](https://tailscale.com/download) serve forwards `https://<電腦名稱>.<tailnet>.ts.net:8443` (`<電腦名稱>` = your computer's name) to local port 3000, reachable only within your tailnet. The computer must be on and running the service. Without Tailscale, you can still use it locally. **Do not** expose it publicly through another reverse proxy instead: the server trusts the identity headers Tailscale attaches, and behind other proxies those headers could be forged.

1. Install Tailscale on your computer and phone and sign in with the same account.
2. Run `tailscale serve --https=8443 --bg 3000` (`start.bat` on Windows does this automatically).
3. Create `start.local.bat` in the project root (already in `.gitignore`; on macOS/Linux, set environment variables instead):

   ```bat
   set "REMOTE_ORIGINS=https://<電腦名稱>.<tailnet>.ts.net:8443"
   set "OWNER_LOGIN=<你的 Tailscale 登入帳號>"
   rem 選填：Tailscale 不在預設位置時
   rem set "TAILSCALE=C:\Program Files\Tailscale\tailscale.exe"
   ```

   `REMOTE_ORIGINS` is the URL you open on your phone; `OWNER_LOGIN` is your Tailscale login (`<你的 Tailscale 登入帳號>`), so your phone and computer use the same journal. (The `rem` comment means: optional, if Tailscale is not in its default location.)
4. Open the ts.net URL on your phone and choose "Add to Home Screen" in the browser.

ChatGPT sign-in and AI service settings can only be changed on the computer; on your phone you can log, view, and edit meals.

## Docker / Synology NAS deployment

To keep the service always on without a laptop, run it with Docker on a NAS or Linux host. Tested on a Synology DS920+ (DSM 7.1, `docker-compose` 1.28).

1. Get the project and create the config:

   ```sh
   git clone https://github.com/<your-account>/FoodKcalNotes.git app && cd app
   cp .env.example .env        # fill in REMOTE_ORIGINS, OWNER_LOGIN, DATA_DIR
   sudo mkdir -p /volume1/docker/foodkcal/journal
   sudo chown 1000:1000 /volume1/docker/foodkcal/journal && sudo chmod 700 /volume1/docker/foodkcal/journal
   sudo docker-compose up -d --build
   sudo docker-compose logs --tail 20      # success once the startup banner appears
   ```

2. Install Tailscale on the host and run `sudo tailscale serve --https=8443 --bg 3000`; open the `REMOTE_ORIGINS` URL on your phone (same as "Using from your phone" above).
3. Update: `git pull && sudo docker-compose up -d --build`.

Notes:

- **`network_mode: host` is required**: the server only listens on 127.0.0.1, so ordinary port mapping cannot reach it.
- **Time zone**: meal date, time and meal-period all use the server's local time, and containers default to UTC (8 hours behind Taipei). `docker-compose.yml` defaults to `TZ=Asia/Taipei`; override with `TZ=...` in `.env`.
- **`DATA_DIR` must be a separate folder**, not the repo's `data/` (bundled nutrition data), and owned by uid 1000, otherwise startup fails with `EPERM` on `chmod`.
- **ChatGPT sign-in must be completed at `127.0.0.1:3000`**. On a host without a browser, open an SSH tunnel from your computer: `ssh -L 3000:127.0.0.1:3000 user@host -p <port>`, then open `http://127.0.0.1:3000`. Close it afterwards. The Claude API key can likewise only be set at `127.0.0.1:3000` (remote connections do not see the AI service settings), so it also needs this tunnel.
  - Synology defaults to `AllowTcpForwarding no`. Append `Match User <account>` and `AllowTcpForwarding yes` at the **end** of `/etc/ssh/sshd_config`, check with `sudo sshd -t`, then `sudo synosystemctl restart sshd`. Back it up first; DSM updates or changing SSH settings in the UI may overwrite it.
  - After restarting sshd, **existing SSH sessions keep the old setting**: reconnect. If a stale `ssh` still holds local port 3000, the new forward fails (check with `lsof -nP -iTCP:3000 -sTCP:LISTEN`).
  - If a proxy tool such as Surge interferes with 127.0.0.1, compare against `curl --noproxy '*'` to tell whether the proxy is intercepting.
- Backup: `meals.sqlite` (with `-wal`, `-shm`) and the plaintext `credentials.json` in `DATA_DIR`; choose a backup destination you trust.

## Data & food library

- **Local food library**: Stored in the journal database; read-only in the app, with no UI to add, edit, or delete entries.
- **Automatic caching**: When a meal is saved, unedited "web data" and "nutrition label" results are written to the food library automatically, without overwriting existing entries of the same name. LLM estimates from background auto-saves are never written; however, results from 「AI 估算」 on the result page that you confirm and save are written. Items whose name or calories you edited are not written. Each meal stores a snapshot of its values at save time, so later library updates never change past meals.
- **Nutrient backfill exception**: When a meal is saved, a food already in the library whose nutrients have gaps can be filled from this meal's values (including AI estimates, stored with the 「估」mark); nutrients marked as estimated can later only be replaced by sourced web data or a nutrition label; sourced nutrients are never overwritten. Calories, name and source are never touched. Items whose nutrients you edited do not take part, and friends' journals do not by default.
- **Bundled data**: `data/tfda-common.json` (TFDA food nutrient dataset, 137 entries, with the five nutrients taken unmodified from the source dataset) and `data/hpa-2018-dishes.json` (HPA 「熱量知多少」 2018, 22 entries). The HPA data originally had only whole-gram protein, fat and carbohydrate per serving and no sugar or sodium, too coarse once converted to per 100 g, so it is not used; those entries keep calories only and the AI backfills nutrients. See [`data/ATTRIBUTION.md`](data/ATTRIBUTION.md) for sources and licenses.
- **Maintainer import**:

  ```sh
  node scripts/import-foods.mjs data/tfda-common.json data/hpa-2018-dishes.json [--dry-run]
  ```

  Or use `npm run import-foods -- data/xxx.json [--dry-run]`. With `--dry-run` it only reports how many entries would be added, skipped, or are invalid, without writing. Before a real import, the database is backed up automatically (`meals-backup-時間.sqlite` in the same folder, where 時間 is a timestamp); entries whose name or alias already exists are skipped, not overwritten. Brand data (e.g. restaurant chain nutrition labels) is not distributed with the project; you can compile it yourself in the same format and import it, checking the source's terms of use yourself. Each entry may optionally include the five nutrients (`proteinPer100g`, `fatPer100g`, `carbsPer100g`, `sugarPer100g`, `sodiumMgPer100g`), and `--dry-run` also reports how many entries include them. Never treat "kcal per serving" as "kcal per 100 g"; use different names for different brands, cooking methods, and raw/cooked states.

- **Filling nutrients in an existing library**: A library built before the upgrade has no nutrients. Besides waiting for the first hit to backfill them, you can fill them in one go from the bundled data:

  ```sh
  npm run fill-nutrients -- data/tfda-common.json [--dry-run]
  ```

  It only touches foods whose name or alias matches and whose kcal per 100 g is the same, and only fills gaps or nutrients marked as estimated (under the rules above); calories and other fields are untouched and no foods are added. `--dry-run` reports without writing, and a real run backs up the database first. On a Docker deployment, run it inside the container: `sudo docker-compose exec foodkcal npm run fill-nutrients -- data/tfda-common.json --dry-run` (drop `--dry-run` once you are happy with it).

### Data location and backups

```text
~/.my-chatgpt-local/            （Windows：%USERPROFILE%\.my-chatgpt-local；可用 MEAL_JOURNAL_DATA_DIR 改位置）
  credentials.json              ChatGPT 登入憑證、Claude API key
  master.key                    加密主金鑰（僅 Windows，DPAPI 保護）
  meals.sqlite                  日誌：餐點、照片、設定、背景工作、本機食物庫
```

On Windows the folder is `%USERPROFILE%\.my-chatgpt-local`, and it can be relocated with `MEAL_JOURNAL_DATA_DIR`. `credentials.json` holds the ChatGPT sign-in credentials and Claude API key; `master.key` is the encryption master key (Windows only, DPAPI-protected); `meals.sqlite` is the journal: meals, photos, settings, background jobs, and the local food library.

- 設定 → 匯出日誌與食物備份 (Settings → Export journal and food backup) downloads a JSON file (credentials not included). For a full backup, stop the service and copy the `.sqlite` file (along with `-wal` and `-shm`).
- If credentials can't be decrypted on Windows after switching computers or user accounts: delete `credentials.json` and `master.key`, then sign in / set the API key again. The journal is unaffected.

## Privacy

- Photos and descriptions are sent to **OpenAI or Anthropic** for recognition, depending on the services you configure; web search uses only the food name and description. All other data stays on your computer.
- Credentials are kept only on the backend, never in the browser; they are encrypted on Windows and stored as 0600 plain text on macOS/Linux. All writes require an HttpOnly session and a CSRF token.
- Requests forwarded through Tailscale (carrying `Tailscale-User-Login` or `X-Forwarded-*` headers) are always treated as remote; a forged `Host: 127.0.0.1` will not make them count as local.
- Local connections need no login: other programs or other OS users on the same computer can also reach `127.0.0.1:3000` with your full permissions.
- `start.local.bat`, the database, and credentials are never committed to git.

## Security assumptions

- The server binds only to `127.0.0.1` and treats any request to `127.0.0.1` without proxy headers as the owner with full rights (admin view of all journals, AI provider settings, ChatGPT login). Any process on the same host is therefore trusted as the owner, including, on a NAS with `network_mode: host`, other host-network containers/packages and other system accounts. Only run it on a host where you trust everything running locally.
- Remote identity relies entirely on Tailscale serve setting `Tailscale-User-Login` and stripping client-supplied copies. Do not enable Tailscale Funnel on this port, do not put another reverse proxy in front, and do not bind 0.0.0.0.
- A local process can also send a forged `Host` and `Tailscale-User-Login` directly, impersonating the owner or any friend. The friend usage, session and photo limits only bind people connecting through Tailscale, not local processes.
- On macOS/Linux `credentials.json` is plain text (0600); protect backups and NAS snapshots of the data directory.

## Development

```sh
npm test          # 模擬 OAuth 與模型，不耗額度
npm run build
npm run dev
```

`npm test` mocks OAuth and the models, so it uses no quota. Development mode (`npm run dev`) rejects all remote (Tailscale) requests and is local-only.

Server flags for testing with other Tailscale identities (`CHATGPT_SHARED`, `FRIENDS_CACHE`, `FRIENDS_DAILY_LIMIT`) are documented in [`server/README.md`](server/README.md).

## Disclaimer

ChatGPT sign-in is optional and is implemented according to OpenAI's "Sign in with ChatGPT" documentation for open-source apps (https://developers.openai.com/siwc/token-sharing-open-source). It is only for users on their own computer with their own account; you must follow OpenAI's terms of use and must not share your account. This project is not affiliated with or endorsed by OpenAI or Anthropic. This tool does not provide medical or nutrition advice. Calories are estimates; a photo cannot accurately determine portion size, hidden oil, or the full recipe, so please check the result page.

## Maintenance status

This is a personal project. There is no guarantee of ongoing maintenance, and issues may not get replies or PRs be merged. Feel free to fork it and adapt it to your own needs.

## License

The code is licensed under the [MIT License](LICENSE). Data in `data/` is licensed by its respective sources; see [`data/ATTRIBUTION.md`](data/ATTRIBUTION.md).
