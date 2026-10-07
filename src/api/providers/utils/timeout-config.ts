import * as vscode from "vscode"
import { Package } from "../../../shared/package"

// 1800s (30 min) default first-chunk wait. A parallel worker can be parked in
// OmniRoute's rate-limit queue for up to 300000ms (5 min) BEFORE emitting its
// first chunk; a shorter budget (the old 600s) left too little room for real
// generation after a full queue park, so the client aborted queued-but-healthy
// workers. 1800s stays safely above the 300000ms queue-park window while
// remaining well under OmniRoute's own 2700000ms (45 min) REQUEST_TIMEOUT_MS,
// so a truly dead backend is still caught. Overridable via zoo-code.apiRequestTimeout.
const DEFAULT_TIMEOUT_SECONDS = 1800
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

// 1800s (30 min) default between-chunks idle bound. A worker legitimately queued
// in OmniRoute's rate-limit queue (parked up to 300000ms / 5 min) streams no
// chunks while it waits, so the old 300000ms idle timer fired and aborted the
// socket on healthy-but-queued workers (observed ~333s request_signal_aborted /
// client_disconnect, "0 in / 0 out"). 1800s is safely above the 300000ms queue
// park plus realistic generation time, yet still well under OmniRoute's own
// 2700000ms (45 min) REQUEST_TIMEOUT_MS, so a stream that truly hangs mid-flight
// is still caught. The abort mechanism is unchanged — only the duration.
// Overridable via zoo-code.apiStreamIdleTimeout; 0 still disables the bound.
const DEFAULT_STREAM_IDLE_SECONDS = 1800
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
