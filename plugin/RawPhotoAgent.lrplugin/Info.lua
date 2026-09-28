return {
    LrSdkVersion = 13.0,
    LrSdkMinimumVersion = 11.0,
    LrToolkitIdentifier = 'local.rawphotoagent.bridge',
    LrPluginName = 'Raw Photo Agent',
    LrPluginInfoUrl = 'https://developer.adobe.com/lightroom-classic',
    VERSION = { major = 0, minor = 1, revision = 0, build = 1 },
    LrInitPlugin = 'Init.lua',
    LrShutdownPlugin = 'Shutdown.lua',
    LrLibraryMenuItems = {
        { title = 'Raw Photo Agent: Start / Status', file = 'Status.lua' },
    },
    LrExportMenuItems = {
        { title = 'Raw Photo Agent: Start / Status', file = 'Status.lua' },
    },
}
