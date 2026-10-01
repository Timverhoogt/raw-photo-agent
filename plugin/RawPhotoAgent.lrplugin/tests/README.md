# Offline Lua checks

Run from the repository root with a **Lua 5.1** interpreter. Check `lua -v` first; substitute your Lua 5.1 executable name if `lua` points to another version.

```sh
lua plugin/RawPhotoAgent.lrplugin/tests/operations_spec.lua
lua plugin/RawPhotoAgent.lrplugin/tests/bridge_spec.lua
```

Each harness mocks Lightroom's SDK. The current total is **199 checks: 177 operation checks and 22 IPC/lifecycle checks**. No Lightroom installation, catalog, or sample images are required.

Copy-selection cases observe delayed selection after a single native creation, without issuing another creation or selection command. They reject unrelated/multiple/empty selections, catalog changes, source or copy settings changes (including absent-to-empty fields), invalid returned identities, and late completion. Import and Develop cases preserve exact state guards across selection/module changes, reject completion at the deadline, and never rebase or rewrite a changed original. These timings are simulated; the live interruption motivates the bounded observation window but does not prove Lightroom's scheduling cause.

The operation tests exercise protected originals, exact single-photo targeting, copied state, adjustment bounds, stale tokens, native snapshot IDs, restore verification, deadlines, export-path constraints, and stale-render rejection. JPEG/TIFF checks verify default compatibility, format/extension matching, 16-bit uncompressed sRGB reference settings, export alias rejection, and unpublished stale renders. Import checks cover upload-root confinement, path/extension/alias rejection, missing or empty files, existing-original reuse, catalog selection, Develop switching, preserved original settings, and uncertain native failures. Existing-mask checks cover guarded Masking panel opening, group selection, controller-native units/ranges, rejected targets/parameters, unchanged mask geometry, and uncertain adjustment failures. Creation checks cover delayed saved/selected group and component identities, unavailable APIs, protected originals, target/state/deadline failures, missing/empty/unselected/ambiguous results, unchanged prior masks and globals, and uncertain native outcomes. Auto Tone checks cover protected targeting, modern tone requirements, unchanged unrelated state, stable changed readback, and unverified no-op outcomes. The IPC tests exercise immutable response reuse, expired and malformed requests, uncertain mutation outcomes, crash receipts, serialization across SDK yields, start/stop heartbeat behavior, reload during an in-flight operation, disabling a pending reload, import-root configuration, and import/module uncertainty.

If Lua is unavailable, install the optional [`lupa`](https://pypi.org/project/lupa/) package in an isolated Python 3 environment. Its `lupa.lua51` module runs the same harnesses with Lua 5.1. The following macOS/Linux shell commands keep that environment outside the repository:

```sh
lua_test_env="$(mktemp -d "${TMPDIR:-/tmp}/raw-photo-agent-lua-tests.XXXXXX")"
python3 -m venv "$lua_test_env"
"$lua_test_env/bin/python" -m pip install lupa
"$lua_test_env/bin/python" - <<'PY'
from lupa.lua51 import LuaRuntime
for name in ('operations_spec.lua', 'bridge_spec.lua'):
    runtime = LuaRuntime(unpack_returned_tuples=True)
    runtime.execute(f"dofile('plugin/RawPhotoAgent.lrplugin/tests/{name}')")
PY
```

Installing Lupa requires package access; it is a test-only dependency and is not loaded by the Lightroom plugin. These checks cannot validate Lightroom's rendering, mask pixels, native snapshot completeness, or real SDK scheduling. Do not infer live readiness from their passing results.
