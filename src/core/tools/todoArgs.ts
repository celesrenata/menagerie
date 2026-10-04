// Import-free leaf module: NativeToolCallParser imports this, and its bundle
// (pnpm parser-scope:model-check) must never pull in a vscode-dependent module.

/**
 * Coerce an `update_todo_list.todos` argument into the string form the tool parses.
 *
 * - A string is returned unchanged.
 * - A non-empty array of strings is joined with newlines (one checklist line per item).
 * - Any other array (including `[]`, which becomes `"[]"`) or a non-null object is
 *   JSON-stringified, which `parseMarkdownChecklist` accepts.
 * - Anything else (number, boolean, null, undefined) is returned unchanged so the
 *   caller can report it as invalid.
 */
export function coerceTodosArg(value: unknown): unknown {
	if (typeof value === "string") {
		return value
	}
	if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")) {
		return value.join("\n")
	}
	if (typeof value === "object" && value !== null) {
		return JSON.stringify(value)
	}
	return value
}
