import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import type {
  KnowledgeEvidence,
  ProviderBinding,
} from "../providers/contracts";
import {
  getSharedLocalSqliteClient,
  serializeSqliteClient,
} from "./sqlite-client";
import { waitForMastraStorage } from "../runtime/storage-lifecycle";

/**
 * The knowledge port is a source of candidates, not a serving index.  These
 * tables are the serving authority: a search reads exactly one activated
 * generation for a tenant/account, so a failed build can never replace the
 * last known-good policy snapshot.
 */
export interface PublishedEvidence extends KnowledgeEvidence {
  documentHash: string;
  generationId: string;
  effectiveAt: string;
  indexedAt: string;
  expiresAt?: string;
  providerKind: string;
  providerAccountId: string;
}

type Candidate = Omit<PublishedEvidence, "generationId" | "indexedAt">;
export interface KnowledgePublication {
  generationId?: string;
  revision: number;
}

const accountKey = (binding: ProviderBinding) =>
  `${binding.tenantId}\u0000${binding.providerKind}\u0000${binding.providerAccountId}`;

const tokenize = (value: string) =>
  value.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];

function lexicalScore(query: string, document: string) {
  const terms = new Set(tokenize(query));
  if (terms.size === 0) return 0;
  const body = new Set(tokenize(document));
  let hits = 0;
  for (const term of terms) if (body.has(term)) hits += 1;
  return hits / terms.size;
}

export class KnowledgePublicationStore {
  private readonly client: Client;
  private ready?: Promise<void>;
  constructor(client: Client = getSharedLocalSqliteClient()) {
    this.client = serializeSqliteClient(client);
  }

  private async ensured() {
    this.ready ??= (async () => {
      await waitForMastraStorage();
      await this.client.executeMultiple(`
        CREATE TABLE IF NOT EXISTS support_knowledge_schema_migrations (
          version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS support_knowledge_generations (
          id TEXT PRIMARY KEY, account_key TEXT NOT NULL, tenant_id TEXT NOT NULL,
          provider_kind TEXT NOT NULL, provider_account_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('candidate','active','rolled_back','failed')),
          created_at TEXT NOT NULL, activated_at TEXT, replaced_generation_id TEXT,
          base_revision INTEGER NOT NULL DEFAULT 0,
          UNIQUE(account_key, id)
        );
        CREATE TABLE IF NOT EXISTS support_knowledge_documents (
          generation_id TEXT NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL,
          text TEXT NOT NULL, version TEXT NOT NULL, document_hash TEXT NOT NULL,
          effective_at TEXT NOT NULL, indexed_at TEXT NOT NULL, expires_at TEXT,
          provider_kind TEXT NOT NULL, provider_account_id TEXT NOT NULL,
          PRIMARY KEY(generation_id, source, document_hash)
        );
        CREATE TABLE IF NOT EXISTS support_knowledge_publications (
          account_key TEXT PRIMARY KEY, generation_id TEXT NOT NULL, revision INTEGER NOT NULL,
          published_at TEXT NOT NULL
        );
      `);
      await this.client.execute({
        sql: "INSERT OR IGNORE INTO support_knowledge_schema_migrations(version, applied_at) VALUES (1, ?)",
        args: [new Date().toISOString()],
      });
    })();
    await this.ready;
  }

  async buildCandidate(
    binding: ProviderBinding,
    documents: KnowledgeEvidence[],
    base?: KnowledgePublication,
  ) {
    await this.ensured();
    base ??= await this.publication(binding);
    if (documents.length === 0)
      throw new Error("Knowledge candidate has no documents.");
    const now = new Date().toISOString();
    const generationId = `knowledge_${crypto.randomUUID()}`;
    const seen = new Set<string>();
    const sourceVersions = new Map<string, string>();
    const candidates: Candidate[] = documents.map((document) => {
      if (
        !document.source ||
        !document.title ||
        !document.text ||
        !document.version
      )
        throw new Error("Knowledge candidate has incomplete provenance.");
      const effectiveAt = Date.parse(document.effectiveAt ?? "");
      const expiresAt =
        document.expiresAt === undefined
          ? undefined
          : Date.parse(document.expiresAt);
      if (!Number.isFinite(effectiveAt))
        throw new Error(
          "Knowledge candidate has no valid source effective time.",
        );
      if (
        effectiveAt > Date.now() ||
        (expiresAt !== undefined &&
          (!Number.isFinite(expiresAt) ||
            expiresAt <= effectiveAt ||
            expiresAt <= Date.now()))
      )
        throw new Error("Knowledge candidate has inactive source evidence.");
      const documentHash = createHash("sha256")
        .update(
          JSON.stringify([document.source, document.version, document.text]),
        )
        .digest("hex");
      const identity = `${document.source}\u0000${documentHash}`;
      if (seen.has(identity))
        throw new Error("Knowledge candidate has duplicate document identity.");
      const priorVersion = sourceVersions.get(document.source);
      if (priorVersion && priorVersion !== document.version)
        throw new Error("Knowledge candidate has conflicting source versions.");
      seen.add(identity);
      sourceVersions.set(document.source, document.version);
      return {
        ...document,
        documentHash,
        // SQLite compares TEXT lexically. Store canonical UTC instants so its
        // query predicate has the same meaning as the validation above.
        effectiveAt: new Date(effectiveAt).toISOString(),
        expiresAt:
          expiresAt === undefined
            ? undefined
            : new Date(expiresAt).toISOString(),
        providerKind: binding.providerKind,
        providerAccountId: binding.providerAccountId,
      };
    });
    const tx = await this.client.transaction("write");
    try {
      await tx.execute({
        sql: "INSERT INTO support_knowledge_generations(id, account_key, tenant_id, provider_kind, provider_account_id, state, created_at, base_revision) VALUES (?, ?, ?, ?, ?, 'candidate', ?, ?)",
        args: [
          generationId,
          accountKey(binding),
          binding.tenantId,
          binding.providerKind,
          binding.providerAccountId,
          now,
          base.revision,
        ],
      });
      for (const document of candidates)
        await tx.execute({
          sql: "INSERT INTO support_knowledge_documents(generation_id, source, title, text, version, document_hash, effective_at, indexed_at, expires_at, provider_kind, provider_account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          args: [
            generationId,
            document.source,
            document.title,
            document.text,
            document.version,
            document.documentHash,
            document.effectiveAt,
            now,
            document.expiresAt ?? null,
            document.providerKind,
            document.providerAccountId,
          ],
        });
      await tx.commit();
    } catch (error) {
      try {
        await tx.rollback();
      } catch {}
      throw error;
    }
    return { generationId, indexed: candidates.length, base };
  }

  /** Activates only if the caller built from the still-current generation. */
  async activate(
    binding: ProviderBinding,
    generationId: string,
    expected: KnowledgePublication,
  ) {
    await this.ensured();
    const key = accountKey(binding);
    const tx = await this.client.transaction("write");
    try {
      const candidate = await tx.execute({
        sql: "SELECT state FROM support_knowledge_generations WHERE id = ? AND account_key = ?",
        args: [generationId, key],
      });
      if (
        !(["candidate", "rolled_back"] as const).includes(
          candidate.rows[0]?.state as "candidate" | "rolled_back",
        )
      )
        throw new Error("Knowledge candidate is not publishable.");
      const current = await tx.execute({
        sql: "SELECT generation_id, revision FROM support_knowledge_publications WHERE account_key = ?",
        args: [key],
      });
      const actual = current.rows[0]?.generation_id as string | undefined;
      const revision = Number(current.rows[0]?.revision ?? 0);
      if (actual !== expected.generationId || revision !== expected.revision)
        throw new Error(
          `Stale knowledge publication rejected by compare-and-set (expected ${expected.generationId ?? "none"}@${expected.revision}, found ${actual ?? "none"}@${revision}).`,
        );
      const now = new Date().toISOString();
      await tx.execute({
        sql: "UPDATE support_knowledge_generations SET state = 'active', activated_at = ?, replaced_generation_id = ? WHERE id = ?",
        args: [now, actual ?? null, generationId],
      });
      if (actual)
        await tx.execute({
          sql: "UPDATE support_knowledge_generations SET state = 'rolled_back' WHERE id = ?",
          args: [actual],
        });
      await tx.execute({
        sql: "INSERT INTO support_knowledge_publications(account_key, generation_id, revision, published_at) VALUES (?, ?, 1, ?) ON CONFLICT(account_key) DO UPDATE SET generation_id = excluded.generation_id, revision = support_knowledge_publications.revision + 1, published_at = excluded.published_at",
        args: [key, generationId, now],
      });
      await tx.commit();
      return { generationId, previousGenerationId: actual };
    } catch (error) {
      try {
        await tx.rollback();
      } catch {}
      throw error;
    }
  }

  async publication(binding: ProviderBinding): Promise<KnowledgePublication> {
    await this.ensured();
    const result = await this.client.execute({
      sql: "SELECT generation_id, revision FROM support_knowledge_publications WHERE account_key = ?",
      args: [accountKey(binding)],
    });
    return {
      generationId: result.rows[0]?.generation_id as string | undefined,
      revision: Number(result.rows[0]?.revision ?? 0),
    };
  }

  async activeGeneration(binding: ProviderBinding) {
    return (await this.publication(binding)).generationId;
  }

  async rollback(binding: ProviderBinding, generationId: string) {
    await this.ensured();
    return this.activate(
      binding,
      generationId,
      await this.publication(binding),
    );
  }

  async search(
    binding: ProviderBinding,
    query: string,
    topK: number,
  ): Promise<PublishedEvidence[]> {
    await this.ensured();
    const generationId = await this.activeGeneration(binding);
    if (!generationId) return [];
    const now = new Date().toISOString();
    const rows = await this.client.execute({
      sql: "SELECT * FROM support_knowledge_documents WHERE generation_id = ? AND effective_at <= ? AND (expires_at IS NULL OR expires_at > ?)",
      args: [generationId, now, now],
    });
    return rows.rows
      .map((row) => {
        const value = row as Record<string, unknown>;
        return {
          title: String(value.title),
          text: String(value.text),
          source: String(value.source),
          version: String(value.version),
          score: lexicalScore(query, `${value.title}\n${value.text}`),
          documentHash: String(value.document_hash),
          generationId,
          effectiveAt: String(value.effective_at),
          indexedAt: String(value.indexed_at),
          expiresAt: value.expires_at ? String(value.expires_at) : undefined,
          providerKind: String(value.provider_kind),
          providerAccountId: String(value.provider_account_id),
        };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.source.localeCompare(b.source))
      .slice(0, topK);
  }

  /** Read the authoritative source row for a selected generation. Vector
   * metadata is an index hint only; serving provenance always comes from here. */
  async document(
    binding: ProviderBinding,
    generationId: string,
    source: string,
    documentHash: string,
  ): Promise<PublishedEvidence | undefined> {
    await this.ensured();
    const row = await this.client.execute({
      sql: "SELECT d.* FROM support_knowledge_documents d JOIN support_knowledge_generations g ON g.id = d.generation_id WHERE d.generation_id = ? AND d.source = ? AND d.document_hash = ? AND g.account_key = ?",
      args: [generationId, source, documentHash, accountKey(binding)],
    });
    const value = row.rows[0] as Record<string, unknown> | undefined;
    if (!value) return undefined;
    return {
      title: String(value.title),
      text: String(value.text),
      source: String(value.source),
      version: String(value.version),
      score: 1,
      documentHash: String(value.document_hash),
      generationId,
      effectiveAt: String(value.effective_at),
      indexedAt: String(value.indexed_at),
      expiresAt: value.expires_at ? String(value.expires_at) : undefined,
      providerKind: String(value.provider_kind),
      providerAccountId: String(value.provider_account_id),
    };
  }
}

export const knowledgePublicationStore = new KnowledgePublicationStore();
