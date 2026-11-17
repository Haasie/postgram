import path from 'node:path';

import { ResultAsync } from 'neverthrow';
import type { Pool } from 'pg';

import { checkTypeAccess, checkVisibilityAccess, requireScope } from '../auth/key-service.js';
import type { AuthContext } from '../auth/types.js';
import type { Visibility } from '../types/entities.js';
import type { ServiceResult } from '../types/common.js';
import { appendAuditEntry } from '../util/audit.js';
import { AppError, ErrorCode } from '../util/errors.js';

const H1_PATTERN = /^#\s+(.+)$/m;

export function extractTitle(content: string, filePath: string): string {
  const match = H1_PATTERN.exec(content);
  if (match?.[1]) {
    return match[1].trim();
  }

  const basename = path.basename(filePath, path.extname(filePath));
  return basename;
}

/** Synced documents are 'shared' unless the caller asks for another visibility for the whole repo. */
export const DEFAULT_SYNC_VISIBILITY: Visibility = 'shared';

type SyncManifestInput = {
  repo: string;
  files: Array<{ path: string; sha: string; content: string }>;
  visibility?: Visibility | undefined;
};

type SyncResult = {
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  reclassified?: number;
};

export type SyncDiffInput = {
  repo: string;
  files: Array<{ path: string; sha: string }>;
  visibility?: Visibility | undefined;
};

export type SyncDiffResult = {
  toUpload: Array<{ path: string; sha: string; reason: 'new' | 'changed' }>;
  unchanged: number;
  toDelete: string[];
};

export type SyncUploadInput = {
  repo: string;
  files: Array<{ path: string; sha: string; content: string }>;
  visibility?: Visibility | undefined;
};

export type SyncUploadResult = {
  created: number;
  updated: number;
};

export type SyncFinalizeInput = {
  repo: string;
  files: Array<{ path: string; sha: string }>;
  visibility?: Visibility | undefined;
};

export type SyncFinalizeResult = {
  deleted: number;
  /** Documents of this repo moved to the requested visibility (only when `visibility` is given). */
  reclassified?: number;
};

/**
 * Move every document of a repo to one visibility. Runs only when the caller passes `visibility`,
 * so a repo that never asks keeps whatever it has. Returns how many documents changed.
 */
async function reclassifyRepo(
  client: { query: Pool['query'] },
  repo: string,
  visibility: Visibility
): Promise<number> {
  const result = await client.query(
    `
      UPDATE entities e
      SET visibility = $2,
          version = e.version + 1
      FROM document_sources ds
      WHERE ds.entity_id = e.id
        AND ds.repo = $1
        AND e.visibility <> $2
    `,
    [repo, visibility]
  );
  return result.rowCount ?? 0;
}

type DocumentSourceRow = {
  id: string;
  entity_id: string;
  path: string;
  sha: string;
  sync_status: string;
};

export type SyncStatusEntry = {
  path: string;
  sha: string;
  syncStatus: string;
  lastSynced: string;
  entityId: string;
};

type SyncStatusRow = {
  path: string;
  sha: string;
  sync_status: string;
  last_synced: Date;
  entity_id: string;
};

function toAppError(error: unknown, fallbackMessage: string): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof Error) {
    return new AppError(ErrorCode.INTERNAL, fallbackMessage, {
      cause: error.message
    });
  }

  return new AppError(ErrorCode.INTERNAL, fallbackMessage);
}

export function syncManifest(
  pool: Pool,
  auth: AuthContext,
  input: SyncManifestInput
): ServiceResult<SyncResult> {
  return ResultAsync.fromPromise(
    (async () => {
      requireScope(auth, 'write');
      requireScope(auth, 'delete');
      checkTypeAccess(auth, 'document');
      const visibility = input.visibility ?? DEFAULT_SYNC_VISIBILITY;
      checkVisibilityAccess(auth, visibility);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const existingRows = await client.query<DocumentSourceRow>(
          'SELECT id, entity_id, path, sha, sync_status FROM document_sources WHERE repo = $1',
          [input.repo]
        );

        const existingByPath = new Map<string, DocumentSourceRow>();
        for (const row of existingRows.rows) {
          existingByPath.set(row.path, row);
        }

        let created = 0;
        let updated = 0;
        let unchanged = 0;

        const incomingPaths = new Set<string>();

        for (const file of input.files) {
          incomingPaths.add(file.path);
          const existing = existingByPath.get(file.path);

          if (!existing) {
            const title = extractTitle(file.content, file.path);
            const entityResult = await client.query<{ id: string }>(
              `
                INSERT INTO entities (type, content, visibility, enrichment_status, metadata)
                VALUES ('document', $1, $3, 'pending', $2)
                RETURNING id
              `,
              [
                file.content,
                JSON.stringify({ repo: input.repo, path: file.path, title }),
                visibility
              ]
            );
            const entityId = entityResult.rows[0]?.id;
            if (!entityId) {
              throw new AppError(ErrorCode.INTERNAL, 'Failed to create entity');
            }

            await client.query(
              `
                INSERT INTO document_sources (entity_id, repo, path, sha)
                VALUES ($1, $2, $3, $4)
              `,
              [entityId, input.repo, file.path, file.sha]
            );

            created += 1;
          } else if (existing.sha !== file.sha) {
            const title = extractTitle(file.content, file.path);

            const versionRow = await client.query<{ version: number }>(
              'SELECT version FROM entities WHERE id = $1',
              [existing.entity_id]
            );
            const currentVersion = versionRow.rows[0]?.version ?? 1;

            const updateResult = await client.query(
              `
                UPDATE entities
                SET content = $1,
                    status = NULL,
                    enrichment_status = 'pending',
                    enrichment_attempts = 0,
                    metadata = jsonb_set(
                      jsonb_set(metadata, '{title}', to_jsonb($3::text)),
                      '{path}', to_jsonb($4::text)
                    ),
                    version = version + 1
                WHERE id = $2 AND version = $5
              `,
              [file.content, existing.entity_id, title, file.path, currentVersion]
            );

            if (updateResult.rowCount === 0) {
              throw new AppError(
                ErrorCode.CONFLICT,
                `Version conflict updating synced entity for ${file.path}`
              );
            }

            await client.query('DELETE FROM chunks WHERE entity_id = $1', [
              existing.entity_id
            ]);

            await client.query(
              `
                UPDATE document_sources
                SET sha = $1, last_synced = now(), sync_status = 'current'
                WHERE id = $2
              `,
              [file.sha, existing.id]
            );

            updated += 1;
          } else {
            // Unchanged SHA — restore if previously stale
            if (existing.sync_status === 'stale') {
              await client.query(
                "UPDATE entities SET status = NULL WHERE id = $1",
                [existing.entity_id]
              );
              await client.query(
                "UPDATE document_sources SET last_synced = now(), sync_status = 'current' WHERE id = $1",
                [existing.id]
              );
            } else {
              await client.query(
                'UPDATE document_sources SET last_synced = now() WHERE id = $1',
                [existing.id]
              );
            }
            unchanged += 1;
          }
        }

        let deleted = 0;
        for (const [existingPath, existing] of existingByPath) {
          if (!incomingPaths.has(existingPath) && existing.sync_status !== 'stale') {
            await client.query(
              "UPDATE entities SET status = 'archived' WHERE id = $1",
              [existing.entity_id]
            );
            await client.query(
              "UPDATE document_sources SET sync_status = 'stale', last_synced = now() WHERE id = $1",
              [existing.id]
            );
            deleted += 1;
          }
        }

        const reclassified = input.visibility
          ? await reclassifyRepo(client, input.repo, input.visibility)
          : undefined;

        await client.query('COMMIT');

        await appendAuditEntry(pool, {
          apiKeyId: auth.apiKeyId,
          operation: 'sync.complete',
          details: {
            repo: input.repo,
            created,
            updated,
            unchanged,
            deleted,
            ...(reclassified !== undefined ? { visibility, reclassified } : {})
          }
        });

        return reclassified !== undefined
          ? { created, updated, unchanged, deleted, reclassified }
          : { created, updated, unchanged, deleted };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    })(),
    (error) => toAppError(error, 'Failed to sync manifest')
  );
}

export function diffSyncManifest(
  pool: Pool,
  auth: AuthContext,
  input: SyncDiffInput
): ServiceResult<SyncDiffResult> {
  return ResultAsync.fromPromise(
    (async () => {
      requireScope(auth, 'read');
      checkTypeAccess(auth, 'document');
      const visibility = input.visibility ?? DEFAULT_SYNC_VISIBILITY;
      checkVisibilityAccess(auth, visibility);

      const existingRows = await pool.query<DocumentSourceRow>(
        'SELECT id, entity_id, path, sha, sync_status FROM document_sources WHERE repo = $1',
        [input.repo]
      );

      const existingByPath = new Map<string, DocumentSourceRow>();
      for (const row of existingRows.rows) {
        existingByPath.set(row.path, row);
      }

      const toUpload: SyncDiffResult['toUpload'] = [];
      let unchanged = 0;
      const incomingPaths = new Set<string>();

      for (const file of input.files) {
        incomingPaths.add(file.path);
        const existing = existingByPath.get(file.path);

        if (!existing) {
          toUpload.push({ path: file.path, sha: file.sha, reason: 'new' });
        } else if (existing.sha !== file.sha) {
          toUpload.push({ path: file.path, sha: file.sha, reason: 'changed' });
        } else {
          unchanged += 1;
        }
      }

      const toDelete: string[] = [];
      for (const [existingPath, existing] of existingByPath) {
        if (!incomingPaths.has(existingPath) && existing.sync_status !== 'stale') {
          toDelete.push(existingPath);
        }
      }

      return { toUpload, unchanged, toDelete };
    })(),
    (error) => toAppError(error, 'Failed to diff sync manifest')
  );
}

export function uploadSyncFiles(
  pool: Pool,
  auth: AuthContext,
  input: SyncUploadInput
): ServiceResult<SyncUploadResult> {
  return ResultAsync.fromPromise(
    (async () => {
      requireScope(auth, 'write');
      checkTypeAccess(auth, 'document');
      const visibility = input.visibility ?? DEFAULT_SYNC_VISIBILITY;
      checkVisibilityAccess(auth, visibility);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        let created = 0;
        let updated = 0;

        for (const file of input.files) {
          const existingResult = await client.query<DocumentSourceRow>(
            'SELECT id, entity_id, path, sha, sync_status FROM document_sources WHERE repo = $1 AND path = $2',
            [input.repo, file.path]
          );
          const existing = existingResult.rows[0];

          if (!existing) {
            const title = extractTitle(file.content, file.path);
            const entityResult = await client.query<{ id: string }>(
              `
                INSERT INTO entities (type, content, visibility, enrichment_status, metadata)
                VALUES ('document', $1, $3, 'pending', $2)
                RETURNING id
              `,
              [
                file.content,
                JSON.stringify({ repo: input.repo, path: file.path, title }),
                visibility
              ]
            );
            const entityId = entityResult.rows[0]?.id;
            if (!entityId) {
              throw new AppError(ErrorCode.INTERNAL, 'Failed to create entity');
            }

            await client.query(
              `
                INSERT INTO document_sources (entity_id, repo, path, sha)
                VALUES ($1, $2, $3, $4)
              `,
              [entityId, input.repo, file.path, file.sha]
            );

            created += 1;
          } else if (existing.sha !== file.sha) {
            const title = extractTitle(file.content, file.path);

            const versionRow = await client.query<{ version: number }>(
              'SELECT version FROM entities WHERE id = $1',
              [existing.entity_id]
            );
            const currentVersion = versionRow.rows[0]?.version ?? 1;

            const updateResult = await client.query(
              `
                UPDATE entities
                SET content = $1,
                    status = NULL,
                    enrichment_status = 'pending',
                    enrichment_attempts = 0,
                    metadata = jsonb_set(
                      jsonb_set(metadata, '{title}', to_jsonb($3::text)),
                      '{path}', to_jsonb($4::text)
                    ),
                    version = version + 1
                WHERE id = $2 AND version = $5
              `,
              [file.content, existing.entity_id, title, file.path, currentVersion]
            );

            if (updateResult.rowCount === 0) {
              throw new AppError(
                ErrorCode.CONFLICT,
                `Version conflict updating synced entity for ${file.path}`
              );
            }

            await client.query('DELETE FROM chunks WHERE entity_id = $1', [
              existing.entity_id
            ]);

            await client.query(
              `
                UPDATE document_sources
                SET sha = $1, last_synced = now(), sync_status = 'current'
                WHERE id = $2
              `,
              [file.sha, existing.id]
            );

            updated += 1;
          }
          // Same-sha uploads are no-ops; finalize handles last_synced and stale restoration.
        }

        await client.query('COMMIT');

        return { created, updated };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    })(),
    (error) => toAppError(error, 'Failed to upload sync files')
  );
}

export function finalizeSyncManifest(
  pool: Pool,
  auth: AuthContext,
  input: SyncFinalizeInput
): ServiceResult<SyncFinalizeResult> {
  return ResultAsync.fromPromise(
    (async () => {
      requireScope(auth, 'write');
      requireScope(auth, 'delete');
      checkTypeAccess(auth, 'document');
      const visibility = input.visibility ?? DEFAULT_SYNC_VISIBILITY;
      checkVisibilityAccess(auth, visibility);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const existingRows = await client.query<DocumentSourceRow>(
          'SELECT id, entity_id, path, sha, sync_status FROM document_sources WHERE repo = $1',
          [input.repo]
        );

        const existingByPath = new Map<string, DocumentSourceRow>();
        for (const row of existingRows.rows) {
          existingByPath.set(row.path, row);
        }

        const incomingPaths = new Set<string>();

        for (const file of input.files) {
          incomingPaths.add(file.path);
          const existing = existingByPath.get(file.path);
          if (!existing || existing.sha !== file.sha) {
            continue;
          }

          if (existing.sync_status === 'stale') {
            await client.query(
              "UPDATE entities SET status = NULL WHERE id = $1",
              [existing.entity_id]
            );
            await client.query(
              "UPDATE document_sources SET last_synced = now(), sync_status = 'current' WHERE id = $1",
              [existing.id]
            );
          } else {
            await client.query(
              'UPDATE document_sources SET last_synced = now() WHERE id = $1',
              [existing.id]
            );
          }
        }

        let deleted = 0;
        for (const [existingPath, existing] of existingByPath) {
          if (!incomingPaths.has(existingPath) && existing.sync_status !== 'stale') {
            await client.query(
              "UPDATE entities SET status = 'archived' WHERE id = $1",
              [existing.entity_id]
            );
            await client.query(
              "UPDATE document_sources SET sync_status = 'stale', last_synced = now() WHERE id = $1",
              [existing.id]
            );
            deleted += 1;
          }
        }

        const reclassified = input.visibility
          ? await reclassifyRepo(client, input.repo, input.visibility)
          : undefined;

        await client.query('COMMIT');

        await appendAuditEntry(pool, {
          apiKeyId: auth.apiKeyId,
          operation: 'sync.finalize',
          details: {
            repo: input.repo,
            deleted,
            manifestFiles: input.files.length,
            ...(reclassified !== undefined ? { visibility, reclassified } : {})
          }
        });

        return reclassified !== undefined ? { deleted, reclassified } : { deleted };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    })(),
    (error) => toAppError(error, 'Failed to finalize sync manifest')
  );
}

export function getSyncStatus(
  pool: Pool,
  auth: AuthContext,
  repo: string
): ServiceResult<SyncStatusEntry[]> {
  return ResultAsync.fromPromise(
    (async () => {
      requireScope(auth, 'read');
      checkVisibilityAccess(auth, 'shared');

      const rows = await pool.query<SyncStatusRow>(
        `
          SELECT path, sha, sync_status, last_synced, entity_id
          FROM document_sources
          WHERE repo = $1
          ORDER BY path
        `,
        [repo]
      );

      return rows.rows.map((row) => ({
        path: row.path,
        sha: row.sha,
        syncStatus: row.sync_status,
        lastSynced: row.last_synced.toISOString(),
        entityId: row.entity_id
      }));
    })(),
    (error) => toAppError(error, 'Failed to get sync status')
  );
}
