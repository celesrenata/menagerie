from pathlib import Path

path = Path("/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/open-sse/handlers/chatCore.ts")
text = path.read_text()
old = '''              const res = normalizeExecutorResult(rawExecutorResult);
              trace("post_executor", { status: res?.response?.status });
'''
new = '''              const res = normalizeExecutorResult(rawExecutorResult);
              if (res.response.headers.has("x-omniroute-account-capacity")) {
                const responseHeaders = new Headers(normalizeHeaders(res.response.headers));
                responseHeaders.delete("x-omniroute-account-capacity");
                res.response = new Response(res.response.body, {
                  status: res.response.status,
                  statusText: res.response.statusText,
                  headers: responseHeaders,
                });
              }
              trace("post_executor", { status: res?.response?.status });
'''
assert text.count(old) == 1
path.write_text(text.replace(old, new))
