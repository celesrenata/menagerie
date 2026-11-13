/**
 * Crash Guard
 *
 * A React-independent safety net for the webview.
 *
 * React's ErrorBoundary only catches render-phase errors. Errors thrown in
 * useEffect, event handlers, async functions, or promise rejections escape
 * the boundary entirely. Worse, if the React root ends up empty (or the whole
 * tree is torn down), no boundary is left to display anything.
 *
 * This module:
 *   1. Records every uncaught error and unhandled promise rejection.
 *   2. Watches #root via MutationObserver. The instant it becomes empty or
 *      contentless (the exact "all gray" condition), it paints a full-screen
 *      diagnostic overlay directly on document.body — outside React's control,
 *      so it cannot be wiped by any React re-render or unmount.
 *
 * The overlay stays until the React root re-populates (i.e., the next
 * successful render), at which point it is removed.
 */

type GuardRecord = {
	timestamp: string
	message: string
	stack: string
	source: "window.error" | "unhandledrejection"
}

const MAX_RECORDS = 20
const records: GuardRecord[] = []
let overlay: HTMLDivElement | null = null
let activated = false

/** Test-only: clear recorded errors and remove the overlay so suites start clean. */
export function resetCrashGuardForTesting(): void {
	records.length = 0
	if (overlay) {
		overlay.remove()
		overlay = null
	}
	activated = false
}

function pushRecord(source: GuardRecord["source"], err: unknown) {
	const e = err instanceof Error ? err : new Error(String(err))
	records.push({
		timestamp: new Date().toISOString(),
		message: e.message || "(no message)",
		stack: e.stack || "(no stack)",
		source,
	})
	if (records.length > MAX_RECORDS) records.shift()
	console.error(`[crashGuard:${source}]`, e)
}

/** Show the diagnostic overlay on document.body (outside #root). */
function showOverlay(reason: string) {
	if (overlay) return // already visible

	const el = document.createElement("div")
	el.id = "crash-guard-overlay"
	// Theme-aware via the webview's CSS variables, with dark fallbacks.
	el.style.cssText = [
		"position:fixed",
		"inset:0",
		"z-index:2147483647",
		"background:var(--background, #1e1e1e)",
		"color:var(--foreground, #e8e8e8)",
		"font:13px/1.5 'SF Mono','Menlo','Consolas',monospace",
		"padding:16px",
		"overflow-y:auto",
		"display:flex",
		"flex-direction:column",
		"gap:8px",
	].join(";")

	const title = document.createElement("h2")
	title.style.cssText = "margin:0;font-size:15px;color:var(--destructive, #ff6b6b)"
	title.textContent = `Menagerie webview crashed — ${reason}`

	const hint = document.createElement("p")
	hint.style.cssText = "margin:0;color:var(--muted-foreground, #aaa);font-size:12px"
	hint.textContent =
		"The React tree was destroyed. This overlay is rendered outside React, so it cannot be wiped by a re-render. " +
		"Reload the window (Cmd+Shift+P → Developer: Reload Window) to recover."

	el.append(title, hint)

	// Show the most recent recorded errors
	const shown = records.slice(-8).reverse()
	if (shown.length === 0) {
		const none = document.createElement("div")
		none.style.cssText = "color:#ccc;font-size:12px"
		none.textContent =
			"No uncaught errors were recorded before the tree was destroyed — the failure happened outside the webview process (iframe/extension host level)."
		el.append(none)
	}
	for (const rec of shown) {
		const block = document.createElement("div")
		block.style.cssText = "border-top:1px solid #333;padding-top:6px;margin-top:6px"

		const meta = document.createElement("div")
		meta.style.cssText = "color:#888;font-size:11px"
		meta.textContent = `${rec.timestamp}  ${rec.source}`

		const msg = document.createElement("div")
		msg.style.cssText = "color:#ff6b6b;margin-top:2px"
		msg.textContent = rec.message

		const stack = document.createElement("pre")
		stack.style.cssText = "margin:4px 0 0;color:#ccc;font-size:11px;white-space:pre-wrap"
		stack.textContent = rec.stack.slice(0, 4000)

		block.append(meta, msg, stack)
		el.append(block)
	}

	document.body.append(el)
	overlay = el
}

/** Remove the overlay once React has re-rendered into #root. */
function hideOverlay() {
	if (overlay) {
		overlay.remove()
		overlay = null
	}
}

/** Show the overlay if #root is missing or has been emptied (the "all gray" state). */
function checkRoot() {
	const root = document.getElementById("root")
	if (!root) {
		showOverlay("document.getElementById('root') returned null")
		return
	}
	// The working app always renders at least one element (the loading spinner
	// or the app shell). An empty #root means the React tree has been torn
	// down — which is exactly the "all gray" condition we're guarding against.
	if (root.childElementCount === 0) {
		showOverlay("React root (#root) is empty")
		return
	}
	// React has content — hide the overlay if it's showing
	if (overlay) hideOverlay()
}

/**
 * Activate the crash guard. Call once at module load, before createRoot.
 * Idempotent: subsequent calls are no-ops so re-imports or re-mounts don't
 * stack duplicate listeners.
 */
export function activateCrashGuard(): void {
	if (activated) return
	activated = true

	// 1. Capture uncaught errors
	window.addEventListener("error", (event) => {
		pushRecord("window.error", event.error ?? event.message)
	})

	// 2. Capture unhandled promise rejections
	window.addEventListener("unhandledrejection", (event) => {
		pushRecord("unhandledrejection", event.reason)
	})

	// 3. Watch #root for the "gray" condition
	const root = document.getElementById("root")
	if (root) {
		const observer = new MutationObserver(() => checkRoot())
		observer.observe(root, { childList: true, subtree: true })
	}

	// 4. Periodic safety check (catches the case where the root node itself
	//    is replaced, which would detach the MutationObserver target).
	setInterval(checkRoot, 2000)
}
