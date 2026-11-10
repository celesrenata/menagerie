import type { AnalysisValidOutcome } from "@roo-code/types"

/**
 * Exact-input result cache (MEN-GRANITE-SDD-001 R5.4, R5.5).
 *
 * Keys are `namespace + digest`, where the digest already covers operation, evidence hashes,
 * schema / instruction / template versions, model and output budget. `namespace` is the
 * workspace identity, so two workspaces can never share an entry even if a digest collided.
 * Only `valid` outcomes are stored. Entries are never an inference about unseen repo state:
 * the executor re-verifies evidence freshness BEFORE consulting this cache.
 *
 * Independent of the service's 2-slot KV prefix cache, which is a speed hint only.
 */
export class AnalysisCache {
	private readonly entries = new Map<string, AnalysisValidOutcome>()
	hits = 0
	misses = 0

	constructor(private readonly maxEntries = 256) {}

	private static key(namespace: string, digest: string): string {
		return `${namespace}\u0000${digest}`
	}

	get(namespace: string, digest: string): AnalysisValidOutcome | undefined {
		const key = AnalysisCache.key(namespace, digest)
		const hit = this.entries.get(key)
		if (!hit) {
			this.misses++
			return undefined
		}
		// Refresh recency (Map preserves insertion order).
		this.entries.delete(key)
		this.entries.set(key, hit)
		this.hits++
		return hit
	}

	set(namespace: string, outcome: AnalysisValidOutcome): void {
		const key = AnalysisCache.key(namespace, outcome.digest)
		this.entries.delete(key)
		this.entries.set(key, outcome)
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value
			if (oldest === undefined) break
			this.entries.delete(oldest)
		}
	}

	clearNamespace(namespace: string): void {
		const prefix = `${namespace}\u0000`
		for (const key of [...this.entries.keys()]) if (key.startsWith(prefix)) this.entries.delete(key)
	}

	get size(): number {
		return this.entries.size
	}
}
