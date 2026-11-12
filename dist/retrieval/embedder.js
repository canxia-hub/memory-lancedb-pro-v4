import { readFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';

const DEFAULT_MULTIMODAL_EMBEDDING_URL = 'https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding';
const DEFAULT_MODEL = 'tongyi-embedding-vision-flash';
const DEFAULT_DIMENSION = 2560;

function mimeFromPath(path) {
  const ext = extname(path).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  return 'image/png';
}

function resolveConfig(config = {}) {
  return {
    provider: config.provider ?? 'dashscope',
    model: config.model ?? DEFAULT_MODEL,
    baseUrl: config.baseUrl ?? config.embeddingBaseUrl ?? DEFAULT_MULTIMODAL_EMBEDDING_URL,
    apiKeyEnv: config.apiKeyEnv ?? 'DASHSCOPE_API_KEY',
    apiKey: config.apiKey ?? process.env[config.apiKeyEnv ?? 'DASHSCOPE_API_KEY'] ?? process.env.DASHSCOPE_API_KEY,
    dimension: config.dimension ?? config.embeddingDimension ?? DEFAULT_DIMENSION,
    nativeDimension: config.nativeDimension ?? 768,
  };
}

export function normalizeEmbeddingDimension(vector, dimension = DEFAULT_DIMENSION) {
  const values = Array.isArray(vector) ? vector.map(Number) : [];
  if (values.length === dimension) return values;
  if (values.length > dimension) return values.slice(0, dimension);
  return values.concat(Array.from({ length: dimension - values.length }).fill(0));
}

export function isZeroVector(vector) {
  return !Array.isArray(vector) || vector.length === 0 || vector.every(v => !v || Math.abs(Number(v)) < 1e-12);
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function imageToDataUrl(image) {
  if (!image) return undefined;
  if (typeof image === 'string' && image.startsWith('data:')) return image;
  if (typeof image === 'string' && /^https?:\/\//i.test(image)) return image;
  if (typeof image === 'string' && existsSync(image)) {
    const mime = mimeFromPath(image);
    const b64 = readFileSync(image).toString('base64');
    return `data:${mime};base64,${b64}`;
  }
  return image;
}

export function buildEmbeddingAvailability(config = {}) {
  const resolved = resolveConfig(config);
  if (String(resolved.provider).toLowerCase() !== 'dashscope') {
    return {
      hasProvider: !!resolved.provider,
      isFunctional: false,
      provider: resolved.provider,
      model: resolved.model,
      dimension: resolved.dimension,
      unavailableReason: `Unsupported embedding provider: ${resolved.provider}`,
    };
  }
  if (!resolved.apiKey) {
    return {
      hasProvider: true,
      isFunctional: false,
      provider: 'dashscope',
      model: resolved.model,
      dimension: resolved.dimension,
      nativeDimension: resolved.nativeDimension,
      unavailableReason: `DashScope API key not found in ${resolved.apiKeyEnv}`,
    };
  }
  return {
    hasProvider: true,
    isFunctional: true,
    provider: 'dashscope',
    model: resolved.model,
    dimension: resolved.dimension,
    nativeDimension: resolved.nativeDimension,
  };
}

export async function embedMultimodal(input = {}, config = {}, options = {}) {
  const resolved = resolveConfig(config);
  if (String(resolved.provider).toLowerCase() !== 'dashscope') {
    throw new Error(`Unsupported embedding provider: ${resolved.provider}`);
  }
  if (!resolved.apiKey) {
    throw new Error(`DashScope API key not found in ${resolved.apiKeyEnv}`);
  }
  const contents = [];
  const text = input.text ?? input.caption ?? input.summary;
  if (text && String(text).trim()) contents.push({ text: String(text) });
  const image = input.image ?? input.imagePath ?? input.storagePath;
  const imageUrl = imageToDataUrl(image);
  if (imageUrl) contents.push({ image: imageUrl });
  if (contents.length === 0) {
    throw new Error('No text or image input provided for embedding');
  }
  const body = {
    model: resolved.model,
    input: { contents },
  };
  const response = await fetch(resolved.baseUrl, {
    method: 'POST',
    signal: options.signal,
    headers: {
      Authorization: `Bearer ${resolved.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const textBody = await response.text();
  let json;
  try { json = JSON.parse(textBody); } catch { json = { message: textBody.slice(0, 300) }; }
  if (!response.ok) {
    throw new Error(`DashScope embedding failed: HTTP ${response.status} ${json.code ?? ''} ${json.message ?? ''}`.trim());
  }
  const vector = json.output?.embeddings?.[0]?.embedding;
  if (!Array.isArray(vector)) {
    throw new Error('DashScope embedding failed: missing output.embeddings[0].embedding');
  }
  const normalized = normalizeEmbeddingDimension(vector, resolved.dimension);
  return {
    embedding: normalized,
    nativeDimension: vector.length,
    dimension: normalized.length,
    model: resolved.model,
    provider: 'dashscope',
    usage: json.usage,
    requestId: json.request_id,
  };
}
