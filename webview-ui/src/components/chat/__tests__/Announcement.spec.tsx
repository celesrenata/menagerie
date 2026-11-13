import React from "react"

import { fireEvent, render, screen } from "@/utils/test-utils"
import { EXTERNAL_LINKS } from "@/constants/externalLinks"
import { vscode } from "@/utils/vscode"

import Announcement from "../Announcement"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@roo/package", () => ({
	Package: {
		version: "3.84.0",
	},
}))

vi.mock("react-i18next", () => ({
	Trans: ({ i18nKey, components }: { i18nKey: string; components?: Record<string, React.ReactElement> }) => {
		if (i18nKey === "chat:announcement.support" && components?.githubLink) {
			return React.cloneElement(components.githubLink, undefined, "GitHub")
		}

		return <span>{i18nKey}</span>
	},
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: { version?: string }) => {
			const translations: Record<string, string> = {
				"chat:announcement.release.heading": "What's New:",
				"chat:announcement.release.highlight1":
					"✨ New SOTA models added: Use GPT-6 Sol, GPT-6 Luna, and Claude Opus 5.5 across supported providers.",
				"chat:announcement.release.highlight2":
					"🧭 More reliable tasks and subtasks: Keep delegated modes isolated, preserve subtask links after repeated stops, and protect orchestrator settings when slash commands switch modes.",
				"chat:announcement.release.highlight3":
					"🛠️ More dependable terminal, provider, and code-search behavior: Improve terminal behavior across Windows and non-English environments, strengthen provider responses and cancellation, and make code search use the correct workspace more consistently.",
			}

			if (key === "chat:announcement.title") {
				return `Menagerie ${options?.version ?? ""}`
			}

			return translations[key] ?? key
		},
	}),
}))

describe("Announcement", () => {
	it("renders the announcement title and highlights", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		expect(screen.getByText("Menagerie 3.84.0")).toBeInTheDocument()
		expect(
			screen.getByText(
				"✨ New SOTA models added: Use GPT-6 Sol, GPT-6 Luna, and Claude Opus 5.5 across supported providers.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"🧭 More reliable tasks and subtasks: Keep delegated modes isolated, preserve subtask links after repeated stops, and protect orchestrator settings when slash commands switch modes.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"🛠️ More dependable terminal, provider, and code-search behavior: Improve terminal behavior across Windows and non-English environments, strengthen provider responses and cancellation, and make code search use the correct workspace more consistently.",
			),
		).toBeInTheDocument()
	})

	it("renders exactly three release highlight bullets", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		expect(screen.getAllByRole("listitem")).toHaveLength(3)
	})

	it("links users to the Menagerie GitHub repository", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		expect(screen.getByRole("link", { name: "GitHub" })).toHaveAttribute("href", EXTERNAL_LINKS.GITHUB_REPO)
	})

	it("posts each announcement link to the extension host exactly once", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		fireEvent.click(screen.getByRole("link", { name: "GitHub" }))
		fireEvent.click(screen.getByRole("link", { name: "Release notes" }))
		expect(vscode.postMessage).toHaveBeenCalledTimes(2)
		expect(vscode.postMessage).toHaveBeenNthCalledWith(1, { type: "openExternal", url: EXTERNAL_LINKS.GITHUB_REPO })
		expect(vscode.postMessage).toHaveBeenNthCalledWith(2, { type: "openExternal", url: EXTERNAL_LINKS.RELEASES })
	})

	// VS Code's webview bootstrap intercepts clicks on any anchor with an href
	// at the document level and never checks defaultPrevented, so the
	// announcement links must stop propagation to avoid opening twice.
	it("keeps announcement link clicks from reaching the document level", () => {
		const documentClick = vi.fn()
		document.addEventListener("click", documentClick)

		try {
			render(
				<div>
					<a href="#control">control</a>
					<Announcement hideAnnouncement={vi.fn()} />
				</div>,
			)

			fireEvent.click(screen.getByRole("link", { name: "GitHub" }))
			expect(documentClick).not.toHaveBeenCalled()

			fireEvent.click(screen.getByText("control"))
			expect(documentClick).toHaveBeenCalledTimes(1)
		} finally {
			document.removeEventListener("click", documentClick)
		}
	})

	it("hides the announcement when the dialog closes", () => {
		const hideAnnouncement = vi.fn()
		render(<Announcement hideAnnouncement={hideAnnouncement} />)

		fireEvent.keyDown(document.body, { key: "Escape" })

		expect(hideAnnouncement).toHaveBeenCalledTimes(1)
	})
})
