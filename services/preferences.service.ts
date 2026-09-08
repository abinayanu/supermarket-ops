import { query } from './db';

export interface ShopPreferences {
  shopName: string;
  gstin: string;
  defaultUpiId: string;
  defaultAttaBrand?: string;
  phone?: string;
  address?: string;
}

export async function getPreferences(): Promise<Record<string, any> | null> {
  const rows = await query<{ value: any }>(
    `
      SELECT value
      FROM preferences
      WHERE key = 'shop_preferences';
    `,
    []
  );

  if (rows.length === 0) {
    return null;
  }

  return rows[0].value;
}

export async function setPreferences(
  prefs: ShopPreferences,
  updatedBy: string = 'cli-agent'
): Promise<void> {
  await query(
    `
      INSERT INTO preferences (key, value, updated_by, updated_at)
      VALUES ('shop_preferences', $1, $2, now())
      ON CONFLICT (key) DO UPDATE
        SET value = $1, updated_by = $2, updated_at = now();
    `,
    [prefs, updatedBy]
  );
}

export async function getPreference<T>(key: string): Promise<T | null> {
  const rows = await query<{ value: any }>(
    `
      SELECT value
      FROM preferences
      WHERE key = $1;
    `,
    [key]
  );

  if (rows.length === 0) {
    return null;
  }

  return rows[0].value as T;
}

export async function setPreference<T>(
  key: string,
  value: T,
  updatedBy: string = 'cli-agent'
): Promise<void> {
  await query(
    `
      INSERT INTO preferences (key, value, updated_by, updated_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (key) DO UPDATE
        SET value = $2, updated_by = $3, updated_at = now();
    `,
    [key, value, updatedBy]
  );
}