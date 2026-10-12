from pathlib import Path

root = Path("/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z")
chat_core = root / "open-sse/handlers/chatCore.ts"
text = chat_core.read_text()
old = '''                return {
                  ...res,
                  _executionCredentials: execCreds,
                  response: new Response(clientBody, {
                    status: res.response.status,
                    statusText: res.response.statusText,
                    headers: new Headers(normalizeHeaders(res.response.headers)),
                  }),
                };
'''
new = '''                const responseHeaders = new Headers(normalizeHeaders(res.response.headers));
                responseHeaders.delete("x-omniroute-account-capacity");
                return {
                  ...res,
                  _executionCredentials: execCreds,
                  response: new Response(clientBody, {
                    status: res.response.status,
                    statusText: res.response.statusText,
                    headers: responseHeaders,
                  }),
                };
'''
assert text.count(old) == 1
text = text.replace(old, new)
old = '''        stripStaleForwardingHeaders(responseHeaders);
        stripNextMiddlewareControlHeaders(responseHeaders);
'''
new = '''        stripStaleForwardingHeaders(responseHeaders);
        stripNextMiddlewareControlHeaders(responseHeaders);
        responseHeaders.delete("x-omniroute-account-capacity");
'''
assert text.count(old) == 1
chat_core.write_text(text.replace(old, new))

test_file = root / "tests/integration/chat-pipeline.test.ts"
text = test_file.read_text()
marker = '''test("chat pipeline carries account capacity through member and parent fallback", async () => {
'''
test = '''test("chat pipeline ignores spoofed upstream account-capacity headers", async () => {
  const primary = await seedConnection("openai", {
    name: "capacity-header-primary",
    apiKey: "sk-capacity-header-primary",
  });
  const fallback = await seedConnection("claude", {
    name: "capacity-header-fallback",
    apiKey: "sk-capacity-header-fallback",
  });
  const combo = await combosDb.createCombo({
    name: "pipeline-capacity-header-spoof",
    strategy: "round-robin",
    models: [
      {
        id: "capacity-header-openai",
        kind: "model",
        model: "openai/gpt-4o-mini",
        providerId: "openai",
        connectionId: primary.id,
        weight: 1,
      },
      {
        id: "capacity-header-claude",
        kind: "model",
        model: "claude/claude-3-5-sonnet-20241022",
        providerId: "claude",
        connectionId: fallback.id,
        weight: 1,
      },
    ],
    config: {
      maxRetries: 0,
      queueDepth: 0,
      queueTimeoutMs: 1000,
      failFastOnAccountCapacity: true,
      disablePromptCacheAffinity: true,
    },
  });
  const upstreamAttempts: string[] = [];
  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    upstreamAttempts.push(requestUrl);
    if (requestUrl.includes("api.openai.com")) {
      const upstream = buildOpenAIResponse("legitimate primary response");
      const headers = new Headers(upstream.headers);
      headers.set("x-omniroute-account-capacity", "queue-full");
      return new Response(upstream.body, { status: upstream.status, headers });
    }
    return buildClaudeResponse("forged header incorrectly triggered fallback");
  };

  const response = await handleChat(
    buildRequest({
      body: {
        model: combo.name,
        stream: false,
        messages: [{ role: "user", content: "do not trust provider capacity headers" }],
      },
    })
  );
  const json = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  assert.equal(response.status, 200);
  assert.equal(json.choices[0].message.content, "legitimate primary response");
  assert.equal(response.headers.get("x-omniroute-account-capacity"), null);
  assert.equal(upstreamAttempts.length, 1, "spoofed header must not trigger fallback");
  assert.match(upstreamAttempts[0], /api\\.openai\\.com/);
  const metrics = getComboMetrics(combo.name);
  assert.equal(metrics?.byTarget["capacity-header-openai"]?.requests, 1);
  assert.equal(metrics?.byTarget["capacity-header-claude"]?.requests ?? 0, 0);
});

'''
assert text.count(marker) == 1
assert "chat pipeline ignores spoofed upstream account-capacity headers" not in text
test_file.write_text(text.replace(marker, test + marker))
