// Route registry — importing this file registers every /api/* route by
// side-effect (each module calls route(...) at import time). server.js imports
// this before listening.

import './accounts.js';
import './angel.js';
import './upstox.js';
import './zerodha.js';
import './kotak.js';
import './nubra.js';
import './users.js';
import './angelTradePanel.js';
import './master.js';
import './optionChain.js';
import './feed.js';
import './wsfeed.js';
