-- Offline contract tests. Run with Lua 5.1 from the repository root:
-- lua plugin/RawPhotoAgent.lrplugin/tests/operations_spec.lua
-- These mocks do not establish Adobe SDK runtime behavior.
_PLUGIN = _PLUGIN or { path = 'plugin/RawPhotoAgent.lrplugin' }

local now, selected, files, records, moduleName = 100000, {}, {}, {}, 'develop'
local mutations, exports, lastRestored, changeDuringRender = 0, 0, nil, false
local selectedTool, selectedMask, maskSelections = 'masking', nil, 0
local selectedMaskTool, maskCreations, toolSelections = 'component-1', 0, 0
local maskCreationMode, failToolSelection, corruptToolSelection = 'success', false, false
local autoToneMode, autoToneCalls, lastExportSettings = 'success', 0, nil
local pendingMask, maskReadyAt
local failMaskSelection, corruptGlobalOnMaskSet, ignoreMaskSet = false, false, false
local importedPhotos, aliases = {}, {}
local imports, photoSelections, moduleSwitches, writeDepth = 0, 0, 0, 0
local failImport, failPhotoSelection, failModuleSwitch = false, false, false
local importedFormat, switchToOtherPhoto = 'RAW', false
local onCreateCopy, onSelectPhoto, onSwitchModule, pendingPhotoEvent, photoEventAt
local activeCatalog
local function clone(value)
    if type(value) ~= 'table' then return value end
    local copy = {}
    for key, item in pairs(value) do copy[key] = clone(item) end
    return copy
end

local function photo(id, virtual, path, format)
    local p = { localIdentifier = id, virtual = virtual, path = path or '/photos/example.CR3',
        format = format or 'RAW', settings = { Exposure2012 = 0,
        Contrast2012 = 0, Temperature = 5500, Tint = 0, WhiteBalance = 'As Shot' }, snapshots = {} }
    function p:getRawMetadata(key)
        return ({ isVirtualCopy = self.virtual, fileFormat = self.format, path = self.path, isVideo = false })[key]
    end
    function p:getFormattedMetadata(key) return key == 'fileName' and self.path:match('[^/]+$') or 'Working copy' end
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
local function createNativeMask()
    local p = selected[1]
    if maskCreationMode == 'none' then return end
    local id = 'created-mask-' .. tostring(maskCreations)
    local component = 'created-component-' .. tostring(maskCreations)
    local group = { CorrectionID = id, LocalExposure2012 = 0, LocalTexture = 0,
        CorrectionMasks = { { MaskID = component, MaskDigest = 'opaque-generated' } } }
    if maskCreationMode == 'empty' then group.CorrectionMasks = {} end
    if maskCreationMode == 'global' then p.settings.Exposure2012 = p.settings.Exposure2012 + 1 end
    p.settings.MaskGroupBasedCorrections = p.settings.MaskGroupBasedCorrections or {}
    if maskCreationMode == 'existing' then p.settings.MaskGroupBasedCorrections[1].LocalTexture = 0.7 end
    table.insert(p.settings.MaskGroupBasedCorrections, group)
    if maskCreationMode == 'two' then
        table.insert(p.settings.MaskGroupBasedCorrections, { CorrectionID = 'unexpected', LocalExposure2012 = 0 })
    end
    if maskCreationMode ~= 'unselected' then selectedMask = id end
    selectedMaskTool = maskCreationMode == 'mismatch' and 'wrong-component' or component
    p.settings.EnableMaskGroupBasedCorrections = true
    if maskCreationMode == 'switch' then selected = { original } end
end
local catalog = {}
activeCatalog = catalog
function catalog:getPath() return '/catalog/test.lrcat' end
function catalog:getTargetPhoto() return selected[1] end
function catalog:getTargetPhotos() return #selected == 0 and { original } or selected end
function catalog:createVirtualCopies()
    mutations = mutations + 1
    local source = selected[1]
    local copy = photo(2, true)
    copy.settings = clone(source.settings)
    if onCreateCopy then onCreateCopy(copy, source) else selected = { copy } end
    return { copy }
end
function catalog:withWriteAccessDo(_, callback)
    writeDepth = writeDepth + 1
    local ok, err = pcall(callback)
    writeDepth = writeDepth - 1
    if not ok then error(err, 0) end
    return 'executed'
end
function catalog:findPhotoByPath(path) return importedPhotos[path] end
function catalog:addPhoto(path)
    assert(writeDepth > 0, 'addPhoto requires catalog write access')
    imports, mutations = imports + 1, mutations + 1
    if failImport then error('native import failed') end
    local p = photo(100 + imports, false, path, importedFormat)
    importedPhotos[path] = p
    return p
end
function catalog:setSelectedPhotos(activePhoto, otherSelectedPhotos)
    assert(writeDepth == 0 and #otherSelectedPhotos == 0, 'select exactly one photo outside write access')
    photoSelections = photoSelections + 1
    if onSelectPhoto then onSelectPhoto(activePhoto)
    elseif not failPhotoSelection then selected = { activePhoto } end
end

local mocks = {
    LrApplication = { activeCatalog = function() return activeCatalog end, versionString = function() return 'mock' end },
    LrApplicationView = { getCurrentModuleName = function() return moduleName end,
        switchToModule = function(name)
            assert(name == 'develop' and writeDepth == 0)
            moduleSwitches = moduleSwitches + 1
            if not failModuleSwitch then moduleName = name end
            if switchToOtherPhoto then selected = { original } end
            if onSwitchModule then onSwitchModule() end
        end },
    LrDevelopController = {
        getSelectedTool = function() return selectedTool end,
        getSelectedMask = function() return selectedMask end,
        getSelectedMaskTool = function() return selectedMaskTool end,
        selectTool = function(tool)
            assert(writeDepth == 0 and tool == 'masking')
            toolSelections = toolSelections + 1
            if not failToolSelection then selectedTool = tool end
            if corruptToolSelection then selected[1].settings.Exposure2012 = selected[1].settings.Exposure2012 + 1 end
        end,
        createNewMask = function(maskType, kind)
            assert(writeDepth == 0 and selectedTool == 'masking' and maskType == 'aiSelection')
            assert(kind == 'subject' or kind == 'background')
            maskCreations, mutations = maskCreations + 1, mutations + 1
            if maskCreationMode == 'delay' then pendingMask, maskReadyAt = createNativeMask, now + 600
            else createNativeMask() end
        end,
        setAutoTone = function()
            assert(writeDepth == 0 and moduleName == 'develop')
            autoToneCalls, mutations = autoToneCalls + 1, mutations + 1
            if autoToneMode == 'none' then return end
            selected[1].settings.Exposure2012 = selected[1].settings.Exposure2012 + 0.3
            selected[1].settings.Highlights2012 = -20
            selected[1].settings.AutoToneDigest = 'native-auto-digest'
            if autoToneMode == 'global' then selected[1].settings.Temperature = 4000 end
            if autoToneMode == 'switch' then selected = { original } end
        end,
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
    LrTasks = { sleep = function(seconds)
        now = now + seconds * 1000
        if pendingMask and now >= maskReadyAt then local callback = pendingMask; pendingMask = nil; callback() end
        if pendingPhotoEvent and now >= photoEventAt then
            local callback = pendingPhotoEvent; pendingPhotoEvent = nil; callback()
        end
    end },
    LrFileUtils = {
        createAllDirectories = function() return true end,
        exists = function(path) return files[path] == 'directory' and 'directory' or files[path] and 'file' or false end,
        fileAttributes = function(path) return { fileSize = type(files[path]) == 'number' and files[path] or files[path] and 100 or 0 } end,
        resolveAllAliases = function(path) return aliases[path] or path end,
        move = function(source, destination)
            if files[destination] then return false, 'exists' end
            files[destination], files[source] = files[source], nil
            return true
        end,
    },
    LrExportSession = function(params)
        exports = exports + 1
        local settings = params.exportSettings
        lastExportSettings = clone(settings)
        assert((settings.LR_format == 'JPEG' or settings.LR_format == 'TIFF') and settings.LR_export_colorSpace == 'sRGB')
        assert(settings.LR_jpeg_quality == 0.9 and settings.LR_outputSharpeningOn == false)
        assert(settings.LR_size_maxHeight == 2048 and settings.LR_size_doNotEnlarge == true)
        return { renditions = function()
            local yielded = false
            return function()
                if yielded then return nil end
                yielded = true
                return 1, { waitForRender = function()
                    local output = settings.LR_export_destinationPathPrefix .. (settings.LR_format == 'TIFF' and '/render.tif' or '/render.jpg')
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
    bridgeDir = '/bridge', exportRoot = '/renders', importRoot = '/uploads', checkpoints = '/checkpoints', scratch = '/scratch',
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
check(O.capabilities({}).operations.create_subject_mask == true
    and O.capabilities({}).maskCreation.liveValidated == false,
    'implemented runtime capability is separate from live validation')
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
local copyParams = { photoId = originalId, copyName = 'Selection contract' }
local function delayedPhotoEvent(callback, delay)
    pendingPhotoEvent, photoEventAt = callback, now + (delay or 300)
end
local function resetCopy()
    selected, activeCatalog, pendingPhotoEvent = { original }, catalog, nil
    original.settings = clone(baseline.settings)
    onCreateCopy = nil
end
local function failedCopy(code, callback, timeout)
    resetCopy()
    onCreateCopy = callback
    local copyRequest = request()
    if timeout then copyRequest.deadlineAt = now + timeout end
    local beforeMutations, beforePhotoSelections = mutations, photoSelections
    rejects(code, function() O.create_working_copy(copyParams, copyRequest) end)
    check(copyRequest._mutationStarted and mutations == beforeMutations + 1
        and photoSelections == beforePhotoSelections,
        'uncertain copy creates exactly once and never forces photo selection')
end
local beforeDelayedCopy, beforeCopySelections = mutations, photoSelections
onCreateCopy = function(newCopy)
    delayedPhotoEvent(function() selected = { newCopy } end)
end
local delayedCopy = O.create_working_copy(copyParams, request())
check(selected[1].virtual and delayedCopy.photoId == O.selected({}).photoId
    and U.hash(delayedCopy.state.settings) == U.hash(baseline.settings)
    and mutations == beforeDelayedCopy + 1 and photoSelections == beforeCopySelections,
    'delayed native copy selection is observed without another creation or selection call')
failedCopy('COPY_SELECTION_UNVERIFIED', function() end)
failedCopy('EXPIRED', function(newCopy)
    delayedPhotoEvent(function() selected = { newCopy } end, 200)
end, 200)
failedCopy('EXPIRED', function(newCopy) selected = { newCopy }; now = now + 200 end, 200)
failedCopy('TARGET_CHANGED', function()
    delayedPhotoEvent(function() selected = { photo(999, true) } end)
end)
failedCopy('SELECTION_REQUIRED', function(newCopy)
    delayedPhotoEvent(function() selected = { original, newCopy } end)
end)
failedCopy('SELECTION_REQUIRED', function()
    delayedPhotoEvent(function() selected = {} end)
end)
failedCopy('TARGET_CHANGED', function()
    delayedPhotoEvent(function()
        activeCatalog = { getPath = function() return '/catalog/other.lrcat' end }
    end)
end)
failedCopy('VERIFY_FAILED', function()
    delayedPhotoEvent(function() original.settings.Exposure2012 = 0.1 end)
end)
failedCopy('VERIFY_FAILED', function(newCopy)
    delayedPhotoEvent(function() newCopy.settings.Exposure2012 = 0.1 end)
end)
failedCopy('VERIFY_FAILED', function(newCopy)
    delayedPhotoEvent(function() newCopy.settings.PointColors = {} end)
end)
failedCopy('VERIFY_FAILED', function(newCopy) newCopy.virtual = false end)
failedCopy('VERIFY_FAILED', function(newCopy) newCopy.path = '/photos/wrong.CR3' end)
resetCopy()
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
check(render.format == 'JPEG' and render.bitDepth == 8 and render.outputSharpening == false,
    'default render remains JPEG with explicit depth/sharpening metadata')
local tiff = O.render({ photoId = id, expectedStateToken = edited.state.stateToken,
    outputPath = '/renders/reference.tif', format = 'TIFF' }, request())
check(tiff.format == 'TIFF' and tiff.bitDepth == 16 and files[tiff.outputPath]
    and lastExportSettings.LR_tiff_bitDepth == 16
    and lastExportSettings.LR_tiff_compressionMethod == 'compressionMethod_None'
    and lastExportSettings.LR_outputSharpeningOn == false and lastExportSettings.LR_export_colorSpace == 'sRGB',
    'reference TIFF uses 16-bit lossless sRGB with no output sharpening')
for _, spec in ipairs({ { format = 'PNG', path = '/renders/reference.png', code = 'INVALID_PARAMS' },
    { format = 'TIFF', path = '/renders/reference.jpg', code = 'INVALID_OUTPUT_PATH' },
    { format = 'JPEG', path = '/renders/reference.tif', code = 'INVALID_OUTPUT_PATH' },
    { format = 'TIFF', path = '/renders/nested/reference.tif', code = 'INVALID_OUTPUT_PATH' },
    { format = 'TIFF', path = '/renders/../reference.tif', code = 'INVALID_OUTPUT_PATH' } }) do
    rejects(spec.code, function() O.render({ photoId = id, expectedStateToken = edited.state.stateToken,
        outputPath = spec.path, format = spec.format }, request()) end)
end
aliases['/renders'] = '/elsewhere'
rejects('INVALID_OUTPUT_PATH', function() O.render({ photoId = id, expectedStateToken = edited.state.stateToken,
    outputPath = '/renders/alias.tif', format = 'TIFF' }, request()) end)
aliases['/renders'] = nil
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
copy.settings.Exposure2012 = 0
local currentState = O.read_state({ photoId = id })
rejects('STALE_STATE', function() O.render({ photoId = id, expectedStateToken = currentState.stateToken,
    outputPath = '/renders/stale-reference.tif', format = 'TIFF' }, request()) end)
check(not files['/renders/stale-reference.tif'], 'TIFF rejects state changes during rendering')
changeDuringRender = false
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
local failedMaskSelectionRequest = request()
rejects('MASK_TARGET_CHANGED', function() O.select_mask(selectParams, failedMaskSelectionRequest) end)
check(failedMaskSelectionRequest._mutationStarted, 'native mask selection records uncertain UI boundary')
failMaskSelection = false
local selectionResult = O.select_mask(selectParams, request())
check(selectedMask == 'mask-1' and selectionResult.state.stateToken == maskState.stateToken,
    'existing mask selection is verified and leaves settings unchanged')
selectedTool = 'loupe'
local selectOpenRequest = request()
local panelSelected = O.select_mask(selectParams, selectOpenRequest)
check(selectedTool == 'masking' and selectOpenRequest._mutationStarted
    and panelSelected.state.stateToken == maskState.stateToken,
    'explicit select_mask opens Masking with target/state checks and preserves photo settings')
selectedTool, failToolSelection = 'loupe', true
local maskSelectionsBeforeOpen = maskSelections
rejects('MASKING_REQUIRED', function() O.select_mask(selectParams, request()) end)
check(maskSelections == maskSelectionsBeforeOpen, 'failed panel opening cannot select a mask')
failToolSelection, corruptToolSelection = false, true
local savedSelectionExposure = copy.settings.Exposure2012
rejects('STALE_STATE', function() O.select_mask(selectParams, request()) end)
copy.settings.Exposure2012, corruptToolSelection, selectedTool = savedSelectionExposure, false, 'masking'
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
corruptGlobalOnMaskSet = false
-- New masks must be distinct saved groups/components, preserving all prior work.
local savedMaskSettings = clone(copy.settings)
savedMaskSettings.EnableMaskGroupBasedCorrections = true
local function resetMaskCreation(mode)
    copy.settings = clone(savedMaskSettings)
    selected, selectedTool, selectedMask, selectedMaskTool = { copy }, 'masking', 'mask-1', 'component-1'
    maskCreationMode = mode or 'success'
    return { photoId = id, expectedStateToken = O.read_state({ photoId = id }).stateToken }
end
local function longRequest()
    local value = request(); value.deadlineAt = now + 40000; return value
end
local createParams = resetMaskCreation()
local beforeMaskCreations, beforeToolSelections = maskCreations, toolSelections
createParams.expectedStateToken = 'stale'
rejects('STALE_STATE', function() O.create_subject_mask(createParams, request()) end)
createParams = resetMaskCreation(); createParams.photoId = 'wrong'
rejects('TARGET_CHANGED', function() O.create_subject_mask(createParams, request()) end)
selected = { original }
rejects('ORIGINAL_PROTECTED', function() O.create_subject_mask({ photoId = originalId,
    expectedStateToken = baseline.stateToken }, request()) end)
createParams = resetMaskCreation(); moduleName = 'library'
rejects('DEVELOP_REQUIRED', function() O.create_subject_mask(createParams, request()) end)
moduleName = 'develop'
local expiredMask = request(); expiredMask.deadlineAt = now - 1
rejects('EXPIRED', function() O.create_subject_mask(createParams, expiredMask) end)
check(maskCreations == beforeMaskCreations and toolSelections == beforeToolSelections,
    'new mask invalid targeting/state/module/deadline fails before any native action')
local nativeCreate = mocks.LrDevelopController.createNewMask
mocks.LrDevelopController.createNewMask = nil
check(not O.capabilities({}).operations.create_subject_mask and not O.capabilities({}).operations.create_background_mask,
    'mask capabilities reflect missing runtime API')
rejects('UNSUPPORTED', function() O.create_subject_mask(createParams, request()) end)
mocks.LrDevelopController.createNewMask = nativeCreate
createParams = resetMaskCreation(); selectedTool, failToolSelection = 'loupe', true
local failedOpen = request()
rejects('MASKING_REQUIRED', function() O.create_subject_mask(createParams, failedOpen) end)
check(failedOpen._mutationStarted and maskCreations == beforeMaskCreations,
    'failed panel opening is uncertain UI outcome but creates no mask')
failToolSelection, corruptToolSelection = false, true
createParams = resetMaskCreation(); selectedTool = 'loupe'
rejects('STALE_STATE', function() O.create_subject_mask(createParams, request()) end)
check(maskCreations == beforeMaskCreations, 'state changes during panel opening prevent creation')
corruptToolSelection = false
createParams = resetMaskCreation('delay'); selectedTool = 'loupe'
local createRequest = request()
local createdMask = O.create_subject_mask(createParams, createRequest)
check(createRequest._mutationStarted and createdMask.maskKind == 'subject'
    and createdMask.maskId == selectedMask and createdMask.maskContext.selectedMaskToolId == selectedMaskTool
    and createdMask.completion == 'stored-and-selected' and createdMask.pixelCoverageVerified == false
    and createdMask.renderComparisonRequired, 'creation waits for stored and selected native identities without claiming pixel coverage')
check(U.hash(copy.settings.MaskGroupBasedCorrections[1]) == U.hash(savedMaskSettings.MaskGroupBasedCorrections[1])
    and U.hash(copy.settings.MaskGroupBasedCorrections[2]) == U.hash(savedMaskSettings.MaskGroupBasedCorrections[2])
    and copy.settings.Exposure2012 == savedMaskSettings.Exposure2012,
    'new mask preserves other masks, geometry, and global exposure')
createParams = resetMaskCreation()
copy.settings.MaskGroupBasedCorrections, copy.settings.EnableMaskGroupBasedCorrections = nil, nil
createParams.expectedStateToken = O.read_state({ photoId = id }).stateToken
local background = O.create_background_mask(createParams, request())
check(background.maskKind == 'background' and #copy.settings.MaskGroupBasedCorrections == 1
    and copy.settings.EnableMaskGroupBasedCorrections == true, 'first background mask may introduce the mask collection flag')
for _, mode in ipairs({ 'none', 'empty', 'unselected', 'mismatch' }) do
    createParams = resetMaskCreation(mode)
    local unverified = longRequest()
    rejects('MASK_CREATION_UNVERIFIED', function() O.create_subject_mask(createParams, unverified) end)
    check(unverified._mutationStarted, 'no mask/empty mask/unselected component reports uncertain outcome')
end
for _, mode in ipairs({ 'global', 'existing', 'two' }) do
    createParams = resetMaskCreation(mode)
    rejects('VERIFY_FAILED', function() O.create_subject_mask(createParams, request()) end)
end
createParams = resetMaskCreation('switch')
rejects('TARGET_CHANGED', function() O.create_subject_mask(createParams, request()) end)
createParams = resetMaskCreation('delay')
local shortCreate = request(); shortCreate.deadlineAt = now + 200
rejects('EXPIRED', function() O.create_subject_mask(createParams, shortCreate) end)
check(shortCreate._mutationStarted, 'deadline after native creation is uncertain and never retried')
pendingMask = nil
-- Auto Tone is a separately guarded native comparison baseline.
local function resetAuto(mode)
    resetMaskCreation()
    for _, key in ipairs({ 'Highlights2012', 'Shadows2012', 'Whites2012', 'Blacks2012', 'Vibrance', 'Saturation' }) do
        copy.settings[key] = 0
    end
    autoToneMode = mode or 'success'
    return { photoId = id, expectedStateToken = O.read_state({ photoId = id }).stateToken }
end
local autoParams = resetAuto()
local beforeAutoCalls = autoToneCalls
autoParams.expectedStateToken = 'stale'
rejects('STALE_STATE', function() O.auto_tone(autoParams, request()) end)
autoParams = resetAuto(); autoParams.photoId = 'wrong'
rejects('TARGET_CHANGED', function() O.auto_tone(autoParams, request()) end)
selected = { original }
rejects('ORIGINAL_PROTECTED', function() O.auto_tone({ photoId = originalId,
    expectedStateToken = baseline.stateToken }, request()) end)
autoParams = resetAuto(); copy.settings.Vibrance = nil
autoParams.expectedStateToken = O.read_state({ photoId = id }).stateToken
rejects('UNSUPPORTED_PARAMETER', function() O.auto_tone(autoParams, request()) end)
autoParams = resetAuto(); local expiredAuto = request(); expiredAuto.deadlineAt = now - 1
rejects('EXPIRED', function() O.auto_tone(autoParams, expiredAuto) end)
check(autoToneCalls == beforeAutoCalls, 'Auto Tone preconditions prevent any native write')
autoParams = resetAuto()
local autoRequest = request()
local autoResult = O.auto_tone(autoParams, autoRequest)
check(autoRequest._mutationStarted and autoResult.changedSettings.Exposure2012
    and autoResult.changedSettings.Highlights2012 == -20 and autoResult.renderComparisonRequired,
    'Auto Tone returns observed changed settings after stable readback')
check(U.hash(copy.settings.MaskGroupBasedCorrections) == U.hash(savedMaskSettings.MaskGroupBasedCorrections)
    and copy.settings.Temperature == savedMaskSettings.Temperature, 'Auto Tone preserves masks and unrelated white balance')
autoParams = resetAuto('global')
rejects('VERIFY_FAILED', function() O.auto_tone(autoParams, request()) end)
autoParams = resetAuto('switch')
rejects('TARGET_CHANGED', function() O.auto_tone(autoParams, request()) end)
autoParams = resetAuto('none')
local noAutoRequest = longRequest()
rejects('AUTO_TONE_UNVERIFIED', function() O.auto_tone(autoParams, noAutoRequest) end)
check(noAutoRequest._mutationStarted, 'no-op Auto Tone does not falsely claim confirmed completion')
-- Uploaded files may enter the catalog only through a dedicated root and UUID directory.
local uploadDirectory = '/uploads/00000000-0000-4000-8000-000000000001'
local uploadedPath = uploadDirectory .. '/camera.CR3'
files[uploadedPath] = 200
local uploadParams = { path = uploadedPath, filename = 'camera.CR3' }
local beforeImportMutations, beforeSelections, beforeSwitches = mutations, photoSelections, moduleSwitches
for _, path in ipairs({ '/outside/camera.CR3', '/uploads-escape/00000000-0000-4000-8000-000000000001/camera.CR3',
    '/uploads/../camera.CR3', '/uploads/not-a-uuid/camera.CR3', uploadDirectory .. '/nested/camera.CR3',
    uploadDirectory .. '/../camera.CR3' }) do
    rejects('INVALID_IMPORT_PATH', function() O.import_photo({ path = path, filename = 'camera.CR3' }, request()) end)
end
rejects('INVALID_PARAMS', function() O.import_photo({ path = uploadedPath, filename = '' }, request()) end)
rejects('INVALID_IMPORT_PATH', function() O.import_photo({ path = uploadedPath, filename = 'other.CR3' }, request()) end)
rejects('INVALID_IMPORT_PATH', function() O.import_photo({ path = uploadedPath, filename = '../camera.CR3' }, request()) end)
rejects('UNSUPPORTED_FORMAT', function() O.import_photo({ path = uploadDirectory .. '/image.jpg', filename = 'image.jpg' }, request()) end)
rejects('IMPORT_FILE_MISSING', function() O.import_photo({ path = uploadDirectory .. '/missing.CR3', filename = 'missing.CR3' }, request()) end)
files[uploadedPath] = 'directory'
rejects('IMPORT_FILE_MISSING', function() O.import_photo(uploadParams, request()) end)
files[uploadedPath] = 0
rejects('IMPORT_FILE_EMPTY', function() O.import_photo(uploadParams, request()) end)
files[uploadedPath] = 200
aliases[uploadedPath] = '/outside/camera.CR3'
rejects('INVALID_IMPORT_PATH', function() O.import_photo(uploadParams, request()) end)
aliases[uploadedPath], aliases['/uploads'] = nil, '/outside'
rejects('INVALID_IMPORT_PATH', function() O.import_photo(uploadParams, request()) end)
aliases['/uploads'] = nil
local expiredImport = request(); expiredImport.deadlineAt = now - 1
rejects('EXPIRED', function() O.import_photo(uploadParams, expiredImport) end)
check(mutations == beforeImportMutations and photoSelections == beforeSelections and moduleSwitches == beforeSwitches,
    'invalid or expired upload cannot import, select a photo, or change module')
selected, moduleName = {}, 'library'
local importRequest = request()
local imported = O.import_photo(uploadParams, importRequest)
local importedPhoto = selected[1]
check(importRequest._mutationStarted and imports == 1 and #selected == 1
    and not imported.isVirtualCopy and imported.fileFormat == 'RAW'
    and imported.name == 'camera.CR3' and imported.path == uploadedPath and moduleName == 'develop',
    'upload adds one original, selects it exactly, reveals Develop, and returns its descriptor')
check(importedPhoto.settings.Exposure2012 == 0, 'import applies no development edit to original')
local importedAgain = O.import_photo(uploadParams, request())
check(imports == 1 and importedAgain.photoId == imported.photoId, 'duplicate path uses existing catalog original')
local importedSettings = clone(importedPhoto.settings)
selected = { original }
local beforeDelayedImport, beforeImportSelections = imports, photoSelections
onSelectPhoto = function(activePhoto)
    delayedPhotoEvent(function() selected = { activePhoto } end)
end
local delayedImport = O.import_photo(uploadParams, request())
check(delayedImport.photoId == imported.photoId and imports == beforeDelayedImport
    and photoSelections == beforeImportSelections + 1,
    'import observes delayed selection without importing or selecting again')
local function failedImportSelection(code, callback, timeout)
    selected, moduleName, pendingPhotoEvent = { original }, 'develop', nil
    importedPhoto.settings = clone(importedSettings)
    onSelectPhoto = callback
    local importGuardRequest = request()
    if timeout then importGuardRequest.deadlineAt = now + timeout end
    local beforeImports, beforeSelections, beforeModules = imports, photoSelections, moduleSwitches
    rejects(code, function() O.import_photo(uploadParams, importGuardRequest) end)
    check(importGuardRequest._mutationStarted and imports == beforeImports
        and photoSelections == beforeSelections + 1 and moduleSwitches == beforeModules,
        'import selection failure is terminal without another import, selection, or module switch')
end
failedImportSelection('EXPIRED', function(activePhoto)
    delayedPhotoEvent(function() selected = { activePhoto } end, 200)
end, 200)
failedImportSelection('EXPIRED', function(activePhoto)
    selected = { activePhoto }; now = now + 200
end, 200)
failedImportSelection('STALE_STATE', function(activePhoto)
    delayedPhotoEvent(function()
        activePhoto.settings.Exposure2012 = 0.1
        selected = { activePhoto }
    end)
end)
check(importedPhoto.settings.Exposure2012 == 0.1, 'failed import does not rewrite a native settings difference')
failedImportSelection('STALE_STATE', function(activePhoto)
    selected = { activePhoto }
    activePhoto.settings.PointColors = {}
end)
check(type(importedPhoto.settings.PointColors) == 'table', 'absent-to-empty native settings change is not normalized away')
onSelectPhoto, pendingPhotoEvent = nil, nil
importedPhoto.settings, selected, moduleName = clone(importedSettings), { importedPhoto }, 'library'
onSwitchModule = function() importedPhoto.settings.Exposure2012 = 0.2 end
local importDevelopRequest = request()
local beforeDevelopImports, beforeDevelopSelections, beforeDevelopSwitches = imports, photoSelections, moduleSwitches
rejects('STALE_STATE', function() O.import_photo(uploadParams, importDevelopRequest) end)
check(importDevelopRequest._mutationStarted and imports == beforeDevelopImports
    and photoSelections == beforeDevelopSelections + 1 and moduleSwitches == beforeDevelopSwitches + 1
    and importedPhoto.settings.Exposure2012 == 0.2,
    'import settings drift on entering Develop remains terminal, without rebasing or restoring the original')
onSwitchModule, importedPhoto.settings = nil, clone(importedSettings)
local dngPath = uploadDirectory .. '/image.dng'
files[dngPath], importedFormat = 400, 'DNG'
local dng = O.import_photo({ path = dngPath, filename = 'image.dng' }, request())
check(dng.fileFormat == 'DNG' and not dng.isVirtualCopy, 'DNG extension and metadata are supported')
importedFormat = 'RAW'
local namedPath = uploadDirectory .. '/camera sample (2).CR3'
files[namedPath] = 200
local named = O.import_photo({ path = namedPath, filename = 'camera sample (2).CR3' }, request())
check(named.name == 'camera sample (2).CR3', 'safe uploaded filenames may contain spaces and punctuation')
local virtualPath = uploadDirectory .. '/virtual.CR3'
files[virtualPath], importedPhotos[virtualPath] = 200, photo(888, true, virtualPath)
rejects('IMPORT_UNVERIFIED', function() O.import_photo({ path = virtualPath, filename = 'virtual.CR3' }, request()) end)
local jpegPath = uploadDirectory .. '/disguised.CR3'
files[jpegPath], importedPhotos[jpegPath] = 200, photo(889, false, jpegPath, 'JPEG')
rejects('UNSUPPORTED_FORMAT', function() O.import_photo({ path = jpegPath, filename = 'disguised.CR3' }, request()) end)
local failedPath = uploadDirectory .. '/failure.CR3'
files[failedPath], failImport = 200, true
local failedImportRequest = request()
local ok = pcall(function() O.import_photo({ path = failedPath, filename = 'failure.CR3' }, failedImportRequest) end)
check(not ok and failedImportRequest._mutationStarted, 'native import failure records uncertain mutation boundary')
failImport, failPhotoSelection = false, true
selected = { original }
local failedSelectionRequest = request()
rejects('IMPORT_UNVERIFIED', function() O.import_photo(uploadParams, failedSelectionRequest) end)
check(failedSelectionRequest._mutationStarted and selected[1] == original, 'failed native selection never claims upload is ready')
failPhotoSelection = false
selected, moduleName = { importedPhoto }, 'library'
local originalToken = O.read_state({ photoId = imported.photoId }).stateToken
beforeSelections, beforeSwitches = photoSelections, moduleSwitches
rejects('TARGET_CHANGED', function() O.reveal_photo({ photoId = 'wrong' }, request()) end)
check(photoSelections == beforeSelections and moduleSwitches == beforeSwitches, 'wrong reveal target changes no UI state')
local revealRequest = request()
local revealed = O.reveal_photo({ photoId = imported.photoId }, revealRequest)
check(revealed.photoId == imported.photoId and revealRequest._mutationStarted and moduleName == 'develop'
    and photoSelections == beforeSelections and O.read_state({ photoId = imported.photoId }).stateToken == originalToken,
    'reveal enters Develop and preserves original selection/settings')
moduleName = 'library'
onSwitchModule = function()
    moduleName = 'library'
    delayedPhotoEvent(function() moduleName = 'develop' end, 200)
end
local expiredRevealRequest = request(); expiredRevealRequest.deadlineAt = now + 200
local beforeExpiredSwitches = moduleSwitches
rejects('EXPIRED', function() O.reveal_photo({ photoId = imported.photoId }, expiredRevealRequest) end)
check(expiredRevealRequest._mutationStarted and moduleSwitches == beforeExpiredSwitches + 1,
    'module completion at the expired deadline cannot report success or switch again')
onSwitchModule, pendingPhotoEvent = nil, nil
moduleName, failModuleSwitch = 'library', true
local failedRevealRequest = request()
rejects('REVEAL_UNVERIFIED', function() O.reveal_photo({ photoId = imported.photoId }, failedRevealRequest) end)
check(failedRevealRequest._mutationStarted, 'unverified module change is marked uncertain')
failModuleSwitch, switchToOtherPhoto = false, true
rejects('TARGET_CHANGED', function() O.reveal_photo({ photoId = imported.photoId }, request()) end)
print('PASS: ' .. count .. ' offline Lua contract checks (mock SDK, not live Lightroom validation).')
