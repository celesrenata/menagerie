import { CODEBASE_INDEX_DEFAULTS } from "@roo-code/types"

/**Parser */
export const MAX_BLOCK_CHARS = 1000
export const MIN_BLOCK_CHARS = 50
export const MIN_CHUNK_REMAINDER_CHARS = 200 // Minimum characters for the *next* chunk after a split
export const MAX_CHARS_TOLERANCE_FACTOR = 1.15 // 15% tolerance for max chars

/**Search */
export const DEFAULT_SEARCH_MIN_SCORE = CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE
export const DEFAULT_MAX_SEARCH_RESULTS = CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS

/**File Watcher */
export const QDRANT_CODE_BLOCK_NAMESPACE = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
export const MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024 // 1MB

/**Directory Scanner */
export const MAX_LIST_FILES_LIMIT_CODE_INDEX = 50_000
export const BATCH_SEGMENT_THRESHOLD = 60 // Number of code segments to batch for embeddings/upserts
export const MAX_BATCH_RETRIES = 3
export const INITIAL_RETRY_DELAY_MS = 500
export const PARSING_CONCURRENCY = 10
export const MAX_PENDING_BATCHES = 20 // Maximum number of batches to accumulate before waiting

/**OpenAI Embedder */
export const MAX_BATCH_TOKENS = 100000
export const MAX_ITEM_TOKENS = 8191
export const BATCH_PROCESSING_CONCURRENCY = 10

/**
 * Embedding request caps, applied to every embeddings HTTP request (see shared/embedding-batches.ts).
 *
 * Local servers (e.g. OVMS on an iGPU) run one request as one GPU batch padded to its longest item, so an
 * uncapped request carrying every chunk of a large file can exhaust memory and crash the server.
 *
 * These are deliberately independent of `codeIndex.embeddingBatchSize` (default 60): that setting controls how
 * many segments the scanner accumulates per createEmbeddings() call and the Qdrant upsert size, while these
 * bound the size of each wire request inside that call. A 60-segment scanner batch becomes two requests.
 */
export const MAX_EMBEDDING_REQUEST_ITEMS = 32
/** Budget for items x longest item's estimated tokens in one request (approximates the padded GPU batch). */
export const MAX_EMBEDDING_REQUEST_PADDED_TOKENS = 16384
/** Maximum halvings of a request after a 5xx/connection error (32 -> 1 needs 5). */
export const MAX_EMBEDDING_SPLIT_DEPTH = 5

/**Gemini Embedder */
export const GEMINI_MAX_ITEM_TOKENS = 2048
