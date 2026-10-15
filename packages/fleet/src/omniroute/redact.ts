// Shared redaction helpers for the OmniRoute management client and every
// artifact the Reconciler/Observer/Evaluator write (Requirement 22.4, 22.5).
//
// A tokenized URL path segment is the non-empty segment that immediately
// follows the consecutive, case-insensitive segments `api`, `v1`, `vscode`
// (as `<token>` does in `/api/v1/vscode/<token>/`). This is the same
// definition the Inventory_Validator applies (Requirement 22.5); it lives here
// so the HTTP client can *replace* such segments rather than only detect them.

// The single redaction marker used for every credential value and every
// tokenized URL path segment (Requirements 22.4, 22.5). It is intentionally the
// same marker for all redacted values so an output never reveals which value
// (or how many distinct values) was redacted.
export const REDACTION_MARKER = "<redacted>"

// A secret reference in the Fleet_Inventory secret-reference syntax. A tokenized
// segment that is itself a secret reference (e.g. `secret:...`) is exempt from
// redaction per Requirement 22.5; any other value — including a non-secret
// placeholder — is redacted.
const SECRET_REF_RE = /^(secret|secretfile):\S+$/

const isSecretReferenceSegment = (segment: string): boolean => SECRET_REF_RE.test(segment)

// Replace every tokenized URL path segment in `url` with REDACTION_MARKER,
// leaving the scheme, authority, remaining path, query, and fragment unchanged.
// Accepts a full URL or a bare path. Never throws: an unparseable input is
// returned with the same segment-scan applied to its raw text.
export const redactTokenizedSegments = (url: string): string => {
	// Split off scheme://authority (if present) so we only rewrite the path.
	const schemeMatch = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)(\/.*)?$/i.exec(url)
	if (schemeMatch) {
		const authority = schemeMatch[1] ?? ""
		const rest = schemeMatch[2] ?? ""
		return authority + redactPathAndTail(rest)
	}
	return redactPathAndTail(url)
}

// Redact tokenized segments within a path plus optional `?query`/`#fragment`.
// The query and fragment are preserved verbatim (they are not path segments).
const redactPathAndTail = (pathWithTail: string): string => {
	if (pathWithTail.length === 0) return pathWithTail
	const tailMatch = /^([^?#]*)([?#].*)?$/.exec(pathWithTail)
	const pathPart = tailMatch?.[1] ?? pathWithTail
	const tail = tailMatch?.[2] ?? ""

	const leadingSlash = pathPart.startsWith("/")
	const trailingSlash = pathPart.endsWith("/") && pathPart.length > 1
	const segments = pathPart.split("/")

	for (let i = 0; i + 3 < segments.length; i++) {
		if (
			segments[i]?.toLowerCase() === "api" &&
			segments[i + 1]?.toLowerCase() === "v1" &&
			segments[i + 2]?.toLowerCase() === "vscode"
		) {
			const token = segments[i + 3]
			if (token !== undefined && token.length > 0 && !isSecretReferenceSegment(token)) {
				segments[i + 3] = REDACTION_MARKER
			}
		}
	}

	const nonEmpty = segments.filter((s) => s.length > 0)
	let rebuilt = nonEmpty.join("/")
	if (leadingSlash) rebuilt = `/${rebuilt}`
	if (trailingSlash) rebuilt = `${rebuilt}/`
	return rebuilt + tail
}

// Redact every occurrence of each known secret value from an arbitrary text
// summary. Each distinct secret value is replaced with REDACTION_MARKER. Empty
// or whitespace-only secrets are ignored so they never collapse ordinary text.
export const redactSecretValues = (text: string, secrets: readonly string[]): string => {
	let out = text
	for (const secret of secrets) {
		if (typeof secret !== "string" || secret.trim().length === 0) continue
		out = out.split(secret).join(REDACTION_MARKER)
	}
	return out
}

// Produce a redacted, length-bounded summary of an error-response body. The body
// text has every known secret value and every tokenized path segment removed,
// and is truncated so a large body cannot bloat an error or smuggle a credential
// past the length cap. Inference-request/response bodies must never be passed
// here (Requirement 22.6); this is for management-API error bodies only.
export const redactBodySummary = (
	body: string,
	secrets: readonly string[],
	maxLength = 512,
): string => {
	const withoutSecrets = redactSecretValues(body, secrets)
	const withoutTokens = redactTokenizedSegments(withoutSecrets)
	if (withoutTokens.length <= maxLength) return withoutTokens
	return `${withoutTokens.slice(0, maxLength)}…[truncated]`
}
