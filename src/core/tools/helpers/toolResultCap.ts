/** Maximum characters (~30k tokens) a file-discovery tool result may occupy in history. */
export const MAX_DISCOVERY_RESULT_CHARS = 120_000

/** Tools whose results can grow without bound and are capped before entering history. */
export const DISCOVERY_RESULT_TOOLS: readonly string[] = ["list_files", "search_files", "read_file", "codebase_search"]

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

/**
 * Caps tool result text to `maxChars`, keeping the head (2/3) and tail (1/3) and inserting a
 * notice that tells the model how to narrow the request. Never splits a surrogate pair.
 */
export function capToolResultText(text: string, maxChars: number = MAX_DISCOVERY_RESULT_CHARS): string {
	if (text.length <= maxChars) {
		return text
	}

	let headEnd = Math.floor((maxChars * 2) / 3)
	let tailStart = text.length - (maxChars - headEnd)

	// Avoid cutting a surrogate pair in half at either boundary.
	if (headEnd > 0 && isHighSurrogate(text.charCodeAt(headEnd - 1))) {
		headEnd -= 1
	}
	if (tailStart < text.length && isLowSurrogate(text.charCodeAt(tailStart))) {
		tailStart += 1
	}

	const omitted = tailStart - headEnd
	const notice =
		`\n\n[Result truncated: ${omitted} characters omitted from the middle because the output was too large. ` +
		`Narrow the path, regex or file_pattern, or read the file with offset/limit to see the rest.]\n\n`

	return text.slice(0, headEnd) + notice + text.slice(tailStart)
}
