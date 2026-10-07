import { describe, it, expect } from "vitest"

import { DEFAULT_READ_DENYLIST } from "@roo-code/types"

import { isDeniedRead, extractKnownTargetPaths, mergeReadDenylist, type ReadDenylistConfig } from "../readDenylist"

const DEFAULT: ReadDenylistConfig = DEFAULT_READ_DENYLIST

describe("isDeniedRead truth table (design Testability / AC-1..AC-8)", () => {
	const deniedRows: ReadonlyArray<[string, string]> = [
		["node_modules/@types/react/index.d.ts", "vendored typings via node_modules segment"],
		["typescript/lib/lib.dom.d.ts", "vendored typescript lib typings glob"],
		["package-lock.json", "lockfile basename"],
		["app.min.js", "minified bundle glob"],
		["dist/bundle.js", "root-anchored dist build output"],
		["out/x.js", "root-anchored out build output"],
		["target/dependency/foo.jar", "two-segment build-dependency glob"],
	]

	it.each(deniedRows)("denies %s (%s)", (relPath) => {
		const result = isDeniedRead(relPath, DEFAULT)
		expect(result.denied).toBe(true)
		expect(result.category).toBeTruthy()
	})

	const allowedRows: ReadonlyArray<[string, string]> = [
		["src/core/task/Task.ts", "first-party source"],
		["src/types/global.d.ts", "first-party ambient declaration (not vendored)"],
		["docs/x.md", "first-party doc"],
		["packages/pkg/index.ts", "pkg is a first-party root, not denied"],
		["src/features/build/pipeline.ts", "nested build segment, not root-anchored"],
		["services/deps/client.ts", "deps is a first-party root, not denied"],
		["fixtures/sample.map", "broad *.map is not denied (only *.js.map/*.css.map)"],
		["webview-ui/out/README.md", "nested out, not root-anchored"],
	]

	it.each(allowedRows)("allows %s (%s)", (relPath) => {
		expect(isDeniedRead(relPath, DEFAULT).denied).toBe(false)
	})

	it("short-circuits a denied path when knownTarget is set (AC-5 override)", () => {
		const relPath = "node_modules/@types/react/index.d.ts"
		expect(isDeniedRead(relPath, DEFAULT).denied).toBe(true)
		expect(isDeniedRead(relPath, DEFAULT, { knownTarget: true }).denied).toBe(false)
	})

	it("allows a vendored .d.ts once the globs category is cleared (AC-6/AC-7)", () => {
		const cleared = mergeReadDenylist({ globs: [] }, DEFAULT)
		// node_modules is still denied via vendoredDirs, so use a typescript/lib path
		// which is denied only by the (now cleared) globs field.
		const relPath = "typescript/lib/lib.dom.d.ts"
		expect(isDeniedRead(relPath, DEFAULT).denied).toBe(true)
		expect(isDeniedRead(relPath, cleared).denied).toBe(false)
	})

	it("reports the matched field:entry as the category", () => {
		expect(isDeniedRead("package-lock.json", DEFAULT).category).toBe("files:package-lock.json")
		expect(isDeniedRead("dist/bundle.js", DEFAULT).category).toBe("rootDirs:dist")
		expect(isDeniedRead("node_modules/foo.js", DEFAULT).category).toBe("vendoredDirs:node_modules")
	})

	it("prefix-matches out-* root dirs", () => {
		expect(isDeniedRead("out-tsc/app.js", DEFAULT).denied).toBe(true)
		expect(isDeniedRead("out-tsc/app.js", DEFAULT).category).toBe("rootDirs:out-*")
	})

	it("fails open to {denied:false} for a malformed relPath", () => {
		expect(isDeniedRead("", DEFAULT).denied).toBe(false)
		expect(isDeniedRead("/abs/node_modules/x.js", DEFAULT).denied).toBe(false)
		expect(isDeniedRead("../node_modules/x.js", DEFAULT).denied).toBe(false)
	})
})

describe("extractKnownTargetPaths (design §B path-literal grammar)", () => {
	it("extracts a bare .d.ts path", () => {
		const set = extractKnownTargetPaths("Please read node_modules/@types/react/index.d.ts for the types.")
		expect(set.has("node_modules/@types/react/index.d.ts")).toBe(true)
	})

	it("extracts a backtick-quoted path", () => {
		const set = extractKnownTargetPaths("Edit `src/core/task/Task.ts` to add the counter.")
		expect(set.has("src/core/task/Task.ts")).toBe(true)
	})

	it("strips a trailing :line suffix (diagnostic file:line form)", () => {
		const set = extractKnownTargetPaths("Error at src/core/tools/ReadFileTool.ts:918 — fix it.")
		expect(set.has("src/core/tools/ReadFileTool.ts")).toBe(true)
		expect(set.has("src/core/tools/ReadFileTool.ts:918")).toBe(false)
	})

	it("strips a trailing :line:col suffix", () => {
		const set = extractKnownTargetPaths("See src/foo/bar.ts:12:4 here.")
		expect(set.has("src/foo/bar.ts")).toBe(true)
	})

	it("rejects a path containing a .. traversal segment", () => {
		const set = extractKnownTargetPaths("Do not read ../secret/node_modules/x.ts please.")
		expect(set.has("../secret/node_modules/x.ts")).toBe(false)
		expect(set.size).toBe(0)
	})

	it("ignores tokens with no slash or no extension", () => {
		const set = extractKnownTargetPaths("The function doThing and the folder src are relevant.")
		expect(set.size).toBe(0)
	})
})

describe("mergeReadDenylist (per-field replace-over-default, design §F NIT 6)", () => {
	it("returns a byte-for-byte default when stored is undefined (AC-6)", () => {
		const merged = mergeReadDenylist(undefined, DEFAULT)
		expect(merged.vendoredDirs).toEqual(DEFAULT.vendoredDirs)
		expect(merged.rootDirs).toEqual(DEFAULT.rootDirs)
		expect(merged.files).toEqual(DEFAULT.files)
		expect(merged.globs).toEqual(DEFAULT.globs)
	})

	it("inherits the default for every omitted field", () => {
		const merged = mergeReadDenylist({ files: ["custom.lock"] }, DEFAULT)
		expect(merged.files).toEqual(["custom.lock"])
		expect(merged.vendoredDirs).toEqual(DEFAULT.vendoredDirs)
		expect(merged.rootDirs).toEqual(DEFAULT.rootDirs)
		expect(merged.globs).toEqual(DEFAULT.globs)
	})

	it("replaces a provided field entirely (not union)", () => {
		const merged = mergeReadDenylist({ vendoredDirs: ["node_modules"] }, DEFAULT)
		expect(merged.vendoredDirs).toEqual(["node_modules"])
	})

	it("clears a category when a field is an explicit empty array", () => {
		const merged = mergeReadDenylist({ globs: [] }, DEFAULT)
		expect(merged.globs).toEqual([])
	})
})
