/**
 * Digest Compiler — M6 P0a-2
 *
 * Scans wiki vault Markdown pages, extracts core claims (frontmatter + first paragraph
 * + heading structure), and generates `.openclaw-wiki/cache/agent-digest.json`.
 *
 * Format matches official memory-wiki's prompt-section.ts expectations:
 *   { claimCount, pages: [{ title, kind, claimCount, topClaims, questions, contradictions }], contradictionClusters }
 *
 * Constants match official: MAX_PAGES=4, MAX_CLAIMS_PER_PAGE=2, freshness grading.
 *
 * Hooked into wiki_build / wiki_index tool chain for automatic production.
 *
 * IMPORTANT: DV-1 fix (4.2.3) — no longer inlines its own env-chain default.
 * Resolves the vault root through wiki-store's single resolution point
 * (config.vault.path > env > default) while still accepting explicit
 * options.vaultPath overrides (test fixtures, arbitrary vault paths).
 */

import * as fs from 'fs';
import * as path from 'path';
import { getWikiRoot } from './wiki-store.js';

// ── Constants ──────────────────────────────────────────────────────────

const AGENT_DIGEST_REL = '.openclaw-wiki/cache/agent-digest.json';
const DIGEST_MAX_PAGES = 4;
const DIGEST_MAX_CLAIMS_PER_PAGE = 2;

// Standard wiki categories
const STANDARD_CATEGORIES = ['concepts', 'decisions', 'procedures', 'references', 'snippets'];

// Directories to skip during scanning
const SKIP_DIRS = new Set([
  '.', '..', '.openclaw-wiki', 'graphify-out', 'legacy', 'memory-vaults',
  'archive', 'templates', 'node_modules', '.git',
]);

// Freshness thresholds (days)
const FRESH_THRESHOLD_DAYS = 7;
const AGING_THRESHOLD_DAYS = 30;

// ── Front Matter Parsing (local, no WIKI_ROOT dependency) ──────────────

/**
 * Parse YAML front matter from markdown content.
 * Returns null if no valid front matter found.
 */
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
        const inner = value.slice(1, -1);
        metadata.tags = inner
          .split(',')
          .map(t => t.trim().replace(/^["']|["']$/g, ''))
          .filter(t => t.length > 0);
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

/**
 * Extract body content after front matter.
 */
function extractBody(content) {
  if (!content.startsWith('---')) return content;
  const parts = content.split('---');
  if (parts.length < 3) return content;
  return parts.slice(2).join('---').trim();
}

// ── Freshness Grading ──────────────────────────────────────────────────

/**
 * Compute freshness level from an ISO 8601 timestamp.
 * Returns 'fresh' | 'aging' | 'stale'.
 */
function computeFreshness(timestamp) {
  if (!timestamp) return 'stale';
  try {
    const then = new Date(timestamp).getTime();
    if (isNaN(then)) return 'stale';
    const now = Date.now();
    const daysSince = (now - then) / (1000 * 60 * 60 * 24);
    if (daysSince <= FRESH_THRESHOLD_DAYS) return 'fresh';
    if (daysSince <= AGING_THRESHOLD_DAYS) return 'aging';
    return 'stale';
  } catch {
    return 'stale';
  }
}

// ── Claim Extraction ───────────────────────────────────────────────────

/**
 * Extract the first non-empty, non-heading, non-front-matter paragraph from body.
 */
function extractFirstParagraph(body) {
  const lines = body.split(/\r?\n/);
  let inCodeBlock = false;
  const paragraphLines = [];

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const trimmed = line.trim();
    if (!trimmed || trimmed === '---' || trimmed.startsWith('#') ||
        trimmed.startsWith('- ') || trimmed.startsWith('* ') ||
        trimmed.startsWith('|') || trimmed.startsWith('<!--') ||
        trimmed.startsWith('>') || /^\d+[.)]\s/.test(trimmed)) {
      if (paragraphLines.length > 0) break;
      continue;
    }
    paragraphLines.push(trimmed);
  }

  return paragraphLines.join(' ').trim();
}

/**
 * Extract claims from a wiki page.
 */
function extractClaimsFromPage(frontMatter, body) {
  const claims = [];
  const fm = frontMatter;

  // Claim 1: First paragraph as primary claim
  const firstPara = extractFirstParagraph(body);
  if (firstPara) {
    const truncated = firstPara.length > 200
      ? firstPara.slice(0, 197) + '…'
      : firstPara;
    claims.push({
      text: truncated,
      status: fm.status || undefined,
      confidence: fm.confidence ?? undefined,
      freshnessLevel: computeFreshness(fm.updated || fm.created),
      updatedAt: fm.updated || fm.created || undefined,
    });
  }

  // Claim 2+: Extract from ## headings (topic claims)
  const headingLines = body.split(/\r?\n/).filter(l => /^##\s/.test(l.trim()));
  for (const heading of headingLines) {
    if (claims.length >= 5) break;
    const headingText = heading.replace(/^##+\s*/, '').trim();
    if (!headingText || headingText.length < 3) continue;
    const genericHeadings = ['内容', '概述', '定义', '参考', '相关', '备注', '详情'];
    if (genericHeadings.includes(headingText)) continue;

    claims.push({
      text: `Topic: ${headingText}`,
      status: fm.status || undefined,
      confidence: fm.confidence ?? undefined,
      freshnessLevel: computeFreshness(fm.updated || fm.created),
      updatedAt: fm.updated || fm.created || undefined,
    });
  }

  return claims;
}

/**
 * Extract open questions from a wiki page.
 */
function extractQuestions(body) {
  const questions = [];
  const lines = body.split(/\r?\n/);
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) { inCodeBlock = !inCodeBlock; continue; }
    if (inCodeBlock) continue;
    const trimmed = line.trim();
    if ((trimmed.startsWith('- ') || trimmed.startsWith('* ')) && trimmed.endsWith('?')) {
      const q = trimmed.replace(/^[-*]\s+/, '').trim();
      if (q.length > 3 && q.length < 200) questions.push(q);
    }
  }

  return questions.slice(0, 5);
}

/**
 * Extract contradiction notes from a wiki page.
 */
function extractContradictions(body) {
  const contradictions = [];
  const lines = body.split(/\r?\n/);
  let inContradictionSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##+\s/.test(trimmed)) {
      const heading = trimmed.replace(/^##+\s*/, '').toLowerCase();
      // Narrow contradiction detection: issue/“不一致” sections are often symptoms + mitigation,
      // not claim-vs-claim contradictions. Only explicit contradiction/conflict sections count.
      inContradictionSection = /矛盾|contradiction|冲突/.test(heading) && !/缓解|mitigation|已知问题/.test(heading);
      continue;
    }
    if (inContradictionSection && (trimmed.startsWith('- ') || trimmed.startsWith('* '))) {
      const note = trimmed.replace(/^[-*]\s+/, '').trim();
      if (note.length > 3 && note.length < 200) contradictions.push(note);
    }
  }

  return contradictions.slice(0, 5);
}

// ── Page Scoring ───────────────────────────────────────────────────────

function scorePageForDigest(page) {
  return (
    (page.contradictions?.length ?? 0) * 6 +
    (page.questions?.length ?? 0) * 4 +
    Math.min(page.claimCount ?? 0, 6) * 2 +
    Math.min(page.topClaims?.length ?? 0, 3)
  );
}

// ── Vault Scanning ─────────────────────────────────────────────────────

/**
 * Scan a vault directory for all markdown pages with valid front matter.
 * Returns array of { relativePath, frontMatter, body, rawContent }.
 */
function scanVaultPages(vaultPath) {
  const pages = [];
  const normalizedVault = path.resolve(vaultPath);

  if (!fs.existsSync(normalizedVault)) return pages;

  // Scan standard categories + non-standard directories
  const topEntries = fs.readdirSync(normalizedVault, { withFileTypes: true });

  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;

    const dirPath = path.join(normalizedVault, entry.name);
    scanDirectory(dirPath, entry.name, pages);
  }

  return pages;
}

/**
 * Recursively scan a directory for markdown files with front matter.
 */
function scanDirectory(dirPath, prefix, pages) {
  if (!fs.existsSync(dirPath)) return;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.join(prefix, entry.name).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        scanDirectory(fullPath, relativePath, pages);
      }
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('_')) continue;

    try {
      const rawContent = fs.readFileSync(fullPath, 'utf8');
      const frontMatter = parseFrontMatterLocal(rawContent);
      if (!frontMatter) continue; // Skip pages without valid front matter

      const body = extractBody(rawContent);
      pages.push({ relativePath, frontMatter, body, rawContent });
    } catch {
      // Skip unreadable files
    }
  }
}

// ── Main Compiler ──────────────────────────────────────────────────────

/**
 * Compile wiki vault into agent-digest.json.
 *
 * @param {Object} options
 * @param {string} [options.vaultPath] - Wiki vault path (default: configured wiki root)
 * @param {boolean} [options.dryRun] - If true, return digest without writing
 * @returns {Object} The compiled digest
 */
export function compileDigest(options = {}) {
  const vaultPath = options.vaultPath || getWikiRoot();
  const dryRun = options.dryRun ?? false;

  // 1. Scan all wiki pages
  const scannedPages = scanVaultPages(vaultPath);
  const allPages = [];

  for (const { relativePath, frontMatter, body } of scannedPages) {
    const claims = extractClaimsFromPage(frontMatter, body);
    const questions = extractQuestions(body);
    const contradictions = extractContradictions(body);

    allPages.push({
      title: frontMatter.title,
      kind: frontMatter.category,
      path: relativePath,
      claimCount: claims.length,
      topClaims: claims.slice(0, DIGEST_MAX_CLAIMS_PER_PAGE + 2), // Extract more, trim later
      questions,
      contradictions,
      updatedAt: frontMatter.updated || frontMatter.created,
    });
  }

  // 2. Sort pages by score (descending), then by title
  allPages.sort((a, b) => {
    const scoreA = scorePageForDigest(a);
    const scoreB = scorePageForDigest(b);
    if (scoreA !== scoreB) return scoreB - scoreA;
    return a.title.localeCompare(b.title);
  });

  // 3. Select top pages for digest
  const selectedPages = allPages
    .filter(p => p.claimCount > 0 || p.questions.length > 0 || p.contradictions.length > 0)
    .slice(0, DIGEST_MAX_PAGES);

  // 4. Trim topClaims to MAX_CLAIMS_PER_PAGE for each selected page
  for (const page of selectedPages) {
    page.topClaims = page.topClaims.slice(0, DIGEST_MAX_CLAIMS_PER_PAGE);
  }

  // 5. Build digest object
  const totalClaims = allPages.reduce((sum, p) => sum + p.claimCount, 0);
  const digest = {
    claimCount: totalClaims,
    totalPages: allPages.length,
    pages: selectedPages,
    contradictionClusters: [],
    compiledAt: new Date().toISOString(),
  };

  // 6. Write to cache (unless dry run)
  if (!dryRun) {
    const cacheDir = path.join(vaultPath, '.openclaw-wiki', 'cache');
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    const digestPath = path.join(vaultPath, AGENT_DIGEST_REL);
    fs.writeFileSync(digestPath, JSON.stringify(digest, null, 2), 'utf-8');
  }

  return digest;
}

/**
 * Check if digest cache exists and is fresh enough.
 */
export function isDigestFresh(vaultPath, maxAgeMs = 3600000) {
  const resolvedPath = vaultPath || getWikiRoot();
  const digestPath = path.join(resolvedPath, AGENT_DIGEST_REL);
  if (!fs.existsSync(digestPath)) return false;

  try {
    const raw = fs.readFileSync(digestPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed?.compiledAt) return false;
    const age = Date.now() - new Date(parsed.compiledAt).getTime();
    return age < maxAgeMs;
  } catch {
    return false;
  }
}

/**
 * Compile digest if not fresh, or force recompile.
 */
export function ensureDigest(options = {}) {
  const vaultPath = options.vaultPath || getWikiRoot();
  if (!options.force && isDigestFresh(vaultPath)) {
    const digestPath = path.join(vaultPath, AGENT_DIGEST_REL);
    try {
      return JSON.parse(fs.readFileSync(digestPath, 'utf8'));
    } catch {
      // Fall through to recompile
    }
  }
  return compileDigest(options);
}
