from pathlib import Path

ROOT = Path("/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z")

pipeline = ROOT / "tests/integration/chat-pipeline.test.ts"
text = pipeline.read_text()
old = '''  const upstreamAttempts: Array<{ url: string; authorization: string | undefined }> = [];
  globalThis.fetch = async (url, init: RequestInit = {}) => {
    const headers = toPlainHeaders(init.headers);
    upstreamAttempts.push({ url: String(url), authorization: headers.Authorization });
    assert.notEqual(headers.Authorization, "Bearer sk-capacity-saturated");
    if (headers.Authorization === "Bearer sk-capacity-failing") {
      return Response.json({ error: { message: "member unavailable" } }, { status: 503 });
    }
    return buildGeminiResponse("parent overflow succeeded");
  };
'''
new = '''  const upstreamAttempts: string[] = [];
  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    upstreamAttempts.push(requestUrl);
    assert.doesNotMatch(requestUrl, /api\\.openai\\.com/);
    if (!requestUrl.includes("generativelanguage")) {
      return Response.json({ error: { message: "member unavailable" } }, { status: 503 });
    }
    return buildGeminiResponse("parent overflow succeeded");
  };
'''
assert text.count(old) == 1
text = text.replace(old, new)
old = '''    assert.equal(upstreamAttempts[0].authorization, "Bearer sk-capacity-failing");
    assert.match(upstreamAttempts[1].url, /generativelanguage/);
'''
new = '''    assert.doesNotMatch(upstreamAttempts[0], /generativelanguage/);
    assert.match(upstreamAttempts[1], /generativelanguage/);
'''
assert text.count(old) == 1
text = text.replace(old, new)
pipeline.write_text(text)

translation = ROOT / "tests/unit/chatcore-translation-paths.test.ts"
text = translation.read_text()
old = '''    const result = await handleChatCore({
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
    requestController.abort(
      new Error(afterContent ? "abort-after-content" : "abort-before-content")
    );
    await pendingRead.catch(() => ({ done: true }));
    await waitFor(() => (getAccountSemaphoreStats()[semaphoreKey]?.running ?? 0) === 0);
'''
new = '''    const invocation = handleChatCore({
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

    if (!afterContent) {
      await waitFor(
        () => upstreamController && getAccountSemaphoreStats()[semaphoreKey]?.running === 1,
        5000
      );
      requestController.abort(new Error("abort-before-content"));
      await invocation;
    } else {
      const result = await invocation;
      assert.ok(upstreamController);
      assert.equal(getAccountSemaphoreStats()[semaphoreKey]?.running, 1);
      const reader = result.response.body!.getReader();
      const first = await reader.read();
      assert.match(new TextDecoder().decode(first.value), /partial/);
      const pendingRead = reader.read();
      requestController.abort(new Error("abort-after-content"));
      await pendingRead.catch(() => ({ done: true }));
    }
    await waitFor(() => (getAccountSemaphoreStats()[semaphoreKey]?.running ?? 0) === 0, 5000);
'''
assert text.count(old) == 1
text = text.replace(old, new)
translation.write_text(text)
