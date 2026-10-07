import type OpenAI from "openai"

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default maximum lines to return per file (Codex-inspired predictable limit) */
export const DEFAULT_LINE_LIMIT = 2000

/** Default aggregate line budget shared across a batched read when limit is omitted. */
export const DEFAULT_BATCH_LINE_BUDGET = 2400

/** Maximum characters per line before truncation */
export const MAX_LINE_LENGTH = 2000

/** Default indentation levels to include above anchor (0 = unlimited) */
export const DEFAULT_MAX_LEVELS = 0

// ─── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Generates the file support note, optionally including image format support.
 *
 * @param supportsImages - Whether the model supports image processing
 * @returns Support note string
 */
function getReadFileSupportsNote(supportsImages: boolean): string {
	if (supportsImages) {
		return `Supports text extraction from PDF and DOCX files. Automatically processes and returns image files (PNG, JPG, JPEG, GIF, BMP, SVG, WEBP, ICO, AVIF) for visual analysis. May not handle other binary files properly.`
	}
	return `Supports text extraction from PDF and DOCX files, but may not handle other binary files properly.`
}

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Options for creating the read_file tool definition.
 */
export interface ReadFileToolOptions {
	/** Whether the model supports image processing (default: false) */
	supportsImages?: boolean
}

// ─── Schema Builder ───────────────────────────────────────────────────────────

/**
 * Creates the read_file tool definition with Codex-inspired modes.
 *
 * Two reading modes are supported:
 *
 * 1. **Slice Mode** (default): Simple offset/limit reading
 *    - Reads contiguous lines starting from `offset` (1-based, default: 1)
 *    - Limited to `limit` lines (default: 2000)
 *    - Predictable and efficient for agent planning
 *
 * 2. **Indentation Mode**: Semantic code block extraction
 *    - Anchored on a specific line number (1-based)
 *    - Extracts the block containing that line plus context
 *    - Respects code structure based on indentation hierarchy
 *    - Useful for extracting functions, classes, or logical blocks
 *
 * @param options - Configuration options for the tool
 * @returns Native tool definition for read_file
 */
export function createReadFileTool(options: ReadFileToolOptions = {}): OpenAI.Chat.ChatCompletionTool {
	const { supportsImages = false } = options

	// Build description based on capabilities
	const descriptionIntro =
		`Read up to eight files in one call. path MUST be an array, even when reading only one file. Put every already-known independent file path in the same array; do not issue one read_file call per file across separate turns. Results are returned in the same order. When limit is omitted, a batched read shares a ${DEFAULT_BATCH_LINE_BUDGET}-line default budget across its files (while a single-file read keeps the ${DEFAULT_LINE_LIMIT}-line default). Set an explicit larger limit only when the extra raw text is genuinely needed. When parallel_tasks/project-reader is available, prefer reader workers for broad repository investigation so raw file contents stay out of the coordinator context.`

	const modeDescription =
		` Supports two modes: 'slice' (default) reads lines sequentially with offset/limit; 'indentation' extracts complete semantic code blocks around an anchor line based on indentation hierarchy.` +
		` Slice mode is ideal for initial file exploration, understanding overall structure, reading configuration/data files, or when you need a specific line range. Use it when you don't have a target line number.` +
		` PREFER indentation mode when you have a specific line number from search results, error messages, or definition lookups - it guarantees complete, syntactically valid code blocks without mid-function truncation.` +
		` IMPORTANT: Indentation mode requires anchor_line to be useful. Without it, only header content (imports) is returned.`

	const limitNote = ` A single-file read defaults to ${DEFAULT_LINE_LIMIT} lines; batched reads share the ${DEFAULT_BATCH_LINE_BUDGET}-line default budget. Lines longer than ${MAX_LINE_LENGTH} characters are truncated.`

	const notFoundNote = ` If a path does not exist, this returns a "did you mean" list of near-match candidate paths to re-read (or states no similar files were found) rather than a fatal error — verify the intended path and re-read a candidate.`

	const description =
		descriptionIntro +
		modeDescription +
		limitNote +
		notFoundNote +
		" " +
		getReadFileSupportsNote(supportsImages) +
		` Example (one file): { path: ['src/app.ts'] }` +
		` Example (batch): { path: ['src/app.ts', 'src/config.ts'] }` +
		` Example (indentation mode): { path: ['src/app.ts'], mode: 'indentation', indentation: { anchor_line: 42 } }`

	const indentationProperties: Record<string, unknown> = {
		anchor_line: {
			type: "integer",
			description:
				"1-based line number to anchor the extraction. REQUIRED for meaningful indentation mode results. The extractor finds the semantic block (function, method, class) containing this line and returns it completely. Without anchor_line, indentation mode defaults to line 1 and returns only imports/header content. Obtain anchor_line from: search results, error stack traces, definition lookups, codebase_search results, or condensed file summaries (e.g., '14--28 | export class UserService' means anchor_line=14).",
		},
		max_levels: {
			type: "integer",
			description: `Maximum indentation levels to include above the anchor (indentation mode, 0 = unlimited (default)). Higher values include more parent context.`,
		},
		include_siblings: {
			type: "boolean",
			description:
				"Include sibling blocks at the same indentation level as the anchor block (indentation mode, default: false). Useful for seeing related methods in a class.",
		},
		include_header: {
			type: "boolean",
			description:
				"Include file header content (imports, module-level comments) at the top of output (indentation mode, default: true).",
		},
		max_lines: {
			type: "integer",
			description:
				"Hard cap on lines returned for indentation mode. Acts as a separate limit from the top-level 'limit' parameter.",
		},
	}

	const properties: Record<string, unknown> = {
		path: {
			type: "array",
			minItems: 1,
			maxItems: 8,
			items: { type: "string" },
			description:
				"Required array of one to eight workspace-relative paths. Use a one-item array for a single file and combine all already-known independent files into one call.",
		},
		mode: {
			type: "string",
			enum: ["slice", "indentation"],
			description:
				"Reading mode. 'slice' (default): read lines sequentially with offset/limit - use for general file exploration or when you don't have a target line number (may truncate code mid-function). 'indentation': extract complete semantic code blocks containing anchor_line - PREFERRED when you have a line number because it guarantees complete, valid code blocks. WARNING: Do not use indentation mode without specifying indentation.anchor_line, or you will only get header content.",
		},
		offset: {
			type: "integer",
			description: "1-based line offset to start reading from (slice mode, default: 1)",
		},
		limit: {
			type: "integer",
			description: `Maximum number of lines to return (slice mode, default: ${DEFAULT_LINE_LIMIT})`,
		},
		indentation: {
			type: "object",
			description:
				"Indentation mode options. Only used when mode='indentation'. You MUST specify anchor_line for useful results - it determines which code block to extract.",
			properties: indentationProperties,
			required: [],
			additionalProperties: false,
		},
	}

	return {
		type: "function",
		function: {
			name: "read_file",
			description,
			strict: true,
			parameters: {
				type: "object",
				properties,
				required: ["path"],
				additionalProperties: false,
			},
		},
	} satisfies OpenAI.Chat.ChatCompletionTool
}

/**
 * Default read_file tool with all parameters
 */
export const read_file = createReadFileTool()
