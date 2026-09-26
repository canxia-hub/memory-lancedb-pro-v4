/**
 * Memory Asset Store - Asset Indexing Layer
 *
 * Implements asset storage layer for multimodal memory assets.
 * Uses LanceDB for indexing, with file assets stored separately.
 *
 * Design:
 * - Main memories table stores text memory records
 * - memory_assets table stores asset index/metadata
 * - Actual asset files stored in assets directory (CAS-like)
 * - No binary blobs in database
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, accessSync, constants, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { embedMultimodal } from '../retrieval/embedder.js';
import { Field, FixedSizeList, Float32, Float64, Schema, Utf8 } from 'apache-arrow';

// 0.33: assets 表同样必须使用 FixedSizeList<Float32> 向量列
function makeAssetsSchema(dim) {
    return new Schema([
        new Field('assetId', new Utf8(), false),
        new Field('memoryId', new Utf8(), false),
        new Field('modality', new Utf8(), false),
        new Field('mimeType', new Utf8(), false),
        new Field('storagePath', new Utf8(), false),
        new Field('sha256', new Utf8(), true),
        new Field('sizeBytes', new Float64(), true),
        new Field('caption', new Utf8(), true),
        new Field('ocrText', new Utf8(), true),
        new Field('transcript', new Utf8(), true),
        new Field('summary', new Utf8(), true),
        new Field('embedding', new FixedSizeList(dim, new Field('item', new Float32(), true)), true),
        new Field('createdAt', new Utf8(), false),
        new Field('metadataJson', new Utf8(), false),
    ]);
}
// LanceDB eager load（2026-09-26 生产补丁：宿主 source-capture 退役清理会删除物化文件，
// 惰性 require 在清理后撞 MODULE_NOT_FOUND 并以 unhandled rejection 拖垮整个网关进程；
// 模块加载期完成首次 require 后命中进程内模块缓存，capture 文件被删也不再受影响）
const require = createRequire(import.meta.url);
// Exclude network section from process.report to avoid slow reverse-DNS
// lookups on first LanceDB load (can block event loop 100-250s on some hosts)
try {
    process.report.excludeNetwork = true;
} catch { /* Node < 22 without the flag */ }
const lancedbModule = require('@lancedb/lancedb');
async function loadLanceDB() {
    return lancedbModule;
}
// Escape SQL literal for safe queries
function escapeSqlLiteral(value) {
    return value.replace(/'/g, "''");
}
// Validate and prepare assets directory path
function validateAssetsPath(dbPath) {
    // Derive assets path from dbPath: <dbPath>/assets
    const assetsPath = join(dbPath, 'assets');
    let resolvedPath = assetsPath;
    // Resolve symlinks
    try {
        const stats = lstatSync(assetsPath);
        if (stats.isSymbolicLink()) {
            try {
                resolvedPath = realpathSync(assetsPath);
            }
            catch (err) {
                throw new Error(`assetsPath "${assetsPath}" is a symlink whose target does not exist. Details: ${err.message}`);
            }
        }
    }
    catch (err) {
        if (err?.code === 'ENOENT') {
            // Missing path is OK, will be created
        }
        else if (err.message.includes('symlink whose target')) {
            throw err;
        }
    }
    // Create directory if missing
    if (!existsSync(resolvedPath)) {
        try {
            mkdirSync(resolvedPath, { recursive: true });
        }
        catch (err) {
            throw new Error(`Failed to create assetsPath directory "${resolvedPath}". Details: ${err.message}`);
        }
    }
    // Check write permissions
    try {
        accessSync(resolvedPath, constants.W_OK);
    }
    catch (err) {
        throw new Error(`assetsPath directory "${resolvedPath}" is not writable. Details: ${err.message}`);
    }
    return resolvedPath;
}
/**
 * Resolve asset store config from backend config.
 *
 * @param backendConfig - Memory backend configuration
 * @returns Asset store configuration
 */
export function resolveAssetStoreConfig(backendConfig) {
    return {
        dbPath: backendConfig.dbPath,
        tableName: 'memory_assets',
        embeddingDimension: backendConfig.embeddingDimension,
        embedding: backendConfig.embedding,
    };
}
/**
 * Create Asset Store instance.
 *
 * @param config - Asset store configuration
 * @returns Asset store instance
 */
export function createAssetStore(config) {
    // Internal state
    let _connected = false;
    let _db = null;
    let _table = null;
    let _initPromise = null;
    let _assetsPath = null;
    // Generate UUID
    function generateId() {
        return randomUUID();
    }
    // Get current ISO timestamp
    function timestamp() {
        return new Date().toISOString();
    }
    // Ensure initialization
    async function ensureInitialized() {
        if (_table)
            return;
        if (_initPromise)
            return _initPromise;
        _initPromise = doInitialize().catch((err) => {
            _initPromise = null;
            throw err;
        });
        return _initPromise;
    }
    // Real initialization
    async function doInitialize() {
        const lancedb = await loadLanceDB();
        // Validate and prepare assets directory
        _assetsPath = validateAssetsPath(config.dbPath);
        // 0.33: connect with readConsistencyInterval for cross-process visibility
        const readConsistencyInterval = config.readConsistencyIntervalSeconds ?? 5;
        let db;
        try {
            db = await lancedb.connect(config.dbPath, {
                readConsistencyInterval,
            });
        }
        catch (err) {
            throw new Error(`Failed to open LanceDB at "${config.dbPath}": ${err.code || ''} ${err.message}`);
        }
        let table;
        // Try to open existing assets table, create if missing
        try {
            table = await db.openTable(config.tableName);
        }
        catch (_openErr) {
            // Table doesn't exist - create with proper FixedSizeList<Float32> vector schema (0.33)
            try {
                table = await db.createEmptyTable(config.tableName, makeAssetsSchema(config.embeddingDimension), { existOk: true });
            }
            catch (createErr) {
                // Race condition: another process created the table
                if (String(createErr).includes('already exists')) {
                    table = await db.openTable(config.tableName);
                }
                else {
                    throw createErr;
                }
            }
        }
        _db = db;
        _table = table;
        _connected = true;
    }
    // Map input to database row
    function mapInputToRow(memoryId, input, assetId, createdAt) {
        return {
            assetId,
            memoryId,
            modality: input.modality,
            mimeType: input.mimeType,
            storagePath: input.storagePath,
            sha256: input.sha256 ?? '', // Empty string instead of null
            sizeBytes: input.sizeBytes ?? 0, // 0 instead of null
            caption: input.caption ?? '',
            ocrText: input.ocrText ?? '',
            transcript: input.transcript ?? '',
            summary: input.summary ?? '',
            embedding: input.embedding ?? Array.from({ length: config.embeddingDimension }).fill(0),
            createdAt,
            metadataJson: JSON.stringify(input.metadata ?? {}),
        };
    }
    // Map database row to record
    function mapRowToRecord(row) {
        const embedding = row.embedding ? Array.from(row.embedding) : null;
        let metadataJson = '{}';
        try {
            if (row.metadataJson && typeof row.metadataJson === 'string') {
                metadataJson = row.metadataJson;
            }
            else if (row.metadataJson && typeof row.metadataJson === 'object') {
                metadataJson = JSON.stringify(row.metadataJson);
            }
        }
        catch (_e) {
            metadataJson = '{}';
        }
        return {
            assetId: row.assetId,
            memoryId: row.memoryId,
            modality: row.modality,
            mimeType: row.mimeType,
            storagePath: row.storagePath,
            sha256: row.sha256 && row.sha256 !== '' ? row.sha256 : null, // Treat empty string as null
            sizeBytes: row.sizeBytes && row.sizeBytes !== 0 ? row.sizeBytes : null, // Treat 0 as null
            caption: row.caption && row.caption !== '' ? row.caption : null,
            ocrText: row.ocrText && row.ocrText !== '' ? row.ocrText : null,
            transcript: row.transcript && row.transcript !== '' ? row.transcript : null,
            summary: row.summary && row.summary !== '' ? row.summary : null,
            embedding,
            createdAt: row.createdAt,
            metadataJson,
        };
    }
    // Store implementation
    const store = {
        async initialize() {
            await ensureInitialized();
        },
        async close() {
            _connected = false;
            _db = null;
            _table = null;
            _initPromise = null;
            _assetsPath = null;
        },
        async create(memoryId, input) {
            await ensureInitialized();
            const assetId = generateId();
            const createdAt = timestamp();
            const enrichedInput = input.embedding ? input : { ...input, embedding: config.embedding ? (await embedMultimodal({ text: input.caption ?? input.summary ?? input.ocrText, image: input.storagePath }, { ...config.embedding, dimension: config.embeddingDimension })).embedding : undefined };
            const row = mapInputToRow(memoryId, enrichedInput, assetId, createdAt);
            try {
                await _table.add([row]);
            }
            catch (err) {
                return {
                    asset: mapRowToRecord(row),
                    success: false,
                    error: `Failed to create asset: ${err.message}`,
                };
            }
            return {
                asset: mapRowToRecord(row),
                success: true,
            };
        },
        async batchCreate(memoryId, inputs) {
            await ensureInitialized();
            const createdAt = timestamp();
            const rows = [];
            const errors = [];
            // Prepare all rows
            for (let i = 0; i < inputs.length; i++) {
                const input = inputs[i];
                const assetId = generateId();
                const enrichedInput = input.embedding ? input : { ...input, embedding: config.embedding ? (await embedMultimodal({ text: input.caption ?? input.summary ?? input.ocrText, image: input.storagePath }, { ...config.embedding, dimension: config.embeddingDimension })).embedding : undefined };
                rows.push(mapInputToRow(memoryId, enrichedInput, assetId, createdAt));
            }
            // Batch insert
            try {
                await _table.add(rows);
            }
            catch (err) {
                // If batch fails, return error for all
                return {
                    assets: rows.map(mapRowToRecord),
                    successCount: 0,
                    failCount: inputs.length,
                    errors: inputs.map((_, i) => ({ index: i, error: err.message })),
                    success: false,
                };
            }
            return {
                assets: rows.map(mapRowToRecord),
                successCount: inputs.length,
                failCount: 0,
                errors: [],
                success: true,
            };
        },
        async listByMemoryId(memoryId, options) {
            await ensureInitialized();
            const safeMemoryId = escapeSqlLiteral(memoryId);
            // Use app-layer filtering (more reliable with LanceDB field name issues)
            const results = await _table.query().toArray();
            let filtered = results.filter((r) => r.memoryId === memoryId && r.assetId !== '__schema__');
            if (options?.modality) {
                filtered = filtered.filter((r) => r.modality === options.modality);
            }
            const assets = filtered.map(mapRowToRecord);
            const offset = options?.offset ?? 0;
            const limit = options?.limit ?? 50;
            return {
                assets: assets.slice(offset, offset + limit),
                total: assets.length,
                success: true,
            };
        },
        async listByModality(modality, options) {
            await ensureInitialized();
            // App-layer filtering by modality
            const results = await _table.query().toArray();
            let filtered = results.filter((r) => r.modality === modality && r.assetId !== '__schema__');
            const assets = filtered.map(mapRowToRecord);
            const offset = options?.offset ?? 0;
            const limit = options?.limit ?? 50;
            return {
                assets: assets.slice(offset, offset + limit),
                total: assets.length,
                success: true,
            };
        },
        async get(assetId) {
            await ensureInitialized();
            // Use app-layer filtering (more reliable with LanceDB field name issues)
            const results = await _table.query().toArray();
            const found = results.find((r) => r.assetId === assetId && r.assetId !== '__schema__');
            if (!found)
                return null;
            return mapRowToRecord(found);
        },
        async delete(assetId) {
            await ensureInitialized();
            // Use app-layer filtering (more reliable with LanceDB field name issues)
            const results = await _table.query().toArray();
            const found = results.find((r) => r.assetId === assetId);
            if (!found)
                return false;
            // Delete using SQL (still has issues but we know the record exists)
            try {
                await _table.delete(`assetId = '${escapeSqlLiteral(assetId)}'`);
                return true;
            }
            catch (err) {
                // If SQL delete fails, we can't do much without proper field name handling
                console.warn(`Asset delete failed for ${assetId}: ${err}`);
                return false;
            }
        },
        async status() {
            if (!_table) {
                return {
                    initialized: false,
                    tableName: config.tableName,
                    assetsPath: config.dbPath + '/assets',
                    totalAssets: 0,
                    hasVectors: false,
                    error: 'Asset store not initialized',
                };
            }
            try {
                const results = await _table.query().toArray();
                const realAssets = results.filter((r) => r.assetId !== '__schema__');
                const totalAssets = realAssets.length;
                const withVectors = realAssets.filter((r) => r.embedding && r.embedding.length > 0);
                const hasVectors = withVectors.length > 0;
                return {
                    initialized: _connected,
                    tableName: config.tableName,
                    assetsPath: _assetsPath ?? config.dbPath + '/assets',
                    totalAssets,
                    hasVectors,
                };
            }
            catch (err) {
                return {
                    initialized: _connected,
                    tableName: config.tableName,
                    assetsPath: _assetsPath ?? config.dbPath + '/assets',
                    totalAssets: 0,
                    hasVectors: false,
                    error: err.message,
                };
            }
        },
    };
    return store;
}
/**
 * Internal asset store instance (lazy init).
 */
let _assetStore = null;
let _assetStoreConfig = null;
/**
 * Initialize global asset store.
 *
 * @param backendConfig - Backend configuration
 */
export async function initializeAssetStore(backendConfig) {
    _assetStoreConfig = resolveAssetStoreConfig(backendConfig);
    _assetStore = createAssetStore(_assetStoreConfig);
    await _assetStore.initialize();
}
/**
 * Get global asset store instance.
 *
 * @returns Asset store instance
 */
export function getAssetStore() {
    if (!_assetStore) {
        throw new Error('Asset store not initialized - call initializeAssetStore() first');
    }
    return _assetStore;
}
/**
 * Close global asset store.
 */
export async function closeAssetStore() {
    if (_assetStore) {
        await _assetStore.close();
        _assetStore = null;
    }
    _assetStoreConfig = null;
}
//# sourceMappingURL=asset-store.js.map
