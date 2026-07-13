import test from 'node:test';
import assert from 'node:assert/strict';

import { parseBrokerCSV } from './csv.js';
import { normalizeKotakRows } from './loaders/kotak.js';
import { normalizeZerodhaRows } from './loaders/zerodha.js';
import { setMaster } from './store.js';
import { canonicalForLeg, resolveOrderBasket } from './orderResolver.js';

test('Kotak comma CSV keeps the legacy semicolon header and normalizes broker identifiers', () => {
  const rawExpiry = (Date.parse('2026-07-30T00:00:00Z') / 1000) - 315_511_200;
  const text = [
    'pSymbol,pTrdSymbol,pSymbolName,pExpiryDate,dStrikePrice;,pOptionType,pInstType,lLotSize,dTickSize',
    `12345,NIFTY30JUL2625000CE,NIFTY,${rawExpiry},2500000,CE,OPTIDX,75,0.05`,
  ].join('\n');
  const parsed = parseBrokerCSV(text);
  assert.equal(parsed[0].dStrikePrice, '2500000');
  const [row] = normalizeKotakRows([{ url: 'https://example/nse_fo.csv', text }]);
  assert.equal(row.symbol, 'NIFTY30JUL2625000CE');
  assert.equal(row.token, '12345');
  assert.equal(row.brsymbol, 'NIFTY30JUL2625000CE');
  assert.equal(row.brexchange, 'nse_fo');
  assert.equal(row.strike, 25000);
  assert.equal(row.lotsize, 75);
});

test('Zerodha master preserves tradingsymbol and instrument token separately', () => {
  const [row] = normalizeZerodhaRows([{
    instrument_token: '98765',
    exchange_token: '555',
    tradingsymbol: 'NIFTY30JUL2625000CE',
    name: 'NIFTY',
    expiry: '2026-07-30',
    strike: '25000',
    tick_size: '0.05',
    lot_size: '75',
    instrument_type: 'CE',
    segment: 'NFO-OPT',
    exchange: 'NFO',
  }]);
  assert.equal(row.symbol, 'NIFTY30JUL2625000CE');
  assert.equal(row.token, '98765');
  assert.equal(row.brsymbol, 'NIFTY30JUL2625000CE');
  assert.equal(row.brexchange, 'NFO');
});

test('order basket replaces a foreign token from the selected broker master', () => {
  setMaster('kotak-test', [{
    symbol: 'NIFTY30JUL2625000CE',
    exchange: 'NFO',
    token: 'KOTAK-123',
    brsymbol: 'NIFTY30JUL2625000CE',
    brexchange: 'nse_fo',
    lotsize: 75,
  }]);
  const leg = {
    underlying: 'NIFTY', expiry: '30JUL2026', strike: 25000, optionType: 'CE',
    exchange: 'NFO', token: 'ANGEL-999', qty: 1,
  };
  assert.equal(canonicalForLeg(leg), 'NIFTY30JUL2625000CE');
  const [resolved] = resolveOrderBasket('kotak-test', [leg]);
  assert.equal(resolved.sourceToken, 'ANGEL-999');
  assert.equal(resolved.token, 'KOTAK-123');
  assert.equal(resolved.exchange, 'nse_fo');
});

test('order basket rejects an unmapped contract before placement', () => {
  assert.throws(() => resolveOrderBasket('kotak-test', [{
    underlying: 'BANKNIFTY', expiry: '30JUL2026', strike: 60000, optionType: 'PE', exchange: 'NFO',
  }]), /instrument not found/);
});
