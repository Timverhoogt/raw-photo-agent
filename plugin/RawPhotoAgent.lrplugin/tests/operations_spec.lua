-- Offline contract tests. Run with Lua 5.1 from the repository root:
-- lua plugin/RawPhotoAgent.lrplugin/tests/operations_spec.lua
-- These mocks do not establish Adobe SDK runtime behavior.
_PLUGIN = _PLUGIN or { path = 'plugin/RawPhotoAgent.lrplugin' }

local now, selected, files, records, moduleName = 100000, {}, {}, {}, 'develop'
local mutations, exports, lastRestored, changeDuringRender = 0, 0, nil, false
local selectedTool, selectedMask, maskSelections = 'masking', nil, 0
local failMaskSelection, corruptGlobalOnMaskSet, ignoreMaskSet = false, false, false
local function clone(value)
    if type(value) ~= 'table' then return value end
    local copy = {}
    for key, item in pairs(value) do copy[key] = clone(item) end
    return copy
end

local function photo(id, virtual)
    local p = { localIdentifier = id, virtual = virtual, settings = { Exposure2012 = 0,
        Contrast2012 = 0, Temperature = 5500, Tint = 0, WhiteBalance = 'As Shot' }, snapshots = {} }
    function p:getRawMetadata(key)
        return ({ isVirtualCopy = self.virtual, fileFormat = 'RAW', path = '/photos/example.CR3', isVideo = false })[key]
    end
    function p:getFormattedMetadata(key) return key == 'fileName' and 'example.CR3' or 'Working copy' end
    function p:getDevelopSettings() return clone(self.settings) end
    function p:checkPhotoAvailability() return true end
    function p:createDevelopSnapshot(name)
        mutations = mutations + 1
        self.snapshots[#self.snapshots + 1] = { snapshotID = 'native-' .. (#self.snapshots + 1),
            id_global = 'global-' .. (#self.snapshots + 1), name = name, settings = clone(self.settings) }
        return true
    end
    function p:getDevelopSnapshots() return clone(self.snapshots) end
    function p:applyDevelopSettings(values)
        mutations = mutations + 1
        for key, value in pairs(values) do self.settings[key] = value end
    end
    function p:applyDevelopSnapshot(id)
        lastRestored, mutations = id, mutations + 1
        for _, snapshot in ipairs(self.snapshots) do
            if snapshot.snapshotID == id then self.settings = clone(snapshot.settings); return end
        end
        error('unknown snapshot ID')
    end
    return p
end

local original = photo(1, false)
local catalog = {}
function catalog:getPath() return '/catalog/test.lrcat' end
function catalog:getTargetPhoto() return selected[1] end
function catalog:getTargetPhotos() return #selected == 0 and { original } or selected end
function catalog:createVirtualCopies()
    mutations = mutations + 1
    local copy = photo(2, true)
    copy.settings = clone(selected[1].settings)
    selected = { copy }
    return { copy }
end
function catalog:withWriteAccessDo(_, callback) callback(); return 'executed' end

local mocks = {
    LrApplication = { activeCatalog = function() return catalog end, versionString = function() return 'mock' end },
    LrApplicationView = { getCurrentModuleName = function() return moduleName end },
    LrDevelopController = {
        getSelectedTool = function() return selectedTool end,
        getSelectedMask = function() return selectedMask end,
        getSelectedMaskTool = function() return 'component-1' end,
        selectMask = function(id)
            maskSelections = maskSelections + 1
            if not failMaskSelection then selectedMask = id end
        end,
        getRange = function(key) if key == 'local_Exposure' then return -4, 4 else return -100, 100 end end,
        getValue = function(key)
            for _, mask in ipairs(selected[1].settings.MaskGroupBasedCorrections or {}) do
                if mask.CorrectionID == selectedMask then
                    if key == 'local_Exposure' then return mask.LocalExposure2012 * 4 end
                    if key == 'local_Texture' then return mask.LocalTexture * 100 end
                end
            end
        end,
        setValue = function(key, value)
            mutations = mutations + 1
            if ignoreMaskSet then return end
            for _, mask in ipairs(selected[1].settings.MaskGroupBasedCorrections or {}) do
                if mask.CorrectionID == selectedMask then
                    if key == 'local_Exposure' then mask.LocalExposure2012 = value / 4 end
                    if key == 'local_Texture' then mask.LocalTexture = value / 100 end
                end
            end
            if corruptGlobalOnMaskSet then selected[1].settings.Exposure2012 = 4 end
        end,
    },
    LrDate = { currentTime = function() return now / 1000 end, timeToPosixDate = function(t) return t end },
    LrMD5 = { digest = function(data)
        local value = 5381
        for i = 1, #data do value = (value * 33 + data:byte(i)) % 4294967296 end
        return string.format('%08x', value)
    end },
    LrPathUtils = { child = function(a, b) return a .. '/' .. b end,
        isAbsolute = function(path) return path:sub(1, 1) == '/' end },
    LrTasks = { sleep = function(seconds) now = now + seconds * 1000 end },
    LrFileUtils = {
        createAllDirectories = function() return true end,
        exists = function(path) return files[path] and 'file' or false end,
        fileAttributes = function(path) return { fileSize = files[path] and 100 or 0 } end,
        move = function(source, destination)
            if files[destination] then return false, 'exists' end
            files[destination], files[source] = files[source], nil
            return true
        end,
    },
    LrExportSession = function(params)
        exports = exports + 1
        local settings = params.exportSettings
        assert(settings.LR_format == 'JPEG' and settings.LR_export_colorSpace == 'sRGB')
        assert(settings.LR_jpeg_quality == 0.9 and settings.LR_outputSharpeningOn == false)
        assert(settings.LR_size_maxHeight == 2048 and settings.LR_size_doNotEnlarge == true)
        return { renditions = function()
            local yielded = false
            return function()
                if yielded then return nil end
                yielded = true
                return 1, { waitForRender = function()
                    local output = settings.LR_export_destinationPathPrefix .. '/render.jpg'
                    files[output] = true
                    if changeDuringRender then selected[1].settings.Exposure2012 = 2 end
                    return true, output
                end }
            end
        end }
    end,
}
function import(name) assert(mocks[name], name); return mocks[name] end
local U = dofile(_PLUGIN.path .. '/Util.lua')
U.writeJson = function(path, record) assert(not records[path]); records[path] = clone(record); files[path] = true end
U.readJson = function(path) return clone(records[path]) end
local O = dofile(_PLUGIN.path .. '/Operations.lua')(U, {
    bridgeDir = '/bridge', exportRoot = '/renders', checkpoints = '/checkpoints', scratch = '/scratch',
})
local requestCount, count = 0, 0
local function request()
    requestCount = requestCount + 1
    return { id = '00000000-0000-4000-8000-' .. string.format('%012d', requestCount), deadlineAt = now + 10000 }
end
local function check(condition, label) assert(condition, label); count = count + 1 end
local function rejects(code, fn)
    local ok, err = pcall(fn)
    check(not ok and type(err) == 'table' and err.code == code, 'expected ' .. code)
end

check(U.encode(U.array()) == '[]', 'empty array stays array')
check(U.encode({}) == '{}', 'empty object stays object')
check(U.hash({ b = 2, a = 1 }) == U.hash({ a = 1, b = 2 }), 'tokens use sorted keys')
check(O.selected({}).count == 0, 'no selection never means the filmstrip')
check(O.capabilities({}).operations.create_subject_mask == false, 'mask capability explicitly unavailable')
selected = { original }
local originalId = O.selected({}).photoId
local baseline = O.read_state({ photoId = originalId })
rejects('ORIGINAL_PROTECTED', function() O.apply({ photoId = originalId, expectedStateToken = baseline.stateToken,
    adjustments = { Exposure2012 = 1 } }, request()) end)
check(mutations == 0, 'original protection precedes all writes')
rejects('TARGET_CHANGED', function() O.create_working_copy({ photoId = 'wrong', copyName = 'Test' }, request()) end)
selected = { original, photo(3, true) }
rejects('SELECTION_REQUIRED', function() O.read_state({ photoId = originalId }) end)
selected = { original }
local created = O.create_working_copy({ photoId = originalId, copyName = 'Test' }, request())
local id, copy = created.photoId, selected[1]
check(id ~= originalId and copy.virtual, 'copy has a distinct virtual identity')
check(original.settings.Exposure2012 == 0, 'original stays unchanged')
local checkpoint = O.checkpoint({ photoId = id, name = 'Baseline' }, request())
check(checkpoint.snapshotId == 'native-1', 'checkpoint returns SDK snapshotID')
local priorMutations = mutations
rejects('STALE_STATE', function() O.apply({ photoId = id, expectedStateToken = 'stale',
    adjustments = { Exposure2012 = 1 } }, request()) end)
rejects('INVALID_ADJUSTMENT', function() O.apply({ photoId = id, expectedStateToken = checkpoint.state.stateToken,
    adjustments = { Exposure = 1 } }, request()) end)
rejects('INVALID_ADJUSTMENT', function() O.apply({ photoId = id, expectedStateToken = checkpoint.state.stateToken,
    adjustments = { Exposure2012 = 6 } }, request()) end)
check(mutations == priorMutations, 'invalid/stale requests do not write')
local editRequest = request()
local edited = O.apply({ photoId = id, expectedStateToken = checkpoint.state.stateToken,
    adjustments = { Exposure2012 = 0.5 } }, editRequest)
check(editRequest._mutationStarted and copy.settings.Exposure2012 == 0.5, 'apply records mutation boundary')
local render = O.render({ photoId = id, expectedStateToken = edited.state.stateToken,
    outputPath = '/renders/candidate.jpg' }, request())
check(files[render.outputPath] and render.stateToken == edited.state.stateToken, 'render carries exact revision')
rejects('FILE_EXISTS', function() O.render({ photoId = id, expectedStateToken = edited.state.stateToken,
    outputPath = '/renders/candidate.jpg' }, request()) end)
rejects('INVALID_OUTPUT_PATH', function() O.render({ photoId = id, expectedStateToken = edited.state.stateToken,
    outputPath = '/renders/../escape.jpg' }, request()) end)
rejects('INVALID_OUTPUT_PATH', function() O.render({ photoId = id, expectedStateToken = edited.state.stateToken,
    outputPath = '/renders/nested/image.jpg' }, request()) end)
moduleName = 'library'
rejects('DEVELOP_REQUIRED', function() O.restore({ photoId = id, expectedStateToken = edited.state.stateToken,
    snapshotId = checkpoint.snapshotId }, request()) end)
moduleName = 'develop'
local restored = O.restore({ photoId = id, expectedStateToken = edited.state.stateToken,
    snapshotId = checkpoint.snapshotId }, request())
check(lastRestored == 'native-1' and restored.state.stateToken == checkpoint.state.stateToken,
    'restore passes native ID and verifies saved token')
check(restored.renderComparisonRequired, 'restoration does not claim visual verification')
local expired = request(); expired.deadlineAt = now - 1
priorMutations = mutations
rejects('EXPIRED', function() O.apply({ photoId = id, expectedStateToken = restored.state.stateToken,
    adjustments = { Exposure2012 = 1 } }, expired) end)
check(mutations == priorMutations, 'expired request does not write')
changeDuringRender = true
rejects('STALE_STATE', function() O.render({ photoId = id, expectedStateToken = restored.state.stateToken,
    outputPath = '/renders/stale.jpg' }, request()) end)
check(not files['/renders/stale.jpg'], 'changed state cannot publish a stale render')
rejects('UNSUPPORTED', function() O.create_subject_mask({ photoId = id }, request()) end)
copy.settings.MaskGroupBasedCorrections = {
    { CorrectionID = 'mask-1', LocalExposure2012 = 0.25, LocalTexture = 0,
        CorrectionMasks = { { MaskID = 'component-1', MaskDigest = 'opaque' } } },
    { CorrectionID = 'mask-2', LocalExposure2012 = 0, LocalTexture = 0 },
}
local maskState = O.read_state({ photoId = id })
local function maskParams(adjustments)
    return { photoId = id, expectedStateToken = maskState.stateToken, maskId = 'mask-1', adjustments = adjustments }
end
rejects('MASK_SELECTION_REQUIRED', function() O.selected_mask({ photoId = id }) end)
local selectParams = { photoId = id, expectedStateToken = maskState.stateToken, maskId = 'mask-1' }
selectParams.photoId = 'wrong'
rejects('TARGET_CHANGED', function() O.select_mask(selectParams, request()) end)
selectParams.photoId, selectParams.maskId = id, 'missing'
rejects('MASK_NOT_FOUND', function() O.select_mask(selectParams, request()) end)
check(maskSelections == 0, 'wrong-photo and missing-mask cannot change selection')
selectParams.maskId = 'mask-1'
failMaskSelection = true
rejects('MASK_TARGET_CHANGED', function() O.select_mask(selectParams, request()) end)
failMaskSelection = false
local selectionResult = O.select_mask(selectParams, request())
check(selectedMask == 'mask-1' and selectionResult.state.stateToken == maskState.stateToken,
    'existing mask selection is verified and leaves settings unchanged')
local inspection = O.selected_mask({ photoId = id, maskId = 'mask-1' })
check(inspection.maskContext.parameters.local_Exposure.value == 1
    and inspection.maskContext.parameters.local_Exposure.min == -4
    and inspection.maskContext.parameters.local_Exposure.max == 4,
    'mask inspection uses controller values and dynamic ranges, not stored XMP scale')
rejects('MASK_TARGET_CHANGED', function() O.selected_mask({ photoId = id, maskId = 'mask-2' }) end)
priorMutations = mutations
rejects('INVALID_ADJUSTMENT', function() O.adjust_mask(maskParams({ local_Exposure2012 = 0.25 }), request()) end)
rejects('INVALID_ADJUSTMENT', function() O.adjust_mask(maskParams({ local_Exposure = 5 }), request()) end)
local staleParams = maskParams({ local_Exposure = 0.25 }); staleParams.expectedStateToken = 'stale'
rejects('STALE_STATE', function() O.adjust_mask(staleParams, request()) end)
selectedTool = 'loupe'
rejects('MASKING_REQUIRED', function() O.adjust_mask(maskParams({ local_Exposure = 0.25 }), request()) end)
selectedTool = 'masking'
check(mutations == priorMutations, 'local invalid/stale/tool guard failures do not mutate')
selected = { original }
rejects('ORIGINAL_PROTECTED', function() O.adjust_mask({ photoId = originalId,
    expectedStateToken = baseline.stateToken, maskId = 'mask-1', adjustments = { local_Exposure = 0.25 } }, request()) end)
selected = { copy }
selectedMask = nil -- A native restore may leave no mask selected.
local maskRequest = request()
local masked = O.adjust_mask(maskParams({ local_Exposure = 0.25, local_Texture = 10 }), maskRequest)
check(maskRequest._mutationStarted and masked.maskContext.parameters.local_Exposure.value == 0.25
    and masked.maskContext.parameters.local_Texture.value == 10, 'local controls read back exactly in native units')
check(copy.settings.MaskGroupBasedCorrections[1].LocalExposure2012 == 0.0625
    and copy.settings.MaskGroupBasedCorrections[1].LocalTexture == 0.1,
    'controller translates native controls to stored fields without plugin scale assumptions')
check(copy.settings.MaskGroupBasedCorrections[2].LocalExposure2012 == 0
    and copy.settings.MaskGroupBasedCorrections[1].CorrectionMasks[1].MaskDigest == 'opaque',
    'other masks and opaque mask geometry remain unchanged')
maskState = masked.state
ignoreMaskSet = true
local failedRequest = request()
rejects('VERIFY_FAILED', function() O.adjust_mask(maskParams({ local_Exposure = 0.5 }), failedRequest) end)
check(failedRequest._mutationStarted, 'unverified native set is marked potentially applied')
ignoreMaskSet, corruptGlobalOnMaskSet = false, true
rejects('VERIFY_FAILED', function() O.adjust_mask(maskParams({ local_Exposure = 0.5 }), request()) end)
print('PASS: ' .. count .. ' offline Lua contract checks (mock SDK, not live Lightroom validation).')
