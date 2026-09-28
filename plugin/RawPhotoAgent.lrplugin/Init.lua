local LrTasks = import 'LrTasks'
local previous = RawPhotoAgentBridge
if previous then previous.stop() end

RawPhotoAgentLifecycle = (RawPhotoAgentLifecycle or 0) + 1
local generation = RawPhotoAgentLifecycle
RawPhotoAgentStarting = true
LrTasks.startAsyncTask(function()
    -- Reload can invoke Init before the previous asynchronous worker exits.
    -- Wait for its current operation and final heartbeat instead of losing the
    -- restart request or running two workers against the same file queue.
    while previous and previous.workerActive do LrTasks.sleep(0.1) end
    if RawPhotoAgentLifecycle ~= generation then return end
    RawPhotoAgentBridge = dofile(_PLUGIN.path .. '/Bridge.lua')
    RawPhotoAgentBridge.start()
    RawPhotoAgentStarting = false
end, 'Raw Photo Agent initialize')
