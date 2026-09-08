import pg from 'pg';

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost/supermarket_ops',
});

let connected = false;

export async function connectDatabase(): Promise<void> {
  if (connected) {
    return;
  }
  await client.connect();
  connected = true;
}

export async function closeDatabase(): Promise<void> {
  if (!connected) {
    return;
  }
  await client.end();
  connected = false;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  values?: unknown[]
): Promise<T[]> {
  const result = await client.query<T>(sql, values);
  return result.rows;
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost/supermarket_ops',
  });

  const poolClient = await pool.connect();

  try {
    await poolClient.query('BEGIN');
    const result = await fn(poolClient);
    await poolClient.query('COMMIT');
    return result;
  } catch (error) {
    await poolClient.query('ROLLBACK');
    throw error;
  } finally {
    poolClient.release();
    await pool.end();
  }
}