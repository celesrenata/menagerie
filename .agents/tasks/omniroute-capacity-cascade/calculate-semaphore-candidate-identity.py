import hashlib
import os
from pathlib import Path
import subprocess
import tempfile

root = Path("/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z")
allowlist = [
    "open-sse/handlers/chatCore.ts",
    "open-sse/services/combo.ts",
    "open-sse/services/combo/runtimeUnits.ts",
    "open-sse/services/combo/types.ts",
    "open-sse/services/combo/validateQuality.ts",
    "src/app/api/combos/[id]/route.ts",
    "src/shared/validation/schemas/combo.ts",
    "src/sse/handlers/chat.ts",
    "tests/integration/chat-pipeline.test.ts",
    "tests/unit/accountSemaphore.test.ts",
    "tests/unit/antigravity-byop-account-rotation.test.ts",
    "tests/unit/chatcore-translation-paths.test.ts",
    "tests/unit/combo-capacity-cascade-persistence.test.ts",
    "tests/unit/combo-config.test.ts",
    "tests/unit/combo-runtime-unit-concurrency.test.ts",
    "tests/unit/combo-semaphore-lifecycle.test.ts",
    "tests/unit/combo-shared-account-race.test.ts",
    "tests/unit/combo-strategy-fallbacks.test.ts",
]

def git(*args: str, env: dict[str, str] | None = None, text: bool = True):
    return subprocess.run(
        ["git", "-C", str(root), *args],
        check=True,
        capture_output=True,
        text=text,
        env=env,
    ).stdout

status_lines = [line for line in git("status", "--short").splitlines() if line]
status_paths = sorted(line[3:] for line in status_lines)
assert status_paths == sorted(allowlist), (status_paths, sorted(allowlist))
assert not any("CHANGELOG" in path or ".changeset" in path for path in status_paths)
revision = git("rev-parse", "HEAD").strip()
assert revision == "ad45d990c9f17e857f0bd03aacd1ff29b1825658"
with tempfile.TemporaryDirectory() as temporary_directory:
    index_path = Path(temporary_directory) / "index"
    env = os.environ.copy()
    env["GIT_INDEX_FILE"] = str(index_path)
    git("read-tree", "HEAD", env=env)
    git("add", "--", *allowlist, env=env)
    tree = git("write-tree", env=env).strip()
    binary_diff = git("diff", "--cached", "--binary", "--full-index", "HEAD", env=env, text=False)
    diff_sha256 = hashlib.sha256(binary_diff).hexdigest()
print(f"REVISION={revision}")
print(f"TREE={tree}")
print(f"DIFF_SHA256={diff_sha256}")
print(f"ALLOWLIST_COUNT={len(allowlist)}")
print("FILES=")
print("\n".join(allowlist))
