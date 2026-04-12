const apiPort = process.env.API_PORT || '3100';
const propertyRadarInterval = process.env.PROPERTYRADAR_FEED_INTERVAL_MS || '300000';

module.exports = {
  apps: [
    {
      name: 'sullilink-api',
      cwd: __dirname,
      script: 'src/api/server.js',
      env: {
        NODE_ENV: process.env.NODE_ENV || 'production',
        API_PORT: apiPort
      }
    },
    {
      name: 'sullilink-telegram-bot',
      cwd: __dirname,
      script: 'scripts/ops/run-telegram-bot.js',
      env: {
        NODE_ENV: process.env.NODE_ENV || 'production',
        API_PORT: apiPort,
        BRAIN_API_URL: process.env.BRAIN_API_URL || `http://127.0.0.1:${apiPort}`
      }
    },
    {
      name: 'sullilink-propertyradar-feed',
      cwd: __dirname,
      script: 'scripts/ops/run-propertyradar-feed.js',
      args: ['--loop', '--interval-ms', propertyRadarInterval, '--telegram-summary'],
      env: {
        NODE_ENV: process.env.NODE_ENV || 'production',
        API_PORT: apiPort,
        BRAIN_API_URL: process.env.BRAIN_API_URL || `http://127.0.0.1:${apiPort}`
      }
    }
  ]
};
