// Shared Angel trade-panel singletons — the HTTP client, Auth, MasterStore, and
// Feed. Owned here so both the trade-panel routes and the feed's option-chain
// helper use the SAME instances (one scrip master, one connection pool).

import { Client } from './httpClient.js';
import { Auth } from './auth.js';
import { MasterStore } from './master.js';
import { Feed } from './feed.js';

export const client = new Client();
export const auth = new Auth(client);
export const master = new MasterStore();
export const feed = new Feed();
