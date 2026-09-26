/**
 * Wiki Vector Index — P1 向量检索索引
 *
 * 独立的 wiki_pages LanceDB 表，为 wiki corpus supplement 提供语义检索能力。
 * 与 memories 表完全隔离，不影响 memory_recall。
 *
 * 设计决策：
 * - 整页 embedding（197 页 → 197 条记录）
 * - 独立表，同一 LanceDB dbPath
 * - 惰性连接（第一次 search/index 时建立）
 * - 降级策略：embedding 不可用时回退关键词+图谱
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { embedMultimodal, isZeroVector, cosineSimilarity } from '../retrieval/embedder.js';

// LanceDB eager load（2026-09-26 生产补丁，原因同 asset-store.js）
const require = createRequire(import.meta.url);
try { process.report.excludeNetwork = true; } catch { /* Node < 22 */ }
const lancedbModule = require('@lancedb/lancedb');
async function loadLanceDB() {
    return lancedbModule;
}

// Arrow imports for schema (deferred to avoid import issues)
let arrowModule = null;
async function loadArrow() {
    if (!arrowModule) {
        arrowModule = require('apache-arrow');
    }
    return arrowModule;
}

// ============================================================================
// Constants
// ============================================================================

const WIKI_TABLE_NAME = 'wiki_pages';
const DEFAULT_EMBEDDING_DIM = 2560;

// Directories to skip during vault scanning (same as digest-compiler)
const SKIP_DIRS = new Set([
    '.openclaw-wiki', 'graphify-out', 'legacy', 'memory-vaults',
    'archive', 'templates', 'node_modules', '.git', '__pycache__',
]);

// ============================================================================
// Schema
// ============================================================================

async function makeWikiPagesSchema(dim) {
    const arrow = await loadArrow();
    return new arrow.Schema([
        new arrow.Field('id', new arrow.Utf8(), false),
        new arrow.Field('path', new arrow.Utf8(), false),
        new arrow.Field('title', new arrow.Utf8(), false),
        new arrow.Field('content', new arrow.Utf8(), false),
        new arrow.Field('embedding', new arrow.FixedSizeList(dim, new arrow.Field('item', new arrow.Float32(), true)), true),
        new arrow.Field('category', new arrow.Utf8(), false),
        new arrow.Field('tags', new arrow.Utf8(), false),
        new arrow.Field('updatedAt', new arrow.Utf8(), false),
        new arrow.Field('metadata', new arrow.Utf8(), false),
    ]);
}

// ============================================================================
// Connection Management (lazy singleton)
// ============================================================================

let _wikiDb = null;
let _wikiTable = null;
let _initPromise = null;

/**
 * Ensure wiki_pages table is available.
 * Lazily creates LanceDB connection and table on first call.
 *
 * @param {object} config - Plugin config (needs dbPath, embeddingDimension)
 * @returns {Promise<object|null>} LanceDB table or null if unavailable
 */
export async function ensureWikiVectorTable(config) {
    if (_wikiTable) return _wikiTable;
    if (_initPromise) return _initPromise;

    _initPromise = doEnsureTable(config).catch(err => {
        _initPromise = null;
        console.warn(`[memory-lancedb-pro] wiki vector table init failed: ${err.message?.slice(0, 100)}`);
        return null;
    });

    return _initPromise;
}

async function doEnsureTable(config) {
    const dbPath = config?.dbPath;
    if (!dbPath || typeof dbPath !== 'string') {
        return null; // No dbPath — vector search unavailable, caller falls back
    }
    const lancedb = await loadLanceDB();
    const dim = config.embeddingDimension ?? DEFAULT_EMBEDDING_DIM;

    const db = await lancedb.connect(dbPath, {
        readConsistencyInterval: config.readConsistencyIntervalSeconds ?? 5,
    });

    let table;
    try {
        table = await db.openTable(WIKI_TABLE_NAME);
    } catch {
        // Table doesn't exist — create empty
        const schema = await makeWikiPagesSchema(dim);
        try {
            table = await db.createEmptyTable(WIKI_TABLE_NAME, schema, { existOk: true });
        } catch (createErr) {
            if (String(createErr).includes('already exists')) {
                table = await db.openTable(WIKI_TABLE_NAME);
            } else {
                throw createErr;
            }
        }
    }

    // Create BITMAP index on category (low cardinality)
    try {
        const indices = await table.listIndices();
        const existingColumns = new Set();
        for (const idx of indices) {
            if (idx.columns) {
                for (const col of idx.columns) existingColumns.add(col);
            }
        }
        if (!existingColumns.has('category')) {
            await table.createIndex('category', { config: lancedb.Index.bitmap() });
        }
    } catch { /* non-critical */ }

    _wikiDb = db;
    _wikiTable = table;
    return table;
}

/**
 * Reset connection state (for testing or config changes).
 */
export function resetWikiVectorState() {
    _wikiDb = null;
    _wikiTable = null;
    _initPromise = null;
}

// ============================================================================
// Vault Scanning (reused pattern from digest-compiler)
// ============================================================================

function scanVaultFiles(vaultPath) {
    const results = [];
    if (!fs.existsSync(vaultPath)) return results;

    function scanDir(dirPath, prefix) {
        if (!fs.existsSync(dirPath)) return;
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            const relPath = prefix ? path.join(prefix, entry.name).replace(/\\/g, '/') : entry.name;
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
                    scanDir(fullPath, relPath);
                }
                continue;
            }
            if (entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('_')) {
                results.push(relPath);
            }
        }
    }

    const topEntries = fs.readdirSync(vaultPath, { withFileTypes: true });
    for (const entry of topEntries) {
        if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
            scanDir(path.join(vaultPath, entry.name), entry.name);
        }
    }
    return results;
}

function parseFrontMatterLocal(content) {
    if (!content.startsWith('---')) return null;
    const parts = content.split('---');
    if (parts.length < 3) return null;
    const yamlContent = parts[1].trim();
    const metadata = {};
    for (const line of yamlContent.split('\n')) {
        if (!line.includes(':')) continue;
        const colonIdx = line.indexOf(':');
        const key = line.substring(0, colonIdx).trim();
        const value = line.substring(colonIdx + 1).trim();
        if (key === 'tags') {
            if (value.startsWith('[') && value.endsWith(']')) {
                metadata.tags = value.slice(1, -1).split(',').map(t => t.trim().replace(/^["']|["']$/g, '')).filter(t => t.length > 0);
            }
        } else if (key === 'confidence') {
            metadata.confidence = parseFloat(value);
        } else {
            metadata[key] = value;
        }
    }
    if (!metadata.title || !metadata.category) return null;
    return {
        title: metadata.title,
        category: metadata.category,
        tags: metadata.tags || [],
        status: metadata.status || 'draft',
        agent: metadata.agent,
        confidence: metadata.confidence,
        created: metadata.created,
        updated: metadata.updated,
    };
}

function extractBody(content) {
    if (!content.startsWith('---')) return content;
    const parts = content.split('---');
    if (parts.length < 3) return content;
    return parts.slice(2).join('---').trim();
}

// ============================================================================
// Indexing
// ============================================================================

/**
 * Generate stable ID for a wiki page.
 */
export function wikiPageId(relativePath) {
    return createHash('sha256').update(relativePath).digest('hex').slice(0, 16);
}

/**
 * Index all wiki pages into wiki_pages table.
 * Full re-index: clears existing data and rebuilds.
 *
 * @param {object} config - Plugin config (dbPath, embedding, embeddingDimension)
 * @param {string} vaultPath - Wiki vault root path
 * @param {object} options - { force?: boolean, batchSize?: number }
 * @returns {Promise<{ indexed: number, skipped: number, errors: number, total: number }>}
 */
export async function indexWikiPages(config, vaultPath, options = {}) {
    const table = await ensureWikiVectorTable(config);
    if (!table) {
        return { indexed: 0, skipped: 0, errors: 0, total: 0, error: 'wiki_pages table unavailable' };
    }

    const files = scanVaultFiles(vaultPath);
    const total = files.length;
    let indexed = 0, skipped = 0, errors = 0;

    const embeddingConfig = {
        ...config.embedding,
        dimension: config.embeddingDimension ?? DEFAULT_EMBEDDING_DIM,
    };

    // Clear existing data for full re-index
    if (options.force !== false) {
        try {
            await table.delete('1=1');
        } catch { /* table might be empty */ }
    }

    // Process in batches to avoid overwhelming the embedding API
    const batchSize = options.batchSize ?? 10;
    for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        const rows = [];

        for (const relPath of batch) {
            try {
                const fullPath = path.join(vaultPath, relPath);
                const rawContent = fs.readFileSync(fullPath, 'utf8');
                const fm = parseFrontMatterLocal(rawContent);
                if (!fm) {
                    skipped++;
                    continue;
                }

                const body = extractBody(rawContent);
                // Embed title + body for better semantic coverage
                const textToEmbed = `${fm.title}\n${body}`.slice(0, 8000); // DashScope limit
                const embedResult = await embedMultimodal({ text: textToEmbed }, embeddingConfig);

                if (!embedResult?.embedding || isZeroVector(embedResult.embedding)) {
                    skipped++;
                    continue;
                }

                rows.push({
                    id: wikiPageId(relPath),
                    path: relPath,
                    title: fm.title,
                    content: rawContent,
                    embedding: embedResult.embedding,
                    category: fm.category,
                    tags: JSON.stringify(fm.tags),
                    updatedAt: fm.updated || new Date().toISOString(),
                    metadata: JSON.stringify({
                        status: fm.status,
                        agent: fm.agent,
                        confidence: fm.confidence,
                        created: fm.created,
                        fileSize: rawContent.length,
                    }),
                });
            } catch (err) {
                errors++;
                console.warn(`[memory-lancedb-pro] wiki index error for ${relPath}: ${err.message?.slice(0, 80)}`);
            }
        }

        if (rows.length > 0) {
            try {
                await table.add(rows);
                indexed += rows.length;
            } catch (err) {
                errors += rows.length;
                console.warn(`[memory-lancedb-pro] wiki index batch write failed: ${err.message?.slice(0, 100)}`);
            }
        }
    }

    return { indexed, skipped, errors, total };
}

/**
 * Remove specific wiki pages from the index.
 *
 * @param {object} config - Plugin config
 * @param {string[]} paths - Relative paths to remove
 */
export async function removeWikiPages(config, paths) {
    const table = await ensureWikiVectorTable(config);
    if (!table || !paths?.length) return { removed: 0 };

    let removed = 0;
    for (const relPath of paths) {
        try {
            const id = wikiPageId(relPath);
            await table.delete(`id = '${id}'`);
            removed++;
        } catch { /* non-critical */ }
    }
    return { removed };
}

/**
 * Get wiki vector index status.
 *
 * @param {object} config - Plugin config
 * @returns {Promise<{ available: boolean, count: number, lastIndexed?: string }>}
 */
export async function getWikiIndexStatus(config) {
    try {
        const table = await ensureWikiVectorTable(config);
        if (!table) return { available: false, count: 0 };

        const results = await table.query().limit(1).toArray();
        const countResult = await table.countRows();
        return {
            available: true,
            count: countResult,
            hasData: results.length > 0,
        };
    } catch {
        return { available: false, count: 0 };
    }
}

// ============================================================================
// Vector Search
// ============================================================================

/**
 * Search wiki_pages table by vector similarity.
 *
 * @param {object} config - Plugin config
 * @param {string} query - Search query text
 * @param {object} options - { maxResults?: number, minScore?: number, category?: string }
 * @returns {Promise<Array<{ id, path, title, category, score, snippet, updatedAt }>>}
 */
export async function searchWikiVector(config, query, options = {}) {
    const table = await ensureWikiVectorTable(config);
    if (!table) return [];

    const maxResults = options.maxResults ?? 10;
    const minScore = options.minScore ?? 0.1;
    const embeddingConfig = {
        ...config.embedding,
        dimension: config.embeddingDimension ?? DEFAULT_EMBEDDING_DIM,
    };

    // Generate query embedding
    let queryEmbedding;
    try {
        const result = await embedMultimodal({ text: query }, embeddingConfig);
        queryEmbedding = result?.embedding;
    } catch {
        return []; // Embedding unavailable — caller falls back
    }

    if (!queryEmbedding || isZeroVector(queryEmbedding)) return [];

    // Try native LanceDB vector search
    try {
        let searchQuery = table.vectorSearch(queryEmbedding)
            .distanceType('cosine')
            .limit(maxResults);

        if (options.category) {
            searchQuery = searchQuery.where(`category = '${options.category.replace(/'/g, "''")}'`);
        }

        const results = await searchQuery.toArray();
        return results
            .map(row => {
                const distance = Number(row._distance ?? 0);
                const score = 1 / (1 + distance);
                return {
                    id: row.id,
                    path: row.path,
                    title: row.title,
                    category: row.category,
                    vectorScore: score,
                    score,
                    snippet: truncateSnippet(row.content, 180),
                    updatedAt: row.updatedAt,
                };
            })
            .filter(r => r.score >= minScore)
            .slice(0, maxResults);
    } catch (err) {
        // Fallback: JS-based cosine similarity
        console.warn(`[memory-lancedb-pro] wiki native vector search failed, JS fallback: ${err.message?.slice(0, 80)}`);
        return jsVectorSearch(table, queryEmbedding, maxResults, minScore, options.category);
    }
}

/**
 * JS-based cosine similarity fallback.
 */
async function jsVectorSearch(table, queryEmbedding, maxResults, minScore, category) {
    try {
        let query = table.query();
        if (category) {
            query = query.where(`category = '${category.replace(/'/g, "''")}'`);
        }
        const allRows = await query.toArray();

        return allRows
            .filter(row => row.embedding && !isZeroVector(row.embedding))
            .map(row => {
                const score = cosineSimilarity(queryEmbedding, row.embedding);
                return {
                    id: row.id,
                    path: row.path,
                    title: row.title,
                    category: row.category,
                    vectorScore: score,
                    score,
                    snippet: truncateSnippet(row.content, 180),
                    updatedAt: row.updatedAt,
                };
            })
            .filter(r => r.score >= minScore)
            .sort((a, b) => b.score - a.score)
            .slice(0, maxResults);
    } catch {
        return [];
    }
}

function truncateSnippet(content, maxLength = 180) {
    if (!content || content.length <= maxLength) return content ?? '';
    const breakPoint = content.lastIndexOf(' ', maxLength);
    if (breakPoint > maxLength * 0.7) {
        return content.substring(0, breakPoint) + '...';
    }
    return content.substring(0, maxLength) + '...';
}
