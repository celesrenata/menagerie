import type OpenAI from "openai"
import { createReadFileTool } from "../read_file"

// Helper type to access function tools
type FunctionTool = OpenAI.Chat.ChatCompletionTool & { type: "function" }

// Helper to get function definition from tool
const getFunctionDef = (tool: OpenAI.Chat.ChatCompletionTool) => (tool as FunctionTool).function

const getSchemaProperty = (tool: OpenAI.Chat.ChatCompletionTool, name: string): Record<string, unknown> => {
	const parameters = getFunctionDef(tool).parameters
	if (!parameters || typeof parameters !== "object") throw new Error("Expected tool parameters schema")
	const properties = parameters["properties"]
	if (!properties || typeof properties !== "object") throw new Error("Expected tool properties schema")
	const property = (properties as Record<string, unknown>)[name]
	if (!property || typeof property !== "object") throw new Error(`Expected schema for ${name}`)
	return property as Record<string, unknown>
}

describe("createReadFileTool", () => {
	describe("batched file reads", () => {
		it("should document one-call reads for independent files", () => {
			const tool = createReadFileTool()
			const description = getFunctionDef(tool).description

			expect(description).toContain("path MUST be an array")
			expect(description).toContain("every already-known independent file path in the same array")
			expect(description).toContain("Example (batch)")
		})

		it("should require an array of one to eight paths", () => {
			const pathSchema = getSchemaProperty(createReadFileTool(), "path")
			expect(pathSchema).toMatchObject({
				type: "array",
				items: { type: "string" },
			})
			expect(pathSchema).not.toHaveProperty("anyOf")
			expect(getFunctionDef(createReadFileTool()).description).toContain("path MUST be an array")
		})
	})

	describe("indentation mode", () => {
		it("should always include indentation mode in description", () => {
			const tool = createReadFileTool()
			const description = getFunctionDef(tool).description

			expect(description).toContain("indentation")
		})

		it("should always include indentation parameter in schema", () => {
			const tool = createReadFileTool()

			expect(getSchemaProperty(tool, "indentation")).toBeDefined()
		})

		it("should include mode parameter in schema", () => {
			const tool = createReadFileTool()
			const modeSchema = getSchemaProperty(tool, "mode")

			expect(modeSchema).toMatchObject({ enum: expect.arrayContaining(["slice", "indentation"]) })
		})

		it("should include offset and limit parameters in schema", () => {
			const tool = createReadFileTool()

			expect(getSchemaProperty(tool, "offset")).toBeDefined()
			expect(getSchemaProperty(tool, "limit")).toBeDefined()
		})
	})

	describe("supportsImages option", () => {
		it("should include image format documentation when supportsImages is true", () => {
			const tool = createReadFileTool({ supportsImages: true })
			const description = getFunctionDef(tool).description

			expect(description).toContain(
				"Automatically processes and returns image files (PNG, JPG, JPEG, GIF, BMP, SVG, WEBP, ICO, AVIF) for visual analysis",
			)
		})

		it("should not include image format documentation when supportsImages is false", () => {
			const tool = createReadFileTool({ supportsImages: false })
			const description = getFunctionDef(tool).description

			expect(description).not.toContain(
				"Automatically processes and returns image files (PNG, JPG, JPEG, GIF, BMP, SVG, WEBP, ICO, AVIF) for visual analysis",
			)
			expect(description).toContain("may not handle other binary files properly")
		})

		it("should default supportsImages to false", () => {
			const tool = createReadFileTool({})
			const description = getFunctionDef(tool).description

			expect(description).not.toContain(
				"Automatically processes and returns image files (PNG, JPG, JPEG, GIF, BMP, SVG, WEBP, ICO, AVIF) for visual analysis",
			)
		})

		it("should always include PDF and DOCX support in description", () => {
			const toolWithImages = createReadFileTool({ supportsImages: true })
			const toolWithoutImages = createReadFileTool({ supportsImages: false })

			expect(getFunctionDef(toolWithImages).description).toContain(
				"Supports text extraction from PDF and DOCX files",
			)
			expect(getFunctionDef(toolWithoutImages).description).toContain(
				"Supports text extraction from PDF and DOCX files",
			)
		})
	})

	describe("tool structure", () => {
		it("should have correct tool name", () => {
			const tool = createReadFileTool()

			expect(getFunctionDef(tool).name).toBe("read_file")
		})

		it("should be a function type tool", () => {
			const tool = createReadFileTool()

			expect(tool.type).toBe("function")
		})

		it("should have strict mode enabled", () => {
			const tool = createReadFileTool()

			expect(getFunctionDef(tool).strict).toBe(true)
		})

		it("should require path parameter", () => {
			const tool = createReadFileTool()
			const parameters = getFunctionDef(tool).parameters

			expect(parameters).toHaveProperty("required", expect.arrayContaining(["path"]))
		})
	})
})
