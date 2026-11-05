import React, { useState } from 'react';
import { daysSinceWeight, latestWeightDay, weightStale, weightHint, weightCheck } from './weight.js';

// 設定頁的「體重」卡片。data（{ weights, current }）由 App 持有並與計劃卡片、營養目標共用；記錄或刪除後以 onChange 交回伺服器的新狀態，其他卡片即時更新。
export default function WeightCard({ api, notify, onError, today, data, onChange: setData }) {
  const [form, setForm] = useState({ day: '', kg: '' }); // form.day 空字串 = 今天
  if (!data) return <section className="card weight-card"><h2>體重</h2></section>;
  const { weights: list, current } = data, day = form.day || today(), check = weightCheck(form.kg, day, today());
  const daysSince = daysSinceWeight(latestWeightDay(list), today());
  const save = async () => { try { setData(await api('/api/weights/' + day, { kg: Number(form.kg) }, 'PUT')); setForm({ day: '', kg: '' }); notify('體重已記錄'); } catch (e) { onError(e.message); } };
  const remove = async d => { if (!window.confirm(`刪除 ${d.replace(/-/g, '.')} 的體重紀錄？`)) return; try { setData(await api('/api/weights/' + d, undefined, 'DELETE')); notify('已刪除'); } catch (e) { onError(e.message); } };
  return <section className="card weight-card"><h2>體重</h2>
    <div className="detail-total">{current ? current.kg : '—'}{current && <small> 公斤</small>}</div>
    <p className={weightStale(daysSince) ? 'notice' : 'muted'}>{weightHint(daysSince)}{current?.source === 'plan' && '（目前是減重計劃填的體重）'}</p>
    <div className="two-columns"><label>日期<input type="date" max={today()} value={day} onChange={e => setForm({ ...form, day: e.target.value })} /></label><label>體重 kg<input type="text" inputMode="decimal" value={form.kg} onChange={e => setForm({ ...form, kg: e.target.value })} /></label></div>
    {check.message && <p className="weight-warn">{check.message}</p>}
    <button className="primary full" disabled={!check.ok} onClick={save}>記錄</button>
    {list.length > 0 && <div className="weight-list">{[...list].reverse().map(w => <div className="weight-row" key={w.day}><button className="text-button" onClick={() => setForm({ day: w.day, kg: String(w.kg) })}>{w.day.replace(/-/g, '.')} · {w.kg} 公斤</button><button className="text-button danger" onClick={() => remove(w.day)}>刪除</button></div>)}</div>}
    <p className="muted tiny">同一天再記會覆蓋；點一筆紀錄可帶入上方修改，也可補記過去的日期。</p></section>;
}
