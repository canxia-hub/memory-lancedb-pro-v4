/**
 * Hybrid Retriever - Internal Retrieval with FTS + Vector + Lexical
 *
 * Upgraded for LanceDB 0.33.0:
 * - FTS (BM25) full-text search via LanceDB native index
 * - Vector search with native cosine distanceType
 * - Lexical search as fallback
 * - Hybrid combination with configurable weights
 *
 * Internal candidates must be mapped to public MemorySearchResult before export.
 */
import { buildMemoryPath } from '../store/scope-manager.js';
import { embedMultimodal, cosineSimilarity, isZeroVector } from './embedder.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// LanceDB eager load（2026-09-26 生产补丁，原因同 asset-store.js）
try {
    process.report.excludeNetwork = true;
} catch { /* Node < 22 without the flag */ }
const lancedbModule = require('@lancedb/lancedb');
async function loadLanceDB() {
    return lancedbModule;
}

/**
 * Sigmoid normalization for BM25 raw scores (unbounded → 0-1 range).
 * LanceDB FTS _score is raw BM25 which can be very large.
 * sigmoid(x/5) maps: x=0→0.5, x=5→0.73, x=10→0.88, x=20→0.98
 */
function sigmoidNormalize(rawScore) {
    if (rawScore <= 0) return 0;
    return 1 / (1 + Math.exp(-rawScore / 5));
}

/**
 * Simple lexical search implementation.
 *
 * Fallback when FTS index is not available.
 *
 * @param query - Search query
 * @param records - Memory records to search
 * @param options - Search options
 * @returns Matching candidates with lexical scores
 */
export function simpleLexicalSearch(query, records, options) {
    if (!query || query.trim() === '') {
        return [];
    }
    const normalizedQuery = query.toLowerCase().trim();
    const queryTerms = normalizedQuery.split(/\s+/).filter(t => t.length > 0);
    const limit = options?.limit ?? 20;
    const minScore = options?.minScore ?? 0.1;
    // Calculate lexical scores for each record
    const candidates = records.map(record => {
        const contentLower = record.content.toLowerCase();
        // Simple term frequency scoring
        let termMatches = 0;
        let exactMatchBonus = 0;
        for (const term of queryTerms) {
            const termCount = (contentLower.match(new RegExp(term, 'g')) ?? []).length;
            termMatches += termCount;
            // Bonus for exact phrase match
            if (contentLower.includes(normalizedQuery)) {
                exactMatchBonus = 0.2;
            }
        }
        // Normalize score to 0-1 range
        const baseScore = Math.min(1, termMatches / (queryTerms.length * 3));
        const lexicalScore = Math.min(1, baseScore + exactMatchBonus);
        // Build snippet (truncate to reasonable length)
        const snippet = truncateSnippet(record.content, 180);
        return {
            id: record.id,
            scope: record.scope,
            path: buildMemoryPath(record.scope, record.id),
            lexicalScore,
            finalScore: lexicalScore,
            snippet,
            content: record.content,
            category: record.category,
            importance: record.importance,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            metadata: record.metadata,
        };
    });
    // Filter, sort, and limit
    return candidates
        .filter(c => c.lexicalScore >= minScore)
        .sort((a, b) => b.lexicalScore - a.lexicalScore)
        .slice(0, limit);
}

/**
 * Truncate content to snippet.
 *
 * @param content - Full content
 * @param maxLength - Maximum snippet length
 * @returns Truncated snippet
 */
export function truncateSnippet(content, maxLength = 180) {
    if (!content || content.length <= maxLength) {
        return content ?? '';
    }
    // Find a good break point near maxLength
    const breakPoint = content.lastIndexOf(' ', maxLength);
    if (breakPoint > maxLength * 0.7) {
        return content.substring(0, breakPoint) + '...';
    }
    return content.substring(0, maxLength) + '...';
}

/**
 * Create hybrid retriever instance.
 *
 * Supports: lexical, vector, fts, hybrid modes.
 * FTS uses LanceDB native BM25 index when available.
 * Vector search uses native cosine distanceType when available.
 *
 * @param records - Memory records (from store, for lexical fallback)
 * @param availability - Retrieval availability status
 * @param embeddingConfig - Embedding configuration
 * @param storeRef - Reference to store for direct table access (FTS/vector search)
 * @returns Hybrid retriever instance
 */
export function createHybridRetriever(records, availability, embeddingConfig = {}, storeRef = null) {
    const retriever = {
        async retrieve(options) {
            switch (options.mode) {
                case 'lexical':
                    return this.lexicalSearch(options.query, options);
                case 'vector':
                    return this.vectorSearch(options.query, options);
                case 'fts':
                    return this.ftsSearch(options.query, options);
                case 'hybrid': {
                    const lexicalResults = await this.lexicalSearch(options.query, options);
                    const vectorResults = await this.vectorSearch(options.query, options);
                    const ftsResults = await this.ftsSearch(options.query, options);
                    // If only one path has results, use it directly
                    const nonEmptyPaths = [lexicalResults, vectorResults, ftsResults].filter(r => r.length > 0);
                    if (nonEmptyPaths.length === 1) {
                        return nonEmptyPaths[0];
                    }
                    if (nonEmptyPaths.length === 0) {
                        return [];
                    }
                    // Combine all paths
                    let combined = this.combineResults(lexicalResults, vectorResults, {
                        lexicalWeight: options.lexicalWeight,
                        vectorWeight: options.vectorWeight,
                    });
                    // Merge FTS results into the combined set
                    if (ftsResults.length > 0) {
                        combined = this.mergeFtsResults(combined, ftsResults, {
                            ftsWeight: options.ftsWeight,
                            vectorWeight: options.vectorWeight,
                            lexicalWeight: options.lexicalWeight,
                        });
                    }
                    return combined;
                }
                default:
                    return this.lexicalSearch(options.query, options);
            }
        },
        async checkAvailability() {
            return availability;
        },
        async lexicalSearch(query, options) {
            // Apply scope/category filters
            let filteredRecords = records;
            if (options?.scope) {
                filteredRecords = filteredRecords.filter(r => r.scope === options.scope);
            }
            if (options?.category) {
                filteredRecords = filteredRecords.filter(r => r.category === options.category);
            }
            return simpleLexicalSearch(query, filteredRecords, options);
        },
        async vectorSearch(query, options) {
            if (!availability.vectorAvailable || !availability.embeddingAvailable) {
                return [];
            }
            // Try native LanceDB vector search if store reference is available
            if (storeRef?.table) {
                try {
                    let queryEmbedding;
                    try {
                        queryEmbedding = (await embedMultimodal({ text: query }, embeddingConfig)).embedding;
                    } catch (_err) {
                        return [];
                    }
                    const limit = options?.limit ?? 20;
                    let searchQuery = storeRef.table.vectorSearch(queryEmbedding)
                        .distanceType('cosine')
                        .limit(limit);
                    // Apply scope filter
                    if (options?.scope) {
                        searchQuery = searchQuery.where(`scope = '${options.scope.replace(/'/g, "''")}'`);
                    }
                    if (options?.category) {
                        searchQuery = searchQuery.where(`category = '${options.category.replace(/'/g, "''")}'`);
                    }
                    const results = await searchQuery.toArray();
                    const minScore = options?.minScore ?? 0.1;
                    return results
                        .map(row => {
                            // cosine distance: 0=identical, 2=opposite; score = 1/(1+distance)
                            const distance = Number(row._distance ?? 0);
                            const score = 1 / (1 + distance);
                            return {
                                id: row.id,
                                scope: row.scope ?? 'global',
                                path: buildMemoryPath(row.scope ?? 'global', row.id),
                                vectorScore: score,
                                finalScore: score,
                                snippet: truncateSnippet(row.content, 180),
                                content: row.content,
                                category: row.category,
                                importance: Number(row.importance) ?? 0.7,
                                createdAt: row.createdAt,
                                updatedAt: row.updatedAt,
                                metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata || '{}') : (row.metadata || {}),
                            };
                        })
                        .filter(c => c.vectorScore >= minScore);
                } catch (e) {
                    // Fall through to JS-based vector search
                    console.warn(`[memory-lancedb-pro] Native vector search failed, falling back to JS: ${e.message?.slice(0, 100)}`);
                }
            }
            // Fallback: JS-based cosine similarity search
            let queryEmbedding;
            try {
                queryEmbedding = (await embedMultimodal({ text: query }, embeddingConfig)).embedding;
            }
            catch (_err) {
                return [];
            }
            let filteredRecords = records;
            if (options?.scope) {
                filteredRecords = filteredRecords.filter(r => r.scope === options.scope);
            }
            if (options?.category) {
                filteredRecords = filteredRecords.filter(r => r.category === options.category);
            }
            const limit = options?.limit ?? 20;
            const minScore = options?.minScore ?? 0.1;
            return filteredRecords
                .filter(record => Array.isArray(record.embedding) && !isZeroVector(record.embedding))
                .map(record => {
                const vectorScore = cosineSimilarity(queryEmbedding, record.embedding ?? []);
                return {
                    id: record.id,
                    scope: record.scope,
                    path: buildMemoryPath(record.scope, record.id),
                    vectorScore,
                    finalScore: vectorScore,
                    snippet: truncateSnippet(record.content, 180),
                    content: record.content,
                    category: record.category,
                    importance: record.importance,
                    createdAt: record.createdAt,
                    updatedAt: record.updatedAt,
                    metadata: record.metadata,
                };
            })
                .filter(c => c.vectorScore >= minScore)
                .sort((a, b) => (b.vectorScore ?? 0) - (a.vectorScore ?? 0))
                .slice(0, limit);
        },
        async ftsSearch(query, options) {
            // Check if FTS is available
            if (!storeRef?.table || !storeRef.ftsIndexCreated) {
                return [];
            }
            try {
                const limit = options?.limit ?? 20;
                const minScore = options?.minScore ?? 0.1;
                let searchQuery = storeRef.table.search(query, 'fts').limit(limit);
                // Apply scope filter
                if (options?.scope) {
                    searchQuery = searchQuery.where(`scope = '${options.scope.replace(/'/g, "''")}'`);
                }
                if (options?.category) {
                    searchQuery = searchQuery.where(`category = '${options.category.replace(/'/g, "''")}'`);
                }
                const results = await searchQuery.toArray();
                return results
                    .map(row => {
                        // BM25 _score is raw/unbounded; normalize with sigmoid
                        const rawScore = row._score != null ? Number(row._score) : 0;
                        const ftsScore = sigmoidNormalize(rawScore);
                        let metadata = {};
                        try {
                            if (typeof row.metadata === 'string') metadata = JSON.parse(row.metadata || '{}');
                            else if (typeof row.metadata === 'object') metadata = row.metadata || {};
                        } catch { metadata = {}; }
                        return {
                            id: row.id,
                            scope: row.scope ?? 'global',
                            path: buildMemoryPath(row.scope ?? 'global', row.id),
                            ftsScore,
                            finalScore: ftsScore,
                            snippet: truncateSnippet(row.content, 180),
                            content: row.content,
                            category: row.category,
                            importance: Number(row.importance) ?? 0.7,
                            createdAt: row.createdAt,
                            updatedAt: row.updatedAt,
                            metadata,
                        };
                    })
                    .filter(c => c.ftsScore >= minScore);
            } catch (e) {
                // FTS search failed; return empty (non-critical, vector/lexical still work)
                console.warn(`[memory-lancedb-pro] FTS search failed: ${e.message?.slice(0, 100)}`);
                return [];
            }
        },
        combineResults(lexical, vector, options) {
            const lexicalWeight = options?.lexicalWeight ?? 0.5;
            const vectorWeight = options?.vectorWeight ?? 0.5;
            // Create map for deduplication by path
            const candidateMap = new Map();
            // Add lexical results
            for (const c of lexical) {
                candidateMap.set(c.path, {
                    ...c,
                    lexicalScore: c.lexicalScore,
                    hybridScore: c.lexicalScore * lexicalWeight,
                    finalScore: c.lexicalScore * lexicalWeight,
                });
            }
            // Add/merge vector results
            for (const c of vector) {
                const existing = candidateMap.get(c.path);
                if (existing) {
                    // Merge scores
                    existing.vectorScore = c.vectorScore;
                    existing.hybridScore = (existing.lexicalScore ?? 0) * lexicalWeight + (c.vectorScore ?? 0) * vectorWeight;
                    existing.finalScore = existing.hybridScore;
                }
                else {
                    // New candidate from vector only
                    candidateMap.set(c.path, {
                        ...c,
                        vectorScore: c.vectorScore,
                        hybridScore: (c.vectorScore ?? 0) * vectorWeight,
                        finalScore: (c.vectorScore ?? 0) * vectorWeight,
                    });
                }
            }
            // Sort by final score and return
            return Array.from(candidateMap.values())
                .sort((a, b) => b.finalScore - a.finalScore);
        },
        mergeFtsResults(combined, ftsResults, options) {
            const ftsWeight = options?.ftsWeight ?? 0.3;
            const vectorWeight = options?.vectorWeight ?? 0.4;
            const lexicalWeight = options?.lexicalWeight ?? 0.3;
            // Normalize weights to sum to 1
            const totalWeight = ftsWeight + vectorWeight + lexicalWeight;
            const wFts = ftsWeight / totalWeight;
            const wVec = vectorWeight / totalWeight;
            const wLex = lexicalWeight / totalWeight;
            const candidateMap = new Map();
            // Seed with existing combined results
            for (const c of combined) {
                candidateMap.set(c.path, { ...c });
            }
            // Add/merge FTS results
            for (const c of ftsResults) {
                const existing = candidateMap.get(c.path);
                if (existing) {
                    // Merge FTS score into existing hybrid score
                    existing.ftsScore = c.ftsScore;
                    // Recalculate with three-way weights
                    const lexPart = (existing.lexicalScore ?? 0) * wLex;
                    const vecPart = (existing.vectorScore ?? 0) * wVec;
                    const ftsPart = (c.ftsScore ?? 0) * wFts;
                    existing.hybridScore = lexPart + vecPart + ftsPart;
                    existing.finalScore = existing.hybridScore;
                }
                else {
                    // New candidate from FTS only
                    candidateMap.set(c.path, {
                        ...c,
                        ftsScore: c.ftsScore,
                        hybridScore: (c.ftsScore ?? 0) * wFts,
                        finalScore: (c.ftsScore ?? 0) * wFts,
                    });
                }
            }
            return Array.from(candidateMap.values())
                .sort((a, b) => b.finalScore - a.finalScore);
        },
    };
    return retriever;
}
//# sourceMappingURL=hybrid-retriever.js.map
