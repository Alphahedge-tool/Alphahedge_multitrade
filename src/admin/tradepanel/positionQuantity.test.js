import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLots, positionQuantityBreakdown } from './positionQuantity.js';

test('calculates broker buy, sell, net quantities and lots', () => {
  const out = positionQuantityBreakdown({ totalbuyqty: '150', totalsellqty: '75', netqty: '75', lotsize: '75' });
  assert.deepEqual(out, {
    buyQty: 150, sellQty: 75, netQty: 75, lotSize: 75,
    buyLots: 2, sellLots: 1, netLots: 1,
  });
});

test('keeps a short net-only stream update understandable', () => {
  const out = positionQuantityBreakdown({ netqty: -130, lotSize: 65 });
  assert.equal(out.buyQty, 0);
  assert.equal(out.sellQty, 130);
  assert.equal(out.netLots, 2);
});

test('reports unknown lots without inventing a lot size', () => {
  const out = positionQuantityBreakdown({ buyqty: 50, netqty: 50 });
  assert.equal(out.netLots, null);
  assert.equal(formatLots(out.netLots), '');
});

test('formats fractional lots compactly', () => {
  assert.equal(formatLots(1), '1');
  assert.equal(formatLots(1.5), '1.5');
});
