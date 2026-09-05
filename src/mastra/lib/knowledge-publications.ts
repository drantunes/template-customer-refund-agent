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
        CREATE TABLE IF NOT EXISTS support_knowledge_generations (
          id TEXT PRIMARY KEY, account_key TEXT NOT NULL, tenant_id TEXT NOT NULL,
          provider_kind TEXT NOT NULL, provider_account_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('candidate','active','rolled_back','failed')),
          created_at TEXT NOT NULL, activated_at TEXT, replaced_generation_id TEXT,
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
    })();
    await this.ready;
  }

  async buildCandidate(
    binding: ProviderBinding,
    documents: KnowledgeEvidence[],
  ) {
    await this.ensured();
    if (documents.length === 0)
      throw new Error("Knowledge candidate has no documents.");
    const now = new Date().toISOString();
    const generationId = `knowledge_${crypto.randomUUID()}`;
    const seen = new Set<string>();
    const candidates: Candidate[] = documents.map((document) => {
      if (
        !document.source ||
        !document.title ||
        !document.text ||
        !document.version
      )
        throw new Error("Knowledge candidate has incomplete provenance.");
      const documentHash = createHash("sha256")
        .update(
          JSON.stringify([document.source, document.version, document.text]),
        )
        .digest("hex");
      const identity = `${document.source}\u0000${documentHash}`;
      if (seen.has(identity))
        throw new Error("Knowledge candidate has duplicate document identity.");
      seen.add(identity);
      return {
        ...document,
        documentHash,
        effectiveAt: now,
        expiresAt: undefined,
        providerKind: binding.providerKind,
        providerAccountId: binding.providerAccountId,
      };
    });
    const tx = await this.client.transaction("write");
    try {
      await tx.execute({
        sql: "INSERT INTO support_knowledge_generations(id, account_key, tenant_id, provider_kind, provider_account_id, state, created_at) VALUES (?, ?, ?, ?, ?, 'candidate', ?)",
        args: [
          generationId,
          accountKey(binding),
          binding.tenantId,
          binding.providerKind,
          binding.providerAccountId,
          now,
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
    return { generationId, indexed: candidates.length };
  }

  /** Activates only if the caller built from the still-current generation. */
  async activate(
    binding: ProviderBinding,
    generationId: string,
    expectedGenerationId?: string,
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
      if (actual !== expectedGenerationId)
        throw new Error(
          "Stale knowledge publication rejected by compare-and-set.",
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

  async activeGeneration(binding: ProviderBinding) {
    await this.ensured();
    const result = await this.client.execute({
      sql: "SELECT generation_id FROM support_knowledge_publications WHERE account_key = ?",
      args: [accountKey(binding)],
    });
    return result.rows[0]?.generation_id as string | undefined;
  }

  async rollback(binding: ProviderBinding, generationId: string) {
    await this.ensured();
    const current = await this.activeGeneration(binding);
    return this.activate(binding, generationId, current);
  }

  async search(
    binding: ProviderBinding,
    query: string,
    topK: number,
  ): Promise<PublishedEvidence[]> {
    await this.ensured();
    const generationId = await this.activeGeneration(binding);
    if (!generationId) return [];
    const rows = await this.client.execute({
      sql: "SELECT * FROM support_knowledge_documents WHERE generation_id = ? AND (expires_at IS NULL OR expires_at > ?)",
      args: [generationId, new Date().toISOString()],
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
}

export const knowledgePublicationStore = new KnowledgePublicationStore();
