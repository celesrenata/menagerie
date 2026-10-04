# /dashboard/cache "Internal Server Error": findings (FEAT-002)

Result: not reproduced. No code changed, nothing committed.

## Auth mode

Cookie session only, no Authorization header. A 1h `auth_token` was minted inside the pod (HS256, `{authenticated:true, iat, jti, exp}`, signed with the pod's `JWT_SECRET`, using Node `crypto` because `jose` is bundled into the Next standalone chunks and can't be resolved with `require`). The secret was never printed. The cookie was accepted: `/api/cache/stats` returned 200 with it and 401 without it. Afterwards it was revoked with `POST /api/auth/logout` (200), which made the same cookie get 401. All temp files were deleted.

## Scenarios tried (headless Chromium, cookie set as secure/httpOnly/Lax)

| Scenario                                                                                            | Result                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (a) goto /dashboard/cache (load + 5s), click Semantic Cache, then Reasoning Replay                  | 200; all three tabs rendered; no pageerror; no console errors; no responses >= 400                                                                           |
| (b) page.reload()                                                                                   | 200; rendered cleanly                                                                                                                                        |
| (c) /dashboard/analytics, then sidebar `a[href="/dashboard/cache"]` client-side nav, then both tabs | rendered cleanly; no RSC/chunk failures                                                                                                                      |
| curl SSR of /dashboard/cache with the cookie plus `NEXT_LOCALE=<each of the 67 locales>`            | all 200. The only "Internal Server Error" text matched is the i18n string `error.title` / `500.title` embedded in the messages payload, not a rendered error |
| `/api/cache`, `/api/cache/stats`, `/api/cache/entries`, `/api/cache/reasoning` with the cookie      | all 200; `/api/cache` payload is well-formed (numeric fields, 43 trend points, 7 providers)                                                                  |

The only network noise was `net::ERR_ABORTED` on `/dashboard?_rsc=…`. Those are cancelled router prefetches, which is normal. Hand-crafted RSC requests get a 307 to a normalized `?_rsc` URL. That is Next 16 cache-busting validation, and the browser handled it without error.

## Pod and ingress logs

- `kubectl logs deploy/omniroute --since=10m | grep -iE 'error|cache|unhandled'` returned only `combo trace ... terminal={"status":200,"errorClass":null}` lines.
- The full 10h log (8951 lines) has no level 50/60 entries. The only `[ERROR]` lines are provider upstream 502/504/409 (RTX 5090 busy). Nothing touched `/dashboard/cache` or `/api/cache*`.
- Pod `omniroute-7df4f85777-mjz6j`: up 9h, 0 restarts. Its ReplicaSet was created 2026-10-03T13:48:52Z. Earlier ReplicaSets were rolled at 08:19, 08:48, 09:24 and 09:45 UTC, and their logs are gone.
- Traefik: no 5xx for the cache paths. Unrelated issue found: the HTTP (port 80) router `omniroute-omniroute-http-...` references a missing middleware `default-redirectscheme@kubernetescrd`, so `http://omniroute.celestium.life/*` returns `404 page not found` instead of redirecting to https. That is a 404, not a 500.

## Leading hypothesis

The error was transient and happened before or during one of today's rollouts (five ReplicaSets between 08:19 and 13:48 UTC). Two likely forms:

1. A request reached a pod that was starting up or shutting down.
2. A tab still open from an older build requested RSC payloads or chunks from the new build (deploy skew).

The current pod has never logged an error for this page, and cookie-session, reload, client-nav and all-locale paths render cleanly. So there is no code defect to fix.

## Recommended next step

If the user sees it again, capture the following from DevTools:

- the failing request URL and status (Network tab)
- the response body, or the `error.digest` "Error ID" shown on the page
- the time

Then run `kubectl -n omniroute logs deploy/omniroute --since=15m` right away, before the next rollout rotates the pod. A hard reload after each deploy rules out deploy skew. Separately, consider fixing the missing Traefik `default-redirectscheme` middleware so http redirects to https.
