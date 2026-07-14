const numberFrom = (row, keys) => {
  for (const key of keys) {
    const value = row?.[key];
    if (value != null && value !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return 0;
};

export function positionQuantityBreakdown(row = {}) {
  const netQty = numberFrom(row, ['netqty', 'netQty', 'net_quantity', 'quantity']);
  let buyQty = Math.abs(numberFrom(row, [
    'totalbuyqty', 'totalBuyQty', 'total_buy_qty', 'buyqty', 'buyQty',
    'buyquantity', 'buyQuantity', 'cfbuyqty', 'cfBuyQty',
  ]));
  let sellQty = Math.abs(numberFrom(row, [
    'totalsellqty', 'totalSellQty', 'total_sell_qty', 'sellqty', 'sellQty',
    'sellquantity', 'sellQuantity', 'cfsellqty', 'cfSellQty',
  ]));

  // Some broker streams only publish the net position. Keep the direction
  // understandable until the next full position-book refresh arrives.
  if (!buyQty && !sellQty && netQty) {
    if (netQty > 0) buyQty = netQty;
    else sellQty = Math.abs(netQty);
  }

  const lotSize = Math.abs(numberFrom(row, ['lotsize', 'lotSize', 'lot_size', 'marketlot'])) || 0;
  const toLots = (qty) => (lotSize > 0 ? Math.abs(qty) / lotSize : null);
  return {
    buyQty,
    sellQty,
    netQty,
    lotSize,
    buyLots: toLots(buyQty),
    sellLots: toLots(sellQty),
    netLots: toLots(netQty),
  };
}

export function formatLots(value) {
  if (value == null || !Number.isFinite(Number(value))) return '';
  const lots = Number(value);
  return Number.isInteger(lots) ? String(lots) : lots.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}
