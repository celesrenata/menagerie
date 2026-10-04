# Verification — total-pc-control multi-display screen capture

Task: Rework screen capture to support all displays (multi-monitor), add a
`display` parameter to the capture tools and a `list_displays` tool, regenerate
the committed Nix patch, and prove multi-display capture.

Machine displays (confirmed): display 1 = Color LCD 3456x2234 (main),
display 2 = VP3268a-4K 6720x3780.

## Changes made

- `src/tools/screen.ts`: `captureScreen(format?, display=1)` and
  `captureRegion(region, format?, display?)` now shell out to
  `/usr/sbin/screencapture` via a promisified `execFile` (args array, absolute
  path, no shell string). `captureScreen` uses `-x -D <display> -t <png|jpg>`;
  `captureRegion` uses `-x -R <x,y,w,h> -t <fmt>` (global coords; `display` is
  advisory/ignored because `-R` is not combined with `-D`). Added
  `listDisplays()` (and a `DisplayInfo` interface) that parses
  `system_profiler SPDisplaysDataType`, degrading to `{count:0,displays:[]}` on
  failure. Kept the rotating `screenshot_NN` names, `MAX_SCREENSHOTS`, the
  `os.tmpdir()` write path, and the exact return string
  `File saved as <name>. Image data: data:image/<format>;base64,<...>`.
  `getScreenSize()` still uses nut-js (main display). nut-js kept (mouse/keyboard
  depend on it); unused `FileType`/`NutRegion` imports removed.
- `src/index.ts`: added optional
  `display: z.number().int().min(1).optional()` to `capture_screen` and
  `capture_region`, passed through to the tools; added a `list_displays` tool
  after `get_screen_size` returning a readable summary.
- `src/types.ts`: unchanged (DisplayInfo lives in screen.ts).

## 1. Build

Command:

    cd /Users/celes/Documents/Cline/MCP/github.com_jasondsmith72_total-pc-control && npm run build

Output:

    > total-pc-control@1.0.0 build
    > tsc
    EXIT=0

0 TypeScript errors. Built artifacts confirmed:

    grep -c list_displays build/index.js        -> 1
    grep -c listDisplays build/tools/screen.js  -> 1
    grep -c screencapture build/tools/screen.js -> 9

## 2. Functional proof of multi-display capture

Invoked the built code directly from a NON-main CWD (`/tmp`):

    cd /tmp && node -e 'import("/Users/.../build/tools/screen.js").then(async t => {
      console.log("listDisplays:", JSON.stringify(await t.listDisplays()));
      for (const d of [1,2]) {
        const s = await t.captureScreen("png", d);
        console.log(`captureScreen(png,${d}) len=`, s.length, "prefix=", s.slice(0,60));
      }
    })'

Output:

    listDisplays: {"count":2,"displays":[{"index":1,"resolution":"3456 x 2234 Retina","main":true},{"index":2,"resolution":"6720 x 3780","main":false}]}
    captureScreen(png,1) len= 903187 prefix= File saved as screenshot_01.png. Image data: data:image/png;
    captureScreen(png,2) len= 11623799 prefix= File saved as screenshot_02.png. Image data: data:image/png;

Each returns a nonzero-length base64 string in the expected return-string format.
The standalone node process HAD Screen Recording (TCC) permission on this run,
so real images were captured (no permission failure to document).

Dimensions of the tmp files written by the MCP tool code (`sips`):

    sips -g pixelWidth -g pixelHeight "$TMPDIR/screenshot_01.png"
      pixelWidth: 3456
      pixelHeight: 2234
    sips -g pixelWidth -g pixelHeight "$TMPDIR/screenshot_02.png"
      pixelWidth: 6720
      pixelHeight: 3780

Display 1 captured at 3456x2234 and display 2 captured at 6720x3780 — DIFFERENT
dimensions, proving display 2 is actually captured (not a copy of display 1).

Direct bash construction of the display-2 command (per task note), also run:

    /usr/sbin/screencapture -x -D 2 -t png /tmp/verify_d2.png   # EXIT=0
    sips -g pixelWidth -g pixelHeight /tmp/verify_d2.png
      pixelWidth: 6720
      pixelHeight: 3780
    /usr/sbin/screencapture -x -D 1 -t png /tmp/verify_d1.png   # EXIT=0
    sips -g pixelWidth -g pixelHeight /tmp/verify_d1.png
      pixelWidth: 3456
      pixelHeight: 2234

Error handling: if `screencapture` exits non-zero (e.g. missing Screen Recording
permission in a host that lacks it), `extractCaptureError` surfaces stderr and
the function throws an `Error`; `index.ts` wraps every tool in try/catch and
returns `{ isError: true, ... }`, so the server never crashes.

## 3. Regenerated Nix patch

Generated from the project dir against pristine HEAD (HEAD held the original
EROFS upstream version; the uncommitted tmpdir change plus the new screencapture
change are captured together, matching how the existing patch was produced):

    git -C /Users/celes/Documents/Cline/MCP/github.com_jasondsmith72_total-pc-control \
      diff HEAD src/tools/screen.ts src/index.ts \
      > /Users/celes/sources/m5max-darwin-flake/packages/total-pc-control/screenshot-tmpdir.patch

Patch contents:

    diff --git a/src/index.ts b/src/index.ts
    diff --git a/src/tools/screen.ts b/src/tools/screen.ts
    (352 lines; package-lock.json excluded; types.ts not included because unchanged)

Applies to a pristine tree (stash to pristine, check, restore):

    git stash                                   # Saved WIP on main
    git apply --check <patch>                   # APPLY_CHECK_EXIT=0  (applies cleanly)
    git apply <patch>; git apply --reverse --check <patch>   # REVERSE_CHECK_OK=0
    git apply --reverse <patch>; git stash pop  # working tree restored
    git status --short -> M src/index.ts, M src/tools/screen.ts

The `git apply --check` succeeded (exit 0). The reverse-check succeeded after a
real apply, confirming the activation module's idempotency guard
(`git apply --reverse --check` → "already present, skip") remains valid; the
module in `modules/home/total-pc-control-patch.nix` needs no change. The
trailing-whitespace lines reported by `git apply` are warnings only (pre-existing
trailing whitespace in the surrounding source lines), not errors — the checks
passed.

## 4. Flake build

Command:

    cd /Users/celes/sources/m5max-darwin-flake && \
      nix build --no-link .#darwinConfigurations.stabulous.system

Output (tail):

    these 4 derivations will be built:
      ...activation-script.drv
      ...home-manager-generation.drv
      ...activation-celes.drv
      ...darwin-system-26.11.4cff07d.drv
    building ...
    EXIT=0

The flake evaluates and builds with the updated patch file.

## Commits

- total-pc-control (`/Users/celes/Documents/Cline/MCP/github.com_jasondsmith72_total-pc-control`):
  `4fa9a4a feat: multi-display screen capture via screencapture` (src/tools/screen.ts, src/index.ts).
- flake (`/Users/celes/sources/m5max-darwin-flake`):
  `a50bc11 feat(total-pc-control): regenerate patch for multi-display capture`
  (packages/total-pc-control/screenshot-tmpdir.patch only; unrelated working-tree
  changes left untouched).
