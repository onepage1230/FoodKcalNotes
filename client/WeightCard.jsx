import React, { useState } from 'react';
import { trendChart, dayLabel, TREND_DAYS, daysSinceWeight, latestWeightDay, weightStale, weightHint, weightCheck } from './weight.js';

// 設定頁的「體重」卡片。data（{ weights, current }）由 App 持有並與計劃卡片、營養目標共用；記錄或刪除後以 onChange 交回伺服器的新狀態，其他卡片即時更新。
export default function WeightCard({ api, notify, onError, today, data, planLine, onChange }) {
  const [form, setForm] = useState({ day: '', kg: '' }); // form.day 空字串 = 今天
  if (!data) return <section className="card weight-card"><h2>體重</h2></section>;
  const { weights: list, current } = data, day = form.day || today(), check = weightCheck(form.kg, day, today());
  const daysSince = daysSinceWeight(latestWeightDay(list), today());
  const save = async () => { try { onChange(await api('/api/weights/' + day, { kg: Number(form.kg) }, 'PUT')); setForm({ day: '', kg: '' }); notify('體重已記錄'); } catch (e) { onError(e.message); } };
  const remove = async d => { if (!window.confirm(`刪除 ${d.replace(/-/g, '.')} 的體重紀錄？`)) return; try { onChange(await api('/api/weights/' + d, undefined, 'DELETE')); notify('已刪除'); } catch (e) { onError(e.message); } };
  return <section className="card weight-card"><h2>體重</h2>
    <div className="detail-total">{current ? current.kg : '—'}{current && <small> 公斤</small>}</div>
    <p className={weightStale(daysSince) ? 'notice' : 'muted'}>{weightHint(daysSince)}{current?.source === 'plan' && '（目前是減重計劃填的體重）'}</p>
    <TrendChart weights={list} today={today()} spec={planLine} />
    <div className="two-columns"><label>日期<input type="date" max={today()} value={day} onChange={e => setForm({ ...form, day: e.target.value })} /></label><label>體重 kg<input type="text" inputMode="decimal" value={form.kg} onChange={e => setForm({ ...form, kg: e.target.value })} /></label></div>
    {check.message && <p className="weight-warn">{check.message}</p>}
    <button className="primary full" disabled={!check.ok} onClick={save}>記錄</button>
    {list.length > 0 && <div className="weight-list">{[...list].reverse().map(w => <div className="weight-row" key={w.day}><button className="text-button" onClick={() => setForm({ day: w.day, kg: String(w.kg) })}>{w.day.replace(/-/g, '.')} · {w.kg} 公斤</button><button className="text-button danger" onClick={() => remove(w.day)}>刪除</button></div>)}</div>}
    <p className="muted tiny">同一天再記會覆蓋；點一筆紀錄可帶入上方修改，也可補記過去的日期。</p></section>;
}

// 趨勢圖：手寫 SVG，資料模型來自 trendChart。顏色全部走 CSS 變數（style.css 的 --chart-*），淺色與深色主題共用。
const W = 300, H = 190, L = 30, R = 8, T = 8, B = 22;
function TrendChart({ weights, today, spec }) {
  const m = trendChart({ weights, today, spec });
  if (!m) return null;
  const px = x => L + (x - m.x0) / (m.x1 - m.x0) * (W - L - R), py = kg => T + (m.y.max - kg) / (m.y.max - m.y.min) * (H - T - B);
  const path = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${px(p.x).toFixed(1)} ${py(p.v).toFixed(1)}`).join('');
  const avgPts = m.avg.map(p => ({ x: p.x, v: p.avg }));
  const xLabels = [[m.x0, 'start'], ...(m.x1 - m.x0 >= 14 ? [[Math.round((m.x0 + m.x1) / 2), 'middle']] : []), [m.x1, 'end']];
  return <figure className="trend">
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={m.summary}><title>{m.summary}</title>
      {m.y.ticks.map(t => <g key={t}><line className="trend-grid" x1={L} x2={W - R} y1={py(t)} y2={py(t)} /><text className="trend-axis" x={L - 5} y={py(t)} textAnchor="end" dominantBaseline="middle">{t}</text></g>)}
      {xLabels.map(([x, anchor]) => <text key={x} className="trend-axis" x={px(x)} y={H - 6} textAnchor={anchor}>{dayLabel(x)}</text>)}
      {m.plan && <path className="trend-plan" d={path(m.plan.map(p => ({ x: p.x, v: p.kg })))} />}
      {avgPts.length > 1 && <path className="trend-avg" d={path(avgPts)} />}
      {m.points.map(p => <circle key={p.day} className="trend-dot" cx={px(p.x)} cy={py(p.kg)} r="2.6" />)}
      {avgPts.length === 1 && <circle className="trend-avg-dot" cx={px(avgPts[0].x)} cy={py(avgPts[0].v)} r="5" />}
    </svg>
    <figcaption className="trend-legend"><span><i className="sw dot" />每日體重</span><span><i className="sw avg" />7 天平均</span>{m.plan && <span><i className="sw plan" />計劃線</span>}<span className="muted">近 {TREND_DAYS} 天</span></figcaption>
  </figure>;
}
