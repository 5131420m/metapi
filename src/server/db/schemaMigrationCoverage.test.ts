import { describe, expect, it } from 'vitest';
import { is } from 'drizzle-orm';
import { SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core';
import { buildSchemaContractFromSqliteMigrations } from './schemaContract.js';
import * as schema from './schema.js';

/**
 * Guards the invariant that every column declared in schema.ts is actually
 * reachable by replaying drizzle/*.sql.
 *
 * Without this, a PR can add a column to schema.ts (plus a runtime
 * compatibility spec) and stay green locally while every test that seeds the
 * table dies with "table X has no column named Y" — the runtime healing path
 * only runs on real server startup, not under the test harness.
 */
describe('schema migration coverage', () => {
  const migratedContract = buildSchemaContractFromSqliteMigrations();

  const declaredTables = Object.values(schema)
    .filter((candidate) => is(candidate, SQLiteTable))
    .map((table) => getTableConfig(table));

  it('declares at least one drizzle table to check', () => {
    expect(declaredTables.length).toBeGreaterThan(0);
  });

  it('creates every schema.ts table through the migration chain', () => {
    const missingTables = declaredTables
      .map((table) => table.name)
      .filter((tableName) => !migratedContract.tables[tableName]);

    expect(missingTables).toEqual([]);
  });

  it('creates every schema.ts column through the migration chain', () => {
    const missingColumns: string[] = [];

    for (const table of declaredTables) {
      const migratedTable = migratedContract.tables[table.name];
      if (!migratedTable) continue;
      for (const column of table.columns) {
        if (!migratedTable.columns[column.name]) {
          missingColumns.push(`${table.name}.${column.name}`);
        }
      }
    }

    expect(missingColumns).toEqual([]);
  });
});
