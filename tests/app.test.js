import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { generateKeyPair, SignJWT } from 'jose';
import { createApp, allowedModel, contentSecurityPolicy } from '../server/app.js';
import { verifyIdentity, ISSUER } from '../server/oauth.js';
import { readSSE } from '../server/sse.js';
import { createJournal } from '../server/journal.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function fixture(t, extra = {}) {
  const account = { client_id: 'oaiapp_test', subject: 'user-1', access_token: 'old-test-token',
    refresh_token: 'test-refresh', scopes: ['chatgpt.tokens.use.direct'], expiresAt: 0 };
  const store = { data: { hostId: 'test-host', accounts: [account], activeId: account.client_id }, save() {} };
  const calls = { refresh: 0, exchange: 0, responses: [] };
  const oauth = {
    authorization: async tx => `https://auth.openai.com/authorize?state=${tx.state}`,
    exchange: async () => { calls.exchange++; return { access_token: 'new-test-token', refresh_token: 'new-test-refresh',
      expires_in: 3600, scope: 'chatgpt.tokens.use.direct', id_token: 'test-id' }; },
    verify: async () => ({ sub: 'user-1', email: 'test@example.invalid' }),
    refresh: async () => { calls.refresh++; await new Promise(resolve => setTimeout(resolve, 15));
      return { access_token: 'new-test-token', refresh_token: 'rotated', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' }; },
    revoke: async () => true,
  };
  const fetcher = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer new-test-token');
    if (url.endsWith('/models')) return Response.json({ models: [
      { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list' },
      { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', visibility: 'list' },
      { slug: 'gpt-5.6-terra', display_name: 'Test model', visibility: 'list' },
      { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list' },
      { slug: 'hidden', visibility: 'hidden' }] });
    const body = JSON.parse(options.body); calls.responses.push(body);
    if (calls.status) return Response.json({ error: { code: 'usage_limit_reached' } }, { status: calls.status });
    // reply 可為函式（依請求內容回覆），回傳陣列時當作完整 output。
    let reply = calls.reply; if (typeof reply === 'function') reply = reply(body);
    const output = Array.isArray(reply) ? reply : [{type:'message',content:[{type:'output_text',text:reply||JSON.stringify({name:'測試餐',items:[{name:'測試飯',grams:100}]})}]}];
    return new Response('data: '+JSON.stringify({type:'response.completed',response:{output}})+'\n\n');
  };
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const journal = createJournal(':memory:');
  t.after(() => journal.close());
  const friends = new Map();
  const journalFor = login => { if (!friends.has(login)) { const j = createJournal(':memory:', { foods: journal }); t.after(() => j.close()); friends.set(login, j); } return friends.get(login); };
  const { app, errors, pending } = createApp({ store, origin, oauth, fetcher, journal, ...extra,
    remoteOrigins: ['https://pc.example.ts.net'], ownerLogin: 'owner@example.com', journalFor,
    listJournals: () => [{ id: 'owner', login: 'owner@example.com', owner: true, journal }, ...[...friends].map(([login, j]) => { j.setMeta('login', login); return { id: login.replace(/[^a-z]/g, ''), login, owner: false, journal: j }; })] });
  app.get('/', (req, res) => res.send('test'));
  app.use(errors); server.on('request', app);
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const home = await fetch(origin);
  const cookie = home.headers.get('set-cookie').split(';')[0];
  const status = await (await fetch(`${origin}/api/status`, { headers: { cookie } })).json();
  // session 依身分綁定：帶 Tailscale-User-Login 的要求（朋友或遠端擁有者）自動取得該身分自己的 session，未帶則用本機 session。
  const identities = new Map();
  const sessionFor = async headers => {
    const login = Object.entries(headers).find(([k]) => k.toLowerCase() === 'tailscale-user-login')?.[1]?.toLowerCase();
    if (!login || 'cookie' in headers) return { cookie, csrf: status.csrf };
    if (!identities.has(login)) {
      const base = { Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', 'Tailscale-User-Login': login };
      const c = (await request('/', undefined, { ...base, cookie: '' })).headers.get('set-cookie')?.split(';')[0];
      if (!c) return { cookie, csrf: status.csrf }; // 開發模式、偽造 Host 等情況拿不到 session，沿用本機的
      identities.set(login, { cookie: c, csrf: (await (await request('/api/status', undefined, { ...base, cookie: c })).json()).csrf });
    }
    return identities.get(login);
  };
  const request = async (path, body, { method = body ? 'POST' : 'GET', ...extra } = {}) => { const s = await sessionFor(extra); return new Promise((resolve, reject) => {
    const req = httpRequest(origin + path, {
    method, redirect: 'manual',
    headers: { cookie: s.cookie, ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf } : {}), ...extra },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  }); };
  // 背景分析：送出後輪詢到工作結束。
  const analyze = async (body, extra, path = '/api/analyze') => {
    const { id } = await (await request(path, body, extra)).json();
    for (;;) {
      const job = await (await request('/api/jobs/' + id, null, extra)).json();
      if (job.status !== 'running') return job;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  return { request, analyze, pending, account, calls, origin, cookie, store, journal };
}
// 自動保存的日期時間：工作建立時的伺服器本機時間。
const localAt = iso => { const d = new Date(iso); const pad = n => String(n).padStart(2, '0');
  return [`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, `${pad(d.getHours())}:${pad(d.getMinutes())}`]; };

test('拒絕跨來源、缺少 CSRF 與未知 Host', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/models', null, { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await f.request('/api/logout', {}, { 'X-CSRF-Token': 'wrong' })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(f.origin + '/api/status', { headers: { Host: 'evil.invalid', Cookie: f.cookie } }, res => {
      res.resume(); resolve(res.statusCode);
    });
    req.on('error', reject); req.end();
  });
  assert.equal(hostStatus, 403);
});
test('開發模式拒絕遠端要求', async t => {
  const f = await fixture(t, { devMode: true });
  const res = await f.request('/api/status', null, { Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', 'Tailscale-User-Login': 'owner@example.com' });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, '開發模式只限本機使用。');
  assert.equal((await f.request('/api/status')).status, 200);
});

test('允許 OAuth 回程的跨站首頁導覽，仍拒絕跨站 API 與登入 POST', async t => {
  const f = await fixture(t);
  const navigation = { Origin: 'https://external.invalid', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  assert.equal((await f.request('/?login=success', null, navigation)).status, 200);
  assert.equal((await f.request('/?login_error=cancelled', null, navigation)).status, 200);
  assert.equal((await f.request('/api/status', null, navigation)).status, 403);
  assert.equal((await f.request('/auth/chatgpt', {}, navigation)).status, 403);
  assert.equal((await f.request('/', null, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' })).status, 200);
  assert.equal((await f.request('/', null, { 'Sec-Fetch-Site': 'same-site' })).status, 200);
  assert.equal((await f.request('/', null, { Origin: 'https://external.invalid' })).status, 200);
  assert.equal((await f.request('/api/status', null, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
});
test('同時要求只 refresh 一次，保存旋轉 token 並隱藏模型', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.request('/api/models'), f.request('/api/models')]);
  assert.equal(f.calls.refresh, 1); assert.equal(f.account.refresh_token, 'rotated');
  assert.deepEqual((await results[0].json()).models.map(m => m.slug), ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra']);
  const status = await (await f.request('/api/status')).text();
  assert.equal(status.includes('new-test-token'), false);
  assert.equal(status.includes('rotated'), false);
});
test('OAuth state、cookie、client ID 與重放驗證', async t => {
  const f = await fixture(t);
  await f.request('/auth/chatgpt', { client_id: 'oaiapp_test' });
  const state = [...f.pending.keys()][0];
  const callback = `/auth/callback?state=${state}&code=fake-code`;
  await f.request(callback, null, { cookie: 'local_session=wrong' });
  assert.equal(f.calls.exchange, 0); assert.equal(f.pending.has(state), true);
  await f.request(callback + '&client_id=wrong');
  assert.equal(f.calls.exchange, 0); assert.equal(f.pending.has(state), false);
  await f.request('/auth/chatgpt', { client_id: 'oaiapp_test' });
  const valid = `/auth/callback?state=${[...f.pending.keys()][0]}&code=fake-code`;
  assert.equal((await f.request(valid)).headers.get('location'), '/?login=success');
  await f.request(valid); assert.equal(f.calls.exchange, 1);
});
test('登入失敗訊息存在 session，網址只帶旗標；成功登入後清除', async t => {
  const f = await fixture(t);
  await f.request('/auth/chatgpt', {});
  const res = await f.request(`/auth/callback?state=${[...f.pending.keys()][0]}&error=access_denied`);
  assert.equal(res.headers.get('location'), '/?login_error=1');
  assert.equal((await (await f.request('/api/status')).json()).loginError, '登入或授權已取消，請重試。');
  await f.request('/auth/chatgpt', { client_id: 'oaiapp_test' });
  assert.equal((await f.request(`/auth/callback?state=${[...f.pending.keys()][0]}&code=fake-code`)).headers.get('location'), '/?login=success');
  assert.equal((await (await f.request('/api/status')).json()).loginError, '');
});
test('CSP：inline 腳本以 SHA-256 列出，外部腳本不列；表單可轉到 OpenAI 授權頁', () => {
  const inline = "var t=1;document.title='x'";
  const csp = contentSecurityPolicy(`<head><script>${inline}</script><script type="module" src="/assets/a.js"></script></head>`);
  const hash = createHash('sha256').update(inline).digest('base64');
  assert.match(csp, new RegExp(`script-src 'self' 'sha256-${hash.replace(/[+/]/g, '\\$&')}';`));
  assert.equal(csp.match(/sha256-/g).length, 1);
  for (const part of ["default-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "img-src 'self' data: blob:", "form-action 'self' https://auth.openai.com"]) assert.ok(csp.includes(part), part);
  assert.equal(contentSecurityPolicy('<p>無腳本</p>').includes("script-src 'self';"), true);
});
test('逾時與使用者取消 OAuth 不交換 code', async t => {
  const f = await fixture(t);
  await f.request('/auth/chatgpt', {});
  const state = [...f.pending.keys()][0]; f.pending.get(state).expiresAt = 0;
  await f.request(`/auth/callback?state=${state}&code=fake`);
  await f.request('/auth/chatgpt', {});
  await f.request(`/auth/callback?state=${[...f.pending.keys()][0]}&error=access_denied`);
  assert.equal(f.calls.exchange, 0);
});
test('飲食 API 傳入圖片並遵守 Responses contract，保存後可查日期', async t => {
  const f = await fixture(t); f.journal.putFood({name:'測試飯',kcalPer100g:130,source:'manual'});
  assert.equal((await f.request('/api/analyze', {model:'hidden',text:'飯'})).status,400);
  const job = await f.analyze({model:'gpt-5.6-terra',photo:'data:image/jpeg;base64,AAAA'});
  assert.equal(job.status,'done');
  const draft = job.result;
  assert.equal(draft.items[0].matched,true);
  assert.equal(f.calls.responses[0].stream,true); assert.equal(f.calls.responses[0].store,false);
  assert.equal(f.calls.responses[0].input[0].content[2].type,'input_image');
  // 用餐時間脈絡取自工作建立時間（與自動存檔時間相同）。
  const [, hhmm] = localAt(job.createdAt); assert.match(f.calls.responses[0].input[0].content[0].text, new RegExp(`^用餐時間：週. ${hhmm}（`));
  const auto = await (await f.request('/api/meals/' + job.mealId)).json();
  assert.deepEqual([auto.day, auto.time], localAt(job.createdAt));
  assert.deepEqual([auto.name, auto.items.map(i => [i.name, i.grams]), auto.photo, auto.kcal], ['測試餐', [['測試飯', 100]], 'data:image/jpeg;base64,AAAA', 130]);
  f.journal.deleteMeal(auto.id); assert.equal((await (await f.request('/api/journal?day=2026-10-02')).json()).since,'');
  const saved = await (await f.request('/api/meals',{...draft,day:'2026-10-02',time:'12:30',photo:''})).json();
  assert.equal(saved.kcal,130);
  await f.request('/api/meals',{...draft,day:'2026-10-05',time:'08:00',photo:''});
  const journal = await (await f.request('/api/journal?day=2026-10-02')).json();
  assert.equal(journal.meals.length,1); assert.equal(journal.since,'2026-10-02');
  assert.deepEqual(Object.keys(journal.dayNutrients),['protein','fat','carbs','sugar','sodiumMg']); assert.equal(journal.dayNutrients.protein.unknown,1);
  assert.match(journal.nutrientGoalsSince,/^\d{4}-\d{2}-\d{2}$/); // ticket 12：營養目標上線日期
  assert.equal((await (await f.request('/api/journal?day=2026-10-02&today=2026-10-05')).json()).streak,1);
});
test('背景分析工作：立即回 id、跑完存結果、只列目前日誌、可刪除；模型錯誤記為 error', async t => {
  const f = await fixture(t); f.journal.putFood({ name: '測試飯', kcalPer100g: 130, source: 'manual' });
  const remote = { Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', 'Tailscale-User-Login': 'friend@example.com' };
  const posted = await (await f.request('/api/analyze', { model: 'gpt-5.6-terra', text: '飯', photo: 'data:image/jpeg;base64,AAAA' })).json();
  assert.equal(typeof posted.id, 'string');
  const job = await f.analyze({ model: 'gpt-5.6-terra', text: '麵' });
  assert.equal(job.status, 'done'); assert.equal(job.text, '麵'); assert.equal(job.photo, ''); assert.equal(job.error, '');
  assert.equal(typeof job.mealId, 'string'); assert.equal((await f.request('/api/meals/' + job.mealId, null, remote)).status, 404);
  assert.equal(job.result.items[0].name, '測試飯'); assert.ok(job.steps.length >= 2); assert.deepEqual(Object.keys(job.steps[0]).sort(), ['label', 'message']);
  const first = await (await f.request('/api/jobs/' + posted.id)).json();
  assert.equal(first.photo, 'data:image/jpeg;base64,AAAA'); assert.equal(first.hasPhoto, true);
  const { jobs } = await (await f.request('/api/jobs')).json();
  assert.deepEqual(jobs.map(j => j.id), [job.id, posted.id]); assert.equal(jobs.some(j => 'photo' in j), false);
  assert.deepEqual((await (await f.request('/api/jobs', null, remote)).json()).jobs, []);
  assert.equal((await f.request('/api/jobs/' + job.id, null, remote)).status, 404);
  assert.equal((await f.request('/api/jobs/' + job.id, null, { ...remote, method: 'DELETE' })).status, 404);
  assert.deepEqual(await (await f.request('/api/jobs/' + job.id, null, { method: 'DELETE' })).json(), { ok: true });
  assert.equal((await f.request('/api/jobs/' + job.id)).status, 404);
  assert.equal((await f.request('/api/meals/' + job.mealId)).status, 200); // 刪除工作不刪餐點
  assert.equal((await f.request('/api/jobs/' + job.id, null, { method: 'DELETE' })).status, 404);
  f.calls.status = 429;
  const failed = await f.analyze({ model: 'gpt-5.6-terra', text: '飯' });
  assert.equal(failed.status, 'error'); assert.match(failed.error, /HTTP 429/); assert.equal('result' in failed, false); assert.equal(failed.mealId, '');
});
test('刪除餐點會移除對應的已完成工作；舊的孤兒工作在列表時清掉，進行中與失敗的保留', async t => {
  const f = await fixture(t); f.journal.putFood({ name: '測試飯', kcalPer100g: 130, source: 'manual' });
  const job = await f.analyze({ model: 'gpt-5.6-terra', text: '飯' });
  assert.equal(job.status, 'done');
  assert.deepEqual(await (await f.request('/api/meals/' + job.mealId, null, { method: 'DELETE' })).json(), { ok: true });
  assert.equal((await f.request('/api/jobs/' + job.id)).status, 404);
  const stuck = f.journal.createJob({ text: '舊' }); f.journal.updateJob(stuck, { status: 'done', mealId: 'gone' });
  const running = f.journal.createJob({ text: '跑', kind: 'relookup', mealId: 'gone' });
  const failed = f.journal.createJob({ text: '錯' }); f.journal.updateJob(failed, { status: 'error', error: 'x' });
  const { jobs } = await (await f.request('/api/jobs')).json();
  assert.deepEqual(jobs.map(j => j.id).sort(), [running, failed].sort());
});
test('背景分析自動存成餐點：LLM 估算不寫入共用食物庫，網路查證仍寫入；朋友日誌隔離（FRIENDS_CACHE 開）', async t => {
  const f = await fixture(t, { chatgptShared: true, friendsCache: true });
  const friend = { Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', 'Tailscale-User-Login': 'friend@example.com' };
  f.calls.reply = body => {
    const content = body.input[0].content;
    if (Array.isArray(content)) return JSON.stringify({ name: '自動餐', items: [{ name: '網路麵', grams: 100 }, { name: '估算湯', grams: 200 }] });
    if (JSON.parse(content).food === '網路麵' && body.tools) return [{ type: 'web_search_call', status: 'completed' }, { type: 'message', content: [{ type: 'output_text',
      text: JSON.stringify({ kcalPer100g: 150, sourceUrl: 'https://example.com/noodle', sourceTitle: '例', notes: '' }),
      annotations: [{ type: 'url_citation', url: 'https://example.com/noodle', title: '例' }] }] }];
    return JSON.stringify({ kcalPer100g: 40, sourceUrl: '', sourceTitle: '', notes: '估', proteinPer100g: 1, fatPer100g: 1, carbsPer100g: 5, sugarPer100g: 1, sodiumMgPer100g: 200 });
  };
  const job = await f.analyze({ model: 'gpt-5.6-terra', text: '麵和湯', fallback: 'web' }, friend);
  assert.equal(job.status, 'done');
  const meal = await (await f.request('/api/meals/' + job.mealId, null, friend)).json();
  assert.deepEqual([meal.day, meal.time], localAt(job.createdAt));
  assert.deepEqual(meal.items.map(i => [i.name, i.source]), [['網路麵', 'web'], ['估算湯', 'llm']]);
  assert.equal((await f.request('/api/meals/' + job.mealId)).status, 404);
  // 估算湯帶五項估算營養素並標「估」，但 LLM 估算仍不寫入共用食物庫。
  assert.equal(meal.items[1].sodiumMgPer100g, 200); assert.equal(meal.items[1].estimated.length, 5); assert.deepEqual(meal.items[0].estimated, []);
  assert.deepEqual(f.journal.foods().map(food => food.name), ['網路麵']);
  // 手動確認（POST /api/meals）維持原行為：LLM 估算也寫入。
  await f.request('/api/meals', { ...job.result, day: '2026-10-02', time: '12:00', photo: '' }, friend);
  assert.deepEqual(f.journal.foods().map(food => food.name).sort(), ['估算湯', '網路麵'].sort());
});
test('FRIENDS_CACHE 預設關閉：朋友的分析與手動保存都不寫共用食物庫（不新增、不加別名）；擁有者照常寫入', async t => {
  const f = await fixture(t, { chatgptShared: true });
  const friend = { Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', 'Tailscale-User-Login': 'friend@example.com' };
  const id = f.journal.putFood({ name: '共用飯', kcalPer100g: 130, source: 'manual' });
  f.calls.reply = body => Array.isArray(body.input[0].content) ? JSON.stringify({ name: '網路餐', items: [{ name: '網路麵', grams: 100 }] })
    : [{ type: 'web_search_call', status: 'completed' }, { type: 'message', content: [{ type: 'output_text',
      text: JSON.stringify({ kcalPer100g: 150, sourceUrl: 'https://example.com/noodle', sourceTitle: '例', notes: '' }),
      annotations: [{ type: 'url_citation', url: 'https://example.com/noodle', title: '例' }] }] }];
  const job = await f.analyze({ model: 'gpt-5.6-terra', text: '麵', fallback: 'web' }, friend);
  assert.equal(job.status, 'done'); assert.equal(job.result.items[0].source, 'web');
  assert.equal((await f.request('/api/meals/' + job.mealId, null, friend)).status, 200);
  const injected = { name: '朋友餐', day: '2026-10-02', time: '12:00', photo: '', items: [{ name: '假熱量', grams: 100, kcalPer100g: 999, source: 'web', cache: true },
    { name: '共用飯', grams: 100, kcalPer100g: 130, source: 'manual', foodId: id, matched: true, recognizedName: '朋友別名' }] };
  assert.equal((await f.request('/api/meals', injected, friend)).status, 200);
  assert.deepEqual(f.journal.foods().map(food => food.name), ['共用飯']); assert.equal(f.journal.findFood(['朋友別名']), null);
  // 擁有者（本機）照常寫入。
  await f.request('/api/meals', injected);
  assert.equal(f.journal.findFood(['假熱量']).kcalPer100g, 999); assert.equal(f.journal.findFood(['朋友別名']).id, id);
  const own = await f.analyze({ model: 'gpt-5.6-terra', text: '麵', fallback: 'web' });
  assert.equal(own.status, 'done'); assert.ok(f.journal.findFood(['網路麵']));
});
test('背景分析自動存檔後，餐點與食物庫的營養素與估算標記正確（新食物、補 null、標示覆蓋估算）', async t => {
  const f = await fixture(t);
  const N = { proteinPer100g: null, fatPer100g: null, carbsPer100g: null, sugarPer100g: null, sodiumMgPer100g: null };
  const id = f.journal.putFood({ name: '標示餅', kcalPer100g: 400, source: 'web', ...N, proteinPer100g: 6, fatPer100g: 30, estimated: ['fatPer100g'] });
  const label = { labelKcalPer100g: 999, labelProteinPer100g: 9, labelFatPer100g: 20, labelCarbsPer100g: 55, labelSugarPer100g: null, labelSodiumMgPer100g: 250 };
  f.calls.reply = body => Array.isArray(body.input[0].content) ? JSON.stringify({ name: '下午茶', note: '', items: [
    { name: '標示餅', aliases: [], grams: 50, confidence: 'high', portionBasis: 'reference', portionNote: '', ...label },
    { name: '新標示茶', aliases: [], grams: 300, confidence: 'high', portionBasis: 'reference', portionNote: '', labelKcalPer100g: 30, labelSugarPer100g: 7 }] })
    : JSON.stringify({ kcalPer100g: 50, sourceUrl: '', sourceTitle: '', notes: '' });
  const job = await f.analyze({ model: 'gpt-5.6-terra', text: '餅和茶', fallback: 'llm' });
  assert.equal(job.status, 'done');
  const meal = await (await f.request('/api/meals/' + job.mealId)).json();
  assert.deepEqual(meal.items.map(i => [i.name, i.source, i.kcalPer100g, i.fatPer100g, i.estimated]), [['標示餅', 'label', 999, 20, []], ['新標示茶', 'label', 30, null, []]]);
  const cake = f.journal.foods().find(food => food.id === id); const tea = f.journal.findFood(['新標示茶']);
  // 熱量與有出處的蛋白質不變；估算的脂肪被標示覆蓋並移出 estimated；null 的碳水與鈉補上。
  assert.deepEqual([cake.kcalPer100g, cake.proteinPer100g, cake.fatPer100g, cake.carbsPer100g, cake.sugarPer100g, cake.sodiumMgPer100g, cake.estimated], [400, 6, 20, 55, null, 250, []]);
  assert.deepEqual([tea.kcalPer100g, tea.sugarPer100g, tea.proteinPer100g, tea.estimated], [30, 7, null, []]);
});
test('FRIENDS_CACHE 關閉：朋友的背景分析不新增食物，也不補既有食物的營養素', async t => {
  const f = await fixture(t, { chatgptShared: true });
  const friend = { Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', 'Tailscale-User-Login': 'friend@example.com' };
  const id = f.journal.putFood({ name: '標示餅', kcalPer100g: 400, source: 'web', fatPer100g: 30, estimated: ['fatPer100g'] });
  f.calls.reply = () => JSON.stringify({ name: '下午茶', note: '', items: [
    { name: '標示餅', aliases: [], grams: 50, confidence: 'high', portionBasis: 'reference', portionNote: '', labelKcalPer100g: 999, labelFatPer100g: 20, labelSodiumMgPer100g: 250 },
    { name: '新標示茶', aliases: [], grams: 300, confidence: 'high', portionBasis: 'reference', portionNote: '', labelKcalPer100g: 30, labelSugarPer100g: 7 }] });
  const job = await f.analyze({ model: 'gpt-5.6-terra', text: '餅和茶', fallback: 'llm' }, friend);
  assert.equal(job.status, 'done');
  assert.equal((await (await f.request('/api/meals/' + job.mealId, null, friend)).json()).items[0].fatPer100g, 20);
  const cake = f.journal.foods().find(food => food.id === id);
  assert.deepEqual(f.journal.foods().map(food => food.name), ['標示餅']);
  assert.deepEqual([cake.fatPer100g, cake.sodiumMgPer100g, cake.estimated], [30, null, ['fatPer100g']]);
});
test('自動保存失敗時工作記為 error 並保留結果', async t => {
  const f = await fixture(t); f.journal.putFood({ name: '測試飯', kcalPer100g: 130, source: 'manual' });
  f.journal.saveMeal = () => { throw new Error('每餐需要 1～30 項食物。'); };
  const job = await f.analyze({ model: 'gpt-5.6-terra', text: '飯' });
  assert.deepEqual([job.status, job.error, job.mealId, job.result.items[0].name], ['error', '每餐需要 1～30 項食物。', '', '測試飯']);
});
test('伺服器重啟時把執行中的工作標記為錯誤', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jobs-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'test.sqlite'); let db = createJournal(filename);
  const id = db.createJob({ text: '飯', photo: '' }); const done = db.createJob({ text: '麵', photo: '' });
  db.updateJob(done, { status: 'done', result: { name: '麵', note: '', items: [], warnings: [] } }); db.close();
  db = createJournal(filename);
  assert.deepEqual([db.getJob(id).status, db.getJob(id).error], ['error', '伺服器重新啟動，請重試。']);
  assert.equal(db.getJob(done).status, 'done'); db.close();
});
test('工作每本日誌最多保留最新 20 筆', () => {
  const db = createJournal(':memory:'); const ids = Array.from({ length: 22 }, (_, k) => db.createJob({ text: String(k), photo: '' }));
  assert.deepEqual(db.listJobs().map(j => j.id), ids.slice(2).reverse()); db.close();
});
test('單項 AI 估算：名稱跑完整分析，拆成多項並各自估份量', async t => {
  const f = await fixture(t); f.journal.putFood({name:'測試飯',kcalPer100g:130,source:'manual',proteinPer100g:2.7,fatPer100g:0.3,carbsPer100g:28,sugarPer100g:0,sodiumMgPer100g:1});
  const estimate = body => f.request('/api/estimate', {model:'gpt-5.6-terra',fallback:'llm',...body});
  assert.equal((await estimate({name:''})).status,400);
  assert.equal((await estimate({name:'測試飯',model:'gpt-6-astra'})).status,400);
  const replies = [JSON.stringify({name:'測試套餐',items:[{name:'測試飯',grams:300},{name:'蘋果派',grams:80}]}),
    JSON.stringify({kcalPer100g:250,sourceUrl:'',sourceTitle:'',notes:'測試估算'})];
  Object.defineProperty(f.calls,'reply',{get:()=>replies.shift()});
  const r = await (await estimate({name:'測試飯套餐 送蘋果派'})).json();
  assert.equal(f.calls.responses.length,2); assert.equal(f.calls.responses[0].input[0].content[0].text,'測試飯套餐 送蘋果派');
  assert.deepEqual(r.items.map(i=>[i.name,i.grams,i.kcalPer100g,i.matched,i.source]),[['測試飯',300,130,true,'manual'],['蘋果派',80,250,false,'llm']]);
  assert.deepEqual(r.warnings,[]);
});
test('ChatGPT：辨識與估算帶 strict text.format（json_schema）；搜尋不帶，也不送出 schema 欄位', async t => {
  const { RECOGNITION_SCHEMA, ESTIMATE_SCHEMA } = await import('../server/food-analysis.js');
  const f = await fixture(t);
  const nutrition = { kcalPer100g: 250, sourceUrl: '', sourceTitle: '', notes: '測試', servingGrams: null };
  const replies = [JSON.stringify({ name: '測試派', note: '', items: [{ name: '蘋果派', aliases: [], grams: 80, confidence: 'high', portionBasis: 'reference', portionNote: '', labelKcalPer100g: null }] }),
    JSON.stringify(nutrition), JSON.stringify({ ...nutrition, sameAs: null })];
  Object.defineProperty(f.calls, 'reply', { get: () => replies.shift() });
  const r = await (await f.request('/api/estimate', { model: 'gpt-5.6-terra', fallback: 'web', name: '蘋果派' })).json();
  assert.equal(r.items[0].source, 'llm');
  const [recognition, search, estimate] = f.calls.responses;
  assert.deepEqual(recognition.text, { format: { type: 'json_schema', name: 'meal_recognition', strict: true, schema: RECOGNITION_SCHEMA.schema } });
  const itemSchema = recognition.text.format.schema.properties.items.items; // 標示營養素：五個可空數字欄位，且全部必填（strict）
  for (const k of ['labelProteinPer100g', 'labelFatPer100g', 'labelCarbsPer100g', 'labelSugarPer100g', 'labelSodiumMgPer100g']) {
    assert.deepEqual(itemSchema.properties[k], { anyOf: [{ type: 'number' }, { type: 'null' }] }); assert.ok(itemSchema.required.includes(k)); }
  assert.equal(search.text, undefined); assert.deepEqual(search.tools, [{ type: 'web_search' }]);
  assert.deepEqual(estimate.text, { format: { type: 'json_schema', name: 'food_estimate', strict: true, schema: ESTIMATE_SCHEMA.schema } });
  assert.ok(f.calls.responses.every(b => !('schema' in b)));
  // 估算 schema 含五項可空的營養素欄位（ticket 03）；搜尋那次不帶。
  for (const k of ['proteinPer100g', 'fatPer100g', 'carbsPer100g', 'sugarPer100g', 'sodiumMgPer100g']) assert.deepEqual(estimate.text.format.schema.properties[k], { anyOf: [{ type: 'number' }, { type: 'null' }] }, k);
  assert.match(search.instructions, /sodiumMgPer100g/); assert.match(estimate.instructions, /sodiumMgPer100g/);
});
test('背景重新查詢：只查這一項並改寫已存餐點，保留重量與其他項', async t => {
  const f = await fixture(t, { chatgptShared: true }); f.journal.putFood({name:'滷排骨',kcalPer100g:220,source:'manual'});
  const friend = { Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', 'Tailscale-User-Login': 'friend@example.com' };
  const base = { name: '午餐', day: '2026-10-02', time: '12:00', photo: '', items: [{ id: 'x1', name: '排骨', grams: 150, kcalPer100g: 300, source: 'llm', portionNote: '一塊' },
    { id: 'x2', name: '白飯', grams: 200, kcalPer100g: 130, source: 'manual' }] };
  const meal = await (await f.request('/api/meals', base)).json();
  const relookup = (body, extra) => f.analyze({ model: 'gpt-5.6-terra', fallback: 'llm', mealId: meal.id, itemId: 'x1', ...body }, extra, '/api/jobs/relookup');
  const post = (body, extra) => f.request('/api/jobs/relookup', { model: 'gpt-5.6-terra', fallback: 'llm', mealId: meal.id, itemId: 'x1', name: '滷排骨', ...body }, extra);
  assert.equal((await post({ mealId: 'nope' })).status, 404); assert.equal((await post({ itemId: 'nope' })).status, 404);
  assert.equal((await post({}, friend)).status, 404); assert.equal((await post({ name: '' })).status, 400);
  assert.equal((await post({ model: 'gpt-6-astra' })).status, 400);
  const hit = await relookup({ name: '滷排骨' });
  assert.equal(f.calls.responses.length, 1); // 本機命中只剩補估營養素那一次呼叫（預設回覆沒有可用內容）
  assert.deepEqual([hit.status, hit.kind, hit.text, hit.mealId, hit.result.item.id], ['done', 'relookup', '滷排骨', meal.id, 'x1']);
  let saved = await (await f.request('/api/meals/' + meal.id)).json();
  assert.deepEqual([saved.name, saved.day, saved.time], ['午餐', '2026-10-02', '12:00']);
  assert.deepEqual(saved.items.map(i => [i.id, i.name, i.grams, i.kcalPer100g, i.source, i.matched, i.portionNote]),
    [['x1', '滷排骨', 150, 220, 'manual', true, '一塊'], ['x2', '白飯', 200, 130, 'manual', false, '']]);
  f.calls.reply = JSON.stringify({kcalPer100g:180,sourceUrl:'',sourceTitle:'',notes:'測試估算',servingGrams:300});
  const est = await relookup({ name: '未知排骨' });
  assert.equal(f.calls.responses.length, 2); assert.equal(est.status, 'done');
  saved = await (await f.request('/api/meals/' + meal.id)).json();
  assert.deepEqual(saved.items.map(i => [i.name, i.grams, i.kcalPer100g, i.source, i.cache]), [['未知排骨', 150, 180, 'llm', false], ['白飯', 200, 130, 'manual', false]]);
  assert.deepEqual(f.journal.foods().map(food => food.name).sort(), ['滷排骨']);
  assert.equal((await (await f.request('/api/jobs')).json()).jobs[0].kind, 'relookup');
  // 查詢期間品項被刪除：工作記為錯誤，不復原該項。
  f.calls.reply = () => { f.journal.saveMeal({ ...f.journal.meal(meal.id), items: f.journal.meal(meal.id).items.filter(i => i.id !== 'x1') });
    return JSON.stringify({kcalPer100g:90,sourceUrl:'',sourceTitle:'',notes:''}); };
  const gone = await relookup({ name: '另一種排骨' });
  assert.deepEqual([gone.status, gone.error], ['error', '品項已被刪除。']);
  assert.deepEqual((await (await f.request('/api/meals/' + meal.id)).json()).items.map(i => i.id), ['x2']);
});
// ticket 07：重新查詢與單項 AI 估算帶上營養素
const FILL = { proteinPer100g: 2.5, fatPer100g: 0.3, carbsPer100g: 28, sugarPer100g: 0, sodiumMgPer100g: 1 };
const NKEYS = Object.keys(FILL);
const isFillBody = body => JSON.stringify(body).includes('nutrient_fill');
const fillOf = (body, patch) => JSON.stringify({ items: JSON.parse(body.input[0].content).items.map(i => ({ id: i.id, ...Object.fromEntries(NKEYS.map(k => [k, null])), ...patch })) });
test('重新查詢：營養素依新來源更新、缺值補估、estimated 正確，nutrientsEdited 重設，其他項與克數不變', async t => {
  const f = await fixture(t);
  f.journal.putFood({ name: '完整飯', kcalPer100g: 130, source: 'manual', ...FILL });
  f.journal.putFood({ name: '缺值麵', kcalPer100g: 140, source: 'manual', proteinPer100g: 4 });
  const old = { proteinPer100g: 99, fatPer100g: 1, carbsPer100g: 1, sugarPer100g: 1, sodiumMgPer100g: 999, estimated: [], nutrientsEdited: true };
  const meal = await (await f.request('/api/meals', { name: '午餐', day: '2026-10-02', time: '12:00', photo: '', items: [
    { id: 'x1', name: '舊名', grams: 150, kcalPer100g: 300, source: 'manual', ...old },
    { id: 'x2', name: '白飯', grams: 200, kcalPer100g: 130, source: 'manual', proteinPer100g: 2, estimated: ['proteinPer100g'] }] })).json();
  const relookup = body => f.analyze({ model: 'gpt-5.6-terra', fallback: 'llm', mealId: meal.id, itemId: 'x1', ...body }, undefined, '/api/jobs/relookup');
  const read = async () => (await (await f.request('/api/meals/' + meal.id)).json()).items;
  // 本機庫命中且營養素完整：不補估，estimated 清空，手改旗標重設。
  let job = await relookup({ name: '完整飯' }); assert.equal(job.status, 'done'); assert.equal(f.calls.responses.length, 0);
  let [a, b] = await read();
  assert.deepEqual([a.name, a.grams, a.kcalPer100g, ...NKEYS.map(k => a[k]), a.estimated, a.nutrientsEdited], ['完整飯', 150, 130, ...Object.values(FILL), [], false]);
  assert.deepEqual([b.grams, b.proteinPer100g, b.estimated], [200, 2, ['proteinPer100g']]);
  // 本機庫命中但缺值：補估一次，只補 null 欄位。
  f.calls.reply = body => fillOf(body, FILL);
  job = await relookup({ name: '缺值麵' }); assert.equal(f.calls.responses.length, 1); assert.deepEqual(job.result.warnings, []);
  [a, b] = await read();
  assert.deepEqual([a.name, a.grams, a.kcalPer100g, a.proteinPer100g, a.fatPer100g, a.nutrientsEdited], ['缺值麵', 150, 140, 4, 0.3, false]);
  assert.deepEqual(a.estimated, NKEYS.filter(k => k !== 'proteinPer100g')); assert.equal(b.name, '白飯');
  // LLM 估算：營養素全為估算值，且不被補估呼叫覆蓋。
  f.calls.responses.length = 0;
  f.calls.reply = JSON.stringify({ kcalPer100g: 180, sourceUrl: '', sourceTitle: '', notes: '估', servingGrams: null, sameAs: null, ...FILL, sodiumMgPer100g: null });
  job = await relookup({ name: '未知排骨' }); assert.equal(f.calls.responses.length, 1);
  [a] = await read(); assert.deepEqual([a.source, a.sodiumMgPer100g, a.proteinPer100g, a.estimated], ['llm', null, 2.5, NKEYS.filter(k => k !== 'sodiumMgPer100g')]);
  assert.equal(a.nutrientsEdited, false);
});
test('重新查詢：補估失敗只加警告，熱量與已存的新名稱照常寫入', async t => {
  const f = await fixture(t); f.journal.putFood({ name: '缺值麵', kcalPer100g: 140, source: 'manual' });
  const meal = await (await f.request('/api/meals', { name: '午餐', day: '2026-10-02', time: '12:00', photo: '', items: [{ id: 'x1', name: '舊名', grams: 150, kcalPer100g: 300, source: 'manual', proteinPer100g: 9, nutrientsEdited: true }] })).json();
  f.calls.reply = '不是 JSON';
  const job = await f.analyze({ model: 'gpt-5.6-terra', fallback: 'llm', mealId: meal.id, itemId: 'x1', name: '缺值麵' }, undefined, '/api/jobs/relookup');
  assert.equal(job.status, 'done'); assert.equal(job.result.warnings.length, 1);
  const [a] = (await (await f.request('/api/meals/' + meal.id)).json()).items;
  assert.deepEqual([a.name, a.grams, a.kcalPer100g, a.proteinPer100g, a.estimated, a.nutrientsEdited], ['缺值麵', 150, 140, null, [], false]);
});
test('單項 AI 估算：回傳項目含營養素與 estimated（含補估），保存後寫入食物庫', async t => {
  const f = await fixture(t); f.journal.putFood({ name: '測試飯', kcalPer100g: 130, source: 'manual' });
  f.calls.reply = body => isFillBody(body) ? fillOf(body, FILL)
    : JSON.stringify(Array.isArray(body.input[0].content) || body.input[0].content.includes('套餐') ? { name: '套餐', items: [{ name: '測試飯', grams: 300 }, { name: '蘋果派', grams: 80 }] }
      : { kcalPer100g: 250, sourceUrl: '', sourceTitle: '', notes: '估', servingGrams: null, sameAs: null, ...FILL, fatPer100g: 11 });
  const r = await (await f.request('/api/estimate', { model: 'gpt-5.6-terra', fallback: 'llm', name: '測試飯套餐' })).json();
  const [rice, pie] = r.items;
  assert.deepEqual(NKEYS.map(k => rice[k]), Object.values(FILL)); assert.deepEqual(rice.estimated, NKEYS); // 補估
  assert.equal(pie.fatPer100g, 11); assert.deepEqual(pie.estimated, NKEYS); assert.equal(pie.cache, true);
  const saved = await (await f.request('/api/meals', { name: '套餐', day: '2026-10-02', time: '12:00', photo: '', items: r.items })).json();
  assert.equal(saved.items[1].fatPer100g, 11);
  const food = f.journal.foods('蘋果派')[0]; assert.deepEqual([food.fatPer100g, food.estimated], [11, NKEYS]);
});
test('真實 JWT 簽章驗證，拒絕錯誤 nonce、audience、issuer 與逾期', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const sign = (aud = 'client', iss = ISSUER, exp = '1h') => new SignJWT({ nonce: 'nonce' })
    .setProtectedHeader({ alg: 'RS256' }).setSubject('sub').setIssuer(iss).setAudience(aud)
    .setIssuedAt().setExpirationTime(exp).sign(privateKey);
  const token = await sign();
  assert.equal((await verifyIdentity(token, 'client', 'nonce', publicKey)).sub, 'sub');
  await assert.rejects(verifyIdentity(token, 'client', 'wrong', publicKey));
  await assert.rejects(verifyIdentity(await sign('wrong'), 'client', 'nonce', publicKey));
  await assert.rejects(verifyIdentity(await sign('client', 'https://evil.invalid'), 'client', 'nonce', publicKey));
  await assert.rejects(verifyIdentity(await sign('client', ISSUER, Math.floor(Date.now() / 1000) - 60), 'client', 'nonce', publicKey));
  const other = await generateKeyPair('RS256');
  await assert.rejects(verifyIdentity(token, 'client', 'nonce', other.publicKey));
});
test('SSE 處理逐位元組中文與 CRLF', async () => {
  const bytes = new TextEncoder().encode('data: {"type":"test","text":"測試"}\r\n\r\n');
  async function* split() { for (const byte of bytes) yield new Uint8Array([byte]); }
  const events = []; for await (const event of readSSE(split())) events.push(event);
  assert.deepEqual(events,[{type:'test',text:'測試'}]);
});
test('登出清除憑證並保留 host 及帳號註冊', async t => {
  const f = await fixture(t);
  await f.request('/api/logout', {});
  assert.equal(f.account.access_token, undefined); assert.equal(f.account.refresh_token, undefined);
  assert.equal(f.account.client_id, 'oaiapp_test'); assert.equal(f.store.data.hostId, 'test-host');
  assert.equal((await f.request('/api/models')).status, 401);
});

test('Origin null 登入表單必須有正確 Cookie 與 CSRF，正常表單成功導向 OAuth', async t => {
  const f = await fixture(t);
  const headers = { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' };
  assert.equal((await f.request('/auth/chatgpt', {}, { ...headers, 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await f.request('/auth/chatgpt', {}, { ...headers, cookie: 'local_session=wrong' })).status, 401);
  const response = await f.request('/auth/chatgpt', {}, headers);
  assert.equal(response.status, 303);
  assert.match(response.headers.get('location'), /^https:\/\/auth.openai.com/);
  assert.equal((await f.request('/api/status', null, headers)).status, 403);
});
test('只開放 GPT 主版本 < 6 的模型', async t => {
  for (const slug of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']) assert.equal(allowedModel(slug), true, slug);
  for (const slug of ['gpt-6-astra', 'gpt-6', 'gpt-6.1-sol', 'gpt-7', 'o3', '']) assert.equal(allowedModel(slug), false, slug);
  const f = await fixture(t);
  assert.equal((await f.request('/api/analyze', { model: 'gpt-6-astra', text: '飯' })).status, 400);
});
test('Tailscale 遠端：每人獨立日誌，不能管理登入', async t => {
  const f = await fixture(t);
  const remote = login => ({ Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', ...(login ? { 'Tailscale-User-Login': login } : {}) });
  const meal = { name: '朋友午餐', day: '2026-10-02', time: '12:00', photo: '', items: [{ name: '飯', grams: 100, kcalPer100g: 130, source: 'manual' }] };
  assert.equal((await f.request('/api/journal?day=2026-10-02', null, remote())).status, 403);
  assert.equal((await f.request('/api/status', null, { Host: 'evil.ts.net' })).status, 403);
  assert.equal((await f.request('/api/meals', meal, remote('friend@example.com'))).status, 200);
  const friend = await (await f.request('/api/journal?day=2026-10-02', null, remote('Friend@example.com'))).json();
  assert.equal(friend.meals.length, 1);
  const owner = await (await f.request('/api/journal?day=2026-10-02', null, remote('owner@example.com'))).json();
  assert.equal(owner.meals.length, 0);
  assert.equal((await (await f.request('/api/journal?day=2026-10-02')).json()).meals.length, 0);
  const status = await (await f.request('/api/status', null, remote('friend@example.com'))).json();
  assert.equal(status.remote, true); assert.equal(status.user, 'friend@example.com');
  assert.equal(status.accounts.every(a => !a.email), true);
  assert.equal((await f.request('/auth/chatgpt', {}, remote('owner@example.com'))).status, 403);
  assert.equal((await f.request('/api/logout', {}, remote('owner@example.com'))).status, 403);
  const models = await f.request('/api/models', null, remote('friend@example.com'));
  assert.equal(models.status, 200); assert.deepEqual((await models.json()).models, []); // ChatGPT 未開放給朋友
  assert.deepEqual(status.accounts, []); assert.notEqual(status.activeId, 'oaiapp_test');
  const ownerStatus = await (await f.request('/api/status', null, remote('owner@example.com'))).json();
  assert.deepEqual(ownerStatus.accounts.map(a => a.client_id), [ownerStatus.activeId]); assert.notEqual(ownerStatus.activeId, 'oaiapp_test');
});
test('經 Tailscale 轉送卻偽造 Host: 127.0.0.1 不算本機', async t => {
  const f = await fixture(t);
  for (const header of [{ 'Tailscale-User-Login': 'friend@example.com' }, { 'Tailscale-User-Login': 'owner@example.com' },
    { 'X-Forwarded-For': '100.64.0.2' }, { 'X-Forwarded-Host': '127.0.0.1:3000' }, { 'X-Forwarded-Proto': 'https' }])
    for (const path of ['/api/providers', '/api/admin/journals', '/api/status', '/api/logout'])
      assert.equal((await f.request(path, path === '/api/logout' ? {} : null, header)).status, 403, path);
  assert.equal((await f.request('/api/providers')).status, 200);
});
test('遠端改大小寫或加結尾斜線也不能進入本機專用路由', async t => {
  const f = await fixture(t);
  const paths = [['/api/Providers'], ['/api/providers/'], ['/API/LOGOUT', {}], ['/Api/Account'], ['/AUTH/chatgpt'], ['/auth/chatgpt/', {}]];
  for (const login of ['owner@example.com', 'friend@example.com'])
    for (const [path, body] of paths)
      assert.ok([403, 404].includes((await f.request(path, body, { Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', 'Tailscale-User-Login': login })).status), `${login} ${path}`);
  assert.equal((await f.request('/api/Providers')).status, 200);
  assert.equal((await f.request('/api/providers/')).status, 200);
  assert.equal(f.account.access_token !== undefined, true);
});
test('管理員檢視：本機可唯讀瀏覽所有日誌，遠端（含擁有者手機）一律拒絕', async t => {
  const f = await fixture(t);
  const remote = login => ({ Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', 'Tailscale-User-Login': login });
  const meal = { name: '朋友早餐', day: '2026-10-02', time: '08:00', photo: '', items: [{ name: '蛋', grams: 50, kcalPer100g: 150, source: 'manual' }] };
  await f.request('/api/meals', meal, remote('friend@example.com'));
  const status = await (await f.request('/api/status')).json();
  assert.equal(status.admin, true);
  const list = (await (await f.request('/api/admin/journals')).json()).journals;
  assert.deepEqual(list.map(j => [j.login, j.meals]), [['owner@example.com', 0], ['friend@example.com', 1]]);
  const friend = await (await f.request('/api/admin/journals/' + list[1].id)).json();
  assert.equal(friend.meals[0].name, '朋友早餐'); assert.equal(friend.stats.kcalTotal, 75);
  const detail = await (await f.request(`/api/admin/journals/${list[1].id}/meals/${friend.meals[0].id}`)).json();
  assert.equal(detail.items[0].name, '蛋');
  for (const login of ['owner@example.com', 'friend@example.com']) {
    assert.equal((await f.request('/api/admin/journals', null, remote(login))).status, 403);
    assert.equal((await (await f.request('/api/status', null, remote(login))).json()).admin, false);
  }
  assert.equal((await f.request('/api/admin/journals/nope')).status, 404);
});
test('食物庫在 app 內唯讀：沒有新增、匯入路由，朋友讀到共用庫', async t => {
  const f = await fixture(t); f.journal.putFood({ name: '測試飯', kcalPer100g: 130, source: 'web' });
  for (const path of ['/api/foods', '/api/foods/import']) assert.equal((await f.request(path, { name: 'x', kcalPer100g: 1, foods: [] })).status, 404);
  const remote = { Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', 'Tailscale-User-Login': 'friend@example.com' };
  assert.deepEqual((await (await f.request('/api/foods', null, remote)).json()).foods.map(x => x.name), ['測試飯']);
});

// Claude 模擬用戶端：記錄每次 Messages 參數，依 claude.reply 回覆（預設回辨識 JSON）。
function claudeMock() {
  const claude = { calls: [], keys: [], validated: [] };
  // messages.countTokens 模擬金鑰驗證：claude.keyError 設定時丟出（401／網路錯誤等）。
  claude.factory = key => { claude.keys.push(key); return { messages: { countTokens: async params => {
    claude.validated.push(key); claude.validatedModel = params.model; if (claude.keyError) throw claude.keyError; return { input_tokens: 8 };
  } }, beta: { messages: { create: async params => {
    claude.calls.push(params); if (claude.gate) await claude.gate; // gate：測試可讓呼叫暫停，模擬進行中的分析
    if (claude.error) throw claude.error;
    const text = claude.reply ? claude.reply(params) : JSON.stringify({ name: 'Claude餐', items: [{ name: '測試飯', grams: 100 }] });
    return { stop_reason: 'end_turn', content: [{ type: 'text', text }] };
  } } } }; };
  return claude;
}
const providers = (f, body) => f.request('/api/providers', body);

test('ChatGPT 額度分享：預設只供本機與擁有者；朋友略過 ChatGPT，CHATGPT_SHARED 開啟才可用', async t => {
  const remote = login => ({ Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', 'Tailscale-User-Login': login });
  const ready = async (f, headers) => (await (await f.request('/api/status', null, headers)).json());
  const off = await fixture(t); off.journal.putFood({ name: '測試飯', kcalPer100g: 130, source: 'manual' });
  assert.equal((await (await providers(off)).json()).providers[0].shared, false);
  assert.equal((await ready(off)).providersReady, true);
  assert.equal((await ready(off, remote('owner@example.com'))).providersReady, true);
  const friend = await ready(off, remote('friend@example.com'));
  assert.equal(friend.providersReady, false); assert.match(friend.providersError, /只供擁有者使用/);
  const denied = await off.request('/api/analyze', { model: 'gpt-5.6-terra', text: '飯' }, remote('friend@example.com'));
  assert.equal(denied.status, 401); assert.match((await denied.json()).error, /只供擁有者使用/);
  assert.equal(off.calls.responses.length, 0);
  assert.equal((await off.analyze({ model: 'gpt-5.6-terra', text: '飯' }, remote('owner@example.com'))).status, 'done');
  // 朋友：有 Claude 時略過 ChatGPT（即使 ChatGPT 排第一）。
  const claude = claudeMock(); const mixed = await fixture(t, { anthropicFactory: claude.factory });
  mixed.journal.putFood({ name: '測試飯', kcalPer100g: 130, source: 'manual' });
  await providers(mixed, { providers: [{ id: 'chatgpt', enabled: true }, { id: 'claude', enabled: true }], claudeApiKey: 'sk-ant-test-fake-0000' });
  assert.equal((await ready(mixed, remote('friend@example.com'))).providersReady, true);
  const before = mixed.calls.responses.length;
  const job = await mixed.analyze({ model: 'gpt-5.6-terra', text: '飯' }, remote('friend@example.com'));
  assert.equal(job.status, 'done'); assert.equal(job.result.servedBy.provider, 'claude'); assert.equal(mixed.calls.responses.length, before);
  const on = await fixture(t, { chatgptShared: true }); on.journal.putFood({ name: '測試飯', kcalPer100g: 130, source: 'manual' });
  assert.equal((await (await providers(on)).json()).providers[0].shared, true);
  const shared = await ready(on, remote('friend@example.com'));
  assert.equal(shared.providersReady, true); assert.equal('providersError' in shared, false);
  assert.equal((await on.analyze({ model: 'gpt-5.6-terra', text: '飯' }, remote('friend@example.com'))).result.servedBy.provider, 'chatgpt');
});
const remoteHeaders = { Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', 'Tailscale-User-Login': 'owner@example.com' };

test('AI 服務設定：預設 ChatGPT 優先、Claude 停用；保存順序與金鑰，GET 不洩漏金鑰；遠端一律 403', async t => {
  const claude = claudeMock(); const f = await fixture(t, { anthropicFactory: claude.factory });
  const initial = await (await providers(f)).json();
  assert.deepEqual(initial.providers.map(p => [p.id, p.enabled, p.ready, p.model]), [['chatgpt', true, true, ''], ['claude', false, false, 'claude-haiku-5-5']]);
  assert.deepEqual(initial.providers[0].models, []);
  assert.deepEqual(initial.providers[1].models.map(m => m.slug), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  assert.equal('keyHint' in initial.providers[1], false);
  const key = 'sk-ant-test-fake-1234';
  const saved = await (await providers(f, { providers: [{ id: 'claude', enabled: true, model: 'claude-sonnet-5-5' }, { id: 'chatgpt', enabled: false }], claudeApiKey: key })).json();
  assert.deepEqual(saved.providers.map(p => [p.id, p.enabled, p.ready, p.model]), [['claude', true, true, 'claude-sonnet-5-5'], ['chatgpt', false, true, '']]);
  assert.equal(saved.providers[0].keyHint, '••••1234'); assert.ok(!Number.isNaN(Date.parse(saved.providers[0].keyAddedAt)));
  assert.deepEqual(claude.validated, [key]); assert.equal(claude.validatedModel, 'claude-sonnet-5-5');
  assert.equal(f.store.data.providers[0].apiKey, key);
  const text = await (await providers(f)).text();
  assert.equal(text.includes(key), false); assert.equal(text.includes('apiKey'), false);
  // 未帶 claudeApiKey 保留金鑰；空字串清除。
  await providers(f, { providers: [{ id: 'chatgpt', enabled: true }, { id: 'claude', enabled: true, model: 'claude-opus-5-5' }] });
  assert.equal(f.store.data.providers[1].apiKey, key);
  const cleared = await (await providers(f, { providers: [{ id: 'chatgpt', enabled: true }, { id: 'claude', enabled: true }], claudeApiKey: '' })).json();
  assert.deepEqual(cleared.providers.map(p => [p.id, p.ready, 'keyHint' in p]), [['chatgpt', true, false], ['claude', false, false]]);
  for (const bad of [{ providers: [{ id: 'gemini', enabled: true }] }, { providers: [{ id: 'claude', enabled: true, model: 'gpt-5.6-sol' }] },
    { providers: [{ id: 'chatgpt', enabled: true }, { id: 'chatgpt', enabled: false }] }, { providers: [{ id: 'chatgpt', enabled: 'yes' }] },
    { providers: [{ id: 'chatgpt', enabled: true }], claudeApiKey: 'has space' }])
    assert.equal((await providers(f, bad)).status, 400);
  assert.equal((await f.request('/api/providers', null, remoteHeaders)).status, 403);
  assert.equal((await f.request('/api/providers', { providers: [] }, remoteHeaders)).status, 403);
});

test('providersReady：只有 Claude 金鑰也能分析；請求的空 model 不影響 Claude', async t => {
  const claude = claudeMock(); const f = await fixture(t, { anthropicFactory: claude.factory });
  f.journal.putFood({ name: '測試飯', kcalPer100g: 130, source: 'manual' });
  delete f.account.access_token; delete f.account.refresh_token;
  assert.equal((await (await f.request('/api/status')).json()).providersReady, false);
  assert.equal((await f.request('/api/analyze', { model: '', text: '飯' })).status, 401);
  await providers(f, { providers: [{ id: 'chatgpt', enabled: true }, { id: 'claude', enabled: true, model: 'claude-opus-5-5' }], claudeApiKey: 'sk-ant-test-fake-0000' });
  assert.equal((await (await f.request('/api/status')).json()).providersReady, true);
  const job = await f.analyze({ model: '', text: '飯' });
  assert.equal(job.status, 'done'); assert.deepEqual(job.result.servedBy, { provider: 'claude', model: 'claude-opus-5-5' });
  assert.equal(f.calls.responses.length, 0); assert.ok(claude.keys.every(k => k === 'sk-ant-test-fake-0000'));
  // ChatGPT 為第一順位但未登入：由備援 Claude 處理，備註加註 Claude 模型。
  assert.match(job.result.items[0].notes, /（由 Claude Opus 5\.5 處理）$/);
  const params = claude.calls[0];
  assert.equal(params.model, 'claude-opus-5-5'); assert.deepEqual(params.thinking, { type: 'adaptive' }); assert.equal(params.output_config.effort, 'medium');
  assert.equal(params.fallbacks, 'default'); assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(params.messages[0].content[1].text, '飯');
});

test('服務順序：第一個啟用者優先；停用者跳過；ChatGPT 429／400 改用 Claude 並加註；404 不換服務', async t => {
  const claude = claudeMock(); const f = await fixture(t, { anthropicFactory: claude.factory });
  f.journal.putFood({ name: '測試飯', kcalPer100g: 130, source: 'manual', proteinPer100g: 2.7, fatPer100g: 0.3, carbsPer100g: 28, sugarPer100g: 0, sodiumMgPer100g: 1 });
  // Claude 停用：ChatGPT 額度錯誤照舊直接失敗。
  await providers(f, { providers: [{ id: 'chatgpt', enabled: true }, { id: 'claude', enabled: false }], claudeApiKey: 'sk-ant-test-fake-0000' });
  f.calls.status = 429;
  assert.match((await f.analyze({ model: 'gpt-5.6-terra', text: '飯' })).error, /HTTP 429/); assert.equal(claude.calls.length, 0);
  // 啟用 Claude 為第二順位：429 換 Claude。
  await providers(f, { providers: [{ id: 'chatgpt', enabled: true }, { id: 'claude', enabled: true, model: 'claude-haiku-5-5' }] });
  const job = await f.analyze({ model: 'gpt-5.6-terra', text: '飯' });
  assert.equal(job.status, 'done'); assert.deepEqual(job.result.servedBy, { provider: 'claude', model: 'claude-haiku-5-5' });
  assert.match(job.result.items[0].notes, /（由 Claude Haiku 5\.5 處理）$/); assert.equal(claude.calls.length, 1);
  assert.equal('fallbacks' in claude.calls[0], false); // Haiku 沒有伺服器端 refusal fallback
  // 400：該服務不接受此要求，換下一個服務；404 不換。
  f.calls.status = 400;
  const rejected = await f.analyze({ model: 'gpt-5.6-terra', text: '飯' });
  assert.equal(rejected.status, 'done'); assert.deepEqual(rejected.result.servedBy, { provider: 'claude', model: 'claude-haiku-5-5' }); assert.equal(claude.calls.length, 2);
  f.calls.status = 404;
  const bad = await f.analyze({ model: 'gpt-5.6-terra', text: '飯' });
  assert.equal(bad.status, 'error'); assert.match(bad.error, /HTTP 404/); assert.equal(claude.calls.length, 2);
  // ChatGPT 正常：由第一順位處理，也加註模型名稱；食物庫裡帶舊標註的備註只保留一個標註。
  f.calls.status = 0; f.journal.putFood({ name: '舊標註飯', kcalPer100g: 130, source: 'manual', notes: '備註（由 Claude Haiku 5.5 處理）' });
  const ok = await (await f.request('/api/estimate', { model: 'gpt-5.6-terra', name: '飯', fallback: 'llm' })).json();
  assert.deepEqual(ok.servedBy, { provider: 'chatgpt', model: 'gpt-5.6-terra' }); assert.match(ok.items[0].notes, /（由 Test model 處理）$/);
  f.calls.reply = JSON.stringify({ name: '測試餐', items: [{ name: '舊標註飯', grams: 100 }] });
  const retag = await (await f.request('/api/estimate', { model: 'gpt-5.6-terra', name: '舊標註飯', fallback: 'llm' })).json();
  assert.equal(retag.items[0].notes, '備註（由 Test model 處理）'); f.calls.reply = undefined;
  // Claude 排第一：只呼叫 Claude；Claude 429 再換 ChatGPT。
  await providers(f, { providers: [{ id: 'claude', enabled: true }, { id: 'chatgpt', enabled: true }] });
  const before = f.calls.responses.length;
  const first = await (await f.request('/api/estimate', { model: 'gpt-5.6-terra', name: '飯', fallback: 'llm' })).json();
  assert.equal(first.servedBy.provider, 'claude'); assert.equal(f.calls.responses.length, before);
  claude.error = Object.assign(new Error('rate limited'), { status: 429 });
  const back = await (await f.request('/api/estimate', { model: 'gpt-5.6-terra', name: '飯', fallback: 'llm' })).json();
  assert.equal(back.servedBy.provider, 'chatgpt'); assert.match(back.items[0].notes, /（由 Test model 處理）$/);
  // 兩者都失敗：回傳最後一個錯誤。
  f.calls.status = 503;
  const failed = await f.request('/api/estimate', { model: 'gpt-5.6-terra', name: '飯', fallback: 'llm' });
  assert.equal(failed.status, 503); assert.match((await failed.json()).error, /OpenAI 要求失敗（HTTP 503/);
});

test('Claude 金鑰：先驗證再保存；無效／網路失敗回 400 不保存；回應與錯誤不含金鑰；清除立即刪除；ChatGPT 帶帳號清單', async t => {
  const claude = claudeMock(); const f = await fixture(t, { anthropicFactory: claude.factory });
  const key = 'sk-ant-test-fake-leak-5678';
  const texts = [];
  const post = async body => { const r = await providers(f, body); const text = await r.text(); texts.push(text); return { status: r.status, body: JSON.parse(text) }; };
  const order = [{ id: 'chatgpt', enabled: true }, { id: 'claude', enabled: true }];
  claude.keyError = Object.assign(new Error(`invalid x-api-key ${key}`), { status: 401 });
  let r = await post({ providers: order, claudeApiKey: key });
  assert.equal(r.status, 400); assert.equal(r.body.error, 'Claude API key 無效，請確認後再試。');
  claude.keyError = Object.assign(new Error(`connect ECONNREFUSED ${key}`), { cause: 'net' });
  r = await post({ providers: order, claudeApiKey: key });
  assert.equal(r.status, 400); assert.equal(r.body.error, '無法驗證 Claude API key，請稍後再試。');
  assert.equal(f.store.data.providers, undefined); // 失敗時連順序都不保存
  claude.keyError = null;
  r = await post({ providers: order, claudeApiKey: ` ${key} ` });
  const entry = r.body.providers.find(p => p.id === 'claude');
  assert.equal(entry.keyHint, '••••5678'); assert.ok(Date.parse(entry.keyAddedAt) <= Date.now());
  assert.equal(f.store.data.providers[1].apiKey, key); assert.equal(f.store.data.providers[1].keyAddedAt, entry.keyAddedAt);
  // ChatGPT 項目帶與 /api/status 相同的安全帳號欄位。
  const chatgpt = r.body.providers.find(p => p.id === 'chatgpt');
  assert.deepEqual(chatgpt.accounts, (await (await f.request('/api/status')).json()).accounts);
  assert.deepEqual(Object.keys(chatgpt.accounts[0]).sort(), ['client_id', 'planEnabled', 'signedIn']); // 無 token 欄位
  assert.equal(chatgpt.activeId, 'oaiapp_test');
  // 未帶金鑰：保留金鑰與加入時間，不再驗證。
  const validations = claude.validated.length;
  r = await post({ providers: [{ id: 'claude', enabled: true, model: 'claude-sonnet-5-5' }, { id: 'chatgpt', enabled: true }] });
  assert.equal(r.body.providers[0].keyAddedAt, entry.keyAddedAt); assert.equal(claude.validated.length, validations);
  // 清除：不驗證、立即刪除，其他設定不變。
  r = await post({ providers: [{ id: 'claude', enabled: true }, { id: 'chatgpt', enabled: true }], claudeApiKey: '' });
  assert.equal(claude.validated.length, validations);
  assert.deepEqual(r.body.providers.map(p => [p.id, p.enabled, p.ready, 'keyHint' in p, 'keyAddedAt' in p]), [['claude', true, false, false, false], ['chatgpt', true, true, false, false]]);
  assert.equal(f.store.data.providers[0].apiKey, ''); assert.equal('keyAddedAt' in f.store.data.providers[0], false);
  texts.push(await (await providers(f)).text(), await (await f.request('/api/status')).text());
  for (const text of texts) assert.equal(text.includes(key), false);
});
test('背景分析自動存檔後，補估的營養素出現在餐點中並標「估」，熱量不變；寫回食物庫後不再補估；補估失敗不影響存檔', async t => {
  const f = await fixture(t);
  f.journal.putFood({ name: '補估飯', kcalPer100g: 130, source: 'manual' });
  f.journal.putFood({ name: '補估麵', kcalPer100g: 140, source: 'manual' });
  const fill = { proteinPer100g: 2.5, fatPer100g: 0.3, carbsPer100g: 28, sugarPer100g: 0, sodiumMgPer100g: 1 };
  const isFill = body => JSON.stringify(body).includes('nutrient_fill');
  const recognition = name => JSON.stringify({ name: '補估餐', items: [{ name, grams: 100 }] });
  f.calls.reply = body => isFill(body) ? JSON.stringify({ items: [{ id: JSON.parse(body.input[0].content).items[0].id, ...fill }] }) : recognition('補估飯');
  const job = await f.analyze({ model: 'gpt-5.6-terra', text: '飯', fallback: 'llm' });
  assert.equal(job.status, 'done'); assert.equal(f.calls.responses.length, 2);
  const meal = await (await f.request('/api/meals/' + job.mealId)).json();
  assert.equal(meal.items[0].kcalPer100g, 130); assert.equal(meal.items[0].proteinPer100g, 2.5); assert.equal(meal.items[0].estimated.length, 5);
  assert.deepEqual(job.result.warnings, []);
  // 補估結果已帶「估」寫回食物庫（ADR 0010）：再記同一種食物只需辨識一次呼叫。
  const food = f.journal.foods('補估飯')[0];
  assert.equal(food.kcalPer100g, 130); assert.equal(food.proteinPer100g, 2.5); assert.equal(food.estimated.length, 5);
  const again = await f.analyze({ model: 'gpt-5.6-terra', text: '飯', fallback: 'llm' });
  assert.equal(again.status, 'done'); assert.equal(f.calls.responses.length, 3);
  f.calls.reply = body => isFill(body) ? '不是 JSON' : recognition('補估麵');
  const failed = await f.analyze({ model: 'gpt-5.6-terra', text: '麵', fallback: 'llm' });
  assert.equal(failed.status, 'done'); assert.equal(failed.result.warnings.length, 1);
  const kept = await (await f.request('/api/meals/' + failed.mealId)).json();
  assert.equal(kept.items[0].kcalPer100g, 140); assert.equal(kept.items[0].proteinPer100g, null);
});

// 再記一次（repeat-meals ticket 01）：POST /api/meals/:id/repeat；「現在」由 createApp 的 now 注入（2026-11-05 週四 13:00），避免本地午夜前後偶發失敗。
const REPEAT_NOW = new Date(2026, 10, 5, 13, 0), REPEAT_TODAY = '2026-11-05';
const repeatItems = foodId => [
  { id: 'src-1', name: '吐司', grams: 60, kcalPer100g: 260, source: 'web', sourceUrl: 'https://example.com/toast', sourceTitle: '吐司營養', foodId, matched: true, recognizedName: '白吐司',
    proteinPer100g: 8, fatPer100g: 4, carbsPer100g: 48, sugarPer100g: null, sodiumMgPer100g: 450, estimated: ['proteinPer100g'], nutrientsEdited: false, cache: true },
  { id: 'src-2', name: '豆漿', grams: 250, kcalPer100g: 35, source: 'llm', proteinPer100g: null, fatPer100g: null, carbsPer100g: null, sugarPer100g: null, sodiumMgPer100g: null, nutrientsEdited: true, cache: false }];
async function repeatFixture(t, extra) {
  const f = await fixture(t, { now: () => new Date(REPEAT_NOW), ...extra });
  // 庫裡的吐司有 estimated 蛋白質、其餘營養素未知：若複製觸發補值或加別名，庫內容就會改變。
  const foodId = f.journal.putFood({ name: '吐司', kcalPer100g: 260, source: 'web', sourceUrl: 'https://example.com/toast', sourceTitle: '吐司營養', proteinPer100g: 8, fatPer100g: null, carbsPer100g: null, sugarPer100g: null, sodiumMgPer100g: null, estimated: ['proteinPer100g'] });
  const src = await (await f.request('/api/meals', { name: '早餐', day: '2026-01-05', time: '08:10', photo: 'data:image/jpeg;base64,AAAA', items: repeatItems(foodId) })).json();
  return { f, foodId, src };
}
const friendHeaders = login => ({ Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', 'Tailscale-User-Login': login });
test('再記一次：複製成今天的新餐點，項目原樣保留、換新 id，不含照片', async t => {
  const { f, foodId, src } = await repeatFixture(t);
  assert.equal(src.hasPhoto, true);
  const res = await f.request(`/api/meals/${src.id}/repeat`, {}); const m = await res.json();
  assert.equal(res.status, 200); assert.notEqual(m.id, src.id);
  assert.equal(m.name, '早餐'); assert.equal(m.day, REPEAT_TODAY); assert.equal(m.time, '13:00');
  assert.equal(m.photo, ''); assert.equal(m.hasPhoto, false); assert.equal(m.kcal, src.kcal);
  assert.equal(m.items.length, 2);
  m.items.forEach((item, i) => {
    assert.notEqual(item.id, src.items[i].id); assert.ok(item.id);
    // 複製出的項目一律 cache:false（不寫入食物庫，spec repeat-meals），其餘欄位原樣。
    assert.equal(item.cache, false); assert.deepEqual({ ...item, id: 0, cache: 0 }, { ...src.items[i], id: 0, cache: 0 });
  });
  assert.equal(src.items[0].cache, true); // 來源本來是可快取的網路資料
  assert.equal(m.items[0].foodId, foodId); assert.deepEqual(m.items[0].estimated, ['proteinPer100g']); assert.equal(m.items[1].nutrientsEdited, true);
  assert.deepEqual(m.nutrients, src.nutrients);
  assert.deepEqual(await (await f.request('/api/meals/' + m.id)).json(), m); // 已存入
});
test('再記一次：不寫食物庫、不補營養素、不加別名；來源餐點不變', async t => {
  const { f, src } = await repeatFixture(t);
  const foods = JSON.stringify(f.journal.foods()), before = JSON.stringify(await (await f.request('/api/meals/' + src.id)).json());
  assert.equal((await f.request(`/api/meals/${src.id}/repeat`, { time: '09:00' })).status, 200);
  assert.equal(JSON.stringify(f.journal.foods()), foods);
  assert.equal(JSON.stringify(await (await f.request('/api/meals/' + src.id)).json()), before);
  // 對照：一般儲存同樣的內容會補值（證明上面的不變是「再記一次」的功勞，不是夾具本來就補不了）。
  await f.request('/api/meals', { day: '2026-01-06', time: '08:00', items: [{ ...src.items[0], source: 'web', matched: true, nutrientsEdited: false, recognizedName: '烤吐司' }] });
  assert.notEqual(JSON.stringify(f.journal.foods()), foods);
});
test('再記一次：time 省略用伺服器現在；有給就用給定值；日期一律今天', async t => {
  const { f, src } = await repeatFixture(t);
  const m = await (await f.request(`/api/meals/${src.id}/repeat`, {})).json();
  assert.equal(m.time, '13:00'); assert.equal(m.day, REPEAT_TODAY);
  const given = await (await f.request(`/api/meals/${src.id}/repeat`, { time: '07:05' })).json();
  assert.equal(given.time, '07:05'); assert.equal(given.day, REPEAT_TODAY);
});
test('再記一次：來源不存在 404；time 格式不正確 400', async t => {
  const { f, src } = await repeatFixture(t);
  const r404 = await f.request('/api/meals/不存在/repeat', {}); assert.equal(r404.status, 404); assert.match((await r404.json()).error, /找不到餐點/);
  for (const time of ['9:00', '24:00', '12:60', 'abc', '', 900, null, ['09:00']]) {
    const r = await f.request(`/api/meals/${src.id}/repeat`, { time }); assert.equal(r.status, 400, JSON.stringify(time)); assert.match((await r.json()).error, /時間/);
  }
  assert.equal((await (await f.request('/api/journal?day=' + REPEAT_TODAY)).json()).meals.length, 0); // 失敗不留下餐點
});
test('再記一次：當日總量、營養素總計與連勝照常更新', async t => {
  const { f, src } = await repeatFixture(t);
  const today = REPEAT_TODAY, get = async () => (await f.request(`/api/journal?day=${today}&today=${today}`)).json();
  const before = await get(); assert.equal(before.meals.length, 0); assert.equal(before.streak, 0);
  await f.request(`/api/meals/${src.id}/repeat`, { time: '08:00' });
  const after = await get();
  assert.equal(after.meals.length, 1); assert.equal(after.meals[0].kcal, src.kcal);
  assert.deepEqual(after.dayNutrients, src.nutrients); assert.equal(after.streak, 1);
  await f.request(`/api/meals/${src.id}/repeat`, { time: '12:00' });
  const twice = await get();
  assert.equal(twice.meals.reduce((s, m) => s + m.kcal, 0), src.kcal * 2);
  assert.equal(twice.dayNutrients.protein.known, src.nutrients.protein.known * 2);
});
test('再記一次：朋友日誌只能複製自己日誌的餐點，且不碰共用食物庫', async t => {
  const { f, src } = await repeatFixture(t, { friendsCache: true });
  const friend = friendHeaders('friend@example.com');
  assert.equal((await f.request(`/api/meals/${src.id}/repeat`, {}, friend)).status, 404); // 擁有者的餐點，朋友看不到
  const mine = await (await f.request('/api/meals', { name: '朋友餐', day: '2026-01-05', time: '08:00', items: repeatItems('') }, friend)).json();
  assert.equal((await f.request(`/api/meals/${mine.id}/repeat`, {}, friendHeaders('other@example.com'))).status, 404); // 別的朋友也不行
  assert.equal((await f.request(`/api/meals/${mine.id}/repeat`, {})).status, 404); // 擁有者也看不到朋友的
  const foods = JSON.stringify(f.journal.foods());
  const copy = await (await f.request(`/api/meals/${mine.id}/repeat`, { time: '10:00' }, friend)).json();
  assert.equal(copy.name, '朋友餐'); assert.equal(copy.time, '10:00');
  assert.equal(JSON.stringify(f.journal.foods()), foods); // 即使 friendsCache 開啟，複製也不寫共用庫
  assert.equal((await (await f.request('/api/journal?day=' + REPEAT_TODAY, null, friend)).json()).meals.length, 1);
  assert.equal((await (await f.request('/api/journal?day=' + REPEAT_TODAY)).json()).meals.length, 0); // 擁有者日誌不受影響
});

test('再記一次後再編輯：只改克數再存，食物庫不變', async t => {
  const { f, src } = await repeatFixture(t);
  const foods = JSON.stringify(f.journal.foods());
  const copy = await (await f.request(`/api/meals/${src.id}/repeat`, { time: '09:00' })).json();
  const edited = await f.request('/api/meals', { ...copy, items: copy.items.map(i => ({ ...i, grams: i.grams + 10 })) });
  assert.equal(edited.status, 200); assert.equal((await edited.json()).items[0].grams, 70);
  assert.equal(JSON.stringify(f.journal.foods()), foods);
});
// 來源餐點當時沒寫入食物庫（例如朋友未開 FRIENDS_CACHE 時記的、或維護者整理過庫）：複製後再編輯存檔，
// 未命中的可快取項目不寫入、也不補營養素；命中項目（matched）與「直接編輯原餐點再存」的結果一致（補別名、補 null 營養素）。
test('再記一次後再編輯：未命中的網路資料不寫入食物庫；命中項目與編輯原餐點一致', async t => {
  const egg = { name: '荷包蛋', grams: 50, kcalPer100g: 200, source: 'web', sourceUrl: 'https://example.com/egg', sourceTitle: '蛋', cache: true,
    proteinPer100g: 13, fatPer100g: 15, carbsPer100g: 1, sugarPer100g: null, sodiumMgPer100g: 140 };
  const setup = async () => {
    const f = await fixture(t, { now: () => new Date(REPEAT_NOW) });
    const foodId = f.journal.putFood({ name: '吐司', kcalPer100g: 260, source: 'web', sourceUrl: 'https://example.com/toast', sourceTitle: '吐司營養', proteinPer100g: 8, estimated: ['proteinPer100g'] });
    const items = [{ name: '吐司', grams: 60, kcalPer100g: 260, source: 'web', foodId, matched: true, recognizedName: '烤吐司', proteinPer100g: 8, fatPer100g: 4, sugarPer100g: 5, estimated: ['proteinPer100g', 'sugarPer100g'] }, egg];
    const src = f.journal.saveMeal({ name: '早餐', day: '2026-11-04', time: '08:00', items }, { shareFoods: false });
    return { f, src, toast: () => f.journal.foods().find(x => x.name === '吐司'), names: () => f.journal.foods().map(x => x.name).sort() };
  };
  const bump = m => ({ ...m, items: m.items.map(i => ({ ...i, grams: i.grams + 10 })) });
  const a = await setup(); const before = a.names();
  const copy = await (await a.f.request(`/api/meals/${a.src.id}/repeat`, {})).json();
  assert.ok(copy.items.every(i => i.cache === false));
  assert.equal((await a.f.request('/api/meals', bump(copy))).status, 200);
  assert.deepEqual(a.names(), before); // 荷包蛋沒有被寫入
  // 對照：直接編輯原餐點再存（荷包蛋 cache:true 會寫入）；命中的吐司兩邊結果相同。
  const b = await setup();
  assert.equal((await b.f.request('/api/meals', bump(b.f.journal.meal(b.src.id)))).status, 200);
  assert.ok(b.names().includes('荷包蛋'));
  const { id: _a, ...toastA } = a.toast(), { id: _b, ...toastB } = b.toast();
  assert.deepEqual(toastA, toastB); assert.deepEqual(toastA.aliases, ['烤吐司']); assert.equal(toastA.fatPer100g, 4);
});

// 候選餐點（repeat-meals ticket 02）：GET /api/repeat-candidates；「現在」由 createApp 的 now 注入（2026-11-05 週四 13:00）。
async function candidateFixture(t, at = new Date(2026, 10, 5, 13, 0)) {
  const clock = { at }; const f = await fixture(t, { now: () => new Date(clock.at) });
  const save = (day, time, items, name, headers) => f.request('/api/meals', { name, day, time, items }, headers).then(r => r.json());
  const list = async headers => { const res = await f.request('/api/repeat-candidates', null, headers); assert.equal(res.status, 200); return (await res.json()).candidates; };
  return { f, clock, save, list };
}
const toastItems = (toast = 60, soy = 250) => [{ name: '吐司', grams: toast, kcalPer100g: 260, source: 'web', sourceUrl: 'https://example.com/t' }, { name: '豆漿', grams: soy, kcalPer100g: 35, source: 'llm', proteinPer100g: 3.5, estimated: ['proteinPer100g'] }];
const lunch = [{ name: '雞腿便當', grams: 500, kcalPer100g: 160, source: 'manual' }];
test('候選餐點：回傳欄位（名稱、項目摘要、總熱量、時間、出現次數、來源餐點 id），同一種採最近克數', async t => {
  const { save, list } = await candidateFixture(t);
  await save('2026-11-03', '08:00', toastItems(), '早餐');
  const latest = await save('2026-11-04', '08:30', [...toastItems(90, 300)].reverse(), '最近早餐');
  assert.deepEqual(await list(), [{ mealId: latest.id, name: '最近早餐', items: [{ name: '豆漿', grams: 300 }, { name: '吐司', grams: 90 }], kcal: latest.kcal, time: '08:15', count: 2 }]);
});
test('候選餐點：30 天邊界、刪除不計、只算平日、至少 2 次、中位數、晚於現在與 90 分鐘內不顯示', async t => {
  const { f, save, list } = await candidateFixture(t);
  await save('2026-10-05', '08:00', toastItems()); // 第 31 天：不計
  await save('2026-11-04', '08:00', toastItems());
  assert.deepEqual(await list(), []);
  const old = await save('2026-10-06', '07:00', toastItems()); // 第 30 天：計入
  assert.equal((await list())[0].count, 2); assert.equal((await list())[0].time, '07:30');
  await f.request('/api/meals/' + old.id, undefined, { method: 'DELETE' });
  assert.deepEqual(await list(), []); // 刪除後不計
  await save('2026-10-31', '08:00', toastItems()); await save('2026-11-01', '08:00', toastItems()); // 週末不計
  assert.deepEqual(await list(), []);
  await save('2026-11-02', '07:00', toastItems()); await save('2026-11-03', '10:00', toastItems());
  assert.equal((await list())[0].time, '08:00'); // 07:00、08:00、10:00 的中位數
  await save('2026-11-03', '13:30', lunch); await save('2026-11-04', '13:30', lunch); // 晚於現在 13:00
  assert.deepEqual((await list()).map(c => c.name), ['吐司、豆漿']);
  await save('2026-11-05', '09:30', [{ name: '咖啡', grams: 200, kcalPer100g: 10 }]); // 與 08:00 相差 90 分（含）
  assert.deepEqual(await list(), []);
});
test('候選餐點：一整天沒記時早餐午餐同時列出；點選後以常見時間存成今天，內容同來源；補記後消失', async t => {
  const { f, save, list } = await candidateFixture(t);
  await save('2026-11-03', '10:20', toastItems(), '早餐'); const src = await save('2026-11-04', '10:40', toastItems(70), '早餐');
  await save('2026-11-03', '12:00', lunch, '午餐'); await save('2026-11-04', '12:10', lunch, '午餐');
  const all = await list();
  assert.deepEqual(all.map(c => [c.time, c.name]), [['10:30', '早餐'], ['12:05', '午餐']]);
  const res = await f.request(`/api/meals/${all[0].mealId}/repeat`, { time: all[0].time }); const m = await res.json();
  assert.equal(res.status, 200); assert.equal(m.day, '2026-11-05'); assert.equal(m.time, '10:30'); assert.equal(m.name, '早餐');
  assert.deepEqual(m.items.map(({ id, ...i }) => i), src.items.map(({ id, ...i }) => i)); assert.equal(m.kcal, src.kcal);
  assert.deepEqual((await list()).map(c => c.name), ['午餐']); // 補記後早餐候選消失
});
test('候選餐點：朋友日誌互不影響；週六同樣各自計算', async t => {
  const { clock, save, list } = await candidateFixture(t);
  const friend = friendHeaders('friend@example.com');
  await save('2026-11-03', '08:00', toastItems(), '早餐'); await save('2026-11-04', '08:00', toastItems(), '早餐');
  await save('2026-11-03', '12:00', lunch, '朋友午餐', friend); await save('2026-11-04', '12:00', lunch, '朋友午餐', friend);
  assert.deepEqual((await list()).map(c => c.name), ['早餐']);
  assert.deepEqual((await list(friend)).map(c => c.name), ['朋友午餐']);
  assert.deepEqual(await list(friendHeaders('other@example.com')), []);
  clock.at = new Date(2026, 10, 7, 13, 0); // 週六：最近吃過，各自計算
  assert.deepEqual((await list()).map(c => c.name), ['早餐']);
  assert.deepEqual((await list(friend)).map(c => c.name), ['朋友午餐']);
  assert.deepEqual(await list(friendHeaders('other@example.com')), []);
});
test('候選餐點：假日顯示最近吃過（含平日、只吃一次），時間為最近一次，點選後存成今天', async t => {
  const { f, clock, save, list } = await candidateFixture(t, new Date(2026, 10, 7, 13, 0)); // 週六
  const dinner = [{ name: '晚餐', grams: 100, kcalPer100g: 100, source: 'manual' }];
  await save('2026-11-02', '07:00', toastItems(), '早餐'); await save('2026-11-03', '07:10', toastItems(), '早餐');
  const lastBreakfast = await save('2026-11-06', '10:20', toastItems(80), '週五早餐');
  const once = await save('2026-11-01', '12:30', lunch, '週日午餐'); // 只吃一次，週日也算
  await save('2026-10-07', '12:00', [{ name: '舊的', grams: 100, kcalPer100g: 100, source: 'manual' }]); // 第 31 天不計
  await save('2026-11-06', '18:00', dinner, '晚於現在');
  const all = await list();
  assert.deepEqual(all.map(c => [c.time, c.name, c.count, c.mealId]), [['10:20', '週五早餐', 3, lastBreakfast.id], ['12:30', '週日午餐', 1, once.id]]);
  const res = await f.request(`/api/meals/${all[0].mealId}/repeat`, { time: all[0].time }); const m = await res.json();
  assert.equal(res.status, 200); assert.equal(m.day, '2026-11-07'); assert.equal(m.time, '10:20'); assert.equal(m.name, '週五早餐');
  assert.deepEqual(m.items.map(({ id, ...i }) => i), lastBreakfast.items.map(({ id, ...i }) => i));
  assert.deepEqual((await list()).map(c => c.name), ['週日午餐']); // 10:20 已記，早餐候選消失
  clock.at = new Date(2026, 10, 9, 13, 0); // 週一回到平日規則：只算平日、至少 2 次
  assert.deepEqual((await list()).map(c => [c.name, c.count]), [['週五早餐', 3]]);
});

// 體重紀錄（docs/specs/weight-tracking.md）：GET /api/weights、PUT/DELETE /api/weights/:day；「今天」由注入的 now 決定（2026-11-05）。
const weightFixture = (t, extra) => fixture(t, { now: () => new Date(2026, 10, 5, 13, 0), ...extra });
const foodsOf = f => f.journal.foods().map(({ id, name, kcalPer100g }) => ({ id, name, kcalPer100g }));
const putWeight = (f, day, kg, extra) => f.request('/api/weights/' + day, { kg }, { method: 'PUT', ...extra });
test('體重紀錄：記一筆後可讀回，目前體重取最新日期；同一天再記為覆蓋', async t => {
  const f = await weightFixture(t);
  assert.deepEqual(await (await f.request('/api/weights')).json(), { weights: [], current: null });
  assert.equal((await putWeight(f, '2026-11-03', 70.04)).status, 200);
  assert.equal((await putWeight(f, '2026-11-05', 69.5)).status, 200);
  assert.equal((await putWeight(f, '2026-11-05', 69.2)).status, 200); // 覆蓋
  const body = await (await f.request('/api/weights')).json();
  assert.deepEqual(body.weights, [{ day: '2026-11-03', kg: 70 }, { day: '2026-11-05', kg: 69.2 }]); // 小數一位、日期遞增
  assert.deepEqual(body.current, { kg: 69.2, day: '2026-11-05', source: 'record' });
});
test('體重紀錄：補記過去日期後目前體重仍是最新一筆；可刪除，刪光後沒有目前體重', async t => {
  const f = await weightFixture(t);
  await putWeight(f, '2026-11-05', 69.2);
  await putWeight(f, '2026-10-01', 72); // 補記更早的日子
  assert.equal((await (await f.request('/api/weights')).json()).current.day, '2026-11-05');
  await putWeight(f, '2026-10-01', 71.5); // 修改
  assert.deepEqual((await (await f.request('/api/weights')).json()).weights[0], { day: '2026-10-01', kg: 71.5 });
  assert.equal((await f.request('/api/weights/2026-11-05', null, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await (await f.request('/api/weights')).json()).current, { kg: 71.5, day: '2026-10-01', source: 'record' });
  await f.request('/api/weights/2026-10-01', null, { method: 'DELETE' });
  assert.deepEqual(await (await f.request('/api/weights')).json(), { weights: [], current: null });
});
test('體重紀錄：拒絕未來日期、不合理的體重與壞日期，並回繁體中文錯誤；不留下紀錄', async t => {
  const f = await weightFixture(t);
  let res = await putWeight(f, '2026-11-06', 70); assert.equal(res.status, 400); assert.equal((await res.json()).error, '不能記錄未來的日期。');
  for (const kg of [24.9, 300.1, '70', null, NaN, undefined]) { res = await putWeight(f, '2026-11-05', kg); assert.equal(res.status, 400, String(kg)); assert.match((await res.json()).error, /25–300 公斤/); }
  assert.equal((await putWeight(f, '2026-02-30', 70)).status, 400);
  assert.equal((await putWeight(f, 'abc', 70)).status, 400);
  assert.equal((await putWeight(f, '2026-11-05', 25)).status, 200); // 邊界值可記
  assert.equal((await putWeight(f, '2026-11-04', 300)).status, 200);
  assert.deepEqual((await (await f.request('/api/weights')).json()).weights.map(w => w.day), ['2026-11-04', '2026-11-05']);
});
test('體重紀錄：沒有紀錄時目前體重是計劃裡的體重；有紀錄後改用紀錄；沒有計劃也能記', async t => {
  const f = await weightFixture(t);
  assert.equal((await (await f.request('/api/weights')).json()).current, null);
  await f.request('/api/settings', { plan: { sex: 'f', age: 28, height: 165, weight: 60, target: 55, activity: 1.2 } });
  assert.deepEqual((await (await f.request('/api/weights')).json()).current, { kg: 60, day: null, source: 'plan' });
  await putWeight(f, '2026-11-05', 58.8);
  assert.deepEqual((await (await f.request('/api/weights')).json()).current, { kg: 58.8, day: '2026-11-05', source: 'record' });
  const g = await weightFixture(t); // 沒有計劃的日誌
  assert.equal((await putWeight(g, '2026-11-05', 80)).status, 200);
});
test('體重紀錄：記錄、刪除不改動減重計劃、每日熱量目標與連勝；匯出備份包含體重紀錄', async t => {
  const f = await weightFixture(t);
  const plan = { sex: 'f', age: 28, height: 165, weight: 60, target: 55, activity: 1.2, startDate: '2026-10-01' };
  const before = await (await f.request('/api/settings', { goal: 1500, plan })).json();
  f.journal.saveMeal({ name: '早餐', day: '2026-11-05', time: '08:00', items: [{ name: '白飯', grams: 100, kcalPer100g: 130, source: 'web', sourceUrl: 'https://example.com/rice', sourceTitle: '白飯', cache: true }] });
  const foodsBefore = foodsOf(f), streakOf = async () => (await (await f.request('/api/journal?day=2026-11-05&today=2026-11-05')).json()).streak;
  assert.equal(foodsBefore.length, 1); assert.equal(await streakOf(), 1); // 前置：食物庫有內容、連勝成立
  await putWeight(f, '2026-11-05', 58.8); await putWeight(f, '2026-11-01', 59.5); await f.request('/api/weights/2026-11-01', null, { method: 'DELETE' });
  const settings = (await (await f.request('/api/journal?day=2026-11-05&today=2026-11-05')).json()).settings;
  assert.equal(settings.goal, 1500); assert.deepEqual(settings.plan, before.plan);
  assert.deepEqual(foodsOf(f), foodsBefore); assert.equal(await streakOf(), 1); // 食物庫、連勝不變
  const exported = await (await f.request('/api/export')).json();
  assert.deepEqual(exported.weights, [{ day: '2026-11-05', kg: 58.8 }]);
});
test('體重紀錄：刪除壞日期或不存在的日期不報錯、不改動既有紀錄；沒有紀錄時匯出 weights 為空陣列', async t => {
  const f = await weightFixture(t);
  assert.deepEqual((await (await f.request('/api/export')).json()).weights, []);
  await putWeight(f, '2026-11-05', 70);
  for (const day of ['abc', '2026-02-30', '2026-11-04']) {
    const res = await f.request('/api/weights/' + day, null, { method: 'DELETE' });
    assert.equal(res.status, 200, day); assert.deepEqual((await res.json()).weights, [{ day: '2026-11-05', kg: 70 }]);
  }
});
test('體重紀錄：朋友日誌各自一份，與主日誌互不可見', async t => {
  const f = await weightFixture(t, { chatgptShared: true });
  const friend = friendHeaders('friend@example.com');
  await putWeight(f, '2026-11-05', 70);
  await putWeight(f, '2026-11-04', 55, friend);
  assert.deepEqual((await (await f.request('/api/weights')).json()).weights, [{ day: '2026-11-05', kg: 70 }]);
  assert.deepEqual((await (await f.request('/api/weights', null, friend)).json()).weights, [{ day: '2026-11-04', kg: 55 }]);
  await f.request('/api/weights/2026-11-05', null, { method: 'DELETE', ...friend }); // 朋友刪同一天不影響主日誌
  assert.equal((await (await f.request('/api/weights')).json()).weights.length, 1);
});

// 目前體重進入計劃計算（docs/specs/weight-tracking.md）：日誌 API 一併回傳體重狀態，前端不另外推導目前體重。
test('日誌 API 回傳體重狀態：沒有紀錄時目前體重是計劃體重，記錄後改為最新紀錄；每日熱量目標與計劃不變', async t => {
  const f = await weightFixture(t);
  const journal = async () => (await (await f.request('/api/journal?day=2026-11-05&today=2026-11-05')).json());
  assert.deepEqual((await journal()).weight, { weights: [], current: null });
  const plan = { sex: 'f', age: 28, height: 165, weight: 90, target: 60, activity: 1.2, startDate: '2026-10-01' };
  await f.request('/api/settings', { goal: 1500, plan });
  assert.deepEqual((await journal()).weight.current, { kg: 90, day: null, source: 'plan' });
  await putWeight(f, '2026-11-05', 80);
  const after = await journal();
  assert.deepEqual(after.weight, { weights: [{ day: '2026-11-05', kg: 80 }], current: { kg: 80, day: '2026-11-05', source: 'record' } });
  assert.equal(after.settings.goal, 1500); assert.deepEqual(after.settings.plan, plan);
});

// 重新開始計劃（ticket 03）：開始日由前端的「今天」傳入，裝置時區可能比伺服器快一兩天；伺服器以注入的 now 判斷本地今天。
test('計劃開始日：比伺服器今天晚一兩天（裝置時區較快）時以伺服器今天為準；更晚仍拒絕', async t => {
  const f = await fixture(t, { now: () => new Date(2026, 2, 10, 13, 0) }); // 伺服器今天 2026-03-10
  const plan = { sex: 'f', age: 28, height: 165, weight: 85, target: 60, activity: 1.2 };
  for (const startDate of ['2026-03-11', '2026-03-12']) {
    const res = await f.request('/api/settings', { plan: { ...plan, startDate } });
    assert.equal(res.status, 200, startDate); assert.equal((await res.json()).plan.startDate, '2026-03-10');
  }
  assert.equal((await (await f.request('/api/settings', { plan: { ...plan, startDate: '2026-03-08' } })).json()).plan.startDate, '2026-03-08');
  const res = await f.request('/api/settings', { plan: { ...plan, startDate: '2026-03-13' } });
  assert.equal(res.status, 400); assert.equal((await res.json()).error, '計劃開始日期不正確。');
  assert.equal(f.journal.preferences().plan.startDate, '2026-03-08');
});
test('起點每日目標 startGoal：可省略；500–10000 的整數才保存，否則 400；之後改每日目標不改動它', async t => {
  const f = await weightFixture(t);
  const plan = { sex: 'f', age: 28, height: 165, weight: 90, target: 60, activity: 1.2, startDate: '2026-10-01' };
  assert.equal((await (await f.request('/api/settings', { plan })).json()).plan.startGoal, undefined); // 舊計劃沒有此欄位
  for (const startGoal of [499, 10001, 1500.5, '1500', null]) {
    const res = await f.request('/api/settings', { plan: { ...plan, startGoal } });
    assert.equal(res.status, 400, String(startGoal)); assert.equal((await res.json()).error, '起點每日目標不正確，需為 500～10000 kcal 的整數。');
  }
  for (const startGoal of [500, 10000, 1500]) assert.equal((await (await f.request('/api/settings', { plan: { ...plan, startGoal } })).json()).plan.startGoal, startGoal);
  await f.request('/api/settings', { goal: 1700 });
  assert.deepEqual(f.journal.preferences().plan, { ...plan, startGoal: 1500 });
});

test('朋友用量限制：每本朋友日誌同時最多 2 個 AI 要求、每天 FRIENDS_DAILY_LIMIT 次；擁有者與其他朋友不受影響', async t => {
  const claude = claudeMock();
  const f = await fixture(t, { anthropicFactory: claude.factory, friendsDailyLimit: 3 });
  f.journal.putFood({ name: '測試飯', kcalPer100g: 130, source: 'manual' });
  assert.equal((await providers(f, { providers: [{ id: 'claude', enabled: true }, { id: 'chatgpt', enabled: false }], claudeApiKey: 'sk-ant-test' })).status, 200);
  const remote = login => ({ Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', 'Tailscale-User-Login': login });
  const estimate = headers => f.request('/api/estimate', { name: '飯', fallback: 'llm' }, headers);
  let open; claude.gate = new Promise(resolve => { open = resolve; });
  const pending = [estimate(remote('friend@example.com')), estimate(remote('friend@example.com')), estimate()];
  while (claude.calls.length < 3) await new Promise(resolve => setTimeout(resolve, 5));
  const busy = await estimate(remote('friend@example.com'));
  assert.equal(busy.status, 429); assert.match((await busy.json()).error, /已有 2 個 AI 分析在進行/);
  claude.gate = null; open();
  for (const res of await Promise.all(pending)) assert.equal(res.status, 200);
  assert.equal((await estimate(remote('friend@example.com'))).status, 200); // 第 3 次（並行被拒的那次不計）
  const over = await estimate(remote('friend@example.com'));
  assert.equal(over.status, 429); assert.match((await over.json()).error, /今天的 AI 分析次數已達上限（3 次）/);
  assert.equal((await estimate(remote('other@example.com'))).status, 200);
  assert.equal((await estimate(remote('owner@example.com'))).status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await estimate()).status, 200);
});

test('朋友的 AI 工作不擋擁有者的 ChatGPT 登入；擁有者自己的工作仍會擋（409）', async t => {
  const claude = claudeMock();
  const f = await fixture(t, { anthropicFactory: claude.factory });
  f.journal.putFood({ name: '測試飯', kcalPer100g: 130, source: 'manual' });
  assert.equal((await providers(f, { providers: [{ id: 'claude', enabled: true }, { id: 'chatgpt', enabled: false }], claudeApiKey: 'sk-ant-test' })).status, 200);
  const remote = { Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', 'Tailscale-User-Login': 'friend@example.com' };
  const estimate = headers => f.request('/api/estimate', { name: '飯', fallback: 'llm' }, headers);
  const waitCalls = async n => { while (claude.calls.length < n) await new Promise(resolve => setTimeout(resolve, 5)); };
  let open; claude.gate = new Promise(resolve => { open = resolve; });
  const friend = estimate(remote); await waitCalls(1);
  assert.equal((await f.request('/auth/chatgpt', { client_id: 'oaiapp_test' })).status, 303);
  const owner = estimate(); await waitCalls(2);
  assert.equal((await f.request('/auth/chatgpt', { client_id: 'oaiapp_test' })).status, 409);
  claude.gate = null; open();
  for (const res of await Promise.all([friend, owner])) assert.equal(res.status, 200);
});

test('session 依身分記帳：朋友重複開首頁不會擠掉擁有者的 session，且每人最多 20 個', async t => {
  const f = await fixture(t);
  const remote = login => ({ Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', 'Tailscale-User-Login': login, cookie: '' });
  const open = async login => (await f.request('/', undefined, remote(login))).headers.get('set-cookie').split(';')[0];
  const first = await open('friend@example.com'), status = cookie => f.request('/api/status', undefined, { ...remote('friend@example.com'), cookie });
  assert.equal((await status(first)).status, 200);
  for (let i = 0; i < 24; i++) await open('Friend@Example.com'); // 25 個（大小寫視為同一人）
  assert.equal((await f.request('/api/status')).status, 200); // 擁有者不受影響
  assert.equal((await status(first)).status, 401); // 朋友最舊的已被淘汰
  const other = await open('other@example.com');
  assert.equal((await status(other)).status, 401); // 不同身分不能沿用別人的 session
});
