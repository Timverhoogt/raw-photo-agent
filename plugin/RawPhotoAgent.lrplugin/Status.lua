local LrDialogs = import 'LrDialogs'
local startup = RawPhotoAgentStartup
if RawPhotoAgentStarting or (startup and (startup.phase == 'error' or startup.phase == 'restart-required')) then
    local text = 'Startup is pending; no worker completion has been assumed.'
    if startup then
        local previous = startup.previousWorker or {}
        text = 'Startup phase: ' .. tostring(startup.phase) .. '\nGeneration: ' .. tostring(startup.generation)
            .. '\nPrevious worker: active=' .. tostring(previous.workerActive) .. ', running=' .. tostring(previous.running)
            .. ', request=' .. tostring(previous.currentRequest)
        if startup.error then text = text .. '\n\n' .. tostring(startup.error.code) .. ': ' .. tostring(startup.error.message) end
        if startup.diagnosticPath then text = text .. '\n\nDiagnostics: ' .. startup.diagnosticPath end
    end
    LrDialogs.message('Raw Photo Agent', text, startup and startup.error and 'warning' or 'info')
    return
end
if not RawPhotoAgentBridge or not RawPhotoAgentBridge.running then
    dofile(_PLUGIN.path .. '/Init.lua')
    LrDialogs.message('Raw Photo Agent', 'Starting the bridge. Open Start / Status again to see its state.', 'info')
else
    LrDialogs.message('Raw Photo Agent', RawPhotoAgentBridge.statusText(), 'info')
end
