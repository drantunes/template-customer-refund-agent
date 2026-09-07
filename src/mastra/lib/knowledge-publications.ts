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
type ManifestDocument = Pick<
  PublishedEvidence,
  | "source"
  | "version"
  | "title"
  | "text"
  | "documentHash"
  | "effectiveAt"
  | "indexedAt"
  | "expiresAt"
>;
export interface KnowledgePublication {
  generationId?: string;
  revision: number;
}

/** A durable database key must not use NUL separators: SQLite bindings can
 * truncate those values. JSON preserves all three independently selected
 * account components without delimiter ambiguity. */
export const knowledgeAccountKey = (binding: ProviderBinding) =>
  JSON.stringify([
    binding.tenantId,
    binding.providerKind,
    binding.providerAccountId,
  ]);

const documentHashFor = (source: string, version: string, text: string) =>
  createHash("sha256")
    .update(JSON.stringify([source, version, text]))
    .digest("hex");

/** The manifest is deliberately a hash of a positional array, rather than a
 * database-specific row encoding. It is stable across SQLite implementations
 * and binds every serving-relevant document value to its durable account. */
const manifestHashFor = (
  binding: Pick<
    ProviderBinding,
    "tenantId" | "providerKind" | "providerAccountId"
  >,
  documents: ManifestDocument[],
) => {
  const rows = documents
    .map((document) => [
      document.source,
      document.version,
      document.title,
      document.text,
      document.documentHash,
      document.effectiveAt,
      document.indexedAt,
      document.expiresAt ?? null,
    ])
    .sort((left, right) => {
      const a = JSON.stringify(left);
      const b = JSON.stringify(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  return createHash("sha256")
    .update(
      JSON.stringify([
        binding.tenantId,
        binding.providerKind,
        binding.providerAccountId,
        rows,
      ]),
    )
    .digest("hex");
};

const valueAsString = (value: unknown) =>
  typeof value === "string" ? value : undefined;

const documentFromRow = (row: Record<string, unknown>): ManifestDocument => ({
  source: String(row.source),
  version: String(row.version),
  title: String(row.title),
  text: String(row.text),
  documentHash: String(row.document_hash),
  effectiveAt: String(row.effective_at),
  indexedAt: String(row.indexed_at),
  expiresAt:
    row.expires_at === null || row.expires_at === undefined
      ? undefined
      : String(row.expires_at),
});

const canonicalInstant = (value: unknown) => {
  const instant = valueAsString(value);
  if (!instant) return undefined;
  const milliseconds = Date.parse(instant);
  if (!Number.isFinite(milliseconds)) return undefined;
  return new Date(milliseconds).toISOString() === instant
    ? { instant, milliseconds }
    : undefined;
};

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
      const keyMigration = await this.client.execute({
        sql: "SELECT version FROM support_knowledge_schema_migrations WHERE version = 2",
      });
      if (!keyMigration.rows[0]) {
        const tx = await this.client.transaction("write");
        try {
          // Older NUL-delimited bindings were truncated by the SQLite client.
          // Re-key every generation from its independently persisted fields,
          // then retain each legacy serving pointer under that generation's
          // exact account tuple. A pointer that was already re-keyed wins.
          const generations = await tx.execute(
            "SELECT id, tenant_id, provider_kind, provider_account_id FROM support_knowledge_generations",
          );
          for (const row of generations.rows) {
            const value = row as Record<string, unknown>;
            await tx.execute({
              sql: "UPDATE support_knowledge_generations SET account_key = ? WHERE id = ?",
              args: [
                knowledgeAccountKey({
                  tenantId: String(value.tenant_id),
                  providerKind: String(
                    value.provider_kind,
                  ) as ProviderBinding["providerKind"],
                  providerAccountId: String(value.provider_account_id),
                  externalConversationId: "knowledge-publication-migration",
                }),
                String(value.id),
              ],
            });
          }
          const publications = await tx.execute(
            "SELECT p.account_key AS legacy_key, p.generation_id, p.revision, p.published_at, g.tenant_id, g.provider_kind, g.provider_account_id FROM support_knowledge_publications p JOIN support_knowledge_generations g ON g.id = p.generation_id",
          );
          for (const row of publications.rows) {
            const value = row as Record<string, unknown>;
            const key = knowledgeAccountKey({
              tenantId: String(value.tenant_id),
              providerKind: String(
                value.provider_kind,
              ) as ProviderBinding["providerKind"],
              providerAccountId: String(value.provider_account_id),
              externalConversationId: "knowledge-publication-migration",
            });
            const legacyKey = String(value.legacy_key);
            if (legacyKey === key) continue;
            const existing = await tx.execute({
              sql: "SELECT generation_id FROM support_knowledge_publications WHERE account_key = ?",
              args: [key],
            });
            if (!existing.rows[0])
              await tx.execute({
                sql: "INSERT INTO support_knowledge_publications(account_key, generation_id, revision, published_at) VALUES (?, ?, ?, ?)",
                args: [
                  key,
                  String(value.generation_id),
                  Number(value.revision),
                  String(value.published_at),
                ],
              });
            await tx.execute({
              sql: "DELETE FROM support_knowledge_publications WHERE account_key = ?",
              args: [legacyKey],
            });
          }
          await tx.execute({
            sql: "INSERT INTO support_knowledge_schema_migrations(version, applied_at) VALUES (2, ?)",
            args: [new Date().toISOString()],
          });
          await tx.commit();
        } catch (error) {
          try {
            await tx.rollback();
          } catch {}
          throw error;
        }
      }
      const manifestMigration = await this.client.execute({
        sql: "SELECT version FROM support_knowledge_schema_migrations WHERE version = 3",
      });
      if (!manifestMigration.rows[0]) {
        const tx = await this.client.transaction("write");
        try {
          // This is intentionally additive. Existing generations are given a
          // deterministic snapshot of their current authoritative rows, so a
          // valid historical generation remains eligible for rollback.
          await tx.execute(
            "ALTER TABLE support_knowledge_generations ADD COLUMN expected_document_count INTEGER",
          );
          await tx.execute(
            "ALTER TABLE support_knowledge_generations ADD COLUMN manifest_hash TEXT",
          );
          const generations = await tx.execute(
            "SELECT id, tenant_id, provider_kind, provider_account_id FROM support_knowledge_generations",
          );
          for (const row of generations.rows) {
            const generation = row as Record<string, unknown>;
            const documents = await tx.execute({
              sql: "SELECT source, title, text, version, document_hash, effective_at, indexed_at, expires_at FROM support_knowledge_documents WHERE generation_id = ?",
              args: [String(generation.id)],
            });
            const binding = {
              tenantId: String(generation.tenant_id),
              providerKind: String(
                generation.provider_kind,
              ) as ProviderBinding["providerKind"],
              providerAccountId: String(generation.provider_account_id),
            };
            const manifestDocuments = documents.rows.map((document) =>
              documentFromRow(document as Record<string, unknown>),
            );
            await tx.execute({
              sql: "UPDATE support_knowledge_generations SET expected_document_count = ?, manifest_hash = ? WHERE id = ?",
              args: [
                manifestDocuments.length,
                manifestHashFor(binding, manifestDocuments),
                String(generation.id),
              ],
            });
          }
          await tx.execute({
            sql: "INSERT INTO support_knowledge_schema_migrations(version, applied_at) VALUES (3, ?)",
            args: [new Date().toISOString()],
          });
          await tx.commit();
        } catch (error) {
          try {
            await tx.rollback();
          } catch {}
          throw error;
        }
      }
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
    const sourceVersionPayloads = new Map<string, string>();
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
      const documentHash = documentHashFor(
        document.source,
        document.version,
        document.text,
      );
      const identity = `${document.source}\u0000${documentHash}`;
      if (seen.has(identity))
        throw new Error("Knowledge candidate has duplicate document identity.");
      const priorVersion = sourceVersions.get(document.source);
      if (priorVersion && priorVersion !== document.version)
        throw new Error("Knowledge candidate has conflicting source versions.");
      const sourceVersionIdentity = JSON.stringify([
        document.source,
        document.version,
      ]);
      const payload = JSON.stringify([
        document.title,
        document.text,
        new Date(effectiveAt).toISOString(),
        expiresAt === undefined ? null : new Date(expiresAt).toISOString(),
      ]);
      const priorPayload = sourceVersionPayloads.get(sourceVersionIdentity);
      if (priorPayload && priorPayload !== payload)
        throw new Error(
          "Knowledge candidate has conflicting source/version payload.",
        );
      seen.add(identity);
      sourceVersions.set(document.source, document.version);
      sourceVersionPayloads.set(sourceVersionIdentity, payload);
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
    const indexedAt = now;
    const manifestDocuments = candidates.map((document) => ({
      ...document,
      indexedAt,
    }));
    const manifestHash = manifestHashFor(binding, manifestDocuments);
    const tx = await this.client.transaction("write");
    try {
      await tx.execute({
        sql: "INSERT INTO support_knowledge_generations(id, account_key, tenant_id, provider_kind, provider_account_id, state, created_at, base_revision, expected_document_count, manifest_hash) VALUES (?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?)",
        args: [
          generationId,
          knowledgeAccountKey(binding),
          binding.tenantId,
          binding.providerKind,
          binding.providerAccountId,
          now,
          base.revision,
          manifestDocuments.length,
          manifestHash,
        ],
      });
      for (const document of manifestDocuments)
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
            document.indexedAt,
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
    const key = knowledgeAccountKey(binding);
    const tx = await this.client.transaction("write");
    try {
      const candidate = await tx.execute({
        sql: "SELECT id, account_key, tenant_id, provider_kind, provider_account_id, state, expected_document_count, manifest_hash FROM support_knowledge_generations WHERE id = ?",
        args: [generationId],
      });
      const candidateRow = candidate.rows[0] as
        Record<string, unknown> | undefined;
      if (
        !(["candidate", "rolled_back"] as const).includes(
          candidateRow?.state as "candidate" | "rolled_back",
        )
      )
        throw new Error("Knowledge candidate is not publishable.");
      if (
        candidateRow?.account_key !== key ||
        candidateRow.tenant_id !== binding.tenantId ||
        candidateRow.provider_kind !== binding.providerKind ||
        candidateRow.provider_account_id !== binding.providerAccountId
      )
        throw new Error("Knowledge candidate has an invalid durable binding.");
      const expectedCount = Number(candidateRow.expected_document_count);
      const expectedManifest = valueAsString(candidateRow.manifest_hash);
      if (
        !Number.isSafeInteger(expectedCount) ||
        expectedCount <= 0 ||
        !expectedManifest ||
        !/^[0-9a-f]{64}$/.test(expectedManifest)
      )
        throw new Error("Knowledge candidate has no valid immutable manifest.");
      const now = new Date().toISOString();
      const nowMilliseconds = Date.parse(now);
      const documents = await tx.execute({
        sql: "SELECT generation_id, source, title, text, version, document_hash, effective_at, indexed_at, expires_at, provider_kind, provider_account_id FROM support_knowledge_documents WHERE generation_id = ?",
        args: [generationId],
      });
      if (documents.rows.length !== expectedCount)
        throw new Error(
          "Knowledge candidate has incomplete or inactive source evidence (or altered integrity metadata).",
        );
      const seen = new Set<string>();
      const sourceVersions = new Map<string, string>();
      const sourceVersionPayloads = new Map<string, string>();
      const manifestDocuments: ManifestDocument[] = [];
      for (const row of documents.rows) {
        const document = row as Record<string, unknown>;
        const source = valueAsString(document.source);
        const title = valueAsString(document.title);
        const text = valueAsString(document.text);
        const version = valueAsString(document.version);
        const documentHash = valueAsString(document.document_hash);
        const effective = canonicalInstant(document.effective_at);
        const indexed = canonicalInstant(document.indexed_at);
        const expires =
          document.expires_at === null || document.expires_at === undefined
            ? undefined
            : canonicalInstant(document.expires_at);
        if (
          document.generation_id !== generationId ||
          !source ||
          !title ||
          !text ||
          !version ||
          !documentHash ||
          !effective ||
          !indexed ||
          (document.expires_at !== null &&
            document.expires_at !== undefined &&
            !expires) ||
          effective.milliseconds > nowMilliseconds ||
          indexed.milliseconds > nowMilliseconds ||
          (expires &&
            (expires.milliseconds <= effective.milliseconds ||
              expires.milliseconds <= nowMilliseconds)) ||
          document.provider_kind !== binding.providerKind ||
          document.provider_account_id !== binding.providerAccountId ||
          documentHash !== documentHashFor(source, version, text)
        )
          throw new Error(
            "Knowledge candidate has incomplete or inactive source evidence (or altered integrity metadata).",
          );
        const identity = `${source}\u0000${documentHash}`;
        if (seen.has(identity))
          throw new Error(
            "Knowledge candidate has incomplete or inactive source evidence (or altered integrity metadata).",
          );
        const priorVersion = sourceVersions.get(source);
        if (priorVersion && priorVersion !== version)
          throw new Error(
            "Knowledge candidate has incomplete or inactive source evidence (or altered integrity metadata).",
          );
        const sourceVersionIdentity = JSON.stringify([source, version]);
        const payload = JSON.stringify([
          title,
          text,
          effective.instant,
          expires?.instant ?? null,
        ]);
        const priorPayload = sourceVersionPayloads.get(sourceVersionIdentity);
        if (priorPayload && priorPayload !== payload)
          throw new Error(
            "Knowledge candidate has incomplete or inactive source evidence (or altered integrity metadata).",
          );
        seen.add(identity);
        sourceVersions.set(source, version);
        sourceVersionPayloads.set(sourceVersionIdentity, payload);
        manifestDocuments.push({
          source,
          title,
          text,
          version,
          documentHash,
          effectiveAt: effective.instant,
          indexedAt: indexed.instant,
          expiresAt: expires?.instant,
        });
      }
      if (manifestHashFor(binding, manifestDocuments) !== expectedManifest)
        throw new Error(
          "Knowledge candidate has incomplete or inactive source evidence (or altered integrity metadata).",
        );
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
      args: [knowledgeAccountKey(binding)],
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
      args: [generationId, source, documentHash, knowledgeAccountKey(binding)],
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
