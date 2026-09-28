local LrDialogs = import 'LrDialogs'
if RawPhotoAgentStarting then
    LrDialogs.message('Raw Photo Agent', 'Starting after the previous bridge worker finishes…', 'info')
    return
end
if not RawPhotoAgentBridge or not RawPhotoAgentBridge.running then
    dofile(_PLUGIN.path .. '/Init.lua')
    LrDialogs.message('Raw Photo Agent', 'Starting the bridge. Open Start / Status again to see its state.', 'info')
else
    LrDialogs.message('Raw Photo Agent', RawPhotoAgentBridge.statusText(), 'info')
end
