/** Longest error text recorded in a parallel worker result or batch manifest. */
export const MAX_RECORDED_ERROR_CHARS = 4096

/**
 * Bounds error text before it is persisted. Process errors (for example an execa `maxBuffer`
 * failure) embed the whole captured stdout in their message, which previously produced
 * manifest files of tens of megabytes that are re-read on every model turn.
 */
export function boundErrorText(text: string, maxChars: number = MAX_RECORDED_ERROR_CHARS): string {
	if (text.length <= maxChars) {
		return text
	}
	return `${text.slice(0, maxChars)}… [truncated ${text.length - maxChars} characters]`
}
