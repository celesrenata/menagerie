// Feature: file-not-found-as-question (Layer 2) — the read tool turns a missing
// path into a structured, model-actionable "did you mean" notice with
// ignore-filtered near-match PATHS, instead of a bare fatal error.
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ReadDenylistConfig } from "../../../../services/glob/readDenylist"
import type { FileResult } from "../../../../services/search/file-search"

import { formatNotFoundNotice, isEnoent, suggestNearbyPaths } from "../notFoundSuggestions"

vi.mock("../../../../services/search/file-search", () => ({
	searchWorkspaceFiles: vi.fn(),
}))

// Imported after the mock so the mocked implementation is bound.
import { searchWorkspaceFiles } from "../../../../services/search/file-search"

const mockedSearch = vi.mocked(searchWorkspaceFiles)

/** Minimal denylist that denies the vendored dir `node_modules` and `secrets.json`. */
const DENYLIST: ReadDenylistConfig = {
	vendoredDirs: ["node_modules"],
	rootDirs: [],
	files: ["secrets.json"],
	globs: [],
}

const file = (p: string): FileResult => ({ path: p, type: "file", label: p.split("/").pop() })
const folder = (p: string): FileResult => ({ path: p, type: "folder", label: p.split("/").pop() })

const allowAll = () => true
const noKnownTargets = () => false

describe("isEnoent", () => {
	it("returns true for a Node ENOENT error", () => {
		const error = Object.assign(new Error("no such file"), { code: "ENOENT" })
		expect(isEnoent(error)).toBe(true)
	})

	it("returns false for a non-ENOENT errno (EACCES)", () => {
		const error = Object.assign(new Error("permission denied"), { code: "EACCES" })
		expect(isEnoent(error)).toBe(false)
	})

	it("returns false for a non-Error value", () => {
		expect(isEnoent("ENOENT")).toBe(false)
		expect(isEnoent(undefined)).toBe(false)
		expect(isEnoent({ code: "ENOENT" })).toBe(false)
	})
})

describe("formatNotFoundNotice", () => {
	it("renders the match case with File: header, 'Did you mean', and each candidate", () => {
		const notice = formatNotFoundNotice("config/app.yaml", ["deploy/app.yaml", "src/app.yml"])

		expect(notice.startsWith("File: config/app.yaml\n")).toBe(true)
		expect(notice).toContain("Not found:")
		expect(notice).toContain("Did you mean")
		expect(notice).toContain("  - deploy/app.yaml")
		expect(notice).toContain("  - src/app.yml")
	})

	it("renders the no-match case stating no similar files, with no candidate list", () => {
		const notice = formatNotFoundNotice("config/app.yaml", [])

		expect(notice.startsWith("File: config/app.yaml\n")).toBe(true)
		expect(notice).toContain("Not found:")
		expect(notice).toContain("no similar files were found")
		expect(notice).not.toContain("Did you mean")
		expect(notice).not.toContain("  - ")
	})
})

describe("suggestNearbyPaths", () => {
	beforeEach(() => {
		mockedSearch.mockReset()
	})

	it("ranks exact basename matches ahead of substring matches", async () => {
		mockedSearch.mockResolvedValue([
			file("docs/app.config.ts"), // substring of basename, tier 3
			file("packages/app.ts"), // exact basename, tier 0
		])

		const result = await suggestNearbyPaths({
			missingRelPath: "src/app.ts",
			cwd: "/repo",
			denylist: DENYLIST,
			isAccessAllowed: allowAll,
			isKnownTarget: noKnownTargets,
		})

		expect(result[0]).toBe("packages/app.ts")
		expect(result).toContain("docs/app.config.ts")
	})

	it("ranks a stem match (ingress.yaml vs ingress.yml) ahead of residual hits", async () => {
		mockedSearch.mockResolvedValue([
			file("misc/other-ingress-notes.md"), // residual substring, tier 3
			file("k8s/ingress.yml"), // stem match of `ingress`, tier 2
		])

		const result = await suggestNearbyPaths({
			missingRelPath: "deploy/ingress.yaml",
			cwd: "/repo",
			denylist: DENYLIST,
			isAccessAllowed: allowAll,
			isKnownTarget: noKnownTargets,
		})

		expect(result[0]).toBe("k8s/ingress.yml")
	})

	it("drops a non-known-target denylisted top hit without consuming a cap slot", async () => {
		mockedSearch.mockResolvedValue([
			file("node_modules/pkg/app.ts"), // vendored → denied, dropped
			file("src/app.ts"), // allowed
		])

		const result = await suggestNearbyPaths({
			missingRelPath: "app.ts",
			cwd: "/repo",
			denylist: DENYLIST,
			isAccessAllowed: allowAll,
			isKnownTarget: noKnownTargets,
		})

		expect(result).toEqual(["src/app.ts"])
	})

	it("allows a denylisted candidate that is a Known_Target (intentional bypass)", async () => {
		mockedSearch.mockResolvedValue([file("config/secrets.json")])

		const result = await suggestNearbyPaths({
			missingRelPath: "secrets.json",
			cwd: "/repo",
			denylist: DENYLIST,
			isAccessAllowed: allowAll,
			// The user named config/secrets.json as a Known_Target elsewhere.
			isKnownTarget: (p) => p === "config/secrets.json",
		})

		expect(result).toEqual(["config/secrets.json"])
	})

	it("drops a rooIgnore-blocked candidate", async () => {
		mockedSearch.mockResolvedValue([file("private/app.ts"), file("src/app.ts")])

		const result = await suggestNearbyPaths({
			missingRelPath: "app.ts",
			cwd: "/repo",
			denylist: DENYLIST,
			isAccessAllowed: (p) => p !== "private/app.ts",
			isKnownTarget: noKnownTargets,
		})

		expect(result).toEqual(["src/app.ts"])
	})

	it("enforces the cap of 5", async () => {
		mockedSearch.mockResolvedValue([
			file("a/app.ts"),
			file("b/app.ts"),
			file("c/app.ts"),
			file("d/app.ts"),
			file("e/app.ts"),
			file("f/app.ts"),
			file("g/app.ts"),
		])

		const result = await suggestNearbyPaths({
			missingRelPath: "app.ts",
			cwd: "/repo",
			denylist: DENYLIST,
			isAccessAllowed: allowAll,
			isKnownTarget: noKnownTargets,
		})

		expect(result).toHaveLength(5)
	})

	it("considers only type: 'file' results, ignoring folders", async () => {
		mockedSearch.mockResolvedValue([folder("app.ts"), file("src/app.ts")])

		const result = await suggestNearbyPaths({
			missingRelPath: "app.ts",
			cwd: "/repo",
			denylist: DENYLIST,
			isAccessAllowed: allowAll,
			isKnownTarget: noKnownTargets,
		})

		expect(result).toEqual(["src/app.ts"])
	})

	it("returns an empty list when the source returns no results", async () => {
		mockedSearch.mockResolvedValue([])

		const result = await suggestNearbyPaths({
			missingRelPath: "app.ts",
			cwd: "/repo",
			denylist: DENYLIST,
			isAccessAllowed: allowAll,
			isKnownTarget: noKnownTargets,
		})

		expect(result).toEqual([])
	})

	it("returns only paths, never any file-content bytes", async () => {
		mockedSearch.mockResolvedValue([file("src/app.ts"), file("src/other.ts")])

		const result = await suggestNearbyPaths({
			missingRelPath: "src/app.ts",
			cwd: "/repo",
			denylist: DENYLIST,
			isAccessAllowed: allowAll,
			isKnownTarget: noKnownTargets,
		})

		// Each entry is a workspace-relative path, nothing resembling content.
		for (const entry of result) {
			expect(entry).toMatch(/^[\w./-]+$/)
			expect(entry).not.toContain("\n")
		}
	})
})
