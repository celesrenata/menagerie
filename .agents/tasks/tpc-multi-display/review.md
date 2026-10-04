# Multi-display screen capture for total-pc-control

The change swaps the image-capture path in `total-pc-control` from libnut (which only ever sees the main display) to macOS `screencapture`, so the MCP server can grab any monitor. `captureScreen` gains a 1-based `display` parameter and shells out via `-D <n>`; `captureRegion` keeps global `-R` coordinates (which already span the virtual desktop); a new `list_displays` tool enumerates monitors by parsing `system_profiler`. The committed Nix patch that home-manager applies at activation was regenerated to carry both the pre-existing tmpdir fix and this new capture logic. nut-js stays for `getScreenSize()` and the mouse/keyboard/clipboard tools.

Watch for: the `display` parameter advertised on `capture_region` is silently ignored (confirmed) — it is accepted by the Zod schema and the function signature but intentionally dropped because `-R` is not combined with `-D`. This is documented in the code and plan, so it is a known contract wart, not a defect.

**Verdict**: APPROVED

## High-level view

Capture moves to `execFile("/usr/sbin/screencapture", [...args])` with an absolute binary path and an args array, so there is no shell and no injection surface even though region coordinates are interpolated into the `-R` rect string (they go in as a single argv element, not a shell token). `captureScreen` defaults `display` to 1 and maps the format enum to screencapture's `jpg`/`png` tokens while keeping the data-URI MIME as `image/jpeg`, which preserves the exact return string downstream consumers parse.

The API surface grows by one optional `display` field on both capture tools and one new `list_displays` tool registered right after `get_screen_size`. The `capture_region` `display` field is the one soft spot: it is validated and passed through but then voided inside `captureRegion`. Everything else — rotating `screenshot_NN` names, `MAX_SCREENSHOTS`, the `os.tmpdir()` write path, the return-string format — is unchanged.

Failure handling is fail-loud-but-contained: a non-zero `screencapture` exit throws an `Error` whose message carries stderr, and `index.ts` already wraps every tool body in try/catch returning `{ isError: true }`, so a permission denial surfaces as an error payload rather than crashing the server. `listDisplays()` is the opposite posture — fail-soft — returning `{ count: 0, displays: [] }` on any parse or exec failure so the enumeration tool never throws.

The regenerated patch is diff-only against `src/index.ts` and `src/tools/screen.ts` (package-lock excluded, types.ts untouched because `DisplayInfo` lives in screen.ts). The verification evidence records a clean `git apply --check` against a stashed pristine tree and a successful flake build, and the activation module's reverse-check idempotency guard remains valid.

<details>
<summary>Issues (1)</summary>

1. **`capture_region` display param is a no-op** — the tool schema and function signature accept `display`, but `captureRegion` voids it and relies on global `-R` coordinates. Documented and deliberate; consider dropping the schema field in a future pass to avoid misleading callers, but not blocking.

</details>

<details>
<summary>Details</summary>

## Capture via screencapture, no shell

Both capture functions call `execFile(SCREENCAPTURE, [...])` where `SCREENCAPTURE` is the absolute literal `/usr/sbin/screencapture`. The arguments are passed as an array, so there is no shell interpretation. The only interpolated value is the region rect in `captureRegion` (`${region.left},${region.top},${region.width},${region.height}`), and it enters as one argv element — not a shell token — so even a hostile value cannot break out into a second command. The region fields are additionally constrained upstream by the Zod schema (`int().min(0)` / `int().min(1)`), so they are integers by the time they reach the string. Injection surface is closed (confirmed).

`captureScreen` defaults `display` to 1 and runs `["-x", "-D", String(display), "-t", token, filepath]`. The `-x` suppresses the capture sound, `-D <n>` selects the 1-based display, and the token is `png`/`jpg`. This is the native path to reach display 2, which libnut cannot address (confirmed against the plan's flag research and the verification run).

## Return-string contract preserved

`captureFormatToFileType` maps `CaptureFormat.JPEG` to the screencapture token `jpg` and extension `.jpg`, but the returned string still uses the enum value for the MIME: `data:image/${format}` yields `image/jpeg`. So the file is written with the correct extension screencapture expects while the data URI keeps the MIME any existing consumer was already parsing. The full return string `File saved as <name>. Image data: data:image/<format>;base64,<...>` is byte-for-byte the same shape as before (confirmed). Rotating `screenshot_NN` names, `MAX_SCREENSHOTS = 20`, and the `os.tmpdir()` write location are all retained (confirmed).

## The capture_region display no-op

`captureRegion(region, format, display?)` accepts a `display` argument and immediately `void display`s it. The doc comment explains why: `-R` already uses global coordinates spanning every monitor and screencapture does not combine `-R` with `-D`. The signature exists for API symmetry. The wart is that `index.ts` advertises `display` on the `capture_region` tool schema with the same "Display index to capture" description as `capture_screen`, so a caller who sets it on a region capture gets no error and no effect (confirmed). This is deliberate and documented, so it does not block, but a future cleanup could either drop the field from the region schema or reword its description to say it is ignored for region captures.

## Failure modes: loud for capture, soft for enumeration

`extractCaptureError` pulls `stderr` off the execFile rejection when present and otherwise falls back to the error message, so a missing Screen Recording (TCC) permission surfaces as an actionable message. Both capture functions re-throw as `Error`, and because `index.ts` wraps each tool body in try/catch returning `{ isError: true, content: [...] }`, the server stays up and the client sees the error text (confirmed). The temp file is unlinked on the error path if it was created.

`listDisplays()` takes the opposite stance: any failure from `system_profiler` or the parser is caught and collapsed to `{ count: 0, displays: [] }`, so enumeration degrades to "none detected" rather than throwing. The `parseDisplays` heuristic keys off `Resolution:` lines preceded by a block header and marks `Main Display: Yes`; it is best-effort and the fail-soft wrapper is the right call for a non-critical convenience tool.

## Scope and the regenerated patch

The patch touches only `src/index.ts` (two schema additions, two pass-throughs, one new tool block) and `src/tools/screen.ts` (the capture rewrite, `extractCaptureError`, `DisplayInfo`, `listDisplays`, `parseDisplays`). Mouse, keyboard, and clipboard tools are untouched, `@nut-tree-fork/nut-js` is kept (still imported for `getScreenSize`), and the now-dead `NutRegion` / `FileType` / `fileURLToPath` imports were removed to keep `tsc` clean (confirmed in the diff). `types.ts` is correctly excluded from the patch since `DisplayInfo` was placed in screen.ts and nothing in types.ts changed. package-lock.json is excluded as intended.

The regeneration method (`git diff HEAD <files>`) is sound given HEAD still holds the pristine EROFS upstream and the tmpdir fix was uncommitted — it captures both changes together, reproducing how the original patch was built.

## Verification evidence

The recorded evidence (build exit 0, zero TS errors, grep confirmation of `list_displays`/`listDisplays`/`screencapture` in the built artifacts) supports the compile claim. The functional proof is the strongest part: display 1 captured at 3456x2234 and display 2 at 6720x3780, with `sips` reading the actual pixel dimensions of the tmp files the tool wrote — distinct dimensions prove display 2 is genuinely captured, not a copy of display 1. `listDisplays()` returned both monitors with correct `main` flagging. The patch-apply check (stash to pristine, `git apply --check` exit 0, reverse-check, restore) and the flake build (exit 0) are recorded.

Not independently re-run here (per the task's instruction to trust recorded evidence): the build, the node capture, and the nix build. No articulable doubt in the evidence warranted a spot-check beyond reading the final source and patch, which match each other exactly.

</details>

<details>
<summary>Files changed</summary>

- `src/tools/screen.ts` — capture rewritten to shell out to `screencapture` via `execFile`; added `display` param to `captureScreen`, advisory `display` to `captureRegion`, plus `extractCaptureError`, `DisplayInfo`, `listDisplays`, `parseDisplays`; dropped dead nut-js/url imports.
- `src/index.ts` — optional `display` field on `capture_screen` and `capture_region` schemas (passed through), new `list_displays` tool after `get_screen_size`.
- `packages/total-pc-control/screenshot-tmpdir.patch` (flake repo) — regenerated to carry the tmpdir fix plus the multi-display capture change.

Full diff: `packages/total-pc-control/screenshot-tmpdir.patch` in `m5max-darwin-flake`.

</details>
