const path = require('path');
const dotenv = require('dotenv');
const express = require('express');
const healthRouter = require('./routes/health');
const ingestRouter = require('./routes/ingest');
const searchRouter = require('./routes/search');
const entitiesRouter = require('./routes/entities');
const buyersRouter = require('./routes/buyers');
const sellersRouter = require('./routes/sellers');
const knowledgeRouter = require('./routes/knowledge');
const matchRouter = require('./routes/match');
const dailyRouter = require('./routes/daily');
const importExportRouter = require('./routes/import-export');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(healthRouter);
  app.use(ingestRouter);
  app.use(searchRouter);
  app.use(entitiesRouter);
  app.use(buyersRouter);
  app.use(sellersRouter);
  app.use(knowledgeRouter);
  app.use(matchRouter);
  app.use(dailyRouter);
  app.use(importExportRouter);
  return app;
}

async function startServer(port) {
  const app = createApp();
  const listenPort = port ?? Number(process.env.API_PORT || 3100);

  await new Promise((resolve, reject) => {
    const server = app.listen(listenPort, resolve);
    server.on('error', reject);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  createApp,
  startServer
};
