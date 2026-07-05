// Entry point for the Alphahedge Node backend.
// Registers all /api/* routes (via the side-effect imports in routes/index.js),
// then starts the HTTP server. Run:
//   node --env-file-if-exists=.env node-backend/main.js

import { keepSupabaseWarm } from './lib/supabaseAgent.js';
import { warmMasters } from './master/manager.js';
import './routes/index.js';
import { start } from './server.js';

// Install the keep-alive connection pool + keep a warm socket to Supabase, so
// requests never pay the ~600ms cold-TLS cost on the first call after an idle.
keepSupabaseWarm();

// Load the public instrument masters (Angel, Upstox) in the background so
// symbol->token routing works right after boot. Session masters (Nubra/Kotak)
// load after their broker logs in.
warmMasters();

start();
