# Alphahedge HTML5 Charting

Reusable, dependency-free time-series charts rendered with the HTML5 Canvas API.

```jsx
import Html5TimeSeriesChart from '../charting/Html5TimeSeriesChart'

<Html5TimeSeriesChart
  title="My market model"
  series={[
    { id: 'model', label: 'Model', color: '#3b82f6', data: [{ time: Date.now(), value: 42 }] },
  ]}
  valueFormatter={(value) => value.toFixed(2)}
/>
```

Features: high-DPI rendering, responsive resize, multiple series, IST timestamp axis,
crosshair tooltip, wheel zoom, pointer drag pan, auto-follow at the live edge, and reset/fit controls.
