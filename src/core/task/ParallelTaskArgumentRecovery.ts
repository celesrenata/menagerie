/** Retry one malformed parallel_tasks call with that tool explicitly selected. */
export class ParallelTaskArgumentRecovery {
	private pending = false
	private retryUsed = false

	onMalformedCall(): void {
		if (!this.retryUsed) this.pending = true
	}

	consume(toolAvailable: boolean): boolean {
		const retry = this.pending && toolAvailable
		this.pending = false
		if (retry) this.retryUsed = true
		return retry
	}

	onValidCall(): void {
		this.pending = false
		this.retryUsed = false
	}
}
