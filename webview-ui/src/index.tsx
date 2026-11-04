import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App"
import ErrorBoundary from "./components/ErrorBoundary"
import { activateCrashGuard } from "./utils/crashGuard"
import "../node_modules/@vscode/codicons/dist/codicon.css"

import { getHighlighter } from "./utils/highlighter"

// React's ErrorBoundary only catches render-phase errors. Errors thrown in
// effects, event handlers, or async flows escape it entirely, and the webview
// has no other last-resort handler — historically that manifested as the whole
// panel going gray with no visible error. The crash guard (outside React)
// records those fatal errors and, if #root ends up empty, paints a diagnostic
// overlay directly on document.body so the cause is visible instead of an
// empty panel.
activateCrashGuard()

// Initialize Shiki early to hide initialization latency (async)
getHighlighter().catch((error: Error) => console.error("Failed to initialize Shiki highlighter:", error))

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		{/* Root-level boundary: catches render errors in <App/> itself and its providers
			(the inner ErrorBoundary only wraps the tab content). Without this, an uncaught
			render error unmounts the whole tree and leaves #root empty, so the webview shows
			the bare background (all gray) instead of a recoverable error screen. */}
		<ErrorBoundary>
			<App />
		</ErrorBoundary>
	</StrictMode>,
)
