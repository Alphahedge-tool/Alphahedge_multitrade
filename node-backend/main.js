// Entry point for the Alphahedge Node backend.
// Registers all /api/* routes (via the side-effect imports in routes/index.js),
// then starts the HTTP server. Run:
//   node --env-file-if-exists=.env node-backend/main.js

import { keepSupabaseWarm } from './lib/supabaseAgent.js';
import { warmMasters } from './master/manager.js';
import './routes/index.js';
import { start } from './server.js';
import { attachFeedWSS } from './ws/wsServer.js';
import { installAutoStart } from './ws/feedManager.js';

// Install the keep-alive connection pool + keep a warm socket to Supabase, so
// requests never pay the ~600ms cold-TLS cost on the first call after an idle.
keepSupabaseWarm();

// Load the public instrument masters (Angel, Upstox) in the background so
// symbol->token routing works right after boot. Session masters (Nubra/Kotak)
// load after their broker logs in.
warmMasters();

// Broker WebSocket feeds (openalgo-style): auto-start a broker's upstream
// market-data socket the moment Feed Master logs that broker in, and mount the
// client-facing /ws/feed endpoint on the same HTTP server.
installAutoStart();
const server = start();
attachFeedWSS(server);
