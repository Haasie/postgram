import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createEnrichmentWorker } from '../../src/services/enrichment-worker.js';
import { MAX_CONSECUTIVE_RATE_LIMITS } from '../../src/services/rate-limit-backoff.js';
import { createEmbeddingService } from '../../src/services/embedding-service.js';
import { recallEntity, storeEntity } from '../../src/services/entity-service.js';
import type { AuthContext } from '../../src/auth/types.js';
import { AppError, ErrorCode, RateLimitError } from '../../src/util/errors.js';
import {
  createTestDatabase,
  resetTestDatabase,
  seedApiKey,
  type TestDatabase
} from '../helpers/postgres.js';

function makeAuthContext(): AuthContext {
  return {
    apiKeyId: '00000000-0000-0000-0000-000000000103',
    keyName: 'worker-key',
    clientId: 'worker-key',
    scopes: ['read', 'write', 'delete'],
    allowedTypes: null,
    allowedVisibility: ['personal', 'work', 'shared']
  };
}

describe('enrichment-worker', () => {
  let database: TestDatabase | undefined;

  beforeAll(async () => {
    database = await createTestDatabase();
  }, 120_000);

  beforeEach(async () => {
    if (!database) {
      throw new Error('test database not initialized');
    }

    await resetTestDatabase(database.pool);
    await seedApiKey(database.pool, {
      id: '00000000-0000-0000-0000-000000000103',
      name: 'worker-key'
    });
  });

  afterAll(async () => {
    if (database) {
      await database.close();
    }
  });

  it('processes pending entities into chunks and marks them completed', async () => {
    if (!database) {
      throw new Error('test database not initialized');
    }

    const stored = (await storeEntity(database.pool, makeAuthContext(), {
      type: 'memory',
      content: 'pgvector lets postgres do vector search without a separate service'
    }))._unsafeUnwrap();

    const worker = createEnrichmentWorker({
      pool: database.pool,
      embeddingService: createEmbeddingService()
    });

    const { processed } = await worker.runOnce();
    expect(processed).toBe(1);

    const recalled = await recallEntity(
      database.pool,
      makeAuthContext(),
      stored.id
    );
    expect(recalled.isOk()).toBe(true);
    expect(recalled._unsafeUnwrap().enrichmentStatus).toBe('completed');

    const chunkRows = await database.pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM chunks WHERE entity_id = $1',
      [stored.id]
    );
    expect(Number(chunkRows.rows[0]?.count ?? '0')).toBeGreaterThan(0);
  }, 120_000);

  it('marks entities failed when embedding generation fails', async () => {
    if (!database) {
      throw new Error('test database not initialized');
    }

    const stored = (await storeEntity(database.pool, makeAuthContext(), {
      type: 'memory',
      content: 'this enrichment should fail'
    }))._unsafeUnwrap();

    const worker = createEnrichmentWorker({
      pool: database.pool,
      embeddingService: createEmbeddingService({
        embedBatch: () =>
          Promise.reject(
            new AppError(
            ErrorCode.EMBEDDING_FAILED,
            'forced embedding failure'
            )
          )
      })
    });

    const { processed } = await worker.runOnce();
    expect(processed).toBe(1);

    const recalled = await recallEntity(
      database.pool,
      makeAuthContext(),
      stored.id
    );
    expect(recalled.isOk()).toBe(true);
    expect(recalled._unsafeUnwrap().enrichmentStatus).toBe('failed');
  }, 120_000);

  it('retries failed entities and stops after max attempts', async () => {
    if (!database) {
      throw new Error('test database not initialized');
    }

    const stored = (await storeEntity(database.pool, makeAuthContext(), {
      type: 'memory',
      content: 'this entity will keep failing'
    }))._unsafeUnwrap();

    const failingWorker = createEnrichmentWorker({
      pool: database.pool,
      embeddingService: createEmbeddingService({
        embedBatch: () =>
          Promise.reject(
            new AppError(ErrorCode.EMBEDDING_FAILED, 'always fails')
          )
      })
    });

    // First failure
    await failingWorker.runOnce();
    let row = await database.pool.query<{ enrichment_status: string; enrichment_attempts: number }>(
      'SELECT enrichment_status, enrichment_attempts FROM entities WHERE id = $1',
      [stored.id]
    );
    expect(row.rows[0]?.enrichment_status).toBe('failed');
    expect(row.rows[0]?.enrichment_attempts).toBe(1);

    // Simulate 5-minute backoff by updating updated_at (disable trigger to bypass auto-update)
    await database.pool.query('ALTER TABLE entities DISABLE TRIGGER trg_entities_updated_at');
    await database.pool.query(
      "UPDATE entities SET updated_at = now() - interval '10 minutes' WHERE id = $1",
      [stored.id]
    );
    await database.pool.query('ALTER TABLE entities ENABLE TRIGGER trg_entities_updated_at');

    // Second failure
    await failingWorker.runOnce();
    row = await database.pool.query(
      'SELECT enrichment_status, enrichment_attempts FROM entities WHERE id = $1',
      [stored.id]
    );
    expect(row.rows[0]?.enrichment_attempts).toBe(2);

    // Simulate backoff again
    await database.pool.query('ALTER TABLE entities DISABLE TRIGGER trg_entities_updated_at');
    await database.pool.query(
      "UPDATE entities SET updated_at = now() - interval '10 minutes' WHERE id = $1",
      [stored.id]
    );
    await database.pool.query('ALTER TABLE entities ENABLE TRIGGER trg_entities_updated_at');

    // Third failure — should be final
    await failingWorker.runOnce();
    row = await database.pool.query(
      'SELECT enrichment_status, enrichment_attempts FROM entities WHERE id = $1',
      [stored.id]
    );
    expect(row.rows[0]?.enrichment_attempts).toBe(3);

    // Simulate backoff again
    await database.pool.query('ALTER TABLE entities DISABLE TRIGGER trg_entities_updated_at');
    await database.pool.query(
      "UPDATE entities SET updated_at = now() - interval '10 minutes' WHERE id = $1",
      [stored.id]
    );
    await database.pool.query('ALTER TABLE entities ENABLE TRIGGER trg_entities_updated_at');

    // Fourth run — should NOT pick up the entity (max 3 attempts reached)
    const { processed } = await failingWorker.runOnce();
    expect(processed).toBe(0);
  }, 120_000);

  it('does not queue auto-created entities for extraction', async () => {
    if (!database) {
      throw new Error('test database not initialized');
    }

    // Stub auto-created entity, as if produced by extraction-service.
    const inserted = await database.pool.query<{ id: string }>(
      `INSERT INTO entities (type, content, visibility, enrichment_status, tags, metadata)
       VALUES ('person', 'Alice', 'shared', 'pending', ARRAY['auto-created'], '{}'::jsonb)
       RETURNING id`
    );
    const autoId = inserted.rows[0]!.id;

    // And a regular entity, to confirm the normal path still queues extraction.
    const normal = (await storeEntity(database.pool, makeAuthContext(), {
      type: 'document',
      content: 'normal entity that should get extracted'
    }))._unsafeUnwrap();

    const worker = createEnrichmentWorker({
      pool: database.pool,
      embeddingService: createEmbeddingService(),
      extractionEnabled: true,
      callLlm: () => Promise.resolve('[]')
    });

    await worker.runOnce();
    await worker.runOnce();

    const rows = await database.pool.query<{
      id: string;
      enrichment_status: string;
      extraction_status: string | null;
    }>(
      'SELECT id, enrichment_status, extraction_status FROM entities WHERE id = ANY($1)',
      [[autoId, normal.id]]
    );
    const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r]));

    // Auto-created: embedded, but NOT pushed into the extraction queue —
    // extraction_status must stay NULL so the loop terminates.
    expect(byId[autoId]?.enrichment_status).toBe('completed');
    expect(byId[autoId]?.extraction_status).toBeNull();

    // Normal entity: embedded AND processed by extraction (LLM returned [],
    // so it transitions pending → completed in the same pass).
    expect(byId[normal.id]?.enrichment_status).toBe('completed');
    expect(byId[normal.id]?.extraction_status).toBe('completed');
  }, 120_000);

  it('embeds session-context memory but does not queue graph extraction', async () => {
    if (!database) {
      throw new Error('test database not initialized');
    }

    const stored = (await storeEntity(database.pool, makeAuthContext(), {
      type: 'memory',
      content: 'Session context about Postgram memory lifecycle roles.',
      visibility: 'personal',
      metadata: {
        memory_role: 'session_context',
        session_scope: { kind: 'client', client_id: 'codex' }
      }
    }))._unsafeUnwrap();

    const worker = createEnrichmentWorker({
      pool: database.pool,
      embeddingService: createEmbeddingService(),
      extractionEnabled: true,
      callLlm: () => Promise.resolve('[]')
    });

    await worker.runOnce();

    const entity = await database.pool.query<{
      enrichment_status: string;
      extraction_status: string | null;
    }>(
      'SELECT enrichment_status, extraction_status FROM entities WHERE id = $1',
      [stored.id]
    );
    const chunks = await database.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM chunks WHERE entity_id = $1',
      [stored.id]
    );

    expect(entity.rows[0]).toEqual({
      enrichment_status: 'completed',
      extraction_status: null
    });
    expect(chunks.rows[0]?.count).toBeGreaterThan(0);
  }, 120_000);

  it('embeds durable memory without graph extraction by default', async () => {
    if (!database) {
      throw new Error('test database not initialized');
    }

    const stored = (await storeEntity(database.pool, makeAuthContext(), {
      type: 'memory',
      content: 'Durable memory about Postgram extraction policy.',
      visibility: 'personal',
      metadata: {
        memory_role: 'durable_memory'
      }
    }))._unsafeUnwrap();

    let llmCalls = 0;
    const worker = createEnrichmentWorker({
      pool: database.pool,
      embeddingService: createEmbeddingService(),
      extractionEnabled: true,
      callLlm: () => {
        llmCalls += 1;
        return Promise.resolve('[]');
      }
    });

    await worker.runOnce();

    const entity = await database.pool.query<{
      enrichment_status: string;
      extraction_status: string | null;
    }>(
      'SELECT enrichment_status, extraction_status FROM entities WHERE id = $1',
      [stored.id]
    );
    const chunks = await database.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM chunks WHERE entity_id = $1',
      [stored.id]
    );

    expect(entity.rows[0]).toEqual({
      enrichment_status: 'completed',
      extraction_status: null
    });
    expect(chunks.rows[0]?.count).toBeGreaterThan(0);
    expect(llmCalls).toBe(0);
  }, 120_000);

  it('can opt durable memory back into graph extraction', async () => {
    if (!database) {
      throw new Error('test database not initialized');
    }

    const stored = (await storeEntity(database.pool, makeAuthContext(), {
      type: 'memory',
      content: 'Durable memory that should be graph extracted.',
      visibility: 'personal',
      metadata: {
        memory_role: 'durable_memory'
      }
    }))._unsafeUnwrap();

    const worker = createEnrichmentWorker({
      pool: database.pool,
      embeddingService: createEmbeddingService(),
      extractionEnabled: true,
      extractionMemoryMode: 'extract_durable',
      callLlm: () => Promise.resolve('[]')
    });

    await worker.runOnce();

    const entity = await database.pool.query<{
      enrichment_status: string;
      extraction_status: string | null;
    }>(
      'SELECT enrichment_status, extraction_status FROM entities WHERE id = $1',
      [stored.id]
    );

    expect(entity.rows[0]).toEqual({
      enrichment_status: 'completed',
      extraction_status: 'completed'
    });
  }, 120_000);

  it('clears already-pending memory extraction when memory extraction is disabled by default', async () => {
    if (!database) {
      throw new Error('test database not initialized');
    }

    const stored = (await storeEntity(database.pool, makeAuthContext(), {
      type: 'memory',
      content: 'Durable memory that was queued before the default policy changed.',
      visibility: 'personal',
      metadata: {
        memory_role: 'durable_memory'
      }
    }))._unsafeUnwrap();
    await database.pool.query(
      `UPDATE entities
       SET enrichment_status = 'completed',
           extraction_status = 'pending'
       WHERE id = $1`,
      [stored.id]
    );

    let llmCalls = 0;
    const worker = createEnrichmentWorker({
      pool: database.pool,
      embeddingService: createEmbeddingService(),
      extractionEnabled: true,
      callLlm: () => {
        llmCalls += 1;
        return Promise.resolve('[]');
      }
    });

    const { processed } = await worker.runOnce();

    const entity = await database.pool.query<{
      extraction_status: string | null;
      extraction_error: string | null;
    }>(
      'SELECT extraction_status, extraction_error FROM entities WHERE id = $1',
      [stored.id]
    );

    expect(processed).toBe(1);
    expect(entity.rows[0]).toEqual({
      extraction_status: null,
      extraction_error: null
    });
    expect(llmCalls).toBe(0);
  }, 120_000);

  it('preserves skipped extraction while embedding entities', async () => {
    if (!database) {
      throw new Error('test database not initialized');
    }

    const skipped = (await storeEntity(database.pool, makeAuthContext(), {
      type: 'interaction',
      content: 'imported transcript that should become searchable without graph extraction',
      skipExtraction: true
    } as never))._unsafeUnwrap();

    const worker = createEnrichmentWorker({
      pool: database.pool,
      embeddingService: createEmbeddingService(),
      extractionEnabled: true,
      callLlm: () => Promise.resolve('[]')
    });

    const { processed } = await worker.runOnce();
    expect(processed).toBe(1);

    const rows = await database.pool.query<{
      enrichment_status: string | null;
      extraction_status: string | null;
      chunks: string;
    }>(
      `
        SELECT e.enrichment_status,
               e.extraction_status,
               COUNT(c.id)::text AS chunks
        FROM entities e
        LEFT JOIN chunks c ON c.entity_id = e.id
        WHERE e.id = $1
        GROUP BY e.id
      `,
      [skipped.id]
    );

    expect(rows.rows[0]).toMatchObject({
      enrichment_status: 'completed',
      extraction_status: 'skipped'
    });
    expect(Number(rows.rows[0]?.chunks ?? '0')).toBeGreaterThan(0);
  }, 120_000);

  it('uses per-entity LLM override (model+provider) when columns are set, and clears them on success', async () => {
    if (!database) {
      throw new Error('test database not initialized');
    }

    // Two entities both queued for extraction. Only one has an override set
    // — verifies the worker dispatches per-row, not in batch.
    const overridden = (await storeEntity(database.pool, makeAuthContext(), {
      type: 'document',
      content: 'entity that should be extracted with the override model'
    }))._unsafeUnwrap();
    const defaulted = (await storeEntity(database.pool, makeAuthContext(), {
      type: 'document',
      content: 'entity that should be extracted with the default model'
    }))._unsafeUnwrap();
    await database.pool.query(
      `UPDATE entities
       SET extraction_model_override = 'claude-sonnet-4-6',
           extraction_provider_override = 'anthropic'
       WHERE id = $1`,
      [overridden.id]
    );

    const factoryCalls: Array<{ provider: string | null; model: string | null }> = [];
    const callLlmDefault = () => Promise.resolve('[]');
    const factory = (provider: string | null, model: string | null) => {
      factoryCalls.push({ provider, model });
      return () => Promise.resolve('[]');
    };

    const worker = createEnrichmentWorker({
      pool: database.pool,
      embeddingService: createEmbeddingService(),
      extractionEnabled: true,
      callLlm: callLlmDefault,
      callLlmFactory: factory
    });

    // Run repeatedly until both entities are processed (enrichment then
    // extraction; each pass picks one).
    for (let i = 0; i < 8 && (await worker.runOnce()).processed > 0; i++) {
      // loop body intentionally empty
    }

    const rows = await database.pool.query<{
      id: string;
      extraction_status: string | null;
      extraction_model_override: string | null;
      extraction_provider_override: string | null;
    }>(
      `SELECT id, extraction_status, extraction_model_override, extraction_provider_override
       FROM entities WHERE id = ANY($1)`,
      [[overridden.id, defaulted.id]]
    );
    const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r]));

    expect(byId[overridden.id]?.extraction_status).toBe('completed');
    // Cleared on success so the next reextract pass uses env defaults.
    expect(byId[overridden.id]?.extraction_model_override).toBeNull();
    expect(byId[overridden.id]?.extraction_provider_override).toBeNull();

    expect(byId[defaulted.id]?.extraction_status).toBe('completed');
    // Defaulted entity never touched the override columns.
    expect(byId[defaulted.id]?.extraction_model_override).toBeNull();
    expect(byId[defaulted.id]?.extraction_provider_override).toBeNull();

    // The factory should have been called exactly once for the override —
    // the cache reuses the closure for any further entities sharing
    // (anthropic, claude-sonnet-4-6). The defaulted entity should have used
    // options.callLlm directly (no factory call).
    const overrideCalls = factoryCalls.filter(
      (c) =>
        c.provider === 'anthropic' && c.model === 'claude-sonnet-4-6'
    );
    expect(overrideCalls).toHaveLength(1);
  }, 120_000);

  it('does not process the same entity twice when workers run concurrently', async () => {
    if (!database) {
      throw new Error('test database not initialized');
    }

    await storeEntity(database.pool, makeAuthContext(), {
      type: 'memory',
      content: 'only one worker should process this'
    });

    const delayedEmbeddingService = createEmbeddingService({
      embedBatch: async (texts) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return texts.map(() => new Array<number>(1536).fill(0));
      }
    });

    const workerA = createEnrichmentWorker({
      pool: database.pool,
      embeddingService: delayedEmbeddingService
    });
    const workerB = createEnrichmentWorker({
      pool: database.pool,
      embeddingService: delayedEmbeddingService
    });

    const processed = await Promise.all([
      workerA.runOnce(),
      workerB.runOnce()
    ]);

    expect(processed.map((r) => r.processed).sort((left, right) => left - right)).toEqual([0, 1]);
  }, 120_000);

  it('treats 429 rate-limit LLM errors as transient: leaves entity pending and returns rateLimited=true', async () => {
    if (!database) {
      throw new Error('test database not initialized');
    }

    // Store an entity and manually set it to extraction pending.
    const stored = (await storeEntity(database.pool, makeAuthContext(), {
      type: 'document',
      content: 'entity that triggers a rate limit during extraction'
    }))._unsafeUnwrap();
    await database.pool.query(
      `UPDATE entities
       SET enrichment_status = 'completed', extraction_status = 'pending'
       WHERE id = $1`,
      [stored.id]
    );

    const worker = createEnrichmentWorker({
      pool: database.pool,
      embeddingService: createEmbeddingService(),
      extractionEnabled: true,
      callLlm: () =>
        Promise.reject(
          new RateLimitError(
            'OpenAI-compatible API error: 429 - {"object":"error","message":"Rate limit exceeded","type":"rate_limited"}'
          )
        )
    });

    const result = await worker.runOnce();

    // rateLimited flag should be set.
    expect(result.rateLimited).toBe(true);

    // Entity must still be 'pending' — not 'failed' — so it is retried.
    const row = await database.pool.query<{
      extraction_status: string | null;
      extraction_error: string | null;
    }>(
      'SELECT extraction_status, extraction_error FROM entities WHERE id = $1',
      [stored.id]
    );
    expect(row.rows[0]?.extraction_status).toBe('pending');
    expect(row.rows[0]?.extraction_error).toBeNull();
  }, 120_000);

  it('does not treat a non-429 extraction error as throttling, even when the text contains 429', async () => {
    if (!database) {
      throw new Error('test database not initialized');
    }

    const stored = (await storeEntity(database.pool, makeAuthContext(), {
      type: 'document',
      content: 'entity whose extraction fails permanently'
    }))._unsafeUnwrap();
    await database.pool.query(
      `UPDATE entities
       SET enrichment_status = 'completed', extraction_status = 'pending'
       WHERE id = $1`,
      [stored.id]
    );

    const worker = createEnrichmentWorker({
      pool: database.pool,
      embeddingService: createEmbeddingService(),
      extractionEnabled: true,
      callLlm: () => Promise.reject(new Error('LLM request timed out after 4290ms'))
    });

    const result = await worker.runOnce();

    expect(result.rateLimited).toBe(false);
    const row = await database.pool.query<{
      extraction_status: string | null;
      extraction_error: string | null;
    }>(
      'SELECT extraction_status, extraction_error FROM entities WHERE id = $1',
      [stored.id]
    );
    expect(row.rows[0]?.extraction_status).toBe('failed');
    expect(row.rows[0]?.extraction_error).toContain('4290ms');
  }, 120_000);

  it('keeps serving healthy entities behind a rate-limited one (no head-of-line blocking)', async () => {
    if (!database) {
      throw new Error('test database not initialized');
    }

    const first = (await storeEntity(database.pool, makeAuthContext(), {
      type: 'document',
      content: 'oldest entity, upstream throttles it'
    }))._unsafeUnwrap();
    const second = (await storeEntity(database.pool, makeAuthContext(), {
      type: 'document',
      content: 'newer entity, extraction works fine'
    }))._unsafeUnwrap();
    await database.pool.query(
      `UPDATE entities
       SET enrichment_status = 'completed', extraction_status = 'pending'
       WHERE id = ANY($1::uuid[])`,
      [[first.id, second.id]]
    );

    const worker = createEnrichmentWorker({
      pool: database.pool,
      embeddingService: createEmbeddingService(),
      extractionEnabled: true,
      extractionMinContentChars: 0,
      callLlm: (prompt) =>
        prompt.includes('oldest entity')
          ? Promise.reject(new RateLimitError('429'))
          : Promise.resolve('[]')
    });

    const result = await worker.runOnce();

    expect(result.rateLimited).toBe(true);
    const rows = await database.pool.query<{ id: string; extraction_status: string | null }>(
      'SELECT id, extraction_status FROM entities WHERE id = ANY($1::uuid[])',
      [[first.id, second.id]]
    );
    const status = new Map(rows.rows.map((r) => [r.id, r.extraction_status]));
    expect(status.get(first.id)).toBe('pending');
    expect(status.get(second.id)).toBe('completed');
  }, 120_000);

  it('treats an embedding-phase 429 as transient: entity stays pending, attempts unchanged', async () => {
    if (!database) {
      throw new Error('test database not initialized');
    }

    const stored = (await storeEntity(database.pool, makeAuthContext(), {
      type: 'document',
      content: 'entity whose embedding call is throttled'
    }))._unsafeUnwrap();

    const worker = createEnrichmentWorker({
      pool: database.pool,
      embeddingService: createEmbeddingService({
        embedBatch: () => Promise.reject(new RateLimitError('429'))
      })
    });

    const result = await worker.runOnce();

    expect(result.rateLimited).toBe(true);
    const row = await database.pool.query<{
      enrichment_status: string;
      enrichment_attempts: number;
    }>(
      'SELECT enrichment_status, enrichment_attempts FROM entities WHERE id = $1',
      [stored.id]
    );
    expect(row.rows[0]?.enrichment_status).toBe('pending');
    expect(row.rows[0]?.enrichment_attempts).toBe(0);
  }, 120_000);

  it('counts a non-429 embedding failure whose text contains 429 as a real attempt', async () => {
    if (!database) {
      throw new Error('test database not initialized');
    }

    const stored = (await storeEntity(database.pool, makeAuthContext(), {
      type: 'document',
      content: 'entity whose embedding call breaks'
    }))._unsafeUnwrap();

    const worker = createEnrichmentWorker({
      pool: database.pool,
      embeddingService: createEmbeddingService({
        embedBatch: () =>
          Promise.reject(
            new AppError(ErrorCode.EMBEDDING_FAILED, 'expected 1, actual 1429')
          )
      })
    });

    const result = await worker.runOnce();

    expect(result.rateLimited).toBe(false);
    const row = await database.pool.query<{ enrichment_attempts: number }>(
      'SELECT enrichment_attempts FROM entities WHERE id = $1',
      [stored.id]
    );
    expect(row.rows[0]?.enrichment_attempts).toBe(1);
  }, 120_000);

  it('propagates a 429 from the semantic target match so the entity stays pending', async () => {
    if (!database) {
      throw new Error('test database not initialized');
    }

    const stored = (await storeEntity(database.pool, makeAuthContext(), {
      type: 'document',
      content: 'Meeting notes mentioning Alice and Bob in a long enough text body'
    }))._unsafeUnwrap();
    await database.pool.query(
      `UPDATE entities
       SET enrichment_status = 'completed', extraction_status = 'pending'
       WHERE id = $1`,
      [stored.id]
    );

    const worker = createEnrichmentWorker({
      pool: database.pool,
      embeddingService: createEmbeddingService({
        embedBatch: () => Promise.reject(new RateLimitError('429'))
      }),
      extractionEnabled: true,
      extractionMinContentChars: 0,
      callLlm: () =>
        Promise.resolve(
          JSON.stringify([
            { target_name: 'Alice', target_type: 'person', relation: 'related_to', confidence: 0.9 },
            { target_name: 'Bob', target_type: 'person', relation: 'related_to', confidence: 0.9 }
          ])
        )
    });

    const result = await worker.runOnce();

    expect(result.rateLimited).toBe(true);
    const row = await database.pool.query<{
      extraction_status: string | null;
      extraction_error: string | null;
    }>(
      'SELECT extraction_status, extraction_error FROM entities WHERE id = $1',
      [stored.id]
    );
    expect(row.rows[0]?.extraction_status).toBe('pending');
    expect(row.rows[0]?.extraction_error).toBeNull();
  }, 120_000);

  describe('per-entity cooldown after a 429', () => {
    async function deferral(entityId: string, phase: 'enrichment' | 'extraction') {
      if (!database) throw new Error('test database not initialized');
      const result = await database.pool.query<{
        consecutive_rate_limits: number;
        cooling: boolean;
      }>(
        `SELECT consecutive_rate_limits, next_attempt_at > now() AS cooling
         FROM entity_rate_limit_deferrals WHERE entity_id = $1 AND phase = $2`,
        [entityId, phase]
      );
      return result.rows[0];
    }

    it('skips a throttled entity on the next poll so the queue behind it keeps moving', async () => {
      if (!database) throw new Error('test database not initialized');

      const throttled = (await storeEntity(database.pool, makeAuthContext(), {
        type: 'document',
        content: 'THROTTLED embedding input'
      }))._unsafeUnwrap();
      const healthy = (await storeEntity(database.pool, makeAuthContext(), {
        type: 'document',
        content: 'healthy embedding input'
      }))._unsafeUnwrap();

      const embedded: string[] = [];
      const worker = createEnrichmentWorker({
        pool: database.pool,
        rateLimitBackoffMs: 60_000,
        embeddingService: createEmbeddingService({
          embedBatch: (texts) => {
            if (texts.some((text) => text.includes('THROTTLED'))) {
              return Promise.reject(new RateLimitError('429'));
            }
            embedded.push(...texts);
            return Promise.resolve(texts.map(() => Array.from({ length: 1536 }, () => 0.01)));
          }
        })
      });

      const first = await worker.runOnce();
      expect(first.rateLimited).toBe(true);
      expect(await deferral(throttled.id, 'enrichment')).toEqual({
        consecutive_rate_limits: 1,
        cooling: true
      });

      const second = await worker.runOnce();
      expect(second.rateLimited).toBe(false);

      const rows = await database.pool.query<{ id: string; enrichment_status: string }>(
        'SELECT id, enrichment_status FROM entities WHERE id = ANY($1::uuid[])',
        [[throttled.id, healthy.id]]
      );
      const status = new Map(rows.rows.map((r) => [r.id, r.enrichment_status]));
      expect(status.get(throttled.id)).toBe('pending');
      expect(status.get(healthy.id)).toBe('completed');
      expect(embedded.some((text) => text.includes('THROTTLED'))).toBe(false);
    }, 120_000);

    it('clears the cooldown once the entity succeeds', async () => {
      if (!database) throw new Error('test database not initialized');

      const stored = (await storeEntity(database.pool, makeAuthContext(), {
        type: 'document',
        content: 'recovers after throttling'
      }))._unsafeUnwrap();
      await database.pool.query(
        `INSERT INTO entity_rate_limit_deferrals (entity_id, phase, consecutive_rate_limits, next_attempt_at)
         VALUES ($1, 'enrichment', 3, now() - interval '1 second')`,
        [stored.id]
      );

      const worker = createEnrichmentWorker({
        pool: database.pool,
        embeddingService: createEmbeddingService()
      });
      await worker.runOnce();

      expect(await deferral(stored.id, 'enrichment')).toBeUndefined();
      const row = await database.pool.query<{ enrichment_status: string }>(
        'SELECT enrichment_status FROM entities WHERE id = $1',
        [stored.id]
      );
      expect(row.rows[0]?.enrichment_status).toBe('completed');
    }, 120_000);

    it('turns an unbroken series of 429s into one counted failure', async () => {
      if (!database) throw new Error('test database not initialized');

      const stored = (await storeEntity(database.pool, makeAuthContext(), {
        type: 'document',
        content: 'permanently throttled'
      }))._unsafeUnwrap();
      await database.pool.query(
        `INSERT INTO entity_rate_limit_deferrals (entity_id, phase, consecutive_rate_limits, next_attempt_at)
         VALUES ($1, 'enrichment', $2, now() - interval '1 second')`,
        [stored.id, MAX_CONSECUTIVE_RATE_LIMITS - 1]
      );

      const worker = createEnrichmentWorker({
        pool: database.pool,
        embeddingService: createEmbeddingService({
          embedBatch: () => Promise.reject(new RateLimitError('429'))
        })
      });
      const result = await worker.runOnce();

      expect(result.rateLimited).toBe(true);
      const row = await database.pool.query<{
        enrichment_status: string;
        enrichment_attempts: number;
        enrichment_error: string | null;
      }>(
        'SELECT enrichment_status, enrichment_attempts, enrichment_error FROM entities WHERE id = $1',
        [stored.id]
      );
      expect(row.rows[0]?.enrichment_status).toBe('failed');
      expect(row.rows[0]?.enrichment_attempts).toBe(1);
      expect(row.rows[0]?.enrichment_error).toContain(
        `rate limited ${MAX_CONSECUTIVE_RATE_LIMITS} times in a row`
      );
      expect(await deferral(stored.id, 'enrichment')).toBeUndefined();
    }, 120_000);

    it('does not call the LLM again for an extraction entity that is cooling down', async () => {
      if (!database) throw new Error('test database not initialized');

      const stored = (await storeEntity(database.pool, makeAuthContext(), {
        type: 'document',
        content: 'extraction gets throttled'
      }))._unsafeUnwrap();
      await database.pool.query(
        `UPDATE entities
         SET enrichment_status = 'completed', extraction_status = 'pending'
         WHERE id = $1`,
        [stored.id]
      );

      let llmCalls = 0;
      const worker = createEnrichmentWorker({
        pool: database.pool,
        embeddingService: createEmbeddingService(),
        extractionEnabled: true,
        extractionMinContentChars: 0,
        rateLimitBackoffMs: 60_000,
        callLlm: () => {
          llmCalls += 1;
          return Promise.reject(new RateLimitError('429'));
        }
      });

      expect((await worker.runOnce()).rateLimited).toBe(true);
      expect(await deferral(stored.id, 'extraction')).toEqual({
        consecutive_rate_limits: 1,
        cooling: true
      });

      expect((await worker.runOnce()).rateLimited).toBe(false);
      expect(llmCalls).toBe(1);
      const row = await database.pool.query<{ extraction_status: string | null }>(
        'SELECT extraction_status FROM entities WHERE id = $1',
        [stored.id]
      );
      expect(row.rows[0]?.extraction_status).toBe('pending');
    }, 120_000);
  });
});
