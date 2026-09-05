import { createClient, type Client } from "@libsql/client";
import type { SupportCase } from "../domain/support-case";

/**
 * Case store backed by libSQL - the same database as the rest of this app's
 * Mastra storage (see `src/mastra/index.ts`). Uses `TURSO_DATABASE_URL` /
 * `TURSO_AUTH_TOKEN` when set (Turso, for production), or falls back to the
 * local `file:./mastra.db` file used by `mastra dev` otherwise. There's no
 * separate "in-memory mode" - the local file already gives zero-config local
 * development without losing case state on restart, and using the same
 * database/env vars as the rest of the app's storage means there's only one
 * place to configure persistence for a real deployment.
 */
function resolveLibsqlConfig() {
  return {
    url: process.env.TURSO_DATABASE_URL || "file:./mastra.db",
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  };
}

class CaseStore {
  private client: Client;
  private ready: Promise<void>;

  constructor() {
    this.client = createClient(resolveLibsqlConfig());
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS support_cases (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    await this.client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS support_cases_source_external_id
      ON support_cases (source, external_id)
    `);
  }

  private rowToCase(data: unknown): SupportCase {
    return JSON.parse(data as string) as SupportCase;
  }

  async findByExternalId(
    source: string,
    externalId: string,
  ): Promise<SupportCase | undefined> {
    await this.ready;
    const result = await this.client.execute({
      sql: "SELECT data FROM support_cases WHERE source = ? AND external_id = ?",
      args: [source, externalId],
    });
    const row = result.rows[0];
    return row ? this.rowToCase(row.data) : undefined;
  }

  async create(supportCase: SupportCase): Promise<SupportCase> {
    await this.ready;
    await this.client.execute({
      sql: `INSERT INTO support_cases (id, source, external_id, data, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        supportCase.id,
        supportCase.source,
        supportCase.externalId,
        JSON.stringify(supportCase),
        supportCase.createdAt,
        supportCase.updatedAt,
      ],
    });
    return supportCase;
  }

  async get(id: string): Promise<SupportCase | undefined> {
    await this.ready;
    const result = await this.client.execute({
      sql: "SELECT data FROM support_cases WHERE id = ?",
      args: [id],
    });
    const row = result.rows[0];
    return row ? this.rowToCase(row.data) : undefined;
  }

  async update(id: string, patch: Partial<SupportCase>): Promise<SupportCase> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Support case not found: ${id}`);
    }
    const updated: SupportCase = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await this.client.execute({
      sql: "UPDATE support_cases SET data = ?, updated_at = ? WHERE id = ?",
      args: [JSON.stringify(updated), updated.updatedAt, id],
    });
    return updated;
  }

  async appendMessage(
    id: string,
    message: SupportCase["messages"][number],
  ): Promise<SupportCase> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Support case not found: ${id}`);
    }
    return this.update(id, { messages: [...existing.messages, message] });
  }

  async list(): Promise<SupportCase[]> {
    await this.ready;
    const result = await this.client.execute(
      "SELECT data FROM support_cases ORDER BY created_at DESC",
    );
    return result.rows.map((row) => this.rowToCase(row.data));
  }
}

export const caseStore = new CaseStore();
