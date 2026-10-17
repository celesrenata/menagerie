export type ChangeIndexStatus = "applied" | "reverted" | "conflict"

export interface ChangeIndexRecord {
	taskId: string
	path: string
	beforeHash: string
	afterHash: string
	beforeContents: string
	patch: string
	timestamp: number
	status: ChangeIndexStatus
}

export class ChangeIndex {
	private readonly records: ChangeIndexRecord[] = []

	record(entry: ChangeIndexRecord): void {
		this.records.push(entry)
	}

	getChangesForTask(taskId: string): ChangeIndexRecord[] {
		return this.records.filter((entry) => entry.taskId === taskId)
	}

	getChangesForPath(filePath: string): ChangeIndexRecord[] {
		return this.records.filter((entry) => entry.path === filePath)
	}

	latestForPath(filePath: string): ChangeIndexRecord | undefined {
		for (let i = this.records.length - 1; i >= 0; i--) {
			if (this.records[i]?.path === filePath) return this.records[i]
		}
		return undefined
	}

	markReverted(entry: ChangeIndexRecord): void {
		entry.status = "reverted"
	}

	clear(): void {
		this.records.length = 0
	}
}

export const changeIndex = new ChangeIndex()
