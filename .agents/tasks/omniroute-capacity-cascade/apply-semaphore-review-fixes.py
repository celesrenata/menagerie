from pathlib import Path

ROOT = Path("/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z")

pipeline = ROOT / "tests/integration/chat-pipeline.test.ts"
text = pipeline.read_text()
old = '''const { clearProviderFailure } = await import("../../open-sse/services/accountFallback.ts");
'''
new = '''const { clearProviderFailure } = await import("../../open-sse/services/accountFallback.ts");
const {
  acquire: acquireAccountSemaphore,
  buildAccountSemaphoreKey,
  getStats: getAccountSemaphoreStats,
} = await import("../../open-sse/services/accountSemaphore.ts");
const { getComboMetrics } = await import("../../open-sse/services/comboMetrics.ts");
'''
assert text.count(old) == 1
text = text.replace(old, new)
marker = '''test("chat pipeline deduplicates concurrent identical non-stream requests", async () => {
'''
test_block = '''test("chat pipeline carries account capacity through member and parent fallback", async () => {
  const saturated = await seedConnection("openai", {
    name: "capacity-saturated",
    apiKey: "sk-capacity-saturated",
  });
  const failing = await seedConnection("claude", {
    name: "capacity-failing-member",
    apiKey: "sk-capacity-failing",
  });
  const overflow = await seedConnection("gemini", {
    name: "capacity-parent-overflow",
    apiKey: "sk-capacity-overflow",
  });
  await Promise.all([
    providersDb.updateProviderConnection(saturated.id, { maxConcurrent: 1 }),
    providersDb.updateProviderConnection(failing.id, { maxConcurrent: 1 }),
    providersDb.updateProviderConnection(overflow.id, { maxConcurrent: 1 }),
  ]);

  const leaf = await combosDb.createCombo({
    name: "pipeline-capacity-leaf",
    strategy: "round-robin",
    models: [
      {
        id: "capacity-openai",
        kind: "model",
        model: "openai/gpt-4o-mini",
        providerId: "openai",
        connectionId: saturated.id,
        weight: 1,
      },
      {
        id: "capacity-claude",
        kind: "model",
        model: "claude/claude-3-5-sonnet-20241022",
        providerId: "claude",
        connectionId: failing.id,
        weight: 1,
      },
    ],
    config: {
      maxRetries: 0,
      queueDepth: 0,
      queueTimeoutMs: 1000,
      failFastOnAccountCapacity: true,
      failoverBeforeRetry: true,
      disablePromptCacheAffinity: true,
    },
  });
  const overflowLeaf = await combosDb.createCombo({
    name: "pipeline-capacity-overflow",
    strategy: "round-robin",
    models: [
      {
        id: "capacity-gemini",
        kind: "model",
        model: "gemini/gemini-2.5-flash",
        providerId: "gemini",
        connectionId: overflow.id,
        weight: 1,
      },
    ],
    config: { maxRetries: 0 },
  });
  await combosDb.createCombo({
    name: "pipeline-capacity-parent",
    strategy: "priority",
    models: [
      { id: "capacity-tier1", kind: "combo-ref", comboName: leaf.name },
      { id: "capacity-tier1b", kind: "combo-ref", comboName: overflowLeaf.name },
    ],
    config: { nestedComboMode: "execute", maxRetries: 0, failoverBeforeRetry: true },
  });

  const semaphoreKey = buildAccountSemaphoreKey({
    provider: "openai",
    accountKey: saturated.id,
  });
  const release = await acquireAccountSemaphore(semaphoreKey, { maxConcurrency: 1 });
  const upstreamAttempts: Array<{ url: string; authorization: string | undefined }> = [];
  globalThis.fetch = async (url, init: RequestInit = {}) => {
    const headers = toPlainHeaders(init.headers);
    upstreamAttempts.push({ url: String(url), authorization: headers.Authorization });
    assert.notEqual(headers.Authorization, "Bearer sk-capacity-saturated");
    if (headers.Authorization === "Bearer sk-capacity-failing") {
      return Response.json({ error: { message: "member unavailable" } }, { status: 503 });
    }
    return buildGeminiResponse("parent overflow succeeded");
  };

  try {
    const response = await handleChat(
      buildRequest({
        body: {
          model: "pipeline-capacity-parent",
          stream: false,
          messages: [{ role: "user", content: "cascade immediately" }],
        },
      })
    );
    const json = (await response.json()) as any;

    assert.equal(response.status, 200);
    assert.equal(json.choices[0].message.content, "parent overflow succeeded");
    assert.equal(upstreamAttempts.length, 2, "capacity skip must not dispatch or retry upstream");
    assert.equal(upstreamAttempts[0].authorization, "Bearer sk-capacity-failing");
    assert.match(upstreamAttempts[1].url, /generativelanguage/);
    assert.equal(getAccountSemaphoreStats()[semaphoreKey]?.queued, 0);
    const metrics = getComboMetrics(leaf.name);
    assert.equal(metrics?.byTarget["capacity-openai"]?.requests ?? 0, 0);
    assert.equal(metrics?.byTarget["capacity-claude"]?.requests, 1);
    const saturatedAfter = await providersDb.getProviderConnectionById(saturated.id);
    assert.ok(!saturatedAfter?.rateLimitedUntil, "capacity skip must not cool the account");
  } finally {
    release();
  }
});

'''
assert text.count(marker) == 1
text = text.replace(marker, test_block + marker)
pipeline.write_text(text)

translation = ROOT / "tests/unit/chatcore-translation-paths.test.ts"
text = translation.read_text()
append = '''

test("chatCore request signal abort releases streaming account before and after content", async () => {
  for (const afterContent of [false, true]) {
    const connectionId = `request-signal-abort-${afterContent ? "after" : "before"}`;
    const semaphoreKey = buildAccountSemaphoreKey({ provider: "openai", accountKey: connectionId });
    const requestController = new AbortController();
    const releaseLogs: string[] = [];
    let upstreamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let upstreamSignal: AbortSignal | null = null;
    const body = {
      model: "gpt-4o-mini",
      stream: true,
      messages: [{ role: "user", content: "request signal abort" }],
    };

    globalThis.fetch = async (_url, init: RequestInit = {}) => {
      upstreamSignal = init.signal as AbortSignal;
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          upstreamController = controller;
          if (afterContent) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\\n\\n'
              )
            );
          }
          upstreamSignal?.addEventListener(
            "abort",
            () => controller.error(upstreamSignal?.reason ?? new Error("upstream aborted")),
            { once: true }
          );
        },
      });
      return new Response(source, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "openai", model: "gpt-4o-mini", extendedContext: false },
      credentials: {
        apiKey: "sk-request-abort",
        connectionId,
        maxConcurrent: 1,
        providerSpecificData: {},
      },
      log: {
        ...noopLog(),
        debug(tag: string, message: string) {
          if (tag === "ACCOUNT_SEMAPHORE" && message.startsWith("release ")) {
            releaseLogs.push(message);
          }
        },
      },
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: structuredClone(body),
        headers: new Headers({ accept: "text/event-stream" }),
        signal: requestController.signal,
      },
      connectionId,
      userAgent: "unit-test",
    } as any);

    assert.ok(upstreamController);
    assert.equal(getAccountSemaphoreStats()[semaphoreKey]?.running, 1);
    const reader = result.response.body!.getReader();
    if (afterContent) {
      const first = await reader.read();
      assert.match(new TextDecoder().decode(first.value), /partial/);
    }
    const pendingRead = reader.read();
    requestController.abort(new Error(afterContent ? "abort-after-content" : "abort-before-content"));
    await pendingRead.catch(() => ({ done: true }));
    await waitFor(() => (getAccountSemaphoreStats()[semaphoreKey]?.running ?? 0) === 0);

    assert.equal(upstreamSignal?.aborted, true);
    assert.equal(getAccountSemaphoreStats()[semaphoreKey]?.running ?? 0, 0);
    assert.equal(releaseLogs.length, 1, "request abort must release the permit exactly once");
  }
});
'''
assert "chatCore request signal abort releases streaming account before and after content" not in text
translation.write_text(text.rstrip() + append + "\n")
