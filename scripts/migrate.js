const fs = require('fs');
const path = require('path');
const { getPool, query, close } = require('../src/db/connection');

const migrationsDir = path.join(__dirname, '..', 'src', 'db', 'migrations');

function sortMigrations(a, b) {
  const aMatch = a.match(/^(\d+)/);
  const bMatch = b.match(/^(\d+)/);
  const aValue = aMatch ? Number(aMatch[1]) : Number.MAX_SAFE_INTEGER;
  const bValue = bMatch ? Number(bMatch[1]) : Number.MAX_SAFE_INTEGER;

  if (aValue !== bValue) {
    return aValue - bValue;
  }

  return a.localeCompare(b);
}

async function ensureMigrationsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations() {
  const result = await query('SELECT filename FROM _migrations');
  return new Set(result.rows.map((row) => row.filename));
}

async function runMigrations() {
  await ensureMigrationsTable();

  const files = (await fs.promises.readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort(sortMigrations);

  const appliedMigrations = await getAppliedMigrations();
  const pool = getPool();

  for (const file of files) {
    if (appliedMigrations.has(file)) {
      continue;
    }

    const sql = await fs.promises.readFile(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO _migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING',
        [file]
      );
      await client.query('COMMIT');
      console.log(`Applied migration: ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`Failed migration: ${file}`);
      throw error;
    } finally {
      client.release();
    }
  }
}

runMigrations()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await close();
  });
