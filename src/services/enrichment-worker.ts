import type { Logger } from 'pino';
import type { Pool, PoolClient } from 'pg';

import type { AuthContext } from '../auth/types.js';
import { isRateLimitError } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { chunkText } from './chunking-service.js';
import {
  createEmbeddingService,
  type EmbeddingService
} from './embedding-service.js';
import {
  extractAndLinkRelationships,
  SemanticMatchUnavailableError
} from './extraction-service.js';
import { getMemoryRole } from './memory-role-service.js';
import {
  MAX_CONSECUTIVE_RATE_LIMITS,
  rateLimitBackoffMs
} from './rate-limit-backoff.js';

type PendingEntityRow = {
  id: string;
  type: string;
  content: string;
  metadata: Record<string, unknown>;
  extraction_status: string | null;
};

type PendingExtractionRow = PendingEntityRow & {
  type: string;
  visibility: string;
  owner: string | null;
  extraction_model_override: string | null;
  extraction_provider_override: string | null;
};

type CallLlm = (prompt: string, schema?: object) => Promise<string>;

/**
 * Factory used when an entity has an `extraction_model_override` or
 * `extraction_provider_override` set — typically by `pgm-admin
 * improve-graph --model X --provider Y`. Returning a function that builds a
 * `callLlm` lets the worker swap models per-entity without rebuilding
 * provider state on every call (the worker caches the result by
 * `provider:model`). When neither override is set the worker falls back to
 * `options.callLlm` (the env-configured default), so existing tests and
 * deployments don't need to provide a factory.
 */
type CallLlmFactory = (
  provider: string | null,
  model: string | null
) => CallLlm;

export type ExtractionMemoryMode =
  | 'embed_only'
  | 'extract_durable'
  | 'extract_all';

type EnrichmentWorkerOptions = {
  pool: Pool;
  embeddingService?: EmbeddingService;
  extractionEnabled?: boolean;
  extractionMemoryMode?: ExtractionMemoryMode | undefined;
  callLlm?: CallLlm | undefined;
  callLlmFactory?: CallLlmFactory | undefined;
  logger?: Logger;
  autoCreate?: {
    enabled: boolean;
    types: readonly string[];
    minConfidence: number;
    minConfidenceByType?: Readonly<Record<string, number>> | undefined;
  };
  extractionMatchMinSimilarity?: number;
  extractionMinContentChars?: number;
  /**
   * When true, the worker passes a debug callback to extraction that logs
   * raw LLM responses and per-target decisions at info level. Used to
   * diagnose "no person entities" / "edges look wrong" without redeploying
   * with LOG_LEVEL=debug (which is much noisier).
   */
  extractionDebugLog?: boolean;
  semanticNeighbors?: {
    enabled: boolean;
    maxNeighbors?: number;
    minSimilarity?: number;
  };
  /**
   * Base of the per-entity cooldown after an upstream 429
   * (EXTRACTION_RATE_LIMIT_BACKOFF_MS). Defaults to 60s; 0 disables it.
   */
  rateLimitBackoffMs?: number;
};

type RateLimitPhase = 'enrichment' | 'extraction';

// Rows still cooling down after a 429 are invisible to the pickers below.
const NOT_COOLING_DOWN = (phase: RateLimitPhase) => `
  NOT EXISTS (
    SELECT 1
    FROM entity_rate_limit_deferrals d
    WHERE d.entity_id = entities.id
      AND d.phase = '${phase}'
      AND d.next_attempt_at > now()
  )`;

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original failure if rollback itself fails.
  }
}

const MAX_ERROR_LENGTH = 2000;

function truncateErrorMessage(error: unknown): string {
  let raw: string;
  if (error instanceof Error) {
    raw = error.message;
  } else if (typeof error === 'string') {
    raw = error;
  } else if (error === null || error === undefined) {
    raw = 'unknown error';
  } else {
    try {
      raw = JSON.stringify(error) ?? 'unknown error';
    } catch {
      raw = 'unknown error';
    }
  }
  return raw.length > MAX_ERROR_LENGTH
    ? `${raw.slice(0, MAX_ERROR_LENGTH)}…`
    : raw;
}

function shouldQueueExtractionForEntity(input: {
  type: string;
  metadata: Record<string, unknown>;
  extractionEnabled?: boolean | undefined;
  extractionMemoryMode?: ExtractionMemoryMode | undefined;
}): boolean {
  if (!input.extractionEnabled) {
    return false;
  }

  // FORK-ONLY (Haasie/postgram): skip extraction for archived/system notes and
  // Excalidraw drawings from the Obsidian vault. Do not upstream.
  const path = typeof input.metadata?.path === 'string' ? input.metadata.path : '';
  if (
    path.startsWith('90 Archive/') ||
    path.startsWith('99 Systeem/') ||
    path.endsWith('.excalidraw.md') ||
    path.endsWith('.excalidraw')
  ) {
    return false;
  }

  if (input.type !== 'memory') {
    return true;
  }

  const mode = input.extractionMemoryMode ?? 'embed_only';
  if (mode === 'extract_all') {
    return true;
  }

  if (mode === 'extract_durable') {
    return getMemoryRole(input.metadata) === 'durable_memory';
  }

  return false;
}

export function createEnrichmentWorker(options: EnrichmentWorkerOptions) {
  if (options.extractionEnabled && !options.callLlm && !options.callLlmFactory) {
    throw new Error(
      'callLlm or callLlmFactory is required when extractionEnabled is true'
    );
  }

  const embeddingService = options.embeddingService ?? createEmbeddingService();
  const logger = options.logger ?? createLogger('info');
  const rateLimitBaseMs = options.rateLimitBackoffMs ?? 60_000;

  /**
   * Records a 429 for one entity and phase: bumps the consecutive count and
   * pushes next_attempt_at out by an exponential, jittered cooldown. Returns
   * true once the series has reached MAX_CONSECUTIVE_RATE_LIMITS, at which
   * point the caller converts it into a real failure.
   */
  async function recordRateLimit(
    entityId: string,
    phase: RateLimitPhase,
    error: unknown
  ): Promise<boolean> {
    const upsert = await options.pool.query<{ consecutive_rate_limits: number }>(
      `
        INSERT INTO entity_rate_limit_deferrals AS d (
          entity_id, phase, consecutive_rate_limits, next_attempt_at, last_error
        )
        VALUES ($1, $2, 1, now(), $3)
        ON CONFLICT (entity_id, phase) DO UPDATE
        SET consecutive_rate_limits = d.consecutive_rate_limits + 1,
            last_error = EXCLUDED.last_error
        RETURNING consecutive_rate_limits
      `,
      [entityId, phase, truncateErrorMessage(error)]
    );
    const consecutive = upsert.rows[0]?.consecutive_rate_limits ?? 1;
    if (consecutive >= MAX_CONSECUTIVE_RATE_LIMITS) {
      await clearRateLimit(entityId, phase);
      return true;
    }
    const cooldownMs = rateLimitBackoffMs(rateLimitBaseMs, consecutive - 1);
    await options.pool.query(
      `
        UPDATE entity_rate_limit_deferrals
        SET next_attempt_at = now() + ($3::double precision * interval '1 millisecond')
        WHERE entity_id = $1 AND phase = $2
      `,
      [entityId, phase, cooldownMs]
    );
    return false;
  }

  async function clearRateLimit(
    entityId: string,
    phase: RateLimitPhase,
    client: Pick<PoolClient, 'query'> = options.pool
  ): Promise<void> {
    await client.query(
      'DELETE FROM entity_rate_limit_deferrals WHERE entity_id = $1 AND phase = $2',
      [entityId, phase]
    );
  }

  async function hasPendingEnrichment(): Promise<boolean> {
    const result = await options.pool.query(
      `
        SELECT 1
        FROM entities
        WHERE content IS NOT NULL
          AND (
            enrichment_status = 'pending'
            OR (
              enrichment_status = 'failed'
              AND enrichment_attempts < 3
              AND updated_at < now() - interval '5 minutes'
            )
          )
          AND ${NOT_COOLING_DOWN('enrichment')}
        LIMIT 1
      `
    );

    return Boolean(result.rowCount);
  }

  async function processNextEnrichmentEntity(
    activeModel: Awaited<ReturnType<EmbeddingService['getActiveModel']>>
  ): Promise<boolean> {
    const client = await options.pool.connect();
    let entity: PendingEntityRow | undefined;

    try {
      await client.query('BEGIN');

      const pending = await client.query<PendingEntityRow>(
        `
          SELECT id, type, content, metadata, extraction_status
          FROM entities
          WHERE content IS NOT NULL
            AND (
              enrichment_status = 'pending'
              OR (
                enrichment_status = 'failed'
                AND enrichment_attempts < 3
                AND updated_at < now() - interval '5 minutes'
              )
            )
            AND ${NOT_COOLING_DOWN('enrichment')}
          ORDER BY
            CASE WHEN enrichment_status = 'pending' THEN 0 ELSE 1 END,
            created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `
      );

      entity = pending.rows[0];
      if (!entity) {
        await rollbackQuietly(client);
        return false;
      }

      const chunks = chunkText(entity.content);
      const embeddings = await embeddingService.embedBatch(
        chunks.map((chunk) => chunk.content),
        activeModel
      );

      await client.query('DELETE FROM chunks WHERE entity_id = $1', [entity.id]);

      for (const chunk of chunks) {
        const embedding = embeddings[chunk.chunkIndex];
        if (!embedding) {
          throw new Error('missing embedding for chunk');
        }

        await client.query(
          `
            INSERT INTO chunks (
              entity_id,
              chunk_index,
              content,
              embedding,
              model_id,
              token_count
            )
            VALUES ($1, $2, $3, $4::vector, $5, $6)
          `,
          [
            entity.id,
            chunk.chunkIndex,
            chunk.content,
            `[${embedding.join(',')}]`,
            activeModel.id,
            chunk.tokenCount
          ]
        );
      }

      const shouldQueueExtraction =
        shouldQueueExtractionForEntity({
          type: entity.type,
          metadata: entity.metadata,
          extractionEnabled: options.extractionEnabled,
          extractionMemoryMode: options.extractionMemoryMode
        });

      if (options.extractionEnabled) {
        await client.query(
          `
            UPDATE entities
            SET enrichment_status = 'completed',
                enrichment_attempts = 0,
                enrichment_error = NULL,
                -- Auto-created stubs only have a name as content. Running
                -- extraction on them prompts the LLM with "what does Alice
                -- relate to?" with no context, which free-associates new
                -- stubs and loops. Skip them.
                extraction_status = CASE
                  WHEN extraction_status = 'skipped' THEN 'skipped'
                  WHEN $2::boolean = false THEN NULL
                  WHEN 'auto-created' = ANY(tags) THEN NULL
                  ELSE 'pending'
                END,
                extraction_error = CASE
                  WHEN extraction_status = 'skipped' THEN extraction_error
                  ELSE NULL
                END
            WHERE id = $1
          `,
          [entity.id, shouldQueueExtraction]
        );
      } else {
        await client.query(
          `
            UPDATE entities
            SET enrichment_status = 'completed',
                enrichment_attempts = 0,
                enrichment_error = NULL
            WHERE id = $1
          `,
          [entity.id]
        );
      }

      await clearRateLimit(entity.id, 'enrichment', client);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await rollbackQuietly(client);

      if (!entity) {
        throw error;
      }

      if (isRateLimitError(error)) {
        // 429 from the embedding API is transient. The transaction was rolled
        // back, so the entity keeps its status and attempt count; it gets a
        // cooldown so the next poll moves on to other rows, and the error is
        // re-thrown so the worker loop pauses.
        const exhausted = await recordRateLimit(entity.id, 'enrichment', error);
        if (!exhausted) {
          logger.warn(
            { entityId: entity.id },
            'enrichment deferred — embedding rate limit (429), will back off and retry'
          );
          throw error;
        }
        logger.warn(
          { entityId: entity.id, consecutiveRateLimits: MAX_CONSECUTIVE_RATE_LIMITS },
          'enrichment failed — rate limited too many times in a row'
        );
        await options.pool.query(
          `
            UPDATE entities
            SET enrichment_status = 'failed',
                enrichment_attempts = enrichment_attempts + 1,
                enrichment_error = $2
            WHERE id = $1
          `,
          [
            entity.id,
            truncateErrorMessage(
              `rate limited ${MAX_CONSECUTIVE_RATE_LIMITS} times in a row: ${truncateErrorMessage(error)}`
            )
          ]
        );
        throw error;
      }

      logger.warn({ err: error, entityId: entity.id }, 'enrichment failed');
      await clearRateLimit(entity.id, 'enrichment');

      await options.pool.query(
        `
          UPDATE entities
          SET enrichment_status = 'failed',
              enrichment_attempts = enrichment_attempts + 1,
              enrichment_error = $2
          WHERE id = $1
        `,
        [entity.id, truncateErrorMessage(error)]
      );

      return true;
    } finally {
      client.release();
    }
  }

  // Cache of pre-built provider functions, keyed by `provider:model`. This
  // matters when `improve-graph --model X --provider Y --limit 500` queues
  // 500 entities all pointing at the same override — building 500 provider
  // closures (each with its own captured config) is wasteful, and some
  // providers do non-trivial work in their factory (e.g. validating creds).
  const llmCache = new Map<string, CallLlm>();
  const resolveCallLlm = (
    providerOverride: string | null,
    modelOverride: string | null
  ): CallLlm | undefined => {
    if (!providerOverride && !modelOverride) {
      return options.callLlm;
    }
    if (!options.callLlmFactory) {
      // Override columns set but no factory configured. Log once per unique
      // (provider, model) pair so a misconfigured deployment shows up in
      // logs rather than silently degrading to the default model.
      const key = `MISSING_FACTORY:${providerOverride ?? ''}:${modelOverride ?? ''}`;
      if (!llmCache.has(key)) {
        logger.warn(
          { providerOverride, modelOverride },
          'extraction model override set on entity but worker has no callLlmFactory configured — falling back to default'
        );
        // Sentinel so we don't log again.
        llmCache.set(key, options.callLlm ?? (() => Promise.resolve('[]')));
      }
      return options.callLlm;
    }
    const cacheKey = `${providerOverride ?? ''}:${modelOverride ?? ''}`;
    let entry = llmCache.get(cacheKey);
    if (!entry) {
      entry = options.callLlmFactory(providerOverride, modelOverride);
      llmCache.set(cacheKey, entry);
    }
    return entry;
  };

  async function processNextExtractionEntity(
    extractionAuth: AuthContext
  ): Promise<{ more: boolean; rateLimited: boolean }> {
    // Set when any candidate in this batch hit an upstream 429. The batch is
    // still drained so one throttled entity cannot starve the ones behind it;
    // the caller pauses once the batch is done.
    let rateLimited = false;
    // Do NOT hold a long row-level `FOR UPDATE` across the LLM call.
    // createEdge (called inside extractAndLinkRelationships) runs on a
    // different pool connection, and its INSERT INTO edges needs a FK
    // share lock on the source entity — which would block forever behind
    // our own transaction's FOR UPDATE lock (no cycle = no deadlock
    // detection = stuck forever). Instead, use a short connection just
    // for a per-entity advisory lock.
    const candidates = await options.pool.query<PendingExtractionRow>(
      `
        SELECT id, content, type, metadata, visibility, owner,
               extraction_model_override, extraction_provider_override
        FROM entities
        WHERE extraction_status = 'pending'
          AND content IS NOT NULL
          AND ${NOT_COOLING_DOWN('extraction')}
        ORDER BY created_at ASC
        LIMIT 5
      `
    );

    if (candidates.rows.length === 0) {
      return { more: false, rateLimited };
    }

    const lockClient = await options.pool.connect();
    try {
      for (const entity of candidates.rows) {
        let entityRateLimited = false;
        const lockRes = await lockClient.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
          [entity.id]
        );
        if (!lockRes.rows[0]?.locked) {
          continue;
        }

        if (
          !shouldQueueExtractionForEntity({
            type: entity.type,
            metadata: entity.metadata,
            extractionEnabled: options.extractionEnabled,
            extractionMemoryMode: options.extractionMemoryMode
          })
        ) {
          try {
            await options.pool.query(
              `UPDATE entities
               SET extraction_status = NULL,
                   extraction_error = NULL,
                   extraction_model_override = NULL,
                   extraction_provider_override = NULL
               WHERE id = $1
                 AND extraction_status = 'pending'`,
              [entity.id]
            );
          } finally {
            await lockClient
              .query('SELECT pg_advisory_unlock(hashtext($1))', [entity.id])
              .catch(() => undefined);
          }
          return { more: true, rateLimited };
        }

        const entityCallLlm = resolveCallLlm(
          entity.extraction_provider_override,
          entity.extraction_model_override
        );

        try {
          await extractAndLinkRelationships(
            options.pool,
            extractionAuth,
            {
              id: entity.id,
              type: entity.type,
              content: entity.content,
              visibility: entity.visibility,
              owner: entity.owner
            },
            {
              ...(entityCallLlm ? { callLlm: entityCallLlm } : {}),
              ...(options.autoCreate ? { autoCreate: options.autoCreate } : {}),
              embeddingService,
              ...(options.extractionMatchMinSimilarity !== undefined
                ? { matchMinSimilarity: options.extractionMatchMinSimilarity }
                : {}),
              ...(options.extractionMinContentChars !== undefined
                ? { minContentChars: options.extractionMinContentChars }
                : {}),
              ...(options.extractionDebugLog
                ? {
                    debugLog: (event, payload) =>
                      logger.info({ event, ...payload }, event)
                  }
                : {}),
              ...(options.semanticNeighbors
                ? { semanticNeighbors: options.semanticNeighbors }
                : {})
            }
          );
          // Clear the override columns on success so the next time this
          // entity is re-queued (e.g. via plain `reextract`), it falls back
          // to the env-configured default model rather than silently
          // continuing with the per-run override forever.
          await options.pool.query(
            `UPDATE entities
             SET extraction_status = 'completed',
                 extraction_error = NULL,
                 extraction_model_override = NULL,
                 extraction_provider_override = NULL
             WHERE id = $1`,
            [entity.id]
          );
          await clearRateLimit(entity.id, 'extraction');
        } catch (error) {
          if (error instanceof SemanticMatchUnavailableError) {
            // Leave extraction_status = 'pending' AND the override columns
            // so the next poll retries with the same model. Any edges
            // already linked in this pass are committed (createEdge upserts
            // on conflict, so the retry is idempotent).
            logger.warn(
              { entityId: entity.id, linkedSoFar: error.linkedSoFar },
              'extraction deferred — embeddings unavailable, will retry'
            );
          } else if (isRateLimitError(error)) {
            // Order matters: the branch above matches an explicit type, this
            // one matches on HTTP status (never message text). A
            // SemanticMatchUnavailableError is never a 429, so it cannot be
            // shadowed here, and a 429 is never misread as that error.
            //
            // 429 is transient: leave the entity pending (no extraction_error),
            // give it a cooldown, and keep going with the rest of the batch.
            rateLimited = true;
            entityRateLimited = true;
            if (await recordRateLimit(entity.id, 'extraction', error)) {
              logger.warn(
                { entityId: entity.id, consecutiveRateLimits: MAX_CONSECUTIVE_RATE_LIMITS },
                'extraction failed — rate limited too many times in a row'
              );
              await options.pool.query(
                "UPDATE entities SET extraction_status = 'failed', extraction_error = $2 WHERE id = $1",
                [
                  entity.id,
                  truncateErrorMessage(
                    `rate limited ${MAX_CONSECUTIVE_RATE_LIMITS} times in a row: ${truncateErrorMessage(error)}`
                  )
                ]
              );
            } else {
              logger.warn(
                { entityId: entity.id },
                'extraction deferred — LLM rate limit (429), will back off and retry'
              );
            }
          } else {
            logger.warn(
              { err: error, entityId: entity.id },
              'extraction failed'
            );
            // Don't clear override columns here either — operator may want
            // the failure mode investigated against the same model.
            await options.pool.query(
              "UPDATE entities SET extraction_status = 'failed', extraction_error = $2 WHERE id = $1",
              [entity.id, truncateErrorMessage(error)]
            );
            await clearRateLimit(entity.id, 'extraction');
          }
        } finally {
          await lockClient
            .query('SELECT pg_advisory_unlock(hashtext($1))', [entity.id])
            .catch(() => undefined);
        }
        if (!entityRateLimited) {
          // One entity handled per call. A rate-limited entity did not count
          // as handled, so move on to the next candidate instead.
          return { more: true, rateLimited };
        }
      }
      return { more: true, rateLimited };
    } finally {
      lockClient.release();
    }
  }

  return {
    async runOnce(): Promise<{ processed: number; rateLimited: boolean }> {
      let processed = 0;
      let rateLimited = false;

      if (await hasPendingEnrichment()) {
        const activeModel = await embeddingService.getActiveModel(options.pool);

        try {
          while (await processNextEnrichmentEntity(activeModel)) {
            processed += 1;
          }
        } catch (error) {
          if (isRateLimitError(error)) {
            rateLimited = true;
            return { processed, rateLimited };
          } else {
            throw error;
          }
        }
      }

      if (options.extractionEnabled) {
        const extractionAuth: AuthContext = {
          apiKeyId: null,
          keyName: 'system-extraction',
          clientId: null,
          scopes: ['read', 'write', 'delete'] as const,
          allowedTypes: null,
          allowedVisibility: ['personal', 'work', 'shared'] as const
        };

        for (;;) {
          const step = await processNextExtractionEntity(extractionAuth);
          if (!step.more) {
            break;
          }
          if (step.rateLimited) {
            // The batch was drained (throttled rows now carry a cooldown);
            // hand control back so the worker loop pauses before more calls.
            rateLimited = true;
            break;
          }
          processed += 1;
        }
      }

      return { processed, rateLimited };
    }
  };
}
