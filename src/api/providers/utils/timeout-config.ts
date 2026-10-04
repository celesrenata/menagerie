import * as vscode from "vscode"
import { Package } from "../../../shared/package"

const DEFAULT_TIMEOUT_SECONDS = 600
const MIN_TIMEOUT_SECONDS = 1
const MAX_TIMEOUT_SECONDS = 3600

function isValidTimeout(value: unknown): value is number {
	return typeof value === "number" && !isNaN(value) && value >= MIN_TIMEOUT_SECONDS && value <= MAX_TIMEOUT_SECONDS
}

export function getApiRequestTimeout(): number {
	const configTimeout = vscode.workspace
		.getConfiguration(Package.name)
		.get<number>("apiRequestTimeout", DEFAULT_TIMEOUT_SECONDS)

	const seconds = isValidTimeout(configTimeout) ? configTimeout : DEFAULT_TIMEOUT_SECONDS
	return Math.round(seconds * 1000)
}

const DEFAULT_STREAM_IDLE_SECONDS = 300
const MAX_STREAM_IDLE_SECONDS = 3600

function isValidStreamIdleTimeout(value: unknown): value is number {
	return typeof value === "number" && !isNaN(value) && value >= 0 && value <= MAX_STREAM_IDLE_SECONDS
}

/**
 * Maximum wait between streamed chunks, in milliseconds. 0 disables the bound.
 * The wait for the first chunk is governed by getApiRequestTimeout().
 */
export function getApiStreamIdleTimeout(): number {
	const configTimeout = vscode.workspace
		.getConfiguration(Package.name)
		.get<number>("apiStreamIdleTimeout", DEFAULT_STREAM_IDLE_SECONDS)

	const seconds = isValidStreamIdleTimeout(configTimeout) ? configTimeout : DEFAULT_STREAM_IDLE_SECONDS
	return Math.round(seconds * 1000)
}
