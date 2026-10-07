// npx vitest run api/providers/utils/__tests__/timeout-config.spec.ts

import { getApiRequestTimeout, getApiStreamIdleTimeout } from "../timeout-config"
import * as vscode from "vscode"

// Mock vscode
vitest.mock("vscode", () => ({
	workspace: {
		getConfiguration: vitest.fn().mockReturnValue({
			get: vitest.fn(),
		}),
	},
}))

let mockGetConfig: any

beforeEach(() => {
	vitest.clearAllMocks()
	mockGetConfig = vitest.fn()
	;(vscode.workspace.getConfiguration as any).mockReturnValue({
		get: mockGetConfig,
	})
})

describe("getApiRequestTimeout", () => {
	it("should return default timeout of 1800000ms when no configuration is set", () => {
		mockGetConfig.mockReturnValue(1800)

		const timeout = getApiRequestTimeout()

		expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith("zoo-code")
		expect(mockGetConfig).toHaveBeenCalledWith("apiRequestTimeout", 1800)
		expect(timeout).toBe(1800000) // 1800 seconds (30 min) in milliseconds
	})

	it("should return custom timeout in milliseconds when within allowed range", () => {
		mockGetConfig.mockReturnValue(1200) // 20 minutes

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(1200000) // 1200 seconds in milliseconds
	})

	it("should accept the minimum boundary value (1 second)", () => {
		mockGetConfig.mockReturnValue(1)

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(1000)
	})

	it("should accept the maximum boundary value (3600 seconds)", () => {
		mockGetConfig.mockReturnValue(3600)

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(3600000)
	})

	it("should fall back to default for zero (below minimum)", () => {
		mockGetConfig.mockReturnValue(0)

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(1800000)
	})

	it("should fall back to default for negative values (below minimum)", () => {
		mockGetConfig.mockReturnValue(-100)

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(1800000)
	})

	it("should fall back to default for fractional values below 1", () => {
		mockGetConfig.mockReturnValue(0.5)

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(1800000)
	})

	it("should fall back to default for values above the maximum (>3600)", () => {
		mockGetConfig.mockReturnValue(3601)

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(1800000)
	})

	it("should fall back to default for very large values", () => {
		mockGetConfig.mockReturnValue(99999)

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(1800000)
	})

	it("should handle null by using default", () => {
		mockGetConfig.mockReturnValue(null)

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(1800000) // Should fall back to default 1800 seconds (30 min)
	})

	it("should handle undefined by using default", () => {
		mockGetConfig.mockReturnValue(undefined)

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(1800000) // Should fall back to default 1800 seconds (30 min)
	})

	it("should handle NaN by using default", () => {
		mockGetConfig.mockReturnValue(NaN)

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(1800000) // Should fall back to default 1800 seconds (30 min)
	})

	it("should handle string values by using default", () => {
		mockGetConfig.mockReturnValue("not-a-number") // String instead of number

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(1800000) // Should fall back to default since it's not a number
	})

	it("should handle boolean values by using default", () => {
		mockGetConfig.mockReturnValue(true) // Boolean instead of number

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(1800000) // Should fall back to default since it's not a number
	})
})

describe("getApiStreamIdleTimeout", () => {
	it("returns the 1800000ms default when the setting is unset", () => {
		mockGetConfig.mockImplementation((_key: string, defaultValue: number) => defaultValue)

		const timeout = getApiStreamIdleTimeout()

		expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith("zoo-code")
		expect(mockGetConfig).toHaveBeenCalledWith("apiStreamIdleTimeout", 1800)
		expect(timeout).toBe(1800000)
	})

	it("returns 0 (disabled) for 0", () => {
		mockGetConfig.mockReturnValue(0)

		expect(getApiStreamIdleTimeout()).toBe(0)
	})

	it("accepts the maximum boundary value (3600 seconds)", () => {
		mockGetConfig.mockReturnValue(3600)

		expect(getApiStreamIdleTimeout()).toBe(3600000)
	})

	it.each([
		["negative", -1],
		["NaN", NaN],
		["a string", "x"],
		["above the maximum", 4000],
	])("falls back to 1800000ms for %s", (_label, value) => {
		mockGetConfig.mockReturnValue(value)

		expect(getApiStreamIdleTimeout()).toBe(1800000)
	})
})
