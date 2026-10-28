#!/usr/bin/env node
// Compatibility entry for source checkouts and existing PATH shims.
// npm and this entry now run the same SDK-owned application.
require('./bin/kepos.cjs');
