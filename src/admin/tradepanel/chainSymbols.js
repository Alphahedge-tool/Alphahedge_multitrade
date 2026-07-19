// Underlyings the option chain can load, and how each maps to an exchange.
// Shared by the full chain and the standalone mini window so the two can never
// drift apart on which symbols exist or which segment they settle on.

export const INDEX_UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX']

// MCX names must match the Angel scrip master (node-backend/angel/scripoptions.js
// MCX_SYMBOLS).
export const MCX_UNDERLYINGS = ['CRUDEOIL', 'CRUDEOILM', 'NATURALGAS', 'NATGASMINI', 'GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'COPPER', 'ZINC']

export const isMcxSymbol = (symbol) => MCX_UNDERLYINGS.includes(symbol)

// MCX contracts settle on Angel's MCX segment; index options on NFO (BFO for SENSEX).
export const chainExchangeFor = (symbol) => (
  isMcxSymbol(symbol) ? 'MCX' : symbol === 'SENSEX' ? 'BFO' : 'NFO'
)

// The Upstox adapter maps our exchange -> instrument-key prefix; MCX options
// live under MCX_FO. (The tokens we send already include the prefix, but the
// adapter also accepts a bare token + this exchange.)
export const upstoxExchange = (exchange) => (exchange === 'MCX' ? 'MCX' : exchange)
