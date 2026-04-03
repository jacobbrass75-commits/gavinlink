const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

let pool = null;

function getPoolConfig() {
  return {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: Number(process.env.POSTGRES_PORT || 5433),
    database: process.env.POSTGRES_DB || 'isg_brain',
    user: process.env.POSTGRES_USER || 'isg',
    password: process.env.POSTGRES_PASSWORD || 'localdev'
  };
}

function getPool() {
  if (!pool) {
    pool = new Pool(getPoolConfig());
  }

  return pool;
}

function query(text, params = []) {
  return getPool().query(text, params);
}

async function close() {
  if (!pool) {
    return;
  }

  const activePool = pool;
  pool = null;
  await activePool.end();
}

module.exports = {
  getPool,
  query,
  close
};
