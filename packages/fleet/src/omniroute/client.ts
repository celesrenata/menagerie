// The toolkit's interface to OmniRoute's management HTTP API (design §3,
// "Management API surface"). The Reconciler and Fleet_Observer drive OmniRoute
// through this interface; task 4.2 provides an in-memory fake implementing the
// same surface for tests.
//
// Every method resolves the management bearer token from an injected
// SecretResolver at call time and places it in the Authorization header. The
// bearer value is NEVER logged and NEVER included in an error (Requirement
// 22.3, 22.4). Error objects redact credential values and tokenized URL path
// segments (Requirement 22.4, 22.5).

import { REDACTION_MARKER, redactBodySummary, redactTokenizedSegments } from "./redact.js"

// ---------------------------------------------------------------------------
// Typed request/response shapes
// ---------------------------------------------------------------------------
//
// Shapes are kept minimal and aligned to design §2 "live combo schema" (combos
// carry name/strategy/models[]/config/context_length/isHidden) and the
// management API surface table in design §3. They describe only the fields the
// toolkit reads or writes; OmniRoute-owned bookkeeping fields are tolerated via
// index signatures where present but are not modeled here.

export type ComboStrategy = "priority"

export interface ComboModelRef {
	readonly id: string
	readonly kind: "model" | "combo-ref"
	readonly model?: string
	readonly providerId?: string
	readonly connectionId?: string
	readonly weight?: number
	readonly comboName?: string
}

export interface Combo {
	readonly id: string
	readonly name: string
	readonly strategy: ComboStrategy
	readonly models: readonly ComboModelRef[]
	readonly config: Readonly<Record<string, unknown>>
	readonly context_length: number
	readonly isHidden: boolean
}

// A combo create/update payload: the live combo shape without the
// OmniRoute-assigned id (create) or with it supplied as a path parameter
// (update).
export type ComboInput = Omit<Combo, "id">

export interface Connection {
	readonly id: string
	readonly provider: string
	readonly address: string
	readonly isActive: boolean
	readonly maxConcurrent?: number
	readonly defaultModel?: string
	readonly rateLimitOverrides?: Readonly<Record<string, unknown>>
}

// Fields a connection PATCH may set (design §3 "List / patch connections").
export type ConnectionPatch = Partial<
	Pick<Connection, "maxConcurrent" | "isActive" | "defaultModel" | "rateLimitOverrides">
>

export interface ContextOverride {
	readonly model: string
	readonly contextLength: number
}

// A set of per-model context overrides to apply or remove
// (`GET`/`PATCH`/`DELETE /api/model-capability-overrides`).
export interface ContextOverridePatch {
	readonly upserts?: readonly ContextOverride[]
	readonly removes?: readonly string[]
}

export interface AdvertisedModel {
	readonly id: string
	readonly contextLength?: number
}

export interface CallLogRecord {
	readonly timestamp: string
	readonly status: number
	readonly provider: string
	readonly model: string
	readonly requestedModel?: string
	readonly connectionId?: string
	readonly comboName?: string
	readonly correlationId?: string
	readonly errorType?: string
	readonly ttftMs?: number
	readonly addedWaitMs?: number
	readonly addedWaitCause?: string
	readonly sessionTag?: string
}

export interface CallLogQuery {
	readonly status?: number
	readonly model?: string
	readonly provider?: string
	readonly combo?: string
	readonly correlationId?: string
	readonly limit?: number
	readonly offset?: number
}

// Routing-decision trace for one request: metadata only, never body content
// (Requirement 22.6).
export interface ComboTrace {
	readonly id: string
	readonly steps: readonly Readonly<Record<string, unknown>>[]
}

// ---------------------------------------------------------------------------
// Secret resolution
// ---------------------------------------------------------------------------

// Resolves a Fleet_Inventory secret reference to its value at use time. The
// toolkit never caches a resolved secret beyond the request that needs it
// (Requirement 22.3). A reference that cannot be resolved yields `undefined`;
// the caller treats that as a missing-secret error (Requirement 22.8).
export interface SecretResolver {
	resolve(ref: string): Promise<string | undefined>
}

// ---------------------------------------------------------------------------
// Error type — credential- and token-free (Requirement 22.4, 22.5)
// ---------------------------------------------------------------------------

// An OmniRoute management-API error. Carries the HTTP status, the operation
// name, the request method, a redacted URL, and a redacted body summary. It
// NEVER carries the bearer token, any resolved secret, or a tokenized path
// segment. The redacted fields are safe to log, report, and audit.
export class OmniRouteApiError extends Error {
	readonly operation: string
	readonly method: string
	readonly status: number
	readonly redactedUrl: string
	readonly redactedBody: string

	constructor(args: {
		operation: string
		method: string
		status: number
		redactedUrl: string
		redactedBody: string
	}) {
		super(
			`OmniRoute ${args.operation} failed: ${args.method} ${args.redactedUrl} -> ${args.status} ${args.redactedBody}`,
		)
		this.name = "OmniRouteApiError"
		this.operation = args.operation
		this.method = args.method
		this.status = args.status
		this.redactedUrl = args.redactedUrl
		this.redactedBody = args.redactedBody
	}
}

// Raised when the management bearer secret does not resolve to a non-empty
// value (Requirement 22.8). Carries the secret reference and field path, never
// a value.
export class MissingSecretError extends Error {
	readonly ref: string
	readonly fieldPath: string

	constructor(ref: string, fieldPath: string) {
		super(`OmniRoute management secret '${ref}' at '${fieldPath}' did not resolve to a non-empty value`)
		this.name = "MissingSecretError"
		this.ref = ref
		this.fieldPath = fieldPath
	}
}

// ---------------------------------------------------------------------------
// Client interface
// ---------------------------------------------------------------------------

export interface OmniRouteClient {
	// Reads (design §3 management surface; Requirement 22.1 read-only).
	listCombos(): Promise<Combo[]>
	listConnections(): Promise<Connection[]>
	getAdvertisedModels(connectionId: string): Promise<AdvertisedModel[]>
	getContextOverrides(): Promise<ContextOverride[]>
	getComboTrace(id: string): Promise<ComboTrace>
	readCallLogs(params: CallLogQuery): Promise<CallLogRecord[]>

	// Writes (apply/rollback only; Requirement 22.2).
	createCombo(combo: ComboInput): Promise<Combo>
	updateCombo(id: string, combo: ComboInput): Promise<Combo>
	deleteCombo(id: string): Promise<void>
	patchConnection(id: string, patch: ConnectionPatch): Promise<Connection>
	patchContextOverrides(patch: ContextOverridePatch): Promise<ContextOverride[]>
	syncModels(connectionId: string): Promise<void>
}

// ---------------------------------------------------------------------------
// HTTP implementation
// ---------------------------------------------------------------------------

// Minimal view of the global fetch so the client can be constructed with a stub
// in tests without importing Node/DOM lib types. Node 22 provides `fetch`.
export type FetchLike = (input: string, init?: FetchInit) => Promise<FetchResponse>

export interface FetchInit {
	method?: string
	headers?: Record<string, string>
	body?: string
}

export interface FetchResponse {
	readonly ok: boolean
	readonly status: number
	text(): Promise<string>
}

export interface HttpOmniRouteClientOptions {
	// Base URL of the OmniRoute instance, e.g. `https://cluster.example:8080`.
	readonly baseUrl: string
	// Secret reference for the management bearer key (resolved at call time).
	readonly managementSecretRef: string
	// Inventory field path that declares the management secret, for error
	// reporting only (never a value).
	readonly managementSecretFieldPath: string
	readonly secretResolver: SecretResolver
	// Injected for tests; defaults to the global fetch.
	readonly fetch?: FetchLike
}

export class HttpOmniRouteClient implements OmniRouteClient {
	private readonly baseUrl: string
	private readonly managementSecretRef: string
	private readonly managementSecretFieldPath: string
	private readonly secretResolver: SecretResolver
	private readonly fetchImpl: FetchLike

	constructor(options: HttpOmniRouteClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "")
		this.managementSecretRef = options.managementSecretRef
		this.managementSecretFieldPath = options.managementSecretFieldPath
		this.secretResolver = options.secretResolver
		const injected = options.fetch
		if (injected) {
			this.fetchImpl = injected
		} else {
			const globalFetch = (globalThis as { fetch?: FetchLike }).fetch
			if (!globalFetch) {
				throw new Error("global fetch is unavailable; inject a fetch implementation")
			}
			this.fetchImpl = globalFetch
		}
	}

	// --- reads ---------------------------------------------------------------

	async listCombos(): Promise<Combo[]> {
		return this.requestArray<Combo>("listCombos", "GET", "/api/combos")
	}

	async listConnections(): Promise<Connection[]> {
		// The live management API returns a connection's upstream address NESTED in
		// `providerSpecificData.baseUrl` (e.g. a vllm/ollama/llama-cpp connection), NOT
		// as a top-level `address` field. The endpoint->connection match in the
		// Reconciler keys on `hostPort(connection.address)`, so a raw cast would leave
		// `address` undefined and every self-hosted endpoint would fail to resolve
		// (`missing-connection`). Map each raw record into a `Connection`, lifting the
		// address out of the provider-specific data so the host:port match succeeds.
		const raw = await this.requestArray<Record<string, unknown>>(
			"listConnections",
			"GET",
			"/api/providers",
		)
		return raw.map(toConnection)
	}

	async getAdvertisedModels(connectionId: string): Promise<AdvertisedModel[]> {
		return this.requestArray<AdvertisedModel>(
			"getAdvertisedModels",
			"GET",
			`/api/providers/${encodeURIComponent(connectionId)}/models`,
		)
	}

	async getContextOverrides(): Promise<ContextOverride[]> {
		return this.requestArray<ContextOverride>("getContextOverrides", "GET", "/api/model-capability-overrides")
	}

	async getComboTrace(id: string): Promise<ComboTrace> {
		return this.request<ComboTrace>("getComboTrace", "GET", `/api/usage/combo-trace/${encodeURIComponent(id)}`)
	}

	async readCallLogs(params: CallLogQuery): Promise<CallLogRecord[]> {
		const query = buildCallLogQuery(params)
		return this.requestArray<CallLogRecord>("readCallLogs", "GET", `/api/usage/call-logs${query}`)
	}

	// --- writes --------------------------------------------------------------

	async createCombo(combo: ComboInput): Promise<Combo> {
		return this.request<Combo>("createCombo", "POST", "/api/combos", combo)
	}

	async updateCombo(id: string, combo: ComboInput): Promise<Combo> {
		return this.request<Combo>("updateCombo", "PUT", `/api/combos/${encodeURIComponent(id)}`, combo)
	}

	async deleteCombo(id: string): Promise<void> {
		await this.request<unknown>("deleteCombo", "DELETE", `/api/combos/${encodeURIComponent(id)}`)
	}

	async patchConnection(id: string, patch: ConnectionPatch): Promise<Connection> {
		return this.request<Connection>(
			"patchConnection",
			"PATCH",
			`/api/providers/${encodeURIComponent(id)}`,
			patch,
		)
	}

	async patchContextOverrides(patch: ContextOverridePatch): Promise<ContextOverride[]> {
		return this.request<ContextOverride[]>(
			"patchContextOverrides",
			"PATCH",
			"/api/model-capability-overrides",
			patch,
		)
	}

	async syncModels(connectionId: string): Promise<void> {
		await this.request<unknown>(
			"syncModels",
			"POST",
			`/api/providers/${encodeURIComponent(connectionId)}/sync-models`,
		)
	}

	// --- transport -----------------------------------------------------------

	private async resolveBearer(): Promise<string> {
		const value = await this.secretResolver.resolve(this.managementSecretRef)
		if (typeof value !== "string" || value.trim().length === 0) {
			throw new MissingSecretError(this.managementSecretRef, this.managementSecretFieldPath)
		}
		return value
	}

	private async request<T>(
		operation: string,
		method: string,
		path: string,
		body?: unknown,
	): Promise<T> {
		// Resolve the bearer at call time; it is used only in the Authorization
		// header and never retained, logged, or placed in an error.
		const bearer = await this.resolveBearer()
		const url = `${this.baseUrl}${path}`

		const headers: Record<string, string> = { Authorization: `Bearer ${bearer}` }
		const init: FetchInit = { method, headers }
		if (body !== undefined) {
			headers["Content-Type"] = "application/json"
			init.body = JSON.stringify(body)
		}

		const response = await this.fetchImpl(url, init)
		if (!response.ok) {
			// Read the error body, then redact the bearer, any secret value, and
			// tokenized path segments before it reaches the error object.
			const rawBody = await safeReadText(response)
			throw new OmniRouteApiError({
				operation,
				method,
				status: response.status,
				redactedUrl: redactTokenizedSegments(url),
				redactedBody: redactBodySummary(rawBody, [bearer]),
			})
		}

		if (method === "DELETE") {
			// Delete responses may be empty; callers typed as void ignore the value.
			return undefined as T
		}

		const text = await response.text()
		if (text.length === 0) {
			return undefined as T
		}
		return JSON.parse(text) as T
	}

	/**
	 * A list read whose live payload may be a bare JSON array OR an object that
	 * WRAPS the array under a conventional key. The live OmniRoute management API
	 * returns list endpoints wrapped (e.g. `/api/combos` -> `{ object, data, combos }`),
	 * so a bare-`JSON.parse(text) as T[]` would hand a non-array object to callers
	 * such as `compareCombos`, which then throws `live.map is not a function`. This
	 * mirrors the unwrapping the Menagerie webview client already applies to the
	 * same endpoint (`response.data?.data ?? response.data?.combos ?? response.data`).
	 *
	 * Unwrap order: a bare array is used as-is; otherwise the body's `data` array,
	 * else the first own-property whose value is an array. An empty body or a body
	 * with no array degrades to `[]` (downstream drift treats absent items as
	 * missing/extra rather than crashing). Never returns `undefined`.
	 */
	private async requestArray<T>(
		operation: string,
		method: string,
		path: string,
		body?: unknown,
	): Promise<T[]> {
		const raw = await this.request<unknown>(operation, method, path, body)
		return unwrapArray<T>(raw)
	}
}

/**
 * Unwrap a list payload into an array of `T`. Accepts a bare array, an object
 * with a `data` array, or an object whose first array-valued own-property holds
 * the list (covering the live `combos` / `providers` / `models` wrappers). Any
 * other shape — including `undefined` from an empty body — yields `[]`.
 *
 * The element type is the caller's contract exactly as `request<T>`'s
 * `JSON.parse(text) as T` is: we narrow the container with `Array.isArray` and
 * cast only the element type, never the array-ness.
 */
function unwrapArray<T>(raw: unknown): T[] {
	if (Array.isArray(raw)) {
		return raw as T[]
	}
	if (raw !== null && typeof raw === "object") {
		const record = raw as Record<string, unknown>
		if (Array.isArray(record.data)) {
			return record.data as T[]
		}
		for (const value of Object.values(record)) {
			if (Array.isArray(value)) {
				return value as T[]
			}
		}
	}
	return []
}

/**
 * Map a raw `/api/providers` record into a {@link Connection}, lifting the
 * upstream address out of `providerSpecificData.baseUrl` (the only place the
 * live API exposes it) into the top-level `address` the Reconciler matches on.
 * A top-level `address` is honored if the server ever provides one; otherwise
 * the provider-specific `baseUrl` is used, falling back to the snake_case
 * `provider_specific_data.baseUrl` for older server builds. The address is left
 * as the empty string when none is present, which the match treats as
 * unresolved (unchanged behavior for a connection that truly has no address).
 */
function toConnection(raw: Record<string, unknown>): Connection {
	const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
	const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined)
	const obj = (v: unknown): Record<string, unknown> | undefined =>
		v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined

	const psd = obj(raw.providerSpecificData) ?? obj(raw.provider_specific_data)
	const address = str(raw.address) ?? str(psd?.baseUrl) ?? str(psd?.base_url) ?? ""
	const rateLimitOverrides = obj(raw.rateLimitOverrides) ?? obj(raw.rate_limit_overrides)

	return {
		id: str(raw.id) ?? "",
		provider: str(raw.provider) ?? "",
		address,
		isActive: raw.isActive === true || raw.is_active === true,
		...(num(raw.maxConcurrent ?? raw.max_concurrent) !== undefined
			? { maxConcurrent: num(raw.maxConcurrent ?? raw.max_concurrent) }
			: {}),
		...(str(raw.defaultModel ?? raw.default_model) !== undefined
			? { defaultModel: str(raw.defaultModel ?? raw.default_model) }
			: {}),
		...(rateLimitOverrides !== undefined ? { rateLimitOverrides } : {}),
	}
}

// Build a `?key=value&...` query string for the call-log read, omitting unset
// fields. Values are URL-encoded.
const buildCallLogQuery = (params: CallLogQuery): string => {
	const pairs: [string, string][] = []
	if (params.status !== undefined) pairs.push(["status", String(params.status)])
	if (params.model !== undefined) pairs.push(["model", params.model])
	if (params.provider !== undefined) pairs.push(["provider", params.provider])
	if (params.combo !== undefined) pairs.push(["combo", params.combo])
	if (params.correlationId !== undefined) pairs.push(["correlationId", params.correlationId])
	if (params.limit !== undefined) pairs.push(["limit", String(params.limit)])
	if (params.offset !== undefined) pairs.push(["offset", String(params.offset)])
	if (pairs.length === 0) return ""
	const encoded = pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
	return `?${encoded}`
}

// Read a response body as text, never throwing: a body-read failure yields an
// empty summary rather than masking the HTTP status with a transport error.
const safeReadText = async (response: FetchResponse): Promise<string> => {
	try {
		return await response.text()
	} catch {
		return ""
	}
}

// Re-exported so callers that build their own artifacts share one marker.
export { REDACTION_MARKER }
