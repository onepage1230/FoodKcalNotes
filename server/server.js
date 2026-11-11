import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp, contentSecurityPolicy } from './app.js';
import { createStore, loadOwnerToken } from './storage.js';
import { createJournal } from './journal.js';
import os from 'node:os';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 必須是 1024～65535。');
const origin = `http://127.0.0.1:${port}`;
const dataDirectory = process.env.MEAL_JOURNAL_DATA_DIR || path.join(os.homedir(), '.my-chatgpt-local');
const store = createStore(dataDirectory);
const journal = createJournal(path.join(dataDirectory, 'meals.sqlite'));
// Tailscale：REMOTE_ORIGINS=https://電腦名稱.xxx.ts.net，OWNER_LOGIN=你的 Tailscale 帳號（共用主日誌）。
const remoteOrigins = (process.env.REMOTE_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean).map(value => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search) throw new Error('REMOTE_ORIGINS 必須是 https://主機名稱，不含路徑。');
  return url.origin;
});
const ownerLogin = process.env.OWNER_LOGIN || '';
if (remoteOrigins.length && !ownerLogin) throw new Error('設定 REMOTE_ORIGINS 時也要設定 OWNER_LOGIN（你的 Tailscale 登入帳號）。');
const friends = new Map();
const friendsDirectory = path.join(dataDirectory, 'friends');
// 朋友日誌最多保留 100 張餐點照片（各自計算），超過就清掉最早存入的照片，避免塞滿磁碟；擁有者不限。
const FRIEND_PHOTO_LIMIT = 100;
// 朋友日誌以帳號雜湊命名（meals-<id>.sqlite），帳號本身記在日誌的 meta 表供管理員檢視；食物庫共用主日誌。
function openFriend(id) {
  if (!friends.has(id)) {
    fs.mkdirSync(friendsDirectory, { recursive: true });
    friends.set(id, createJournal(path.join(friendsDirectory, `meals-${id}.sqlite`), { foods: journal, photoLimit: FRIEND_PHOTO_LIMIT }));
  }
  return friends.get(id);
}
function journalFor(login) {
  const friend = openFriend(createHash('sha256').update(login).digest('hex').slice(0, 16));
  if (friend.getMeta('login') !== login) friend.setMeta('login', login);
  return friend;
}
// 管理員檢視：主日誌加上 friends 資料夾裡所有日誌（包含這次啟動後尚未連線的人）。
function listJournals() {
  const ids = fs.existsSync(friendsDirectory) ? fs.readdirSync(friendsDirectory)
    .map(name => /^meals-([0-9a-f]{16})\.sqlite$/.exec(name)?.[1]).filter(Boolean) : [];
  return [{ id: 'owner', login: ownerLogin, owner: true, journal },
    ...ids.map(id => { const j = openFriend(id); return { id, login: j.getMeta('login'), owner: false, journal: j }; })];
}
listJournals(); // 啟動時打開所有朋友日誌，觸發一次性食物庫搬移。
// CHATGPT_SHARED=1：朋友也可使用擁有者的 ChatGPT 額度（預設關閉，依 OpenAI 條款帳號不可分享）。
const chatgptShared = process.env.CHATGPT_SHARED === '1';
// FRIENDS_CACHE=1：朋友存的餐點也寫入共用食物庫（預設關閉，防止朋友以自填熱量污染共用庫）。
const friendsCache = process.env.FRIENDS_CACHE === '1';
// FRIENDS_DAILY_LIMIT：每位朋友每天可用的 AI 分析次數（預設 30，0 不限），避免朋友無上限消耗擁有者的 API key 額度。
const friendsDailyLimit = Number(process.env.FRIENDS_DAILY_LIMIT || 30);
if (!Number.isInteger(friendsDailyLimit) || friendsDailyLimit < 0) throw new Error('FRIENDS_DAILY_LIMIT 必須是 0 以上的整數（0 表示不限）。');
// OWNER_TOKEN=1：擁有者必須用配對碼配對過的瀏覽器（owner_token cookie）才算擁有者，本機程式與偽造標頭拿不到主日誌。
// 配對碼存在資料夾的 owner.token；Docker 版預設開啟，Windows start.bat 預設關閉。
if (!['', '0', '1'].includes(process.env.OWNER_TOKEN || '')) throw new Error('OWNER_TOKEN 只能是 1（開啟擁有者配對）或 0（關閉）。');
const ownerToken = process.env.OWNER_TOKEN === '1' ? loadOwnerToken(dataDirectory) : null;
const { app, errors } = createApp({ store, origin, remoteOrigins, ownerLogin, journalFor, listJournals, journal, chatgptShared, friendsCache, friendsDailyLimit, ownerToken, devMode: process.argv.includes('--dev') });
let vite;
if (process.argv.includes('--dev')) {
  const { createServer } = await import('vite');
  vite = await createServer({ root, server: { middlewareMode: true, hmr: false }, appType: 'spa' });
  app.use(vite.middlewares);
} else {
  if (!fs.existsSync(path.join(root, 'dist/index.html'))) throw new Error('請先執行 npm run build。');
  // CSP 只在正式模式加（開發模式的 Vite 會插入自己的腳本）；inline 腳本的雜湊由建置後的 index.html 算出。
  const csp = contentSecurityPolicy(fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8'));
  app.use((req, res, next) => { res.setHeader('Content-Security-Policy', csp); next(); });
  app.use(express.static(path.join(root, 'dist')));
  app.get('/', (req, res) => res.sendFile(path.join(root, 'dist/index.html')));
}
app.use(errors);
// 配對網址與配對碼印在啟動訊息（docker-compose logs 看得到；能讀 Docker 紀錄的 NAS 管理員也看得到）。
const pairing = ownerToken ? `\n\n擁有者配對（OWNER_TOKEN=1）：在要使用的瀏覽器開啟以下網址完成配對，或在配對畫面貼上配對碼。` +
  [origin, ...remoteOrigins].map(o => `\n  ${o}/?pair=${ownerToken}`).join('') + `\n配對碼：${ownerToken}\n（也存在 ${path.join(dataDirectory, 'owner.token')}；刪除後重啟會換新的，所有裝置需重新配對）` : '';
const server = app.listen(port, '127.0.0.1', () => console.log(`\n飲食日誌 v2.0.0 已啟動：${origin}${remoteOrigins.map(o => `\n遠端（Tailscale）：${o}`).join('')}${pairing}\n按 Ctrl+C 結束。\n`));
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `連接埠 ${port} 已被使用，請改用 PORT 環境變數。` : `本機服務無法啟動（${error.code || error.message}）。`);
  process.exit(1);
});
async function shutdown() { server.close(); journal.close(); for (const j of friends.values()) j.close(); await vite?.close(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
