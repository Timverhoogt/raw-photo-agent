-- IPC control-flow tests with an in-memory filesystem and cooperative scheduler.
_PLUGIN = _PLUGIN or { path = 'plugin/RawPhotoAgent.lrplugin' }
local actualDofile = dofile
local now, tasks, fs, dispatched, active, peak = 100000, {}, {}, 0, 0, 0
local observedConfig
local function clone(value)
    if type(value) ~= 'table' then return value end
    local result = {}; for key, item in pairs(value) do result[key] = clone(item) end; return result
end
local function fail(code, message) error({ code = code, message = message }, 0) end
local U = {
    version = 'test', now = function() return now end, fail = fail,
    finite = function(value) return type(value) == 'number' end,
    absoluteDirectory = function(path) return path end, directory = function() end,
    readJson = function(path) assert(fs[path], path); return clone(fs[path]) end,
    writeJson = function(path, value, replace)
        assert(replace or not fs[path], 'immutable response overwritten'); fs[path] = clone(value)
    end,
    encode = function() return '{}' end,
    checkDeadline = function(request) if now >= request.deadlineAt then fail('EXPIRED', 'expired') end end,
    errorObject = function(err) return type(err) == 'table' and err or { code = 'SDK_ERROR', message = tostring(err) } end,
}
local T = {}
function T.startAsyncTask(fn) tasks[#tasks + 1] = { thread = coroutine.create(fn), wake = now } end
function T.sleep(seconds) coroutine.yield(seconds * 1000) end
function T.yield() coroutine.yield(1) end
-- LrTasks.pcall permits yields; emulate that behavior on stock Lua 5.1.
function T.pcall(fn)
    local thread = coroutine.create(fn)
    while true do
        local result = { coroutine.resume(thread) }
        if not result[1] then return false, result[2] end
        if coroutine.status(thread) == 'dead' then return true, result[2] end
        coroutine.yield(result[2])
    end
end
local mocks = {
    LrTasks = T,
    LrPathUtils = { child = function(a, b) return a .. '/' .. b end,
        parent = function(path) return path:match('^(.*)/[^/]+$') end,
        leafName = function(path) return path:match('[^/]+$') end },
    LrFileUtils = {
        exists = function(path) return fs[path] and 'file' or false end,
        files = function(directory)
            local paths = {}
            for path in pairs(fs) do
                if path:sub(1, #directory + 1) == directory .. '/' then paths[#paths + 1] = path end
            end
            table.sort(paths)
            local i = 0; return function() i = i + 1; return paths[i] end
        end,
    },
}
function import(name) return assert(mocks[name], name) end
local operations = {
    selected = function() dispatched = dispatched + 1; return { count = 0, photos = {} } end,
    apply = function(params, request)
        if params.reject then fail('STALE_STATE', 'known precondition') end
        request._mutationStarted = true
        dispatched, active = dispatched + 1, active + 1; peak = math.max(peak, active)
        T.sleep(0.3)
        active = active - 1
        if params.crash then error('native operation failed after starting') end
        return { state = { stateToken = 'new' } }
    end,
}
operations.import_photo = operations.apply
operations.reveal_photo = operations.apply
function dofile(path)
    if path == _PLUGIN.path .. '/Util.lua' then return U end
    if path == _PLUGIN.path .. '/Operations.lua' then
        return function(_, config) observedConfig = clone(config); return operations end
    end
    return actualDofile(path)
end
fs[_PLUGIN.path .. '/config.json'] = { bridgeDir = '/bridge', exportRoot = '/renders', importRoot = '/uploads' }
local B = actualDofile(_PLUGIN.path .. '/Bridge.lua')
local function tick(milliseconds)
    local untilTime = now + milliseconds
    while now < untilTime do
        now = now + 10
        for _, task in ipairs(tasks) do
            if coroutine.status(task.thread) ~= 'dead' and task.wake <= now then
                local ok, sleep = coroutine.resume(task.thread)
                assert(ok, sleep)
                task.wake = now + (sleep or 0)
            end
        end
    end
end
local function id(n) return '00000000-0000-4000-8000-' .. string.format('%012d', n) end
local function submit(n, operation, params, deadline)
    local request = { protocolVersion = 1, id = id(n), operation = operation, params = params or {},
        issuedAt = now - 100, deadlineAt = deadline or now + 10000 }
    fs['/bridge/requests/' .. id(n) .. '.json'] = request
    return request
end
local function response(n) return assert(fs['/bridge/responses/' .. id(n) .. '.json'], 'missing response') end
local checks = 0
local function check(condition, label) assert(condition, label); checks = checks + 1 end
B.start(); tick(100)
check(observedConfig.importRoot == '/uploads', 'configured import root reaches operation handlers')
submit(1, 'selected'); tick(500)
check(response(1).ok and dispatched == 1, 'read request completes')
submit(1, 'apply'); tick(500)
check(response(1).ok and dispatched == 1, 'duplicate ID cannot reapply with a different payload')
submit(2, 'apply', {}, now - 1); tick(500)
check(response(2).error.code == 'EXPIRED' and not response(2).error.outcomeUncertain, 'expired request is known not applied')
check(dispatched == 1, 'expired request never dispatched')
submit(3, 'apply', { crash = true }); tick(1000)
check(not response(3).ok and response(3).error.outcomeUncertain, 'native failure after mutation boundary is uncertain')
submit(4, 'apply', { reject = true }); tick(500)
check(response(4).error.code == 'STALE_STATE' and not response(4).error.outcomeUncertain, 'precondition failure is certain')
fs['/bridge/receipts/' .. id(5) .. '.json'] = { startedAt = now }
submit(5, 'apply'); tick(500)
check(response(5).error.code == 'OUTCOME_UNKNOWN' and response(5).error.outcomeUncertain, 'receipt without response never replays')
local invalid = submit(6, 'apply'); invalid.id = id(99); tick(500)
check(response(6).error.code == 'INVALID_REQUEST', 'filename and payload identity must match')
submit(7, 'unknown'); tick(500)
check(response(7).error.code == 'UNKNOWN_OPERATION', 'unknown operation rejects')
submit(8, 'apply'); submit(9, 'apply'); tick(1500)
check(response(8).ok and response(9).ok and peak == 1, 'operations serialize while SDK yields')
check(fs['/bridge/heartbeat.json'].status == 'idle', 'heartbeat remains available')
submit(11, 'import_photo', { crash = true }); tick(1000)
check(response(11).error.outcomeUncertain, 'native import failure after execution starts is uncertain')
submit(12, 'import_photo', { reject = true }); tick(500)
check(not response(12).error.outcomeUncertain, 'import precondition failure is known not applied')
submit(13, 'reveal_photo', { crash = true }); tick(1000)
check(response(13).error.outcomeUncertain, 'failed module switch after execution starts is uncertain')
B.stop(); tick(1500)
check(fs['/bridge/heartbeat.json'].status == 'stopped', 'shutdown marks heartbeat stopped')
B.start(); tick(1500)
check(fs['/bridge/heartbeat.json'].status == 'idle', 'worker can restart without duplicate dispatch')
-- Regression: Lightroom reload calls Init while Shutdown's worker is still alive.
RawPhotoAgentBridge = B
fs[_PLUGIN.path .. '/config.json'].importRoot = nil
submit(10, 'apply'); tick(250)
actualDofile(_PLUGIN.path .. '/Shutdown.lua')
actualDofile(_PLUGIN.path .. '/Init.lua')
check(RawPhotoAgentStarting and RawPhotoAgentBridge == B, 'reload waits for the previous worker')
tick(1500)
check(RawPhotoAgentBridge ~= B and RawPhotoAgentBridge.running and not B.workerActive,
    'reload replaces the module and restarts after old worker exits')
check(observedConfig.importRoot == '/bridge/uploads', 'missing importRoot defaults to an uploads child of bridgeDir')
check(response(10).ok and peak == 1, 'reload does not overlap or replay an in-flight mutation')
local reloaded = RawPhotoAgentBridge
actualDofile(_PLUGIN.path .. '/Init.lua')
actualDofile(_PLUGIN.path .. '/Shutdown.lua')
tick(1500)
check(RawPhotoAgentBridge == reloaded and not reloaded.running and not reloaded.workerActive,
    'disable cancels a pending reload rather than starting a new worker')
print('PASS: ' .. checks .. ' offline IPC checks (mock filesystem/scheduler).')
