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

def git(*args: str, env: dict[str, str] | None = None) -> bytes:
    return subprocess.check_output(["git", "-C", str(root), *args], env=env)

status = git("status", "--porcelain=v1", "-z").decode().split("\0")
paths = sorted(entry[3:] for entry in status if entry)
assert paths == sorted(allowlist), (paths, sorted(allowlist))
assert not any("CHANGELOG" in path or path.startswith(".changeset/") for path in paths)
revision = git("rev-parse", "HEAD").decode().strip()
assert revision == "ad45d990c9f17e857f0bd03aacd1ff29b1825658"
fd, index_path = tempfile.mkstemp(prefix="omniroute-candidate-index-")
os.close(fd)
os.unlink(index_path)
env = os.environ.copy()
env["GIT_INDEX_FILE"] = index_path
try:
    git("read-tree", "HEAD", env=env)
    git("add", "--", *allowlist, env=env)
    tree = git("write-tree", env=env).decode().strip()
    diff = git("diff", "--cached", "--binary", "--full-index", "HEAD", env=env)
finally:
    Path(index_path).unlink(missing_ok=True)
print(f"REVISION={revision}")
print(f"TREE={tree}")
print(f"DIFF_SHA256={hashlib.sha256(diff).hexdigest()}")
print(f"ALLOWLIST_COUNT={len(allowlist)}")
for path in allowlist:
    print(path)
