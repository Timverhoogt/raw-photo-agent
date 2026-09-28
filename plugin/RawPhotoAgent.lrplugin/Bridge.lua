local LrFileUtils = import 'LrFileUtils'
local LrPathUtils = import 'LrPathUtils'
local LrTasks = import 'LrTasks'
local U = dofile(_PLUGIN.path .. '/Util.lua')

local B = { running = false, workerActive = false, currentRequest = nil, lastError = nil }
local config, operations

local function loadConfig()
    local paths = {
        LrPathUtils.child(_PLUGIN.path, 'config.json'),
        LrPathUtils.child(LrPathUtils.parent(_PLUGIN.path), 'config.json'),
    }
    local loaded = {}
    for _, path in ipairs(paths) do
        if LrFileUtils.exists(path) == 'file' then loaded = U.readJson(path); break end
    end
    if type(loaded) ~= 'table' then U.fail('INVALID_CONFIG', 'config.json must contain an object.') end
    local bridgeDir = U.absoluteDirectory(loaded.bridgeDir or LrPathUtils.child(_PLUGIN.path, 'runtime'), 'bridgeDir')
    local exportRoot = U.absoluteDirectory(loaded.exportRoot or LrPathUtils.child(bridgeDir, 'renders'), 'exportRoot')
    local result = {
        bridgeDir = bridgeDir, exportRoot = exportRoot,
        requests = LrPathUtils.child(bridgeDir, 'requests'),
        responses = LrPathUtils.child(bridgeDir, 'responses'),
        receipts = LrPathUtils.child(bridgeDir, 'receipts'),
        checkpoints = LrPathUtils.child(bridgeDir, 'checkpoints'),
        scratch = LrPathUtils.child(bridgeDir, 'render-scratch'),
    }
    for _, path in pairs(result) do U.directory(path) end
    return result
end

local function heartbeat(status)
    if not config then return end
    U.writeJson(LrPathUtils.child(config.bridgeDir, 'heartbeat.json'), {
        protocolVersion = 1, pluginVersion = U.version, timestamp = U.now(),
        status = status or (B.currentRequest and 'busy' or 'idle'),
        requestId = B.currentRequest, error = B.lastError,
    }, true)
end

local function uuid(value)
    if type(value) ~= 'string' or #value ~= 36 then return false end
    local a, b, c, d, e = value:match('^(%x+)%-(%x+)%-(%x+)%-(%x+)%-(%x+)$')
    return a and #a == 8 and #b == 4 and #c == 4 and #d == 4 and #e == 12
end

local function responsePath(id) return LrPathUtils.child(config.responses, id .. '.json') end

local function handle(path, id)
    -- An existing immutable response is the response to every retry of this ID.
    if LrFileUtils.exists(responsePath(id)) then return end
    B.currentRequest = id
    local activeRequest
    local ok, result = LrTasks.pcall(function()
        local request = U.readJson(path)
        activeRequest = request
        if type(request) ~= 'table' or request.protocolVersion ~= 1 or request.id ~= id
            or not uuid(request.id) or type(request.operation) ~= 'string'
            or type(request.params) ~= 'table' or not U.finite(request.issuedAt)
            or not U.finite(request.deadlineAt) or request.deadlineAt <= request.issuedAt then
            U.fail('INVALID_REQUEST', 'Invalid protocol, ID, operation, params, or epoch-millisecond timestamps.')
        end
        for key in pairs(request) do
            if key ~= 'protocolVersion' and key ~= 'id' and key ~= 'operation'
                and key ~= 'params' and key ~= 'issuedAt' and key ~= 'deadlineAt' then
                U.fail('INVALID_REQUEST', 'Unknown request field: ' .. tostring(key))
            end
        end
        local operation = operations[request.operation]
        if not operation then U.fail('UNKNOWN_OPERATION', 'Unsupported operation: ' .. request.operation) end
        local receipt = LrPathUtils.child(config.receipts, id .. '.json')
        if LrFileUtils.exists(receipt) then
            U.fail('OUTCOME_UNKNOWN', 'This request previously started without a saved response. It will not run again; inspect the photo state before recovery.')
        end
        U.checkDeadline(request)
        -- A persisted receipt precedes every possible side effect. This is
        -- at-most-once execution, not a cross-database exactly-once transaction.
        U.writeJson(receipt, { id = id, operation = request.operation, startedAt = U.now(), request = request })
        local value = operation(request.params, request)
        if value == nil then U.fail('INTERNAL_ERROR', 'Operation returned no result.') end
        U.encode(value) -- Fail inside the protected call if SDK state is not JSON-safe.
        return value
    end)
    local response = { protocolVersion = 1, id = id, ok = ok }
    if ok then
        response.result = result
    else
        response.error = U.errorObject(result)
        response.error.outcomeUncertain = (type(activeRequest) == 'table' and activeRequest._mutationStarted == true)
            or response.error.code == 'OUTCOME_UNKNOWN'
    end
    U.writeJson(responsePath(id), response)
    B.currentRequest = nil
end

local function worker()
    while B.running do
        local requests = {}
        for path in LrFileUtils.files(config.requests) do
            local id = LrPathUtils.leafName(path):match('^(.-)%.json$')
            if uuid(id) and not LrFileUtils.exists(responsePath(id)) then
                requests[#requests + 1] = { id = id, path = path }
            end
        end
        table.sort(requests, function(a, b) return a.id < b.id end)
        for _, request in ipairs(requests) do
            if not B.running then break end
            handle(request.path, request.id)
            LrTasks.yield()
        end
        LrTasks.sleep(0.2)
    end
end

function B.start()
    if B.workerActive then return end
    B.generation = (B.generation or 0) + 1
    local generation = B.generation
    B.workerActive, B.running, B.lastError = true, true, nil
    LrTasks.startAsyncTask(function()
        local ok, result = LrTasks.pcall(function()
            config = loadConfig()
            operations = dofile(_PLUGIN.path .. '/Operations.lua')(U, config)
            heartbeat('idle')
            -- Only this second task writes heartbeats during long SDK renders.
            LrTasks.startAsyncTask(function()
                while B.running and B.generation == generation do
                    LrTasks.sleep(1)
                    if B.running and B.generation == generation then
                        local beatOK, beatError = LrTasks.pcall(heartbeat)
                        if not beatOK then
                            B.lastError = U.errorObject(beatError).message
                            B.running = false
                        end
                    end
                end
            end, 'Raw Photo Agent heartbeat')
            worker()
        end)
        if not ok then B.lastError = U.errorObject(result).message end
        B.running = false
        LrTasks.pcall(function() heartbeat(B.lastError and 'error' or 'stopped') end)
        B.currentRequest = nil
        B.workerActive = false
    end, 'Raw Photo Agent bridge')
end

function B.stop()
    B.running = false
    -- Shutdown only stops polling; an already-started SDK operation cannot be
    -- cancelled safely. The receipt lets the client reconcile a lost outcome.
end

function B.statusText()
    if B.lastError then return 'Bridge stopped: ' .. B.lastError end
    local label = B.running and (B.currentRequest and 'Busy: ' .. B.currentRequest or 'Running') or 'Stopped'
    return label .. '\n\n' .. (config and config.bridgeDir or 'Initializing configuration…')
        .. '\n\nOnly virtual copies can be edited. AI mask operations are not enabled yet.'
end

return B
