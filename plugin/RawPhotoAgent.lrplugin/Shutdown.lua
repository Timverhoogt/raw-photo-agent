RawPhotoAgentLifecycle = (RawPhotoAgentLifecycle or 0) + 1
RawPhotoAgentStarting = false
if RawPhotoAgentBridge then
    RawPhotoAgentBridge.stop()
end
