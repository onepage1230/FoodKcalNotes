import React, { useEffect, useState } from 'react';
import App from './App.jsx';

// 擁有者配對（伺服器開啟 OWNER_TOKEN 時）：未配對的瀏覽器先顯示配對畫面，配對後才載入 App。
// 網址的 ?pair=配對碼 先從網址列移除（不留在歷史紀錄），再以 POST 送出；成功後重新載入首頁，取得擁有者的新 session。
export default function Pairing() {
  const [state, setState] = useState(null); // null：載入中；{ pairing, csrf, remote }；'app'：已配對或未開啟配對
  const [token, setToken] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);

  async function pair(csrf, value) {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ token: value.trim() }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `配對失敗 (${response.status})`);
      location.replace('/');
    } catch (e) { setError(e.message); setBusy(false); }
  }
  useEffect(() => {
    const url = new URL(location.href); const fromUrl = url.searchParams.get('pair');
    if (fromUrl !== null) { url.searchParams.delete('pair'); history.replaceState({}, '', url.pathname + url.search); }
    (async () => {
      // 只有伺服器明確回 pairing 才顯示配對畫面；其他錯誤交給 App 顯示（OWNER_TOKEN 關閉時行為不變）。
      const response = await fetch('/api/status').catch(() => null); const data = await response?.json().catch(() => ({})) || {};
      if (!data.pairing) return setState('app');
      setState(data);
      if (fromUrl) await pair(data.csrf, fromUrl);
    })().catch(e => setError(e.message));
  }, []);

  if (state === 'app') return <App />;
  return <div className="journal-app">
    {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="關閉提示" onClick={() => setError('')}>×</button></div>}
    {state && <div className="screen"><nav><span/><b>配對這個裝置</b><span/></nav><div className="scroll page-pad">
      <section className="card"><h2>輸入配對碼</h2>
        <p>這台伺服器只讓配對過的瀏覽器使用你的日誌。每個瀏覽器（以及加入主畫面的 App）第一次使用時要配對一次。</p>
        <form onSubmit={e => { e.preventDefault(); if (token.trim() && state.csrf) pair(state.csrf, token); }}>
          <label>配對碼<input type="password" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={token} onChange={e => setToken(e.target.value)} /></label>
          <button className="primary full" disabled={busy || !token.trim() || !state.csrf}>{busy ? '配對中…' : '配對'}</button>
        </form>
      </section>
      <section className="card"><h2>配對碼在哪裡</h2>
        <p className="muted">伺服器啟動時會印出配對碼與配對網址：Docker 部署執行 <code>sudo docker-compose logs foodkcal</code>，在電腦上執行則看啟動的終端機視窗。直接開啟配對網址也能完成配對。</p>
        <p className="muted">配對碼也存在日誌資料夾的 <code>owner.token</code> 檔案。</p>
        <p className="muted tiny">配對碼等同擁有者的鑰匙，不要傳給別人。刪除 owner.token 後重啟伺服器會換新的配對碼，所有裝置都要重新配對。</p>
      </section>
    </div></div>}
  </div>;
}
