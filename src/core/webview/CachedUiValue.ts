/** Optional UI metadata must never put credential RPCs on the task execution path. */
export class CachedUiValue<T> {
	private refresh?: Promise<void>
	private refreshedAt = -Infinity
	private generation = 0
	private disposed = false

	constructor(
		private value: T,
		private readonly load: () => Promise<T>,
		private readonly changed: () => void,
		private readonly ttlMs = 30_000,
	) {}

	get(): T {
		if (!this.disposed && !this.refresh && Date.now() - this.refreshedAt >= this.ttlMs) {
			const generation = this.generation
			this.refresh = Promise.resolve()
				.then(this.load)
				.then((value) => {
					if (this.disposed || generation !== this.generation) return
					const changed = JSON.stringify(value) !== JSON.stringify(this.value)
					this.value = value
					if (changed) this.changed()
				})
				.catch(() => {
					// Retain the last UI projection; actual API authentication remains authoritative.
				})
				.finally(() => {
					this.refresh = undefined
					this.refreshedAt = generation === this.generation ? Date.now() : -Infinity
					if (!this.disposed && generation !== this.generation) this.get()
				})
		}
		return this.value
	}

	invalidate(value: T): void {
		this.generation++
		this.value = value
		this.refreshedAt = -Infinity
		this.get()
	}

	dispose(): void {
		this.disposed = true
	}
}
