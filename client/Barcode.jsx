import React, { useEffect, useRef, useState } from 'react';
import { normalizeBarcode } from './barcode-view.js';

// 條碼掃描（ADR 0013）：相機＋解碼（BarcodeDetector 或 zxing-wasm），以及手動輸入條碼的保底。
// 相機需要安全環境（127.0.0.1 或 Tailscale serve 的 HTTPS）；不可用時只剩手動輸入。
function Scanner({ onBack, onCode }) {
  const video = useRef(null); const stream = useRef(null); const [error,setError] = useState(''); const [manual,setManual] = useState('');
  const stop = () => { stream.current?.getTracks().forEach(t=>t.stop()); stream.current=null; };
  useEffect(() => {
    let alive = true, timer = 0, reading = false;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { setError('相機需要安全連線（本機 127.0.0.1 或 Tailscale 的 HTTPS 網址），請改用下方手動輸入條碼。'); return; }
    // 解碼器（含 WASM）與相機同時開始準備；載入失敗只提示改用手動輸入。
    const decoder = import('./barcode-decoder.js').then(m => m.createDecoder()).catch(() => { if (alive) setError('無法載入條碼解碼器，請改用下方手動輸入條碼。'); return null; });
    navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false}).then(async s => {
      if (!alive) { s.getTracks().forEach(t=>t.stop()); return; }
      stream.current=s; video.current.srcObject=s;
      const decode = await decoder; if (!alive || !decode) return;
      // 每 250ms 讀一次畫面中央的橫條區域（與取景框相同），同時只跑一次解碼。
      const canvas = document.createElement('canvas');
      timer = setInterval(async () => {
        const v = video.current; if (reading || !v?.videoWidth) return; reading = true;
        try {
          const w = Math.round(v.videoWidth*.8), h = Math.round(v.videoHeight*.4);
          canvas.width = w; canvas.height = h; canvas.getContext('2d', { willReadFrequently: true }).drawImage(v, (v.videoWidth-w)/2, (v.videoHeight-h)/2, w, h, 0, 0, w, h);
          const code = normalizeBarcode(await decode(canvas));
          if (code && alive) { alive = false; clearInterval(timer); stop(); onCode(code); }
        } catch {} finally { reading = false; }
      }, 250);
    }).catch(()=>alive&&setError('無法開啟相機，請允許相機權限，或改用下方手動輸入條碼。'));
    return () => { alive=false; clearInterval(timer); stop(); };
  }, []);
  const code = normalizeBarcode(manual);
  return <div className="camera screen"><nav><button className="round" aria-label="返回" onClick={onBack}>✕</button><b>掃條碼</b><span/></nav>
    <div className="camera-view"><video ref={video} autoPlay playsInline muted/><div className="viewfinder barcode"/>{error?<p className="camera-error">{error}</p>:<p className="scan-hint">把包裝上的條碼對準框內</p>}</div>
    <form className="barcode-manual" onSubmit={e=>{e.preventDefault();if(code){stop();onCode(code);}}}><input aria-label="手動輸入條碼" inputMode="numeric" autoComplete="off" value={manual} onChange={e=>setManual(e.target.value)} placeholder="或輸入條碼數字（8～14 位）"/><button className="primary" disabled={!code}>查詢</button></form></div>;
}

// 條碼查詢流程：掃描／輸入 → GET /api/barcode/:code → 命中交給 onFound（確認畫面沿用「記一餐」草稿）；
// 未命中顯示三個出口；OFF 暫時無法查詢（503）顯示重試，不當成未命中。AI 查條碼只在使用者按下時呼叫，候選品名可選可改。
export default function Barcode({ api, onBack, onFound, onLabel, onManual, onAnalyze, needModel, model, onError, aiBlocked = '' }) {
  const [step,setStep] = useState({ kind: 'scan' }); const [name,setName] = useState('');
  async function lookup(code) {
    setStep({ kind: 'loading', code }); onError('');
    try { const r = await api('/api/barcode/'+code); if (r.found) onFound(r, code); else setStep({ kind: 'missing', code }); }
    catch (e) { if (e.status === 503) setStep({ kind: 'unavailable', code, message: e.message }); else { onError(e.message); setStep({ kind: 'scan' }); } }
  }
  async function askAi(code) {
    if (needModel()) return; setStep({ kind: 'ai', code }); onError('');
    try { const { candidates } = await api(`/api/barcode/${code}/ai`, { model }); setName(candidates[0] || ''); setStep({ kind: 'candidates', code, candidates }); }
    catch (e) { onError(e.message); setStep({ kind: 'missing', code }); }
  }
  async function analyze(code) { setStep({ kind: 'analyzing', code }); if (!(await onAnalyze(name.trim(), code))) setStep({ kind: 'candidates', code, candidates: step.candidates }); }
  if (step.kind === 'scan') return <Scanner onBack={onBack} onCode={lookup}/>;
  const { code } = step;
  const bar = <nav><button className="round" aria-label="返回" onClick={onBack}>‹</button><b>條碼 {code}</b><span/></nav>;
  const again = <button className="text-button full" onClick={()=>setStep({ kind: 'scan' })}>重新掃描</button>;
  return <div className="screen">{bar}<div className="scroll page-pad">
    {step.kind === 'loading' && <p className="working"><span className="dots">•••</span> 查詢條碼中</p>}
    {step.kind === 'unavailable' && <div className="card"><h2>暫時無法查詢</h2><p className="muted">{step.message || '條碼資料庫暫時無法使用，請稍後再試。'}</p>
      <button className="primary full" onClick={()=>lookup(code)}>重試</button><button className="outline full" onClick={onLabel}>拍營養標示</button><button className="outline full" onClick={onManual}>手動新增</button>{again}</div>}
    {(step.kind === 'missing' || step.kind === 'ai') && <div className="card"><h2>資料庫沒有這個條碼</h2><p className="muted tiny">本機食物庫與條碼資料庫（Open Food Facts）都查不到。</p>
      <button className="primary full" onClick={onLabel}>拍營養標示</button><button className="outline full" onClick={onManual}>手動新增</button>
      <button className="outline full" disabled={step.kind === 'ai' || !!aiBlocked} onClick={()=>askAi(code)}>{step.kind === 'ai' ? 'AI 查詢中…' : '用 AI 上網查這個條碼'}</button>
      {aiBlocked && <p className="notice">{aiBlocked}</p>}
      <p className="muted tiny">AI 只找出可能的商品名稱，請對照手上的包裝確認；營養數字之後照一般文字分析查詢。找品名與查熱量各使用一次 AI 額度。</p>{again}</div>}
    {(step.kind === 'candidates' || step.kind === 'analyzing') && <div className="card"><h2>是這個商品嗎？</h2>
      {step.candidates?.length ? step.candidates.map(c=><label className="radio" key={c}><input type="radio" name="barcode-candidate" checked={name===c} onChange={()=>setName(c)}/>{c}</label>)
        : <p className="notice">AI 沒有找到可靠的商品名稱，可以自己輸入包裝上的品名，或改拍營養標示。</p>}
      <label>品名（可修改，請對照包裝）<input aria-label="商品名稱" value={name} onChange={e=>setName(e.target.value)} placeholder="例如：可口可樂 330ml 鋁罐"/></label>
      <button className="primary full" disabled={!name.trim() || step.kind === 'analyzing'} onClick={()=>analyze(code)}>{step.kind === 'analyzing' ? '查詢熱量中…' : '用這個品名查熱量'}</button>
      <button className="outline full" onClick={onLabel}>改拍營養標示</button>{again}</div>}
  </div></div>;
}
