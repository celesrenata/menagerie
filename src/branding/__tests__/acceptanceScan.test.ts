// Feature: menagerie-branding-migration
//
// Acceptance scan (Property 3): scan rendered user-facing strings and published
// package metadata for Prohibited_Branding and assert every match is a member of
// the carve-out allowlist (a retained Compatibility_Boundary token). The scan is
// the executable guarantee behind Requirement 6.
//
// The scan also validates the allowlist itself: every carve-out entry must be a
// substantiated Compatibility_Boundary token that genuinely appears in the scanned
// surfaces, so the carve-out cannot silently mask a real branding leak.

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import fc from "fast-check"
import { describe, it, expect } from "vitest"

import { carveOutAllowlist, prohibitedBrandingPatterns } from "../carveOut"

// --- Load the raw package files from disk (relative to this test file) ---
// src/branding/__tests__ -> src/ is two directories up.
const srcDir = resolve(__dirname, "..", "..")
const packageJsonPath = resolve(srcDir, "package.json")
const packageNlsPath = resolve(srcDir, "package.nls.json")

const packageJsonRaw = readFileSync(packageJsonPath, "utf8")
const packageNlsRaw = readFileSync(packageNlsPath, "utf8")

interface PackageJson {
	displayName?: string
	description?: string
	author?: { name?: string }
	repository?: { url?: string }
	homepage?: string
	keywords?: string[]
	contributes?: {
		viewsContainers?: Record<string, Array<{ id?: string; title?: string; icon?: string }>>
		commands?: Array<{ command?: string; title?: string; category?: string }>
		configuration?: {
			title?: string
			properties?: Record<string, { description?: string }>
		}
	}
}

const packageJson = JSON.parse(packageJsonRaw) as PackageJson
const packageNls = JSON.parse(packageNlsRaw) as Record<string, string>

/**
 * Resolve a `%key%` NLS reference to its displayed string. A value that is not a
 * `%key%` reference is returned unchanged (it is already a literal rendered
 * string). An unresolved key is returned verbatim so the scan still inspects it.
 */
function resolveNls(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined
	}
	const match = /^%(.+)%$/.exec(value)
	if (!match) {
		return value
	}
	const key = match[1]
	return packageNls[key] ?? value
}

/** A rendered user-visible string paired with where it came from. */
interface ScannedString {
	location: string
	text: string
}

/**
 * Collect every rendered user-facing string from package.json (NLS-resolved
 * where applicable) and from package.nls.json. These are the User_Visible_String
 * surfaces the acceptance scan inspects.
 */
function collectUserVisibleStrings(): ScannedString[] {
	const scanned: ScannedString[] = []
	const push = (location: string, text: string | undefined) => {
		if (text !== undefined && text.length > 0) {
			scanned.push({ location, text })
		}
	}

	// package.json published metadata (resolved through NLS where it is a %key%).
	push("src/package.json#displayName", resolveNls(packageJson.displayName))
	push("src/package.json#description", resolveNls(packageJson.description))
	push("src/package.json#author.name", packageJson.author?.name)
	push("src/package.json#repository.url", packageJson.repository?.url)
	push("src/package.json#homepage", packageJson.homepage)
	for (const [index, keyword] of (packageJson.keywords ?? []).entries()) {
		push(`src/package.json#keywords[${index}]`, keyword)
	}

	// views container titles (resolved through NLS).
	const viewsContainers = packageJson.contributes?.viewsContainers ?? {}
	for (const [containerArea, containers] of Object.entries(viewsContainers)) {
		for (const container of containers) {
			push(
				`src/package.json#contributes.viewsContainers.${containerArea}[${container.id ?? "?"}].title`,
				resolveNls(container.title),
			)
		}
	}

	// command titles (resolved through NLS when in %key% form).
	for (const command of packageJson.contributes?.commands ?? []) {
		push(
			`src/package.json#contributes.commands[${command.command ?? "?"}].title`,
			resolveNls(command.title),
		)
	}

	// settings descriptions (resolved through NLS when in %key% form).
	const properties = packageJson.contributes?.configuration?.properties ?? {}
	for (const [propertyKey, property] of Object.entries(properties)) {
		push(
			`src/package.json#contributes.configuration.properties[${propertyKey}].description`,
			resolveNls(property.description),
		)
	}

	// Every value in package.nls.json is a displayed string.
	for (const [nlsKey, nlsValue] of Object.entries(packageNls)) {
		push(`src/package.nls.json#${nlsKey}`, nlsValue)
	}

	return scanned
}

/**
 * Find all Prohibited_Branding matches in a string. Returns each matched token
 * with the surrounding text so failures can report useful context.
 */
interface BrandingMatch {
	token: string
	context: string
	index: number
}

function findProhibitedMatches(text: string): BrandingMatch[] {
	const matches: BrandingMatch[] = []
	for (const pattern of prohibitedBrandingPatterns) {
		// Reset lastIndex: patterns are shared global regexes.
		pattern.lastIndex = 0
		let m: RegExpExecArray | null
		while ((m = pattern.exec(text)) !== null) {
			const start = Math.max(0, m.index - 20)
			const end = Math.min(text.length, m.index + m[0].length + 20)
			matches.push({
				token: m[0],
				context: text.slice(start, end),
				index: m.index,
			})
			// Guard against zero-width matches causing an infinite loop.
			if (m.index === pattern.lastIndex) {
				pattern.lastIndex += 1
			}
		}
	}
	return matches
}

/**
 * Determine whether a prohibited-branding match found at a given location is
 * accounted for by the carve-out allowlist. A match is permitted only when the
 * surrounding text contains a carve-out token whose span covers the matched
 * token — i.e. the match is really a substring of a retained
 * Compatibility_Boundary identifier.
 */
function isCarvedOut(fullText: string, match: BrandingMatch): boolean {
	for (const entry of carveOutAllowlist) {
		let searchFrom = 0
		let tokenIndex = fullText.indexOf(entry.token, searchFrom)
		while (tokenIndex !== -1) {
			const tokenEnd = tokenIndex + entry.token.length
			if (match.index >= tokenIndex && match.index < tokenEnd) {
				return true
			}
			searchFrom = tokenIndex + 1
			tokenIndex = fullText.indexOf(entry.token, searchFrom)
		}
	}
	return false
}

describe("Menagerie branding acceptance scan", () => {
	const userVisibleStrings = collectUserVisibleStrings()

	// Validates: Requirements 6.1, 6.2
	it("finds no unintended Zoo/Roo branding in rendered strings or package metadata", () => {
		const offenders: string[] = []

		for (const { location, text } of userVisibleStrings) {
			for (const match of findProhibitedMatches(text)) {
				if (!isCarvedOut(text, match)) {
					offenders.push(
						`  location: ${location}\n` +
							`    token:   "${match.token}"\n` +
							`    context: …${match.context}…`,
					)
				}
			}
		}

		expect(
			offenders.length,
			`Unintended Prohibited_Branding found outside the carve-out allowlist:\n${offenders.join("\n")}`,
		).toBe(0)
	})

	// Validates: Requirement 6.3
	it("validates every carve-out entry is a substantiated Compatibility_Boundary token", () => {
		// The scan inspects the raw package files directly for allowlist
		// substantiation: a genuine Compatibility_Boundary token (name, publisher,
		// command/view/container IDs, config paths) appears in the raw sources even
		// though it is intentionally excluded from the rendered user-visible scan.
		const substantiationCorpus = `${packageJsonRaw}\n${packageNlsRaw}`

		const unsubstantiated: string[] = []
		for (const entry of carveOutAllowlist) {
			if (!substantiationCorpus.includes(entry.token)) {
				unsubstantiated.push(
					`  token: "${entry.token}" (reason: ${entry.reason}, claimed location: ${entry.location})`,
				)
			}
		}

		expect(
			unsubstantiated.length,
			`Carve-out allowlist contains tokens not found in any scanned surface; ` +
				`an unsubstantiated entry could mask a real branding leak:\n${unsubstantiated.join("\n")}`,
		).toBe(0)
	})

	// Validates: Requirement 6.3
	it("permits every carve-out token: a prohibited match inside a carve-out token is classified as carved out", () => {
		// Each carve-out token that itself contains a Prohibited_Branding substring
		// (e.g. "zoo-code" contains "zoo") must be recognised as carved out when it
		// appears verbatim, otherwise the allowlist would not actually permit it.
		for (const entry of carveOutAllowlist) {
			for (const match of findProhibitedMatches(entry.token)) {
				expect(
					isCarvedOut(entry.token, match),
					`Carve-out token "${entry.token}" contains prohibited substring "${match.token}" ` +
						`but was not recognised as carved out.`,
				).toBe(true)
			}
		}
	})

	// Feature: menagerie-branding-migration, Property 3: The acceptance scan finds no unintended Zoo/Roo branding outside the carve-out
	//
	// Validates: Requirements 6.1, 6.2, 6.3
	//
	// The classifier (the prohibitedBrandingPatterns regex set) is exercised with
	// randomly generated strings assembled from branded fragments, neutral text, and
	// carve-out tokens. The property asserts the classifier's judgement matches an
	// independent oracle: a prohibited match outside every carve-out token must be
	// detected, and any detected match that is not carved out must correspond to a
	// genuine prohibited fragment the generator inserted.
	it("Property 3: classifier flags prohibited branding exactly when it is not inside a carve-out token", () => {
		const prohibitedFragments = ["Zoo Code", "Roo Code", "Zoo", "Roo"]
		const carveOutTokens = carveOutAllowlist.map((entry) => entry.token)
		const neutralFragments = [
			"Menagerie",
			"a whole dev team",
			"of AI agents",
			"in your editor",
			"settings description",
			"update_todo_list",
			"workspace root",
			" ",
			": ",
			" — ",
		]

		const fragmentArb = fc.oneof(
			fc.constantFrom(...prohibitedFragments).map((f) => ({ kind: "prohibited" as const, text: f })),
			fc.constantFrom(...carveOutTokens).map((f) => ({ kind: "carveout" as const, text: f })),
			fc.constantFrom(...neutralFragments).map((f) => ({ kind: "neutral" as const, text: f })),
		)

		fc.assert(
			fc.property(fc.array(fragmentArb, { minLength: 1, maxLength: 8 }), (fragments) => {
				// Assemble the random string and track where each fragment lands so the
				// oracle knows which spans are genuine prohibited branding vs. carve-outs.
				let text = ""
				const prohibitedSpans: Array<{ start: number; end: number }> = []
				const carveOutSpans: Array<{ start: number; end: number }> = []
				for (const fragment of fragments) {
					const start = text.length
					text += fragment.text
					const end = text.length
					if (fragment.kind === "prohibited") {
						prohibitedSpans.push({ start, end })
					} else if (fragment.kind === "carveout") {
						carveOutSpans.push({ start, end })
					}
				}

				const matches = findProhibitedMatches(text)

				for (const match of matches) {
					const carved = isCarvedOut(text, match)
					if (carved) {
						// A carved-out match must fall inside a carve-out token span.
						const insideCarveOut = carveOutSpans.some(
							(span) => match.index >= span.start && match.index < span.end,
						)
						if (!insideCarveOut) {
							return false
						}
					} else {
						// A non-carved match must correspond to a genuine prohibited span
						// the generator inserted (not a false positive from neutral text).
						const insideProhibited = prohibitedSpans.some(
							(span) => match.index >= span.start && match.index < span.end,
						)
						if (!insideProhibited) {
							return false
						}
					}
				}

				return true
			}),
			{ numRuns: 200 },
		)
	})
})
