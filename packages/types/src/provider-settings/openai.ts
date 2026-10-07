import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import { modelInfoSchema } from "../model.js"
import { baseProviderSettingsShape, createModelIdAccessor, createProviderDefinition } from "./common.js"

export const OPEN_AI_MODEL_ID_FIELD = "openAiModelId"

const OPENAI_EXTRA_BODY_RESERVED_KEYS = [
	// Prototype-pollution defenses; remaining keys are request-owned, including tool-call protocol controls.
	"__proto__",
	"constructor",
	"prototype",
	"max_completion_tokens",
	"max_tokens",
	"messages",
	"model",
	"parallel_tool_calls",
	"reasoning",
	"reasoning_effort",
	"response_format",
	"stream",
	"stream_options",
	"temperature",
	"tool_choice",
	"tools",
] as const

type OpenAiExtraBodyParseResult =
	| { success: true; data: Record<string, unknown> }
	| {
			success: false
			reason: "invalidJson" | "objectRequired" | "reservedKeys"
			data: Record<string, unknown>
			reservedKeys?: string[]
	  }

export function parseOpenAiExtraBody(value: string | undefined): OpenAiExtraBodyParseResult {
	if (!value?.trim()) {
		return { success: true, data: {} }
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(value)
	} catch {
		return { success: false, reason: "invalidJson", data: {} }
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { success: false, reason: "objectRequired", data: {} }
	}

	const entries = Object.entries(parsed)
	const reservedKeys = entries
		.map(([key]) => key)
		.filter((key) => (OPENAI_EXTRA_BODY_RESERVED_KEYS as readonly string[]).includes(key))
	const data = Object.fromEntries(entries.filter(([key]) => !reservedKeys.includes(key)))

	if (reservedKeys.length > 0) {
		return { success: false, reason: "reservedKeys", reservedKeys, data }
	}

	return { success: true, data }
}

const openAiExtraBodySchema = z
	.string()
	.superRefine((value, ctx) => {
		const result = parseOpenAiExtraBody(value)
		if (!result.success) {
			ctx.addIssue({ code: "custom", message: result.reason })
		}
	})
	.optional()

/**
 * The route-capability vocabulary a custom OmniRoute route may be classified as.
 * It MUST stay in lockstep with the `RouteCapability` union and the
 * `ROUTE_CAPABILITIES` tuple in `src/core/task/elasticTypes.ts`: if either side
 * gains or drops a capability, update both. The classifier is read on the
 * extension side by `collectCodeCapableRouteIds` to decide which custom routes a
 * code worker may spread across (a route is code-capable only when it is
 * explicitly `"reasoner"` or `"general"`), so a reader-only alias is never sent
 * code work. The field is optional, so a missing value means "unclassified".
 */
export const routeCapabilitySchema = z.enum(["reader", "reasoner", "long-context", "vision", "general"])

export const openAiProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.openai,
	modelIdKey: OPEN_AI_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(OPEN_AI_MODEL_ID_FIELD),
	schema: {
		...baseProviderSettingsShape,
		openAiBaseUrl: z.string().optional(),
		openAiApiKey: z.string().optional(),
		openAiR1FormatEnabled: z.boolean().optional(),
		[OPEN_AI_MODEL_ID_FIELD]: z.string().optional(),
		openAiCustomModelInfo: modelInfoSchema.nullish(),
		openAiUseAzure: z.boolean().optional(),
		azureApiVersion: z.string().optional(),
		openAiStreamingEnabled: z.boolean().optional(),
		openAiHostHeader: z.string().optional(), // Keep temporarily for backward compatibility during migration.
		openAiHeaders: z.record(z.string(), z.string()).optional(),
		openAiExtraBody: openAiExtraBodySchema,
		// OmniRoute opt-in: when true this OpenAI-compatible profile is treated as an OmniRoute
		// connection (see docs/architecture/omniroute-integration-design.md §1.1). No hostname
		// literal or URL parsing is involved; the flag is the sole discriminator.
		openAiIsOmniRoute: z.boolean().optional(),
		// User-defined convenience mapping of a friendly route name -> an OmniRoute catalog model id.
		// Purely a menagerie-side alias; selecting a custom route just sets openAiModelId (§2.2).
		// `capability` is an OPTIONAL per-route classifier (see `routeCapabilitySchema`): it lets a
		// code worker's lane-driven backend spread target code-capable routes (reasoner/general) and
		// never a reader-only alias. Optional so every existing persisted profile round-trips unchanged.
		openAiOmniRouteCustomRoutes: z
			.array(z.object({ name: z.string(), modelId: z.string(), capability: routeCapabilitySchema.optional() }))
			.optional(),
		// Default OmniRoute catalog id for reader-role parallel workers when they set no explicit route.
		// Unset => readers fall back to the parent openAiModelId (§5.3).
		openAiOmniRouteReaderRouteId: z.string().optional(),
		// Default OmniRoute catalog id for reasoner-role parallel workers when they set no explicit route.
		// Unset => reasoners fall back to the parent openAiModelId (§5.3).
		openAiOmniRouteReasonerRouteId: z.string().optional(),
		// Per-request OmniRoute cost-tier ceiling (1-5) threaded onto the chat request as the
		// `X-OmniRoute-Tier` header (FEAT-005). The source of truth is the global `omniRouteTier`
		// setting (bound beside the YOLO control); ClineProvider.getState() copies it onto the
		// active OmniRoute profile so the request path can read it from ApiHandlerOptions. Unset
		// => no header, OmniRoute keeps its default.
		omniRouteTier: z.number().int().min(1).max(5).optional(),
	},
})
