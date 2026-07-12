import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import './uplot-chart.css'

// UplotChart — the chart engine ported from Alphahedgetool's rolling-straddle
// (its initRollChart uPlot config + the four custom plugins). Self-contained:
// it takes plain series/axis descriptors and data as props instead of reaching
// into app state, so both Rolling Straddle and OI/Premium Decay can use it.
//
// Props:
//   title        chart header text
//   height       px height of the plot area
//   data         [xTimestampsMs, ...seriesValueArrays]  (x in epoch ms)
//   series       [{ label, scale, stroke, width?, dash?, show? }]  (excl. x)
//   axes         [{ scale, side, color, format(v)->string, grid?, size? }]
//   valueFmt     (scale, value) -> tooltip string for that scale
//
// Behaviours replicated from Alphahedgetool: pxAlign crisp rendering, padded
// auto-ranges, wheel/drag pan+zoom (plot and per-axis), crosshair tooltip,
// last-value pills, and cursor axis labels.

const IST = (seconds) => new Date(seconds * 1000).toLocaleTimeString('en-IN', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
})
const IST_HM = (seconds) => new Date(seconds * 1000).toLocaleTimeString('en-IN', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
})
const IST_DATE = (seconds) => new Date(seconds * 1000).toLocaleDateString('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
})

// paddedRange mirrors Alphahedgetool's paddedRollRange: 18% headroom, never a
// zero-height band.
function paddedRange(_u, dataMin, dataMax) {
  if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) return [dataMin, dataMax]
  const span = Math.max(Math.abs(dataMax - dataMin), Math.abs(dataMax) * 0.002, 0.25)
  const pad = span * 0.18
  return [dataMin - pad, dataMax + pad]
}

function clampRange(min, max, hardMin, hardMax, minSpan = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return { min: hardMin, max: hardMax }
  let nextMin = min, nextMax = max
  if (nextMax - nextMin < minSpan) {
    const mid = (nextMin + nextMax) / 2
    nextMin = mid - minSpan / 2; nextMax = mid + minSpan / 2
  }
  if (Number.isFinite(hardMin) && nextMin < hardMin) { nextMax += hardMin - nextMin; nextMin = hardMin }
  if (Number.isFinite(hardMax) && nextMax > hardMax) { nextMin -= nextMax - hardMax; nextMax = hardMax }
  if (Number.isFinite(hardMin)) nextMin = Math.max(hardMin, nextMin)
  if (Number.isFinite(hardMax)) nextMax = Math.min(hardMax, nextMax)
  return { min: nextMin, max: nextMax }
}

// ── plugins (ported from Alphahedgetool, decoupled from app signals) ──

// dataRef.current and specsRef.current give the plugins access to the latest
// data + series/axis specs without rebuilding the chart.
function lastValuePlugin(dataRef, specsRef) {
  const labels = []
  return {
    hooks: {
      init: [(u) => {
        const wrap = u.root.querySelector('.u-wrap') || u.root
        specsRef.current.series.forEach((s, i) => {
          const el = document.createElement('div')
          el.className = 'uc-last-label'
          el.hidden = true
          el.style.borderColor = s.stroke
          el.style.color = s.stroke
          wrap.appendChild(el)
          labels.push({ el, seriesIndex: i + 1, scale: s.scale, side: s.axisSide || 'right', fmt: s.lastFmt })
        })
      }],
      setData: [refresh], setScale: [refresh], setSize: [refresh], setSeries: [refresh],
    },
  }
  function refresh(u) {
    for (const label of labels) {
      const data = dataRef.current[label.seriesIndex]
      const spec = specsRef.current.series[label.seriesIndex - 1]
      if (!spec?.show || !data?.length) { label.el.hidden = true; continue }
      let lastVal = null
      for (let i = data.length - 1; i >= 0; i--) { if (Number.isFinite(data[i])) { lastVal = data[i]; break } }
      const scale = u.scales[label.scale]
      if (lastVal == null || !scale || !Number.isFinite(scale.min) || !Number.isFinite(scale.max)) { label.el.hidden = true; continue }
      const px = u.valToPos(lastVal, label.scale, false)
      if (px < 0 || px > u.over.clientHeight) { label.el.hidden = true; continue }
      label.el.textContent = label.fmt ? label.fmt(lastVal) : Number(lastVal).toFixed(2)
      label.el.hidden = false
      label.el.style.top = `${u.over.offsetTop + px}px`
      label.el.style.transform = 'translateY(-50%)'
      if (label.side === 'left') { label.el.style.left = '0px'; label.el.style.right = '' }
      else { label.el.style.right = '0px'; label.el.style.left = '' }
    }
  }
}

function tooltipPlugin(dataRef, specsRef) {
  let tip
  return {
    hooks: {
      init: [(u) => { tip = document.createElement('div'); tip.className = 'uc-tooltip'; tip.hidden = true; u.over.appendChild(tip) }],
      setCursor: [(u) => {
        if (!tip) return
        const idx = u.cursor.idx
        const x = dataRef.current[0]
        if (idx == null || idx < 0 || !x?.length) { tip.hidden = true; return }
        const time = x[idx]
        if (!Number.isFinite(time)) { tip.hidden = true; return }
        const parts = [`<div class="uc-tip-time"><span>${IST_DATE(time)}</span><b>${IST(time)} <small>IST</small></b></div><div class="uc-tip-values">`]
        specsRef.current.series.forEach((s, i) => {
          const v = dataRef.current[i + 1]?.[idx]
          if (s.show !== false && Number.isFinite(v)) parts.push(`<div><i style="background:${s.stroke}"></i><span>${s.label}</span><b>${s.tipFmt ? s.tipFmt(v) : v.toFixed(2)}</b></div>`)
        })
        const bid = dataRef.current[1]?.[idx]
        const ask = dataRef.current[2]?.[idx]
        if (Number.isFinite(bid) && Number.isFinite(ask)) parts.push(`<div class="uc-tip-spread"><i></i><span>Spread</span><b>₹${(ask - bid).toFixed(2)}</b></div>`)
        parts.push('</div>')
        tip.innerHTML = parts.join('')
        tip.hidden = false
        const left = Math.min(u.over.clientWidth - tip.offsetWidth - 12, Math.max(8, u.cursor.left + 14))
        const top = Math.max(8, Math.min(u.over.clientHeight - tip.offsetHeight - 12, u.cursor.top - 42))
        tip.style.left = `${left}px`; tip.style.top = `${top}px`
      }],
    },
  }
}

function cursorAxisPlugin(specsRef) {
  const labels = []
  let timeLabel
  return {
    hooks: {
      init: [(u) => {
        const wrap = u.root.querySelector('.u-wrap') || u.root
        timeLabel = document.createElement('div')
        timeLabel.className = 'uc-cursor-time-label'
        timeLabel.hidden = true
        wrap.appendChild(timeLabel)
        for (const axis of specsRef.current.axes) {
          const el = document.createElement('div')
          el.className = 'uc-cursor-axis-label'
          el.style.borderColor = axis.color; el.style.color = axis.color
          el.hidden = true
          wrap.appendChild(el)
          labels.push({ el, scale: axis.scale, side: axis.side, fmt: axis.format })
        }
      }],
      setCursor: [(u) => {
        const top = u.cursor.top
        const left = u.cursor.left
        const time = left == null || left < 0 ? null : u.posToVal(left, 'x')
        if (timeLabel) {
          timeLabel.hidden = !Number.isFinite(time)
          if (Number.isFinite(time)) {
            timeLabel.textContent = IST_HM(time)
            timeLabel.style.left = `${u.over.offsetLeft + left}px`
            timeLabel.style.top = `${u.over.offsetTop + u.over.clientHeight}px`
          }
        }
        for (const label of labels) {
          const scale = u.scales[label.scale]
          if (top == null || top < 0 || !scale || !Number.isFinite(scale.min) || !Number.isFinite(scale.max)) { label.el.hidden = true; continue }
          const val = u.posToVal(top, label.scale)
          label.el.textContent = label.fmt ? label.fmt(val) : Number(val).toFixed(2)
          label.el.hidden = false
          label.el.style.top = `${u.over.offsetTop + top}px`
          label.el.style.transform = 'translateY(-50%)'
          if (label.side === 3) { label.el.style.left = '0px'; label.el.style.right = '' }
          else { label.el.style.right = '0px'; label.el.style.left = '' }
        }
      }],
    },
  }
}

// interactionPlugin: wheel + drag pan/zoom on the plot and per-axis, ported
// from Alphahedgetool's createRollInteractionPlugin (manual-scale bookkeeping
// dropped — uPlot's own scales hold state here).
function interactionPlugin(dataRef, specsRef) {
  const yScales = () => specsRef.current.axes.map((a) => a.scale)
  const xBounds = (u) => {
    const x = dataRef.current[0] || []
    const dataMin = x[0], dataMax = x[x.length - 1]
    const pad = Math.max(30, (dataMax - dataMin) * 0.02)
    return { min: dataMin - pad, max: dataMax + pad }
  }
  const zoomAxis = (u, key, pct, factor, hardMin, hardMax, minSpan) => {
    const s = u.scales[key]
    if (!s || !Number.isFinite(s.min) || !Number.isFinite(s.max)) return
    const span = s.max - s.min
    const anchor = s.min + span * pct
    const next = span * factor
    u.setScale(key, clampRange(anchor - next * pct, anchor + next * (1 - pct), hardMin, hardMax, minSpan))
  }
  return {
    hooks: {
      ready: [(u) => {
        const over = u.over
        let drag = null
        const wheel = (e) => {
          if (!dataRef.current[0]?.length) return
          e.preventDefault()
          const rect = over.getBoundingClientRect()
          const xPct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
          const yPct = Math.min(1, Math.max(0, 1 - (e.clientY - rect.top) / rect.height))
          const { min: xMin, max: xMax } = xBounds(u)
          if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && !e.ctrlKey && !e.metaKey) {
            const s = u.scales.x, span = s.max - s.min, shift = span * (e.deltaX / rect.width)
            u.setScale('x', clampRange(s.min + shift, s.max + shift, xMin, xMax, span))
            return
          }
          const factor = e.deltaY < 0 ? 0.82 : 1.22
          const zoomY = e.shiftKey || e.altKey || e.ctrlKey || e.metaKey
          const zoomX = !e.shiftKey || e.ctrlKey || e.metaKey
          if (zoomX) zoomAxis(u, 'x', xPct, factor, xMin, xMax, 10)
          if (zoomY) for (const key of yScales()) zoomAxis(u, key, yPct, factor, -Infinity, Infinity, 0.01)
        }
        const down = (e) => {
          if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return
          drag = { x: e.clientX, y: e.clientY, xMin: u.scales.x.min, xMax: u.scales.x.max,
            y0: yScales().map((k) => ({ key: k, min: u.scales[k]?.min, max: u.scales[k]?.max })) }
          over.setPointerCapture?.(e.pointerId)
        }
        const move = (e) => {
          if (!drag || !dataRef.current[0]?.length) return
          e.preventDefault()
          const rect = over.getBoundingClientRect()
          const dx = e.clientX - drag.x, dy = e.clientY - drag.y
          const { min: xHardMin, max: xHardMax } = xBounds(u)
          const xSpan = drag.xMax - drag.xMin
          const xShift = -(dx / Math.max(1, rect.width)) * xSpan
          u.setScale('x', clampRange(drag.xMin + xShift, drag.xMax + xShift, xHardMin, xHardMax, xSpan))
          for (const y of drag.y0) {
            if (!Number.isFinite(y.min) || !Number.isFinite(y.max) || y.max <= y.min) continue
            const span = y.max - y.min, shift = (dy / Math.max(1, rect.height)) * span
            u.setScale(y.key, clampRange(y.min + shift, y.max + shift, -Infinity, Infinity, span))
          }
        }
        const up = (e) => { drag = null; over.releasePointerCapture?.(e.pointerId) }
        over.addEventListener('wheel', wheel, { passive: false })
        over.addEventListener('pointerdown', down)
        over.addEventListener('pointermove', move)
        over.addEventListener('pointerup', up)
        over.addEventListener('dblclick', () => { for (const k of ['x', ...yScales()]) u.setScale(k, { min: null, max: null }) })
      }],
    },
  }
}

export default function UplotChart({ title, height = 340, data, series, axes, legend = true }) {
  const hostRef = useRef(null)
  const chartRef = useRef(null)
  const dataRef = useRef(data)
  const specsRef = useRef({ series, axes })
  dataRef.current = data
  specsRef.current = { series, axes }

  // Build the uPlot options once per chart shape (series/axes identity).
  const optKey = useMemo(() =>
    JSON.stringify({ s: series.map((s) => [s.label, s.scale, s.stroke]), a: axes.map((a) => [a.scale, a.side]) }),
  [series, axes])

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const width = Math.max(1, Math.floor(host.clientWidth))
    const theme = getComputedStyle(host)
    const cssColor = (name, fallback) => theme.getPropertyValue(name).trim() || fallback
    const axisColor = '#f0f3fa'
    const gridColor = cssColor('--ao-chart-grid', 'rgba(42,46,57,.55)')
    const borderColor = cssColor('--ao-chart-border', '#2a2e39')

    const scaleDefs = { x: { time: true } }
    for (const a of axes) scaleDefs[a.scale] = { auto: true, range: paddedRange }

    const uAxes = [
      {
        scale: 'x', size: 44, gap: 6, font: '12px "Roboto Mono", Consolas, monospace',
        stroke: axisColor,
        border: { show: true, stroke: borderColor, width: 1 },
        grid: { show: true, stroke: gridColor, width: 1 },
        ticks: { show: false },
        // Snap gridlines to clean minute steps (1,5,15,30,60,120,240 min) and
        // keep them far apart so the grid stays sparse like Alphahedgetool.
        incrs: [60, 300, 900, 1800, 3600, 7200, 14400],
        values: (_u, vals) => vals.map((v) => IST_HM(v)), space: 120,
      },
      ...axes.map((a) => ({
        scale: a.scale, side: a.side, size: a.size || 64, gap: 8, font: '12px "Roboto Mono", Consolas, monospace',
        stroke: axisColor,
        border: { show: true, stroke: borderColor, width: 1 },
        // Only the primary (right) axis draws horizontal gridlines; the second
        // axis omits them so lines don't double up. Wider spacing => ~6-7 lines.
        grid: { show: a.grid !== false, stroke: gridColor, width: 1 },
        ticks: { show: false },
        values: (_u, vals) => vals.map((v) => a.format ? a.format(v) : Number(v).toFixed(2)), space: 56,
      })),
    ]

    const uSeries = [
      {},
      ...series.map((s) => ({
        label: s.label, scale: s.scale, show: s.show !== false, stroke: s.stroke,
        width: s.width || 1.6, dash: s.dash, points: { show: false },
      })),
    ]

    const chart = new uPlot({
      width, height, pxAlign: true, legend: { show: false },
      cursor: {
        drag: { x: false, y: false },
        points: { show: false },
        focus: { prox: 24 },
        sync: { key: 'market-charts' },
      },
      scales: scaleDefs,
      axes: uAxes,
      series: uSeries,
      plugins: [
        interactionPlugin(dataRef, specsRef),
        tooltipPlugin(dataRef, specsRef),
        lastValuePlugin(dataRef, specsRef),
        cursorAxisPlugin(specsRef),
      ],
    }, dataRef.current, host)
    chartRef.current = chart

    const ro = new ResizeObserver(() => {
      const w = Math.max(1, Math.floor(host.clientWidth))
      chart.setSize({ width: w, height })
    })
    ro.observe(host)
    return () => { ro.disconnect(); chart.destroy(); chartRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optKey, height])

  // Push new data / visibility without rebuilding the chart.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    series.forEach((s, i) => { if (chart.series[i + 1] && chart.series[i + 1].show !== (s.show !== false)) chart.setSeries(i + 1, { show: s.show !== false }) })
    chart.setData(data)
  }, [data, series])

  return (
    <div className="uc-card" style={{ borderColor: 'var(--ao-border-soft)' }}>
      <div className="uc-head">
        <span className="uc-title">{title}</span>
        {legend && (
          <div className="uc-legend">
            {series.filter((s) => s.show !== false).map((s) => (
              <span key={s.label} className="uc-legend-item">
                <i style={{ background: s.stroke }} />{s.label}
              </span>
            ))}
          </div>
        )}
      </div>
      <div ref={hostRef} className="uc-plot" style={{ height }} />
    </div>
  )
}
