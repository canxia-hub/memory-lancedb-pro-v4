/**
 * Legacy Memory Migrator
 *
 * Migrates memories from old memory-lancedb-pro to v2 LanceDB store.
 * Preserves original IDs, timestamps, and metadata with full migration tracking.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let legacyLancedbModule = null;
// 2026-09-26 生产补丁：current 模块改 eager（原因同 asset-store.js）；legacy 路径可能不存在，保持惰性
try { process.report.excludeNetwork = true; } catch { /* Node < 22 */ }
const currentLancedbModule = require('@lancedb/lancedb');
async function loadLegacyLanceDB() {
    if (!legacyLancedbModule) {
        const legacyModulePath = join(homedir(), '.openclaw', 'workspace', 'memory-lancedb-pro-fork', 'node_modules', '@lancedb', 'lancedb');
        legacyLancedbModule = require(legacyModulePath);
    }
    return legacyLancedbModule;
}
async function loadCurrentLanceDB() {
    return currentLancedbModule;
}
function escapeSqlLiteral(value) {
    return value.replace(/'/g, "''");
}
// ============================================================================
// Default Paths
// ============================================================================
/**
 * Get default legacy database paths to search.
 */
export function getDefaultLegacyPaths() {
    const home = homedir();
    return [
        join(home, '.openclaw', 'memory', 'lancedb-pro'),
        join(home, '.openclaw', 'memory', 'lancedb'),
        join(home, '.claude', 'memory', 'lancedb'),
    ];
}
/**
 * Find legacy database path.
 */
export async function findLegacyDatabase(explicitPath) {
    if (explicitPath) {
        if (existsSync(explicitPath)) {
            return explicitPath;
        }
        return null;
    }
    for (const path of getDefaultLegacyPaths()) {
        if (existsSync(path)) {
            try {
                const lancedb = await loadLegacyLanceDB();
                const db = await lancedb.connect(path);
                const tableNames = await db.tableNames();
                if (tableNames.includes('memories')) {
                    return path;
                }
            }
            catch {
                // Skip invalid paths
                continue;
            }
        }
    }
    return null;
}
// ============================================================================
// Legacy Reader
// ============================================================================
/**
 * Read all entries from legacy database.
 */
export async function readLegacyEntries(sourceDbPath) {
    const lancedb = await loadLegacyLanceDB();
    const db = await lancedb.connect(sourceDbPath);
    const table = await db.openTable('memories');
    const rows = await table.query().toArray();
    let vectorDimension = 0;
    const entries = [];
    for (const row of rows) {
        // Normalize vector to plain array
        let vector;
        if (Array.isArray(row.vector)) {
            vector = row.vector;
        }
        else if (row.vector && typeof row.vector === 'object' && 'length' in row.vector) {
            // Float32Array or Arrow Vector
            vector = Array.from(row.vector);
        }
        else {
            vector = [];
        }
        if (vector.length > 0 && vectorDimension === 0) {
            vectorDimension = vector.length;
        }
        entries.push({
            id: row.id,
            text: row.text,
            vector,
            category: row.category || 'other',
            scope: row.scope || 'global',
            importance: Number(row.importance) ?? 0.7,
            timestamp: Number(row.timestamp) ?? 0,
            metadata: row.metadata && typeof row.metadata === 'object'
                ? row.metadata
                : {},
        });
    }
    return { entries, vectorDimension };
}
// ============================================================================
// Migration Logic
// ============================================================================
/**
 * Map legacy entry to v2 record.
 */
export function mapLegacyToV2(legacy, defaultScope) {
    // Convert timestamp (epoch ms) to ISO 8601
    const createdAt = legacy.timestamp > 0
        ? new Date(legacy.timestamp).toISOString()
        : new Date().toISOString();
    const updatedAt = createdAt;
    // Build metadata with migration tracking
    const metadata = {
        ...legacy.metadata,
        migratedFrom: 'memory-lancedb-pro',
        originalId: legacy.id,
        originalTimestamp: legacy.timestamp,
        originalCategory: legacy.category,
    };
    return {
        id: legacy.id,
        scope: legacy.scope || defaultScope,
        content: legacy.text,
        embedding: legacy.vector.length > 0 ? Array.from(legacy.vector) : null,
        category: legacy.category,
        importance: legacy.importance,
        createdAt,
        updatedAt,
        metadata,
    };
}
/**
 * Check if ID exists in target database.
 */
export async function checkIdExists(targetDbPath, targetTableName, id) {
    try {
        const lancedb = await loadCurrentLanceDB();
        const db = await lancedb.connect(targetDbPath);
        const table = await db.openTable(targetTableName);
        const safeId = escapeSqlLiteral(id);
        const rows = await table.query()
            .where(`id = '${safeId}'`)
            .limit(1)
            .toArray();
        return rows.length > 0;
    }
    catch {
        // Database/table doesn't exist yet
        return false;
    }
}
/**
 * Create target table with schema matching v2.
 */
async function createTargetTable(targetDbPath, targetTableName, vectorDimension) {
    const lancedb = await loadCurrentLanceDB();
    // Ensure directory exists
    if (!existsSync(targetDbPath)) {
        mkdirSync(targetDbPath, { recursive: true });
    }
    const db = await lancedb.connect(targetDbPath);
    // Try to open existing table
    try {
        const table = await db.openTable(targetTableName);
        return table;
    }
    catch {
        // Table doesn't exist, create it with schema row
        const schemaRow = {
            id: '__schema__',
            scope: 'global',
            content: '',
            embedding: Array.from({ length: vectorDimension }).fill(0),
            category: 'other',
            importance: 0.7,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            metadata: '{}',
        };
        try {
            const table = await db.createTable(targetTableName, [schemaRow]);
            await table.delete('id = "__schema__"');
            return table;
        }
        catch (createErr) {
            // Race condition: another process created the table
            if (String(createErr).includes('already exists')) {
                return db.openTable(targetTableName);
            }
            throw createErr;
        }
    }
}
/**
 * Insert records into target table.
 */
async function insertRecords(table, records) {
    // Convert metadata to string for LanceDB storage
    const rows = records.map(r => ({
        id: r.id,
        scope: r.scope,
        content: r.content,
        embedding: r.embedding ?? Array.from({ length: 2560 }).fill(0),
        category: r.category,
        importance: r.importance,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        metadata: JSON.stringify(r.metadata),
    }));
    await table.add(rows);
}
/**
 * Get count of records in target table.
 */
async function getTargetCount(targetDbPath, targetTableName) {
    try {
        const lancedb = await loadCurrentLanceDB();
        const db = await lancedb.connect(targetDbPath);
        const table = await db.openTable(targetTableName);
        const rows = await table.query().toArray();
        return rows.filter((row) => row.id !== '__schema__').length;
    }
    catch {
        return 0;
    }
}
// ============================================================================
// Main Migrator Class
// ============================================================================
/**
 * Legacy memory migrator.
 */
export class LegacyMigrator {
    /**
     * Run migration.
     */
    async migrate(options) {
        const startedAt = new Date().toISOString();
        const startTime = Date.now();
        const report = {
            sourceDbPath: '',
            targetDbPath: '',
            sourceCount: 0,
            migratedCount: 0,
            skippedCount: 0,
            errorCount: 0,
            errors: [],
            startedAt,
            finishedAt: '',
            durationMs: 0,
            legacyVectorDimension: 0,
            targetVectorDimension: 0,
            mode: options.mode,
        };
        try {
            // Find source database
            const sourceDbPath = await findLegacyDatabase(options.sourceDbPath);
            if (!sourceDbPath) {
                report.errors.push({ message: 'No legacy database found to migrate from' });
                report.finishedAt = new Date().toISOString();
                report.durationMs = Date.now() - startTime;
                return report;
            }
            report.sourceDbPath = sourceDbPath;
            // Read legacy entries
            const { entries, vectorDimension } = await readLegacyEntries(sourceDbPath);
            report.sourceCount = entries.length;
            report.legacyVectorDimension = vectorDimension;
            if (entries.length === 0) {
                report.finishedAt = new Date().toISOString();
                report.durationMs = Date.now() - startTime;
                return report;
            }
            // Handle dry-run
            if (options.mode === 'dry-run') {
                report.dryRunResult = {
                    wouldMigrate: entries.length,
                    sampleRecords: entries.slice(0, 5).map(e => ({
                        id: e.id,
                        scope: e.scope,
                        category: e.category,
                        contentPreview: e.text.substring(0, 100),
                    })),
                };
                report.finishedAt = new Date().toISOString();
                report.durationMs = Date.now() - startTime;
                return report;
            }
            // Determine target path
            const targetDbPath = options.targetDbPath;
            if (!targetDbPath) {
                report.errors.push({ message: 'targetDbPath required for run mode' });
                report.finishedAt = new Date().toISOString();
                report.durationMs = Date.now() - startTime;
                return report;
            }
            report.targetDbPath = targetDbPath;
            report.targetVectorDimension = vectorDimension; // Use legacy dimension
            const targetTableName = options.targetTableName ?? 'memories';
            const defaultScope = options.defaultScope ?? 'global';
            const batchSize = options.batchSize ?? 50;
            // Create/open target table
            const table = await createTargetTable(targetDbPath, targetTableName, vectorDimension);
            // Prepare records for migration
            const recordsToInsert = [];
            const existingIds = [];
            // Check existing IDs if skip-existing mode
            if (options.mode === 'skip-existing') {
                for (const entry of entries) {
                    const exists = await checkIdExists(targetDbPath, targetTableName, entry.id);
                    if (exists) {
                        existingIds.push(entry.id);
                        report.skippedCount++;
                    }
                    else {
                        recordsToInsert.push(mapLegacyToV2(entry, defaultScope));
                    }
                }
            }
            else {
                // Run mode: migrate all
                for (const entry of entries) {
                    recordsToInsert.push(mapLegacyToV2(entry, defaultScope));
                }
            }
            // Insert in batches
            for (let i = 0; i < recordsToInsert.length; i += batchSize) {
                const batch = recordsToInsert.slice(i, i + batchSize);
                try {
                    await insertRecords(table, batch);
                    report.migratedCount += batch.length;
                }
                catch (err) {
                    for (const record of batch) {
                        const existsAfterError = await checkIdExists(targetDbPath, targetTableName, record.id);
                        if (existsAfterError) {
                            report.migratedCount += 1;
                            continue;
                        }
                        report.errors.push({
                            id: record.id,
                            message: `Failed to insert: ${err.message}`,
                        });
                        report.errorCount++;
                    }
                }
            }
            report.finishedAt = new Date().toISOString();
            report.durationMs = Date.now() - startTime;
            return report;
        }
        catch (err) {
            report.errors.push({ message: `Migration failed: ${err.message}` });
            report.errorCount++;
            report.finishedAt = new Date().toISOString();
            report.durationMs = Date.now() - startTime;
            return report;
        }
    }
    /**
     * Get migration status (probe source database without migration).
     */
    async probe() {
        const sourceDbPath = await findLegacyDatabase();
        if (!sourceDbPath) {
            return { found: false };
        }
        try {
            const { entries, vectorDimension } = await readLegacyEntries(sourceDbPath);
            return {
                found: true,
                sourceDbPath,
                sourceCount: entries.length,
                vectorDimension,
                sampleEntries: entries.slice(0, 5).map(e => ({
                    id: e.id,
                    scope: e.scope,
                    category: e.category,
                    contentPreview: e.text.substring(0, 100),
                })),
            };
        }
        catch (err) {
            return {
                found: true,
                sourceDbPath,
            };
        }
    }
    /**
     * Verify migration by comparing counts and sampling records.
     */
    async verify(sourceDbPath, targetDbPath, targetTableName) {
        const tableName = targetTableName ?? 'memories';
        // Read source
        const { entries } = await readLegacyEntries(sourceDbPath);
        const sourceCount = entries.length;
        // Get target count
        const targetCount = await getTargetCount(targetDbPath, tableName);
        // Sample verification
        const sampleIds = entries.slice(0, 10).map(e => e.id);
        let matchedSamples = 0;
        const mismatchedSamples = [];
        try {
            const lancedb = await loadCurrentLanceDB();
            const db = await lancedb.connect(targetDbPath);
            const table = await db.openTable(tableName);
            for (const id of sampleIds) {
                const safeId = escapeSqlLiteral(id);
                const rows = await table.query()
                    .where(`id = '${safeId}'`)
                    .limit(1)
                    .toArray();
                if (rows.length === 0) {
                    mismatchedSamples.push({ id, issue: 'Not found in target' });
                }
                else {
                    const sourceEntry = entries.find(e => e.id === id);
                    const targetRow = rows[0];
                    // Compare content
                    if (sourceEntry && targetRow.content !== sourceEntry.text) {
                        mismatchedSamples.push({ id, issue: 'Content mismatch' });
                    }
                    else if (sourceEntry && targetRow.scope !== sourceEntry.scope) {
                        mismatchedSamples.push({ id, issue: `Scope mismatch: expected ${sourceEntry.scope}, got ${targetRow.scope}` });
                    }
                    else {
                        // Matched
                        matchedSamples += 1;
                    }
                }
            }
        }
        catch (err) {
            mismatchedSamples.push({ id: 'verify', issue: err.message });
        }
        const valid = sourceCount === targetCount && mismatchedSamples.length === 0;
        return {
            valid,
            sourceCount,
            targetCount,
            matchedSamples,
            mismatchedSamples,
        };
    }
}
/**
 * Create legacy migrator instance.
 */
export function createLegacyMigrator() {
    return new LegacyMigrator();
}
/**
 * Convenience function for one-shot migration.
 */
export async function migrateFromLegacy(options) {
    const migrator = createLegacyMigrator();
    return migrator.migrate(options);
}
//# sourceMappingURL=legacy-migrator.js.map