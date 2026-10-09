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

/**
 * Directory names the code indexer skips in addition to the shared `DIRS_TO_IGNORE` denylist.
 *
 * These are documentation / translation trees that are high-volume and low-value for code search. A large
 * monorepo (e.g. OmniRoute) can carry 10k+ markdown files under `docs/i18n/`, which the scanner would otherwise
 * parse into hundreds of thousands of tree-sitter "blocks".
 *
 * Excluded names (directory-name based, matched on any path segment so nested variants like `docs/i18n/...`,
 * `src/i18n/...`, and `packages/x/locales/...` are all caught):
 *   - "i18n"
 *   - "locales"
 *   - "translations"
 *
 * IMPORTANT: these are index-only. They are deliberately NOT added to `src/services/glob/constants.ts`
 * (`DIRS_TO_IGNORE`), because that list also backs `src/services/glob/list-files.ts`, which powers the agent's
 * general file-listing tools. Adding these names there would hide i18n/locale dirs from the agent app-wide. The
 * exclusion here applies to the code indexer only, via `isPathInIndexExcludedDirectory()`.
 */
export const INDEX_EXCLUDED_DIRS = ["i18n", "locales", "translations"] as const

/**
 * Hard cap on the number of indexable files handed to the parser in a single full scan.
 *
 * This is a second, tighter backstop below `MAX_LIST_FILES_LIMIT_CODE_INDEX` (50_000, applied at the `listFiles`
 * layer). `MAX_INDEX_SCAN_FILES` is applied AFTER .rooignore / ignored-dir / extension / index-exclude filtering,
 * so it bounds the count of files that would actually be parsed and embedded. On a genuinely unbounded tree the
 * scanner truncates to this many files and surfaces one prominent warning (via the existing `onError` path)
 * telling the user to add a `.rooignore`.
 *
 * Tradeoff: a precise per-block mid-scan abort would require reworking the existing parallel `pLimit` / mutex /
 * `AbortSignal` batching machinery, which is fragile and invasive. Capping the pre-parse file list is
 * deterministic, cheap, and surfaces cleanly through the existing status/error path. The value (25_000) sits
 * above every known-good repo but below the OmniRoute pathological case; once i18n/locale/translation dirs are
 * excluded a normal repo drops well under it, so the cap only trips on truly unbounded trees.
 */
export const MAX_INDEX_SCAN_FILES = 25_000
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
