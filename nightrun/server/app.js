'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const D = require('./db');
const G = require('./geo');
const { createApi } = require('./api');
const { seed } = require('./seed');

function createApp(opts) {
  opts = opts || {};
  const dbFile = opts.dbFile || process.env.NIGHTRUN_DB || path.join(__dirname, '..', 'data', 'nightrun.db');
  const reseed = opts.reseed || !fs.existsSync(dbFile);
  const db = D.connect(dbFile);
  if (reseed) seed();

  const app = express();
  app.use('/api', createApi({ db: D, geo: G }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const app = createApp();
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log('nightrun on http://localhost:' + port);
  });
}

module.exports = { createApp };
