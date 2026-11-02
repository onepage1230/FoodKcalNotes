// 維護者用：用資料集（data/*.json）的營養素，補既有食物庫裡空白或標為估算的營養素（一次性；ADR 0010 的補值規則）。
// 用法：node scripts/fill-library-nutrients.mjs data/tfda-common.json [data/b.json …] [--dry-run]
// 只更新名稱或別名對應、且每 100g 熱量相同（四捨五入）的食物；熱量、名稱、來源、別名與有出處的營養素一律不動，也不新增食物。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createJournal, mergeNutrients, normalize } from '../server/journal.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const files = args.filter(a => a !== '--dry-run');
if (!files.length) { console.error('用法：node scripts/fill-library-nutrients.mjs data/a.json [data/b.json …] [--dry-run]'); process.exit(1); }

// 與 server/server.js 相同的資料夾規則。
const dataDirectory = process.env.MEAL_JOURNAL_DATA_DIR || path.join(os.homedir(), '.my-chatgpt-local');
const filename = path.join(dataDirectory, 'meals.sqlite');
const journal = createJournal(filename);
const byKey = new Map(journal.foods().flatMap(f => [f.name, ...f.aliases].map(k => [normalize(k), f])));

if (!dryRun) {
  const stamp = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().replace(/\D/g, '').slice(0, 14).replace(/^(\d{8})/, '$1-');
  // 同一秒內連續執行（例如先匯入再補值）時檔名會重複，加序號避免 VACUUM INTO 失敗。
  let backup = path.join(dataDirectory, `meals-backup-${stamp}.sqlite`);
  for (let n = 2; fs.existsSync(backup); n++) backup = path.join(dataDirectory, `meals-backup-${stamp}-${n}.sqlite`);
  const db = new DatabaseSync(filename); db.exec('PRAGMA busy_timeout=3000'); db.prepare('VACUUM INTO ?').run(backup); db.close();
  console.log(`備份：${backup}`);
} else console.log('--dry-run：只回報，不寫入。');

for (const file of files) {
  const counts = { updated: 0, same: 0, mismatch: 0, missing: 0 };
  for (const row of JSON.parse(fs.readFileSync(file, 'utf8'))) {
    const keys = [row?.name, ...(Array.isArray(row?.aliases) ? row.aliases : [])].map(k => normalize(k ?? '')).filter(Boolean);
    const food = keys.map(k => byKey.get(k)).find(Boolean);
    if (!food) { counts.missing++; continue; }
    // 熱量不同代表庫裡那筆來自別的來源（品牌、烹調方式不同），營養素不能混用。
    if (Math.round(food.kcalPer100g) !== Math.round(row.kcalPer100g)) { counts.mismatch++; console.log(`  略過 ${food.name}：熱量不同（食物庫 ${food.kcalPer100g}，資料 ${row.kcalPer100g} kcal/100g）`); continue; }
    // 資料集是有出處的實測值：當成非命中的網路資料交給補值規則。
    const item = { ...row, source: 'web', matched: false, estimated: Array.isArray(row.estimated) ? row.estimated : [] };
    if (!mergeNutrients(structuredClone(food), item)) { counts.same++; continue; }
    if (!dryRun) journal.fillNutrients(food.id, item);
    counts.updated++; console.log(`  ${dryRun ? '將更新' : '更新'} ${food.name}`);
  }
  console.log(`${file}：${dryRun ? '將更新' : '更新'} ${counts.updated}，無需變更 ${counts.same}，熱量不同略過 ${counts.mismatch}，食物庫沒有 ${counts.missing}`);
}
journal.close();
