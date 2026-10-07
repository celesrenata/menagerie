import { describe, it, expect } from "vitest"

import {
	GLOBAL_SETTINGS_KEYS,
	globalSettingsSchema,
	parallelReadDenylistSchema,
	DEFAULT_READ_DENYLIST,
	DEFAULT_WORKER_READ_INPUT_BUDGET_BYTES,
	BUDGET_TIGHTENED_LINE_LIMIT,
} from "../global-settings.js"

describe("parallelReadDenylist schema", () => {
	it("exposes the setting key on GLOBAL_SETTINGS_KEYS (derived, not hand-edited)", () => {
		expect(GLOBAL_SETTINGS_KEYS).toContain("parallelReadDenylist")
	})

	it("accepts the empty object and any subset of the four fields", () => {
		expect(parallelReadDenylistSchema.parse({})).toEqual({})
		expect(parallelReadDenylistSchema.parse({ globs: [] })).toEqual({ globs: [] })
		expect(
			parallelReadDenylistSchema.parse({
				vendoredDirs: ["node_modules"],
				rootDirs: ["dist"],
				files: ["package-lock.json"],
				globs: ["**/*.min.js"],
			}),
		).toEqual({
			vendoredDirs: ["node_modules"],
			rootDirs: ["dist"],
			files: ["package-lock.json"],
			globs: ["**/*.min.js"],
		})
	})

	it("rejects non-string-array field values", () => {
		expect(parallelReadDenylistSchema.safeParse({ globs: [1, 2] }).success).toBe(false)
		expect(parallelReadDenylistSchema.safeParse({ files: "nope" }).success).toBe(false)
	})

	it("round-trips through globalSettingsSchema (set, empty, and unset cases)", () => {
		// Set case: a valid partial config survives the schema parse unchanged.
		expect(globalSettingsSchema.parse({ parallelReadDenylist: { globs: ["**/*.min.js"] } })).toEqual({
			parallelReadDenylist: { globs: ["**/*.min.js"] },
		})
		// Empty-object case: a no-op config round-trips.
		expect(globalSettingsSchema.parse({ parallelReadDenylist: {} })).toEqual({ parallelReadDenylist: {} })
		// Explicit cleared-category case round-trips.
		expect(globalSettingsSchema.parse({ parallelReadDenylist: { globs: [] } })).toEqual({
			parallelReadDenylist: { globs: [] },
		})
		// Unset case: an absent key parses away (no default injected).
		expect(globalSettingsSchema.parse({})).toEqual({})
	})

	it("rejects an invalid config through globalSettingsSchema", () => {
		expect(globalSettingsSchema.safeParse({ parallelReadDenylist: { globs: [1] } }).success).toBe(false)
	})
})

describe("shared read-denylist defaults and budget constants", () => {
	it("DEFAULT_READ_DENYLIST holds the design §B values", () => {
		expect(DEFAULT_READ_DENYLIST.vendoredDirs).toEqual([
			"node_modules",
			"vendor",
			"Pods",
			".pnpm-store",
			".stryker-tmp",
			"__pycache__",
		])
		expect(DEFAULT_READ_DENYLIST.rootDirs).toEqual(["dist", "out", "out-*", "build", "coverage"])
		expect(DEFAULT_READ_DENYLIST.files).toEqual(["package-lock.json", "pnpm-lock.yaml", "yarn.lock"])
		expect(DEFAULT_READ_DENYLIST.globs).toEqual([
			"**/node_modules/@types/**",
			"**/typescript/lib/*.d.ts",
			"**/*.min.js",
			"**/*.min.css",
			"**/*.js.map",
			"**/*.css.map",
			"target/dependency/**",
			"build/dependencies/**",
		])
	})

	it("exposes the shared budget constants", () => {
		expect(DEFAULT_WORKER_READ_INPUT_BUDGET_BYTES).toBe(600_000)
		expect(BUDGET_TIGHTENED_LINE_LIMIT).toBe(500)
	})
})
