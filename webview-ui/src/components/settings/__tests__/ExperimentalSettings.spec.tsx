import { fireEvent, render, screen } from "@testing-library/react"

import { experimentDefault } from "@roo/experiments"

import { ExperimentalSettings } from "../ExperimentalSettings"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

describe("ExperimentalSettings", () => {
	const defaultProps = {
		experiments: experimentDefault,
		setExperimentEnabled: vi.fn(),
		setImageGenerationProvider: vi.fn(),
		setOpenRouterImageApiKey: vi.fn(),
		setImageGenerationSelectedModel: vi.fn(),
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders the available experiments including native parallel execution", () => {
		render(<ExperimentalSettings {...defaultProps} />)

		expect(screen.getByText("settings:experimental.PREVENT_FOCUS_DISRUPTION.name")).toBeInTheDocument()
		expect(screen.getByText("settings:experimental.RUN_SLASH_COMMAND.name")).toBeInTheDocument()
		expect(screen.getByText("settings:experimental.IMAGE_GENERATION.name")).toBeInTheDocument()
		expect(screen.getByText("settings:experimental.CUSTOM_TOOLS.name")).toBeInTheDocument()
		expect(screen.getByText("settings:experimental.PARALLEL_TOOL_EXECUTION.name")).toBeInTheDocument()
		expect(screen.getByText("settings:experimental.PARALLEL_TASKS.name")).toBeInTheDocument()
	})
	it.each([
		["PARALLEL_TASKS", "parallelTasks"],
		["PARALLEL_TOOL_EXECUTION", "parallelToolExecution"],
	] as const)("updates the cached %s value in both directions", (key, id) => {
		const { rerender } = render(<ExperimentalSettings {...defaultProps} />)
		const checkbox = screen.getByRole("checkbox", { name: `settings:experimental.${key}.name` })
		fireEvent.click(checkbox)
		expect(defaultProps.setExperimentEnabled).toHaveBeenLastCalledWith(id, true)
		rerender(<ExperimentalSettings {...defaultProps} experiments={{ ...experimentDefault, [id]: true }} />)
		fireEvent.click(checkbox)
		expect(defaultProps.setExperimentEnabled).toHaveBeenLastCalledWith(id, false)
	})
})
