local LrTasks = import 'LrTasks'
local LrFileUtils = import 'LrFileUtils'
local LrPathUtils = import 'LrPathUtils'
local previous = RawPhotoAgentBridge
RawPhotoAgentLifecycle = (RawPhotoAgentLifecycle or 0) + 1
local generation = RawPhotoAgentLifecycle
local startup = { version = 1, generation = generation, phase = 'initializing-diagnostics' }
RawPhotoAgentStartup = startup
RawPhotoAgentStarting = true
local U, diagnosticPath
local function workerState(worker)
    return { present = worker ~= nil, running = worker and worker.running,
        workerActive = worker and worker.workerActive, currentRequest = worker and worker.currentRequest }
end
local function publish(phase)
    -- A cancelled older initializer cannot overwrite a newer generation's log.
    if RawPhotoAgentStartup ~= startup then return end
    startup.phase, startup.updatedAt = phase, U.now()
    startup.lifecycle = RawPhotoAgentLifecycle
    startup.previousWorker, startup.currentWorker = workerState(previous), workerState(RawPhotoAgentBridge)
    U.writeJson(diagnosticPath, startup, true)
end
local function failed(err)
    if RawPhotoAgentStartup ~= startup then return end
    startup.error = U and U.errorObject(err) or { code = 'STARTUP_ERROR', message = tostring(err) }
    startup.phase, RawPhotoAgentStarting = 'error', false
    -- Keep the in-memory error available to Status even if logging failed.
    if U and diagnosticPath then pcall(function() publish('error') end) end
end
local ok, err = pcall(function()
    U = dofile(_PLUGIN.path .. '/Util.lua')
    startup.startedAt = U.now()
    local configured = {}
    for _, path in ipairs({ LrPathUtils.child(_PLUGIN.path, 'config.json'),
        LrPathUtils.child(LrPathUtils.parent(_PLUGIN.path), 'config.json') }) do
        if LrFileUtils.exists(path) == 'file' then configured = U.readJson(path); break end
    end
    if type(configured) ~= 'table' then U.fail('INVALID_CONFIG', 'config.json must contain an object.') end
    local directory = U.absoluteDirectory(configured.bridgeDir or LrPathUtils.child(_PLUGIN.path, 'runtime'), 'bridgeDir')
    U.directory(directory)
    diagnosticPath = LrPathUtils.child(directory, 'startup.json')
    startup.diagnosticPath = diagnosticPath
    publish('stopping-previous-worker')
    if previous then previous.stop() end
    publish('initializer-queued')
    LrTasks.startAsyncTask(function()
        local taskOK, taskError = LrTasks.pcall(function()
            if RawPhotoAgentLifecycle ~= generation then publish('cancelled'); return end
            startup.waitStartedAt = U.now()
            startup.waitDeadlineAt = startup.waitStartedAt + 15000
            publish('waiting-for-previous-worker')
            local lastRecorded = startup.updatedAt
            -- Only the old worker's own completion may release its ownership.
            -- A missing flag, stale heartbeat or empty queue is not proof.
            while previous and (previous.workerActive ~= false or previous.running ~= false or previous.currentRequest ~= nil) do
                if RawPhotoAgentLifecycle ~= generation then publish('cancelled'); return end
                if U.now() >= startup.waitDeadlineAt then
                    startup.restartRequired = true
                    startup.error = { code = 'PREVIOUS_WORKER_UNCONFIRMED',
                        message = 'Previous worker ownership was not released. Restart Lightroom normally; no replacement worker was started.' }
                    publish('restart-required')
                    if RawPhotoAgentStartup == startup then RawPhotoAgentStarting = false end
                    return
                end
                if U.now() - lastRecorded >= 1000 then publish('waiting-for-previous-worker'); lastRecorded = startup.updatedAt end
                LrTasks.sleep(0.1)
            end
            if RawPhotoAgentLifecycle ~= generation then publish('cancelled'); return end
            publish('loading-bridge')
            if RawPhotoAgentLifecycle ~= generation then publish('cancelled'); return end
            local bridge = dofile(_PLUGIN.path .. '/Bridge.lua')
            if RawPhotoAgentLifecycle ~= generation then publish('cancelled'); return end
            RawPhotoAgentBridge = bridge
            publish('starting-bridge')
            if RawPhotoAgentLifecycle ~= generation then publish('cancelled'); return end
            RawPhotoAgentBridge.start()
            publish('worker-launched')
            if RawPhotoAgentStartup == startup then RawPhotoAgentStarting = false end
        end)
        if not taskOK then failed(taskError) end
    end, 'Raw Photo Agent initialize')
end)
if not ok then failed(err) end
