// npx vitest src/components/settings/__tests__/YoloSettings.spec.tsx
import { render, screen, fireEvent } from "@/utils/test-utils"

import { YoloSettings } from "../YoloSettings"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/components/ui", () => ({
	Input: ({ value, onChange, "data-testid": dataTestId }: any) => (
		<input type="number" value={value} onChange={onChange} data-testid={dataTestId} />
	),
	Select: ({ children, value, onValueChange }: any) => (
		<div data-testid="select" data-value={value}>
			{children}
			<button data-testid="select-strict" onClick={() => onValueChange("strict")} />
		</div>
	),
	SelectContent: ({ children }: any) => <div>{children}</div>,
	SelectItem: ({ children, value }: any) => <div data-testid={`select-item-${value}`}>{children}</div>,
	SelectTrigger: ({ children }: any) => <div>{children}</div>,
	SelectValue: () => null,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ children, onChange, checked, "data-testid": dataTestId }: any) => (
		<label>
			<input
				type="checkbox"
				checked={!!checked}
				onChange={(e) => onChange({ target: { checked: e.target.checked } })}
				data-testid={dataTestId}
			/>
			{children}
		</label>
	),
}))

const renderYolo = (overrides = {}) => {
	const setCachedStateField = vi.fn()
	render(<YoloSettings setCachedStateField={setCachedStateField} {...overrides} />)
	return { setCachedStateField }
}

describe("YoloSettings", () => {
	it("offers the four guard levels and no Off option", () => {
		renderYolo()
		for (const level of ["hangLoose", "relaxed", "standard", "strict"]) {
			expect(screen.getByTestId(`select-item-${level}`)).toBeInTheDocument()
		}
		expect(screen.queryByTestId("select-item-off")).not.toBeInTheDocument()
	})

	it("shows documented defaults when values are unset", () => {
		renderYolo()
		expect((screen.getByTestId("tenacity-max-tries-input") as HTMLInputElement).value).toBe("10")
		expect(screen.getByTestId("select").getAttribute("data-value")).toBe("relaxed")
		expect((screen.getByTestId("tenacity-enabled-checkbox") as HTMLInputElement).checked).toBe(false)
		expect((screen.getByTestId("yolo-approve-outside-workspace-checkbox") as HTMLInputElement).checked).toBe(true)
		expect((screen.getByTestId("yolo-workers-any-tool-checkbox") as HTMLInputElement).checked).toBe(false)
		expect((screen.getByTestId("yolo-no-command-timeout-checkbox") as HTMLInputElement).checked).toBe(false)
	})

	it("writes changes through setCachedStateField with the right key", () => {
		const { setCachedStateField } = renderYolo()
		fireEvent.click(screen.getByTestId("tenacity-enabled-checkbox"))
		expect(setCachedStateField).toHaveBeenCalledWith("tenacityEnabled", true)
		fireEvent.click(screen.getByTestId("tenacity-unlimited-checkbox"))
		expect(setCachedStateField).toHaveBeenCalledWith("tenacityUnlimited", true)
		fireEvent.click(screen.getByTestId("yolo-approve-outside-workspace-checkbox"))
		expect(setCachedStateField).toHaveBeenCalledWith("yoloApproveOutsideWorkspace", false)
		fireEvent.click(screen.getByTestId("yolo-skip-request-cost-pauses-checkbox"))
		expect(setCachedStateField).toHaveBeenCalledWith("yoloSkipRequestCostPauses", false)
		fireEvent.click(screen.getByTestId("yolo-auto-answer-followups-checkbox"))
		expect(setCachedStateField).toHaveBeenCalledWith("yoloAutoAnswerFollowups", false)
		fireEvent.click(screen.getByTestId("yolo-workers-any-tool-checkbox"))
		expect(setCachedStateField).toHaveBeenCalledWith("yoloWorkersAnyTool", true)
		fireEvent.click(screen.getByTestId("yolo-no-command-timeout-checkbox"))
		expect(setCachedStateField).toHaveBeenCalledWith("yoloNoCommandTimeout", true)
		fireEvent.click(screen.getByTestId("select-strict"))
		expect(setCachedStateField).toHaveBeenCalledWith("dcgGuardLevel", "strict")
	})

	it("clamps tries to 1-1000 and ignores non-numeric input", () => {
		const { setCachedStateField } = renderYolo()
		const input = screen.getByTestId("tenacity-max-tries-input")
		fireEvent.change(input, { target: { value: "5000" } })
		expect(setCachedStateField).toHaveBeenLastCalledWith("tenacityMaxTries", 1000)
		fireEvent.change(input, { target: { value: "0" } })
		expect(setCachedStateField).toHaveBeenLastCalledWith("tenacityMaxTries", 1)
		setCachedStateField.mockClear()
		fireEvent.change(input, { target: { value: "" } })
		expect(setCachedStateField).not.toHaveBeenCalled()
	})
})
