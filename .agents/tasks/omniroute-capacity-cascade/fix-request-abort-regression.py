from pathlib import Path

path = Path("/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/tests/unit/chatcore-translation-paths.test.ts")
text = path.read_text()
start = text.index('test("chatCore request signal abort releases streaming account before and after content"')
replacement = '''test("chatCore request signal abort releases streaming account before and after content", async () => {
  for (const afterContent of [false, true]) {
    const connectionId = `request-signal-abort-${afterContent ? "after" : "before"}`;
    const semaphoreKey = buildAccountSemaphoreKey({ provider: "openai", accountKey: connectionId });
    const requestController = new AbortController();
    const releaseLogs: string[] = [];
    let sourceCancelCount = 0;
    const body = {
      model: "gpt-4o-mini",
      stream: true,
      messages: [{ role: "user", content: "request signal abort" }],
    };

    globalThis.fetch = async () => {
      const delta = afterContent ? { content: "partial" } : { role: "assistant" };
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\\n\\n`
            )
          );
        },
        cancel() {
          sourceCancelCount += 1;
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

    assert.equal(getAccountSemaphoreStats()[semaphoreKey]?.running, 1);
    const reader = result.response.body!.getReader();
    if (afterContent) {
      const first = await reader.read();
      assert.match(new TextDecoder().decode(first.value), /partial/);
    }
    requestController.abort(new Error(afterContent ? "abort-after-content" : "abort-before-content"));
    await reader.cancel(requestController.signal.reason);
    await waitFor(() => (getAccountSemaphoreStats()[semaphoreKey]?.running ?? 0) === 0, 5000);

    assert.equal(requestController.signal.aborted, true);
    assert.equal(sourceCancelCount, 1);
    assert.equal(getAccountSemaphoreStats()[semaphoreKey]?.running ?? 0, 0);
    assert.equal(releaseLogs.length, 1, "request abort must release the permit exactly once");
  }
});
'''
path.write_text(text[:start] + replacement)
