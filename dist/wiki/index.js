/**
 * Wiki Module - Phase W1 + W2 + W3 + Batch B 实现
 *
 * 提供Wiki 数据存取、索引生成、反向链接同步、健康检查和图谱构建功能
 * Batch B: 新增 corpus supplement + prompt supplement 导出
 */
// Types (冻结契约)
export * from './types.js';
// Wiki Store (Phase W1)
export { WIKI_ROOT, configureWikiRoot, getWikiRoot, slugify, normalizeLinkTarget, resolveLinkToPath, parseFrontMatter, serializeFrontMatter, listCategories, getEntry, createEntry, updateEntry, deleteEntry, } from './wiki-store.js';
// Wiki Doctor (Phase W1)
export { checkWikiHealth, formatHealthReport, } from './wiki-doctor.js';
// Wiki Index (Phase W2)
export { buildCategoryIndex, buildAllIndexes, buildTagIndex, updateMainIndex, } from './wiki-index.js';
// Wiki Sync Links (Phase W2)
export { extractWikiLinks, syncBacklinks, } from './wiki-sync-links.js';
// Wiki Extractor (Phase W3)
export { extractFrontMatter, extractHeadings, extractLinks, extractTags, extractFile, extractWiki, } from './wiki-extractor.js';
// Wiki Graph (Phase W3)
export { loadGraph, queryGraph, buildWikiGraph, analyzeGraph, generateGraphReport, } from './wiki-graph.js';
// Wiki Supplement (Batch B)
export { createWikiCorpusSupplement, createWikiPromptSectionBuilder, } from './wiki-supplement.js';
// Digest Compiler (M6 P0a-2)
export { compileDigest, ensureDigest, isDigestFresh, } from './digest-compiler.js';
//# sourceMappingURL=index.js.map