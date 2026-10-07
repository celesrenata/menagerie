/**
 * Integration test for the reader-swarm document pick routing through the shared
 * read denylist (parallel-input-bloat FEAT-002, FR-2 / AC-7):
 * `addSharedDocumentReader` must never select a denylisted candidate, and it must
 * skip it BEFORE the fs.stat/excerpt step.
 */

import type { Stats } from "fs"

import { addSharedDocumentReader, AUTO_READER_NAME } from "../ParallelTaskReader"
import type { ParallelTaskSpec } from "../../tools/ParallelTasksTool"
import type { UserParallelismPolicy } from "../elasticTypes"

vi.mock("node:fs/promises", () => ({
	realpath: vi.fn(),
	stat: vi.fn(),
	readFile: vi.fn(),
}))

const fsPromises = await import("node:fs/promises")
const mockedRealpath = vi.mocked(fsPromises.realpath)
const mockedStat = vi.mocked(fsPromises.stat)
const mockedReadFile = vi.mocked(fsPromises.readFile)

const WORKSPACE = "/test/workspace"
const POLICY: UserParallelismPolicy = { maxReaderSwarm: 4 }

function worker(name: string, message: string): ParallelTaskSpec {
	return { name, mode: "code", message, todos: null }
}

describe("addSharedDocumentReader denylist filter", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// realpath echoes the joined path; the function joins workspace + relative.
		mockedRealpath.mockImplementation(async (p) => String(p))
		mockedStat.mockResolvedValue({ isFile: () => true, size: 1024 } as Stats)
		mockedReadFile.mockResolvedValue(
			"# Shared contract\nschema: ExampleContract\nendpoint: /example\ninterface Foo { bar: string }\n",
		)
	})

	it("skips a denylisted candidate before fs.stat and never appends a reader for it (AC-7)", async () => {
		// `docs/node_modules/typings.md` passes the SHARED_DOCUMENT regex but is
		// denied by the shared denylist (vendored `node_modules` segment).
		const deniedDoc = "docs/node_modules/typings.md"
		const specs = [worker("w1", `See ${deniedDoc} for types.`), worker("w2", `Also ${deniedDoc}.`)]

		const result = await addSharedDocumentReader(specs, WORKSPACE, true, false, POLICY)

		// No reader was appended (only the original two workers remain).
		expect(result).toHaveLength(2)
		expect(result.some((spec) => spec.name.startsWith(AUTO_READER_NAME))).toBe(false)
		// The denied candidate was skipped before the fs.stat/excerpt step.
		expect(mockedStat).not.toHaveBeenCalled()
		expect(mockedReadFile).not.toHaveBeenCalled()
	})

	it("still appends a reader for an allowed shared document", async () => {
		const allowedDoc = "docs/design/contract.md"
		const specs = [worker("w1", `See ${allowedDoc}.`), worker("w2", `Also ${allowedDoc}.`)]

		const result = await addSharedDocumentReader(specs, WORKSPACE, true, false, POLICY)

		expect(result.length).toBeGreaterThan(2)
		expect(result.some((spec) => spec.name.startsWith(AUTO_READER_NAME))).toBe(true)
		expect(mockedStat).toHaveBeenCalled()
	})
})
