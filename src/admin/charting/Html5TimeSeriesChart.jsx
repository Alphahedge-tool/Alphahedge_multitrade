import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, IconButton, Paper, Stack, Typography } from '@mui/material'
import { Maximize2, RotateCcw } from 'lucide-react'

const PADDING = { left: 14, right: 76, top: 18, bottom: 34 }

const defaultTimeFormatter = (time, withSeconds = false) => new Date(time).toLocaleTimeString('en-IN', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit',
  ...(withSeconds ? { second: '2-digit' } : {}), hour12: false,
})

const defaultValueFormatter = (value) => Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 })

export default function Html5TimeSeriesChart({
  title,
  series = [],
  height = 320,
  valueFormatter = defaultValueFormatter,
  timeFormatter = defaultTimeFormatter,
  emptyMessage = 'No chart data available.',
}) {
  const hostRef = useRef(null)
  const canvasRef = useRef(null)
  const sizeRef = useRef({ width: 0, height })
  const seriesRef = useRef(series)
  const viewRef = useRef(null)
  const domainRef = useRef(null)
  const pointerRef = useRef(null)
  const dragRef = useRef(null)
  const frameRef = useRef(0)
  const [tooltip, setTooltip] = useState(null)
  const [viewVersion, setViewVersion] = useState(0)

  seriesRef.current = series

  const domain = useMemo(() => {
    let min = Number.POSITIVE_INFINITY, max = Number.NEGATIVE_INFINITY
    for (const item of series) {
      for (const point of item.data || []) {
        const time = Number(point.time)
        if (Number.isFinite(time)) { min = Math.min(min, time); max = Math.max(max, time) }
      }
    }
    return Number.isFinite(min) && Number.isFinite(max) ? { min, max: Math.max(max, min + 1000) } : null
  }, [series])

  useEffect(() => {
    const previous = domainRef.current
    domainRef.current = domain
    if (!domain) { viewRef.current = null; return }
    if (!viewRef.current) {
      viewRef.current = { start: domain.min, end: domain.max }
    } else if (previous) {
      const wasFull = viewRef.current.start <= previous.min && viewRef.current.end >= previous.max
      const wasAtRight = Math.abs(viewRef.current.end - previous.max) <= Math.max((previous.max - previous.min) * 0.01, 2000)
      if (wasFull) viewRef.current = { start: domain.min, end: domain.max }
      else if (wasAtRight && domain.max > previous.max) {
        const duration = viewRef.current.end - viewRef.current.start
        viewRef.current = { start: Math.max(domain.min, domain.max - duration), end: domain.max }
      }
    }
    setViewVersion((version) => version + 1)
  }, [domain])

  const scheduleDraw = useCallback(() => {
    cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(() => drawChart({
      canvas: canvasRef.current,
      size: sizeRef.current,
      series: seriesRef.current,
      view: viewRef.current,
      pointer: pointerRef.current,
      title,
      valueFormatter,
      timeFormatter,
    }))
  }, [timeFormatter, valueFormatter])

  useEffect(() => { scheduleDraw() }, [series, viewVersion, scheduleDraw])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const resize = () => {
      const width = Math.max(host.clientWidth, 280)
      sizeRef.current = { width, height }
      const canvas = canvasRef.current
      if (canvas) {
        const ratio = renderRatio()
        canvas.width = Math.round(width * ratio)
        canvas.height = Math.round(height * ratio)
        canvas.style.width = `${width}px`
        canvas.style.height = `${height}px`
      }
      scheduleDraw()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()
    return () => observer.disconnect()
  }, [height, scheduleDraw])

  useEffect(() => () => cancelAnimationFrame(frameRef.current), [])

  const resetView = () => {
    if (!domainRef.current) return
    viewRef.current = { start: domainRef.current.min, end: domainRef.current.max }
    pointerRef.current = null
    setTooltip(null)
    setViewVersion((version) => version + 1)
  }

  const handleWheel = (event) => {
    event.preventDefault()
    const view = viewRef.current, domainNow = domainRef.current
    if (!view || !domainNow) return
    const rect = canvasRef.current.getBoundingClientRect()
    const plotWidth = rect.width - PADDING.left - PADDING.right
    const ratio = clamp((event.clientX - rect.left - PADDING.left) / plotWidth, 0, 1)
    const anchor = view.start + ratio * (view.end - view.start)
    const factor = event.deltaY > 0 ? 1.22 : 0.82
    const minimum = 10_000
    const duration = clamp((view.end - view.start) * factor, minimum, domainNow.max - domainNow.min)
    let start = anchor - ratio * duration
    let end = start + duration
    if (start < domainNow.min) { start = domainNow.min; end = start + duration }
    if (end > domainNow.max) { end = domainNow.max; start = end - duration }
    viewRef.current = { start, end }
    pointerRef.current = null
    setTooltip(null)
    scheduleDraw()
  }

  const updatePointer = (event) => {
    const canvas = canvasRef.current, view = viewRef.current
    if (!canvas || !view) return
    const rect = canvas.getBoundingClientRect()
    const x = event.clientX - rect.left, y = event.clientY - rect.top
    if (dragRef.current) {
      const domainNow = domainRef.current
      const dx = x - dragRef.current.x
      const shift = -dx / Math.max(rect.width - PADDING.left - PADDING.right, 1) * (view.end - view.start)
      let start = dragRef.current.start + shift, end = dragRef.current.end + shift
      if (start < domainNow.min) { start = domainNow.min; end = start + (view.end - view.start) }
      if (end > domainNow.max) { end = domainNow.max; start = end - (view.end - view.start) }
      viewRef.current = { start, end }
      pointerRef.current = null
      setTooltip(null)
      scheduleDraw()
      return
    }
    const inside = x >= PADDING.left && x <= rect.width - PADDING.right && y >= PADDING.top && y <= height - PADDING.bottom
    if (!inside) { pointerRef.current = null; setTooltip(null); scheduleDraw(); return }
    const time = view.start + (x - PADDING.left) / (rect.width - PADDING.left - PADDING.right) * (view.end - view.start)
    const values = seriesRef.current.map((item) => ({ ...item, point: nearestPoint(item.data || [], time) })).filter((item) => item.point)
    if (!values.length) return
    const snapTime = values[0].point.time
    pointerRef.current = { x, y, time: snapTime }
    setTooltip({ x, y, time: snapTime, values })
    scheduleDraw()
  }

  const hasData = Boolean(domain)
  return (
    <Paper variant="outlined" sx={{ p: 0, minHeight: height + 44, overflow: 'hidden', borderColor: 'var(--ao-border-soft)', bgcolor: 'var(--ao-chart-bg)' }}>
      <Box sx={{ height: 42, px: 1.25, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, borderBottom: '1px solid var(--ao-border-soft)', bgcolor: 'var(--ao-chart-header)' }}>
        <Typography sx={{ fontSize: '0.82rem', fontWeight: 700, color: '#d9e1ea' }}>{title}</Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          {series.filter((item) => item.showInLegend !== false).map((item) => <Legend key={item.id || item.label} color={item.color} label={item.label} value={item.data?.at(-1)?.value} formatter={valueFormatter} />)}
          <IconButton size="small" title="Reset chart view" onClick={resetView}><RotateCcw size={15} /></IconButton>
          <IconButton size="small" title="Fit all data" onClick={resetView}><Maximize2 size={15} /></IconButton>
        </Stack>
      </Box>
      <Box ref={hostRef} sx={{ width: '100%', height, position: 'relative', bgcolor: 'var(--ao-chart-bg)', overflow: 'hidden' }}>
        {!hasData && <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'text.secondary', zIndex: 1 }}>{emptyMessage}</Box>}
        <canvas
          ref={canvasRef}
          onWheel={handleWheel}
          onPointerMove={updatePointer}
          onPointerLeave={() => { dragRef.current = null; pointerRef.current = null; setTooltip(null); scheduleDraw() }}
          onPointerDown={(event) => {
            if (!viewRef.current) return
            event.currentTarget.setPointerCapture(event.pointerId)
            const rect = event.currentTarget.getBoundingClientRect()
            dragRef.current = { x: event.clientX - rect.left, ...viewRef.current }
          }}
          onPointerUp={(event) => { dragRef.current = null; event.currentTarget.releasePointerCapture?.(event.pointerId) }}
          onDoubleClick={resetView}
          style={{ display: 'block', cursor: dragRef.current ? 'grabbing' : 'crosshair', touchAction: 'none' }}
        />
        {tooltip && <Tooltip tooltip={tooltip} width={sizeRef.current.width} formatter={valueFormatter} timeFormatter={timeFormatter} />}
      </Box>
    </Paper>
  )
}

function drawChart({ canvas, size, series, view, pointer, title, valueFormatter, timeFormatter }) {
  if (!canvas || !size.width) return
  const ratio = renderRatio()
  const context = canvas.getContext('2d')
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  // TradingView-crisp text: precise glyph geometry, no sub-pixel smearing.
  context.textRendering = 'geometricPrecision'
  // Snap a coordinate to the device-pixel grid so 1px strokes render as a
  // single hard line instead of a 2px blur (the classic canvas-line fix).
  const crisp = (value) => (Math.round(value * ratio) + 0.5) / ratio
  context.clearRect(0, 0, size.width, size.height)
  // Read the theme's chart-surface colors so the canvas follows the active
  // theme (light/dark/alphahedge/terminal) instead of a hardcoded near-black.
  const gradTop = cssVar('--ao-chart-grad-top', '#0d1117')
  const gradBottom = cssVar('--ao-chart-grad-bottom', '#090c10')
  const background = context.createLinearGradient(0, 0, 0, size.height)
  background.addColorStop(0, gradTop); background.addColorStop(1, gradBottom)
  context.fillStyle = background; context.fillRect(0, 0, size.width, size.height)
  const textColor = '#c2cbd6'
  const gridColor = 'rgba(132,145,160,.14)'
  if (!view || !series.length) return

  const plotWidth = size.width - PADDING.left - PADDING.right
  const plotHeight = size.height - PADDING.top - PADDING.bottom
  // Keep the full source data for exact tooltips, but render no more than two
  // extrema per horizontal pixel. This preserves every visible spike while
  // keeping pan/zoom work nearly constant for 500 or 500,000 source points.
  const visible = series.map((item) => {
    const source = visibleSlice(item.data || [], view.start, view.end)
    return { ...item, source, data: downsampleMinMax(source, Math.max(100, Math.floor(plotWidth))) }
  })
  const ranges = new Map()
  for (const item of visible) {
    const scaleId = item.scaleId || 'primary'
    const range = ranges.get(scaleId) || { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY }
    for (const point of item.data) {
      const value = Number(point.value)
      if (Number.isFinite(value)) { range.min = Math.min(range.min, value); range.max = Math.max(range.max, value) }
    }
    ranges.set(scaleId, range)
  }
  for (const range of ranges.values()) {
    if (!Number.isFinite(range.min) || !Number.isFinite(range.max)) continue
    const margin = (range.max - range.min || Math.abs(range.max) * 0.1 || 1) * 0.08
    range.min -= margin; range.max += margin
  }
  const primaryRange = ranges.get('primary')
  if (!primaryRange || !Number.isFinite(primaryRange.min)) return
  const { min, max } = primaryRange
  const x = (time) => PADDING.left + (time - view.start) / (view.end - view.start) * plotWidth
  const y = (value, item = null) => {
    const range = ranges.get(item?.scaleId || 'primary') || primaryRange
    return PADDING.top + (range.max - value) / (range.max - range.min) * plotHeight
  }

  const labelFont = '700 12px "Roboto Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace'
  context.font = labelFont
  context.lineWidth = 1
  context.strokeStyle = gridColor
  context.fillStyle = textColor
  for (let index = 0; index <= 5; index++) {
    const yy = crisp(PADDING.top + index / 5 * plotHeight)
    context.beginPath(); context.moveTo(PADDING.left, yy); context.lineTo(size.width - PADDING.right, yy); context.stroke()
    const value = max - index / 5 * (max - min)
    context.textAlign = 'left'; context.textBaseline = 'middle'; context.fillText(valueFormatter(value), size.width - PADDING.right + 9, yy)
  }

  // TradingView-style scale separators and a faint chart watermark.
  const axisX = crisp(size.width - PADDING.right)
  const axisY = crisp(size.height - PADDING.bottom)
  context.strokeStyle = 'rgba(132,145,160,.24)'; context.lineWidth = 1
  context.beginPath(); context.moveTo(axisX, PADDING.top); context.lineTo(axisX, size.height - PADDING.bottom); context.stroke()
  context.beginPath(); context.moveTo(PADDING.left, axisY); context.lineTo(size.width - PADDING.right, axisY); context.stroke()
  context.save(); context.globalAlpha = 0.035; context.fillStyle = '#dce6f2'; context.font = '700 38px Inter, system-ui, sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(String(title || '').toUpperCase(), PADDING.left + plotWidth / 2, PADDING.top + plotHeight / 2); context.restore()
  context.font = labelFont; context.strokeStyle = gridColor; context.fillStyle = textColor
  for (let index = 0; index <= 6; index++) {
    const xx = crisp(PADDING.left + index / 6 * plotWidth)
    context.beginPath(); context.moveTo(xx, PADDING.top); context.lineTo(xx, size.height - PADDING.bottom); context.stroke()
    const time = view.start + index / 6 * (view.end - view.start)
    context.textAlign = index === 0 ? 'left' : index === 6 ? 'right' : 'center'
    context.textBaseline = 'top'; context.fillText(timeFormatter(time, false), xx, size.height - PADDING.bottom + 9)
  }

  context.save()
  for (const item of visible) {
    if (!item.data.length) continue
    const linePath = new Path2D()
    item.data.forEach((point, index) => index ? linePath.lineTo(x(point.time), y(point.value, item)) : linePath.moveTo(x(point.time), y(point.value, item)))
    // Blur is attractive but expensive. Keep a lightweight halo only when the
    // downsampled path is small enough; dense paths stay crisp and responsive.
    if (item.data.length < 1400) {
      context.save(); context.strokeStyle = item.color || '#3b82f6'; context.globalAlpha = (item.opacity ?? 1) * 0.18; context.lineWidth = 4; context.filter = 'blur(2px)'; context.stroke(linePath); context.restore()
    }
    context.save(); context.globalAlpha = item.opacity ?? 1; context.strokeStyle = item.color || '#3b82f6'; context.lineWidth = item.lineWidth || 1.6; context.lineJoin = 'round'; context.lineCap = 'round'; context.stroke(linePath); context.restore()

    const last = item.data[item.data.length - 1]
    if (last) {
      const yy = y(last.value, item)
      if (item.showLastValue === false) continue
      context.save(); context.setLineDash([3, 4]); context.globalAlpha = 0.45; context.strokeStyle = item.color; context.lineWidth = 1
      context.beginPath(); context.moveTo(PADDING.left, yy); context.lineTo(size.width - PADDING.right, yy); context.stroke(); context.restore()
      drawAxisBadge(context, size.width - PADDING.right + 1, yy, valueFormatter(last.value), item.color, size.width - PADDING.right - 2)
    }
  }
  if (pointer) {
    const xx = x(pointer.time)
    const pointerValues = visible.map((item) => ({ item, point: nearestPoint(item.source, pointer.time) })).filter((entry) => entry.point)
    const primaryY = pointerValues[0] ? y(pointerValues[0].point.value, pointerValues[0].item) : pointer.y
    context.setLineDash([3, 3]); context.strokeStyle = 'rgba(190,201,214,.55)'; context.lineWidth = 1
    context.beginPath(); context.moveTo(xx, PADDING.top); context.lineTo(xx, size.height - PADDING.bottom); context.stroke()
    context.beginPath(); context.moveTo(PADDING.left, primaryY); context.lineTo(size.width - PADDING.right, primaryY); context.stroke(); context.setLineDash([])
    for (const item of visible) {
      const point = nearestPoint(item.source, pointer.time)
      if (!point) continue
      context.beginPath(); context.arc(x(point.time), y(point.value, item), 3.5, 0, Math.PI * 2); context.fillStyle = item.color; context.fill()
    }
    drawBottomBadge(context, xx, size.height - PADDING.bottom, timeFormatter(pointer.time, true), size.width)
    if (pointerValues[0]) drawAxisBadge(context, size.width - PADDING.right + 1, primaryY, valueFormatter(pointerValues[0].point.value), '#5d6978', size.width - PADDING.right - 2)
  }
  context.restore()
}

function roundedRect(context, x, y, width, height, radius = 3) {
  const r = Math.min(radius, height / 2, width / 2)
  context.beginPath(); context.moveTo(x + r, y); context.arcTo(x + width, y, x + width, y + height, r); context.arcTo(x + width, y + height, x, y + height, r); context.arcTo(x, y + height, x, y, r); context.arcTo(x, y, x + width, y, r); context.closePath()
}

function drawAxisBadge(context, x, centerY, text, color, maxX) {
  context.save(); context.font = '600 10.5px "Roboto Mono", ui-monospace, Menlo, Consolas, monospace'
  const width = Math.min(context.measureText(text).width + 12, 76), height = 18
  const drawX = Math.min(x, maxX + 3), drawY = centerY - height / 2
  roundedRect(context, drawX, drawY, width, height, 2); context.fillStyle = color; context.fill()
  context.fillStyle = '#fff'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(text, drawX + width / 2, centerY)
  context.restore()
}

function drawBottomBadge(context, centerX, y, text, canvasWidth) {
  context.save(); context.font = '600 10.5px "Roboto Mono", ui-monospace, Menlo, Consolas, monospace'
  const width = context.measureText(text).width + 14, height = 19
  const x = clamp(centerX - width / 2, PADDING.left, canvasWidth - PADDING.right - width)
  roundedRect(context, x, y + 1, width, height, 2); context.fillStyle = '#5d6978'; context.fill()
  context.fillStyle = '#fff'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(text, x + width / 2, y + 10)
  context.restore()
}

function Tooltip({ tooltip, width, formatter, timeFormatter }) {
  const left = tooltip.x > width - 210 ? tooltip.x - 190 : tooltip.x + 14
  return <Box sx={{ position: 'absolute', left, top: Math.max(8, tooltip.y - 40), width: 176, p: 1, border: '1px solid rgba(255,255,255,.1)', borderRadius: 0.75, bgcolor: 'rgba(18,23,31,.96)', color: '#fff', pointerEvents: 'none', boxShadow: '0 8px 24px rgba(0,0,0,.38)', fontSize: '0.72rem', backdropFilter: 'blur(8px)' }}>
    <Box sx={{ mb: 0.5, opacity: 0.72 }}>{timeFormatter(tooltip.time, true)}</Box>
    {tooltip.values.map((item) => <Box key={item.id || item.label} sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}><span style={{ color: item.color }}>{item.label}</span><strong>{formatter(item.point.value)}</strong></Box>)}
  </Box>
}

function Legend({ color, label, value, formatter }) {
  return <Box sx={{ display: { xs: 'none', md: 'flex' }, alignItems: 'center', gap: 0.5, color: 'text.secondary', fontSize: '0.72rem' }}><Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: color }} /><span>{label}</span><strong>{formatter(value || 0)}</strong></Box>
}

function nearestPoint(data, time) {
  if (!data?.length) return null
  let low = 0, high = data.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (data[middle].time < time) low = middle + 1
    else high = middle
  }
  if (low > 0 && Math.abs(data[low - 1].time - time) < Math.abs(data[low].time - time)) return data[low - 1]
  return data[low]
}

function lowerBound(data, time) {
  let low = 0, high = data.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (data[middle].time < time) low = middle + 1
    else high = middle
  }
  return low
}

function visibleSlice(data, start, end) {
  if (!data.length) return []
  const first = Math.max(0, lowerBound(data, start) - 1)
  const last = Math.min(data.length, lowerBound(data, end) + 1)
  return data.slice(first, last)
}

// Pixel-bucket min/max sampling retains both extremes in their original time
// order. It is better suited to financial/OI charts than averaging, which can
// hide fast spikes and make the chart visually dishonest.
function downsampleMinMax(data, pixelWidth) {
  const target = Math.max(2, pixelWidth * 2)
  if (data.length <= target) return data
  const output = [data[0]]
  const bucketSize = (data.length - 2) / Math.max(pixelWidth - 2, 1)
  for (let bucket = 0; bucket < pixelWidth - 2; bucket++) {
    const start = Math.floor(1 + bucket * bucketSize)
    const end = Math.min(data.length - 1, Math.floor(1 + (bucket + 1) * bucketSize))
    if (end <= start) continue
    let minPoint = data[start], maxPoint = data[start]
    for (let index = start + 1; index < end; index++) {
      if (data[index].value < minPoint.value) minPoint = data[index]
      if (data[index].value > maxPoint.value) maxPoint = data[index]
    }
    if (minPoint.time <= maxPoint.time) { output.push(minPoint); if (maxPoint !== minPoint) output.push(maxPoint) }
    else { output.push(maxPoint); if (maxPoint !== minPoint) output.push(minPoint) }
  }
  output.push(data[data.length - 1])
  return output
}

function clamp(value, min, max) { return Math.min(Math.max(value, min), max) }

// renderRatio is the canvas oversampling factor. We render at AT LEAST 2x the
// CSS pixel size — even on a 1x display — so axis labels and thin grid lines
// stay razor sharp like TradingView. Capped at 3x to bound memory/fill cost on
// 4K panels that already report dpr 1.5-2.
function renderRatio() {
  if (typeof window === 'undefined') return 2
  return Math.min(Math.max(window.devicePixelRatio || 1, 2), 3)
}

// cssVar reads a CSS custom property off the document root (where data-theme is
// set), trimming and falling back when unset so canvas draws stay theme-aware.
function cssVar(name, fallback) {
  if (typeof window === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}
