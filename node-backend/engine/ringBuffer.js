// SeriesRing — a fixed-capacity, columnar ring buffer for time series.
//
// Why columnar: uPlot (the charting layer) wants one array per series, not an
// array of point objects. Storing that way server-side means publishing needs
// no transposition, and the client can hand the arrays straight to the chart.
//
// Why a ring: the live chart keeps the last N points. The old approach rebuilt
// a fresh JS array on every append (`[...points, point].slice(-900)`) and then
// ran six `.map()` passes to columnize — thousands of allocations per second.
// Here an append is a handful of float writes into pre-allocated Float64Arrays,
// and no allocation happens at all in steady state.
//
// Missing values are stored as NaN, which is exactly what uPlot renders as a
// gap. toJSON() converts them to null on the way out, since JSON has no NaN.

export class SeriesRing {
  /**
   * @param {string[]} columns Column names, e.g. ['time','callOi','putOi'].
   * @param {number} capacity Max retained points; appends past this overwrite
   *   the oldest.
   */
  constructor(columns, capacity) {
    if (!Array.isArray(columns) || !columns.length) throw new Error('columns required');
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('capacity must be a positive integer');
    this.columns = [...columns];
    this.capacity = capacity;
    this.count = 0; // total ever pushed; index = count % capacity
    this._data = this.columns.map(() => new Float64Array(capacity));
    // Reused scratch for the wrapped case so reads don't allocate either.
    this._out = this.columns.map(() => new Float64Array(capacity));
  }

  /** Number of points currently retained (<= capacity). */
  get size() {
    return Math.min(this.count, this.capacity);
  }

  /** True once the ring has wrapped and is overwriting old points. */
  get wrapped() {
    return this.count > this.capacity;
  }

  /**
   * push appends one point. Absent/non-numeric fields become NaN (a chart gap),
   * so a partially-populated point is recorded rather than rejected.
   * @param {Record<string, number|null|undefined>} point
   */
  push(point) {
    const slot = this.count % this.capacity;
    for (let c = 0; c < this.columns.length; c++) {
      const raw = point?.[this.columns[c]];
      this._data[c][slot] = raw == null ? NaN : Number(raw);
    }
    this.count++;
  }

  /**
   * toColumns returns the retained points in chronological order, one
   * Float64Array per column.
   *
   * The returned arrays are views/scratch owned by this ring — valid until the
   * next push() or toColumns(). Callers that need to retain them must copy
   * (toJSON does).
   */
  toColumns() {
    const n = this.size;
    // Not yet wrapped: storage is already chronological, hand back views.
    if (this.count <= this.capacity) {
      return this._data.map((col) => col.subarray(0, n));
    }
    // Wrapped: oldest point sits at count % capacity. Rotate with two bulk
    // copies (memcpy under the hood) rather than a per-element loop.
    const start = this.count % this.capacity;
    const tail = this.capacity - start; // start..end holds the older half
    for (let c = 0; c < this.columns.length; c++) {
      const src = this._data[c];
      const dst = this._out[c];
      dst.set(src.subarray(start), 0);
      dst.set(src.subarray(0, start), tail);
    }
    return this._out.map((col) => col.subarray(0, n));
  }

  /**
   * toJSON returns plain arrays safe to JSON.stringify — NaN becomes null,
   * which is what uPlot and the existing frontend already treat as a gap.
   * @returns {Record<string, (number|null)[]>}
   */
  toJSON() {
    const cols = this.toColumns();
    const out = {};
    for (let c = 0; c < this.columns.length; c++) {
      const src = cols[c];
      const arr = new Array(src.length);
      for (let i = 0; i < src.length; i++) arr[i] = Number.isNaN(src[i]) ? null : src[i];
      out[this.columns[c]] = arr;
    }
    return out;
  }

  /** The most recent point as an object, or null when empty. */
  last() {
    if (this.count === 0) return null;
    const slot = (this.count - 1) % this.capacity;
    const out = {};
    for (let c = 0; c < this.columns.length; c++) {
      const v = this._data[c][slot];
      out[this.columns[c]] = Number.isNaN(v) ? null : v;
    }
    return out;
  }

  clear() {
    this.count = 0;
  }
}
