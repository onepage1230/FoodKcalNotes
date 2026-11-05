import React from 'react';
import { TREND_LABELS } from './weight.js';
import { dayLabel } from './dates.js';

// 趨勢圖：手寫 SVG，資料模型 model 來自 weight.js 的 trendChart，summary 是 trendSummary 的文字（aria-label 與 <title>）。顏色全部走 CSS 變數（style.css 的 --chart-*），淺色與深色主題共用。
const CHART_BOX = { width: 300, height: 190, left: 30, right: 8, top: 8, bottom: 22 }; // viewBox 與四邊留白（左側放 y 軸刻度、下方放 x 軸日期）
const DOT_RADIUS = 2.6, AVG_RING_RADIUS = 5; // 每日體重圓點半徑；只有一個平均點時畫成環（線畫不出來）的半徑
const MID_LABEL_MIN_DAYS = 14; // x 軸寬度達這麼多天才加中間日期標籤，太窄會與兩端重疊
export default function TrendChart({ model: m, summary }) {
  const { width: W, height: H, left, right, top, bottom } = CHART_BOX;
  const px = x => left + (x - m.x0) / (m.x1 - m.x0) * (W - left - right), py = kg => top + (m.y.max - kg) / (m.y.max - m.y.min) * (H - top - bottom);
  const path = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${px(p.x).toFixed(1)} ${py(p.v).toFixed(1)}`).join('');
  const avgPts = m.avg.map(p => ({ x: p.x, v: p.avg }));
  const xLabels = [[m.x0, 'start'], ...(m.x1 - m.x0 >= MID_LABEL_MIN_DAYS ? [[Math.round((m.x0 + m.x1) / 2), 'middle']] : []), [m.x1, 'end']];
  return <figure className="trend">
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary}><title>{summary}</title>
      {m.y.ticks.map(t => <g key={t}><line className="trend-grid" x1={left} x2={W - right} y1={py(t)} y2={py(t)} /><text className="trend-axis" x={left - 5} y={py(t)} textAnchor="end" dominantBaseline="middle">{t}</text></g>)}
      {xLabels.map(([x, anchor]) => <text key={x} className="trend-axis" x={px(x)} y={H - 6} textAnchor={anchor}>{dayLabel(x)}</text>)}
      {m.plan && <path className="trend-plan" d={path(m.plan.map(p => ({ x: p.x, v: p.kg })))} />}
      {avgPts.length > 1 && <path className="trend-avg" d={path(avgPts)} />}
      {m.points.map(p => <circle key={p.day} className="trend-dot" cx={px(p.x)} cy={py(p.kg)} r={DOT_RADIUS} />)}
      {avgPts.length === 1 && <circle className="trend-avg-dot" cx={px(avgPts[0].x)} cy={py(avgPts[0].v)} r={AVG_RING_RADIUS} />}
    </svg>
    <figcaption className="trend-legend"><span><i className="trend-sw dot" />{TREND_LABELS.raw}</span><span><i className="trend-sw avg" />{TREND_LABELS.avg}</span>{m.plan && <span><i className="trend-sw plan" />{TREND_LABELS.plan}</span>}<span className="muted">{TREND_LABELS.range}</span></figcaption>
  </figure>;
}
