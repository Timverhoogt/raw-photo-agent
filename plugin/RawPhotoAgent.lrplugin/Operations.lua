local LrApplication = import 'LrApplication'
local LrApplicationView = import 'LrApplicationView'
local LrDevelopController = import 'LrDevelopController'
local LrExportSession = import 'LrExportSession'
local LrFileUtils = import 'LrFileUtils'
local LrMD5 = import 'LrMD5'
local LrPathUtils = import 'LrPathUtils'
local LrTasks = import 'LrTasks'

return function(U, config)
    local O = {}
    local numericRanges = {
        Exposure2012 = { -5, 5 }, Contrast2012 = { -100, 100 },
        Highlights2012 = { -100, 100 }, Shadows2012 = { -100, 100 },
        Whites2012 = { -100, 100 }, Blacks2012 = { -100, 100 },
        Clarity2012 = { -100, 100 }, Texture = { -100, 100 }, Dehaze = { -100, 100 },
        Vibrance = { -100, 100 }, Saturation = { -100, 100 },
        Temperature = { 2000, 50000 }, Tint = { -150, 150 },
        Sharpness = { 0, 150 }, SharpenRadius = { 0.5, 3 },
        SharpenDetail = { 0, 100 }, SharpenEdgeMasking = { 0, 100 },
        LuminanceSmoothing = { 0, 100 }, LuminanceNoiseReductionDetail = { 0, 100 },
        LuminanceNoiseReductionContrast = { 0, 100 }, ColorNoiseReduction = { 0, 100 },
        ColorNoiseReductionDetail = { 0, 100 }, ColorNoiseReductionSmoothness = { 0, 100 },
    }
    -- Controller names/units differ from getDevelopSettings/XMP field names.
    -- Read native ranges and values instead of assuming a normalized scale.
    local localSettings = { local_Exposure = 'LocalExposure2012', local_Texture = 'LocalTexture' }
    local autoToneSettings = { Exposure2012 = true, Contrast2012 = true, Highlights2012 = true,
        Shadows2012 = true, Whites2012 = true, Blacks2012 = true, Vibrance = true, Saturation = true,
        AutoToneDigest = true, AutoToneDigestNoSat = true }
    local importExtensions = U.array({ '3fr', 'arw', 'cr2', 'cr3', 'crw', 'dcr', 'dng', 'erf',
        'fff', 'iiq', 'kdc', 'mef', 'mos', 'mrw', 'nef', 'nrw', 'orf', 'pef', 'ptx', 'raf', 'raw',
        'rw2', 'rwl', 'sr2', 'srf', 'srw' })
    local importExtensionSet = {}
    for _, extension in ipairs(importExtensions) do importExtensionSet[extension] = true end

    local function photoId(catalog, photo)
        return LrMD5.digest(catalog:getPath()) .. ':' .. tostring(photo.localIdentifier)
    end

    local function selection(catalog)
        -- getTargetPhotos alone returns the whole filmstrip for no selection.
        if not catalog:getTargetPhoto() then return {} end
        return catalog:getTargetPhotos()
    end

    local function describe(catalog, photo)
        return {
            photoId = photoId(catalog, photo),
            name = photo:getFormattedMetadata('fileName'),
            copyName = photo:getFormattedMetadata('copyName') or '',
            fileFormat = photo:getRawMetadata('fileFormat'),
            isVirtualCopy = photo:getRawMetadata('isVirtualCopy') == true,
            path = photo:getRawMetadata('path'),
        }
    end

    local function target(id, mutation, requireDevelop)
        U.text(id, 'photoId')
        local catalog = LrApplication.activeCatalog()
        local selected = selection(catalog)
        if #selected ~= 1 then U.fail('SELECTION_REQUIRED', 'Select exactly one photo in Lightroom.') end
        local photo = selected[1]
        if photoId(catalog, photo) ~= id then
            U.fail('TARGET_CHANGED', 'The selected Lightroom photo does not match photoId; no selection was changed.')
        end
        if mutation and photo:getRawMetadata('isVirtualCopy') ~= true then
            U.fail('ORIGINAL_PROTECTED', 'Edits and snapshots are permitted only on a virtual copy.')
        end
        if photo:getRawMetadata('isVideo') then U.fail('UNSUPPORTED_FORMAT', 'Video is not supported.') end
        if requireDevelop and LrApplicationView.getCurrentModuleName() ~= 'develop' then
            U.fail('DEVELOP_REQUIRED', 'Open the selected photo in Develop before this operation.')
        end
        return catalog, photo
    end

    local function state(catalog, photo)
        local settings = photo:getDevelopSettings()
        if type(settings) ~= 'table' then U.fail('STATE_UNAVAILABLE', 'Lightroom returned no develop settings.') end
        local id = photoId(catalog, photo)
        return {
            photoId = id,
            settings = settings,
            stateToken = 'md5:' .. U.hash({ photoId = id, settings = settings }),
            stateTokenScope = 'photo identity and getDevelopSettings; excludes opaque AI caches',
            masks = settings.MaskGroupBasedCorrections or U.array(),
            masksAvailable = settings.MaskGroupBasedCorrections ~= nil,
            masksSource = 'getDevelopSettings.MaskGroupBasedCorrections',
        }
    end

    local function expected(catalog, photo, token)
        U.text(token, 'expectedStateToken')
        local current = state(catalog, photo)
        if current.stateToken ~= token then
            U.fail('STALE_STATE', 'Develop settings changed; read_state and review before submitting another edit.')
        end
        return current
    end

    -- Preserve raw SDK values (including absent versus empty fields) before
    -- another SDK call can reuse or mutate the table returned by Lightroom.
    local function freeze(value)
        if type(value) ~= 'table' then return value end
        local copy = {}
        for key, item in pairs(value) do copy[key] = freeze(item) end
        return setmetatable(copy, getmetatable(value))
    end

    local function settingsChanges(before, after)
        local changes = U.array()
        local function visit(left, right, path)
            if U.encode(left) == U.encode(right) then return end
            if type(left) == 'table' and type(right) == 'table'
                and U.encode(left):sub(1, 1) == U.encode(right):sub(1, 1) then
                local keys, seen = {}, {}
                for key in pairs(left) do keys[#keys + 1], seen[key] = key, true end
                for key in pairs(right) do if not seen[key] then keys[#keys + 1] = key end end
                table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
                for _, key in ipairs(keys) do
                    -- JSON Pointer uses zero-based array indices and escaped
                    -- object keys. Presence flags disambiguate omitted values.
                    local segment = type(key) == 'number' and tostring(key - 1)
                        or key:gsub('~', '~0'):gsub('/', '~1')
                    visit(left[key], right[key], path .. '/' .. segment)
                end
            else
                changes[#changes + 1] = { path = path, beforePresent = left ~= nil,
                    afterPresent = right ~= nil, before = freeze(left), after = freeze(right) }
            end
        end
        visit(before, after, '')
        return changes
    end

    local function importDiagnostics(catalog, photo, request)
        -- Bridge validates UUID request IDs before dispatch. Keep that path
        -- invariant here too, since this helper creates immutable evidence.
        if type(request.id) ~= 'string' or #request.id ~= 36 or not request.id:match('^[%x%-]+$') then
            U.fail('INVALID_REQUEST', 'Import diagnostics require the validated request UUID.')
        end
        local directory = LrPathUtils.child(LrPathUtils.child(LrPathUtils.child(config.bridgeDir, 'diagnostics'), 'import-photo'), request.id)
        U.directory(directory)
        local trace = { sequence = 0 }
        local baseline, previous
        function trace.read(phase, guardToken)
            if trace.sequence >= 64 then U.fail('DIAGNOSTIC_LIMIT', 'Import diagnostic readback limit reached; no action was retried.') end
            local current = freeze(state(catalog, photo))
            local capturedAt = U.now()
            trace.sequence = trace.sequence + 1
            if not baseline then baseline = current; trace.baselineToken = current.stateToken
            else guardToken = guardToken or baseline.stateToken end
            local selectedIds = U.array()
            for _, selectedPhoto in ipairs(selection(catalog)) do selectedIds[#selectedIds + 1] = photoId(catalog, selectedPhoto) end
            U.writeJson(LrPathUtils.child(directory, string.format('%04d.json', trace.sequence)), {
                version = 1, operation = 'import_photo', requestId = request.id,
                requestIssuedAt = request.issuedAt, requestDeadlineAt = request.deadlineAt,
                sequence = trace.sequence, phase = phase, capturedAt = capturedAt,
                photo = describe(catalog, photo), photoId = current.photoId,
                module = LrApplicationView.getCurrentModuleName(), selectedPhotoIds = selectedIds,
                state = current, baselineStateToken = baseline.stateToken, guardStateToken = guardToken,
                previousSequence = previous and trace.sequence - 1 or nil,
                changesFromPrevious = previous and settingsChanges(previous.settings, current.settings) or U.array(),
                changesFromBaseline = settingsChanges(baseline.settings, current.settings),
                interpretation = 'Native readback evidence only; no normalization, settling, retry, or acceptance tolerance.',
            })
            previous = current
            -- Persist the mismatching readback before retaining the original
            -- strict failure. Diagnostic writes never authorize a new baseline.
            if guardToken and current.stateToken ~= guardToken then
                U.fail('STALE_STATE', 'Develop settings changed; read_state and review before submitting another edit.')
            end
            return current
        end
        return trace
    end

    local function correction(settings, id)
        for _, value in ipairs(settings.MaskGroupBasedCorrections or {}) do
            if value.CorrectionID == id then return value end
        end
        U.fail('MASK_NOT_FOUND', 'The selected mask ID is not an existing correction group on this photo.')
    end

    local function maskContext(id, settings)
        if LrDevelopController.getSelectedTool() ~= 'masking' then
            U.fail('MASKING_REQUIRED', 'Open Masking and select the existing mask before this operation.')
        end
        local selectedId = LrDevelopController.getSelectedMask()
        if type(selectedId) ~= 'string' or selectedId == '' then
            U.fail('MASK_SELECTION_REQUIRED', 'Select an existing mask in Lightroom.')
        end
        if id and selectedId ~= id then
            U.fail('MASK_TARGET_CHANGED', 'The selected mask does not match maskId; no mask selection was changed.')
        end
        correction(settings, selectedId)
        local parameters = {}
        for key in pairs(localSettings) do
            local minimum, maximum = LrDevelopController.getRange(key)
            local value = LrDevelopController.getValue(key)
            if not U.finite(minimum) or not U.finite(maximum) or minimum >= maximum or not U.finite(value) then
                U.fail('UNSUPPORTED_PARAMETER', 'Lightroom did not provide a numeric value and range for ' .. key)
            end
            parameters[key] = { value = value, min = minimum, max = maximum }
        end
        -- SDK documentation has an inconsistent return-type annotation for this
        -- optional component identity. It is diagnostic, never a target guard.
        local toolId = LrDevelopController.getSelectedMaskTool()
        if type(toolId) ~= 'string' and type(toolId) ~= 'boolean' then toolId = nil end
        return { selectedMaskId = selectedId, selectedMaskToolId = toolId,
            parameters = parameters, valueUnits = 'LrDevelopController native' }
    end

    local function excludingMaskParameter(settings, id, rawKey)
        local copy = U.json.decode(U.encode(settings))
        correction(copy, id)[rawKey] = nil
        return U.hash(copy)
    end

    local function excludingSettings(settings, keys)
        local copy = U.json.decode(U.encode(settings))
        for key in pairs(keys) do copy[key] = nil end
        return U.hash(copy)
    end

    local function maskCreationAvailable()
        return type(LrDevelopController.createNewMask) == 'function'
            and type(LrDevelopController.selectTool) == 'function'
            and type(LrDevelopController.getSelectedMask) == 'function'
            and type(LrDevelopController.getSelectedMaskTool) == 'function'
    end

    local function openMasking(catalog, photo, before, request)
        U.checkDeadline(request)
        if LrDevelopController.getSelectedTool() ~= 'masking' then
            if type(LrDevelopController.selectTool) ~= 'function' then
                U.fail('UNSUPPORTED', 'Native mask panel selection is unavailable.')
            end
            target(before.photoId, true, true)
            expected(catalog, photo, before.stateToken)
            request._mutationStarted = true -- UI selection can itself complete after a timeout.
            LrDevelopController.selectTool('masking')
        end
        local openUntil = math.min(request.deadlineAt, U.now() + 3000)
        repeat
            U.checkDeadline(request)
            target(before.photoId, true, true)
            expected(catalog, photo, before.stateToken)
            if LrDevelopController.getSelectedTool() == 'masking' then return end
            if U.now() >= openUntil then U.fail('MASKING_REQUIRED', 'Lightroom did not open Masking; no mask edit was applied.') end
            LrTasks.sleep(0.1)
        until false
    end

    local function selectExistingMask(params, request, openPanel)
        local id = U.text(params.maskId, 'maskId')
        local catalog, photo = target(params.photoId, true, true)
        local before = expected(catalog, photo, params.expectedStateToken)
        correction(before.settings, id)
        U.checkDeadline(request)
        if openPanel then openMasking(catalog, photo, before, request) end
        if LrDevelopController.getSelectedTool() ~= 'masking' then
            U.fail('MASKING_REQUIRED', 'Open the Masking panel before selecting an existing mask.')
        end
        if LrDevelopController.getSelectedMask() ~= id then
            target(params.photoId, true, true)
            expected(catalog, photo, before.stateToken)
            -- Changes only the local tool selection, never the selected photo.
            U.checkDeadline(request)
            request._mutationStarted = true
            LrDevelopController.selectMask(id)
        end
        local untilTime = math.min(request.deadlineAt, U.now() + 3000)
        repeat
            U.checkDeadline(request)
            target(params.photoId, true, true)
            expected(catalog, photo, before.stateToken)
            if LrDevelopController.getSelectedTool() ~= 'masking' then
                U.fail('MASKING_REQUIRED', 'Masking tool closed while selecting the mask.')
            end
            if LrDevelopController.getSelectedMask() == id then
                return catalog, photo, before, maskContext(id, before.settings)
            end
            if U.now() >= untilTime then break end
            LrTasks.sleep(0.1)
        until false
        U.fail('MASK_TARGET_CHANGED', 'Lightroom did not select the requested existing mask; no adjustment was applied.')
    end

    local function rawOnly(photo)
        local format = photo:getRawMetadata('fileFormat')
        if format ~= 'RAW' and format ~= 'DNG' then
            U.fail('UNSUPPORTED_FORMAT', 'This first version edits only RAW or DNG photos.')
        end
    end

    local function available(photo)
        if not photo:checkPhotoAvailability() then
            U.fail('ORIGINAL_UNAVAILABLE', 'The original RAW is unavailable; Smart Preview-only editing is not enabled.')
        end
    end

    local function write(catalog, request, name, action)
        U.checkDeadline(request)
        local timeout = math.min(3, math.max(0.01, (request.deadlineAt - U.now()) / 1000))
        local status = catalog:withWriteAccessDo(name, function()
            U.checkDeadline(request)
            action()
        end, { timeout = timeout, asynchronous = false })
        if status ~= 'executed' then U.fail('CATALOG_BUSY', 'Lightroom did not execute the catalog write.') end
    end

    local function checkpointPath(id, snapshotId)
        return LrPathUtils.child(config.checkpoints, LrMD5.digest(id .. '\n' .. snapshotId) .. '.json')
    end

    local function importPath(params)
        local path = U.text(params.path, 'path', 2048)
        local filename = U.text(params.filename, 'filename', 255)
        if filename:find('[/\\]') or filename:find('[%z\1-\31\127]')
            or filename:sub(1, 1) == '.' or filename:find('..', 1, true) then
            U.fail('INVALID_IMPORT_PATH', 'filename must be a basename without separators, control characters, a leading period, or consecutive periods.')
        end
        local root = config.importRoot
        if type(root) ~= 'string' or path:sub(1, #root + 1) ~= root .. '/' then
            U.fail('INVALID_IMPORT_PATH', 'Uploaded RAW path must be beneath the configured importRoot.')
        end
        local relative = path:sub(#root + 2)
        local directory, leaf = relative:match('^([^/]+)/([^/]+)$')
        local a, b, c, d, e
        if directory then a, b, c, d, e = directory:match('^(%x+)%-(%x+)%-(%x+)%-(%x+)%-(%x+)$') end
        if not a or #a ~= 8 or #b ~= 4 or #c ~= 4 or #d ~= 4 or #e ~= 12 or leaf ~= filename then
            U.fail('INVALID_IMPORT_PATH', 'Uploaded RAW path must be importRoot/UUID/filename with an exact filename match.')
        end
        local extension = filename:match('%.([A-Za-z0-9]+)$')
        if not extension or not importExtensionSet[extension:lower()] then
            U.fail('UNSUPPORTED_FORMAT', 'Only the listed camera RAW and DNG filename extensions may be imported.')
        end
        if LrFileUtils.exists(path) ~= 'file' then
            U.fail('IMPORT_FILE_MISSING', 'The uploaded RAW file does not exist.')
        end
        -- The SDK resolves aliases/shortcuts in every component. It exposes no
        -- documented lstat/no-follow primitive: the upload server must also
        -- reject Unix symlinks when creating and validating its private files.
        if LrFileUtils.resolveAllAliases(root) ~= root or LrFileUtils.resolveAllAliases(path) ~= path then
            U.fail('INVALID_IMPORT_PATH', 'Aliases or redirected import paths are not permitted.')
        end
        local attrs = LrFileUtils.fileAttributes(path)
        if type(attrs) ~= 'table' or not U.finite(attrs.fileSize) or attrs.fileSize <= 0 then
            U.fail('IMPORT_FILE_EMPTY', 'The uploaded RAW must be a nonempty file.')
        end
        return path
    end

    local function sameCatalog(catalog)
        if LrApplication.activeCatalog():getPath() ~= catalog:getPath() then
            U.fail('TARGET_CHANGED', 'The active Lightroom catalog changed during the operation.')
        end
    end

    local function developSelected(catalog, photo, request, trace)
        local id = photoId(catalog, photo)
        target(id, false, false)
        local before = trace and trace.read('before-develop', trace.baselineToken) or state(catalog, photo)
        U.checkDeadline(request)
        if LrApplicationView.getCurrentModuleName() ~= 'develop' then
            request._mutationStarted = true -- UI action; its outcome is uncertain on timeout.
            LrApplicationView.switchToModule('develop')
        end
        if trace then trace.read('after-develop-request') end
        local untilTime = math.min(request.deadlineAt, U.now() + 5000)
        repeat
            U.checkDeadline(request)
            target(id, false, false)
            if trace then trace.read('develop-completion-guard', before.stateToken)
            else expected(catalog, photo, before.stateToken) end
            if LrApplicationView.getCurrentModuleName() == 'develop' then
                U.checkDeadline(request)
                if trace then trace.read('completion-guard', trace.baselineToken); U.checkDeadline(request) end
                target(id, false, true)
                return describe(catalog, photo)
            end
            if U.now() >= untilTime then break end
            LrTasks.sleep(0.1)
        until false
        U.fail('REVEAL_UNVERIFIED', 'Lightroom did not enter Develop; inspect its current selection and module.')
    end

    function O.capabilities(params)
        U.keys(params, {})
        return {
            protocolVersion = 1, pluginVersion = U.version,
            lightroomVersion = LrApplication.versionString(),
            bridgeDir = config.bridgeDir, exportRoot = config.exportRoot, importRoot = config.importRoot,
            operations = { capabilities = true, selected = true, create_working_copy = true,
                read_state = true, checkpoint = true, apply = true, restore = true, render = true,
                selected_mask = true, select_mask = true, create_subject_mask = maskCreationAvailable(),
                create_background_mask = maskCreationAvailable(), adjust_mask = true,
                auto_tone = type(LrDevelopController.setAutoTone) == 'function',
                import_photo = true, reveal_photo = true },
            importExtensions = importExtensions, importPathLayout = 'importRoot/UUID/safe-filename.ext',
            importDiagnostics = { enabled = true, immutable = true, maxReadbacks = 64,
                directory = LrPathUtils.child(LrPathUtils.child(config.bridgeDir, 'diagnostics'), 'import-photo'),
                settings = 'full native getDevelopSettings', changes = 'JSON Pointer with explicit presence flags',
                timingImpact = 'Synchronous evidence writes may affect observation timing; preserve the installed plug-in hash.' },
            numericAdjustments = numericRanges, stringAdjustments = { WhiteBalance = U.array({ 'Custom' }) },
            localAdjustments = { local_Exposure = 'dynamic: selected_mask.parameters.local_Exposure',
                local_Texture = 'dynamic: selected_mask.parameters.local_Texture' },
            liveValidated = false,
            maskCreation = { implemented = true, runtimeAvailable = maskCreationAvailable(),
                liveValidated = false, completion = 'stored-and-selected',
                pixelCoverageVerified = false, rollbackVerified = false },
            renderFormats = { JPEG = { extension = 'jpg', bitDepth = 8, lossless = false },
                TIFF = { extension = 'tif', bitDepth = 16, lossless = true } },
            restrictions = U.array({
                'Exactly one selected matching photo is required for target operations.',
                'Uploaded RAW import is restricted to importRoot; it adds or finds an original, selects it, and enters Develop without applying edits.',
                'The upload server must reject Unix symlinks; the SDK additionally rejects paths redirected by its alias resolver.',
                'Photo mutations require a virtual copy; global editing requires RAW or DNG.',
                'Native snapshot restore requires Develop and a checkpoint created by this bridge.',
                'Mask creation observes new stored group/component identities; rendered mask coverage and restoration require separate validation.',
                'Existing-mask exposure/texture require Develop with Masking open. Denoise is not enabled.',
                'Auto tone requires a virtual RAW/DNG in Develop; unrelated settings must remain identical.',
                'Mask values use native DevelopController units; inspect selected_mask before adjusting.',
                'State tokens cover SDK settings, not every opaque AI dependency.',
                'Native restoration verifies settings; the caller must also compare rendered pixels.',
            }),
        }
    end

    function O.selected(params)
        U.keys(params, {})
        local catalog = LrApplication.activeCatalog()
        local photos = U.array()
        for _, photo in ipairs(selection(catalog)) do photos[#photos + 1] = describe(catalog, photo) end
        return { photos = photos, count = #photos, photoId = #photos == 1 and photos[1].photoId or nil }
    end

    function O.import_photo(params, request)
        U.keys(params, { path = true, filename = true })
        local path = importPath(params)
        local catalog = LrApplication.activeCatalog()
        U.checkDeadline(request)
        local photo = catalog:findPhotoByPath(path)
        if not photo then
            write(catalog, request, 'Raw Photo Agent import uploaded RAW', function()
                sameCatalog(catalog)
                importPath(params)
                -- Recheck inside the write gate to avoid a duplicate import if
                -- another action imported this exact path while we waited.
                photo = catalog:findPhotoByPath(path)
                if not photo then
                    U.checkDeadline(request)
                    request._mutationStarted = true
                    photo = catalog:addPhoto(path)
                end
            end)
        end
        sameCatalog(catalog)
        if not photo or photo:getRawMetadata('isVirtualCopy') == true
            or photo:getRawMetadata('path') ~= path then
            U.fail('IMPORT_UNVERIFIED', 'The imported catalog entry could not be verified as the requested original.')
        end
        rawOnly(photo)
        available(photo)
        importPath(params)
        local trace = importDiagnostics(catalog, photo, request)
        local before = trace.read('before-selection')
        U.checkDeadline(request)
        sameCatalog(catalog)
        request._mutationStarted = true -- Selection is part of the requested action.
        catalog:setSelectedPhotos(photo, {})
        trace.read('after-selection-request')
        local id = photoId(catalog, photo)
        local untilTime = math.min(request.deadlineAt, U.now() + 5000)
        repeat
            U.checkDeadline(request)
            sameCatalog(catalog)
            local selected = selection(catalog)
            if #selected == 1 and photoId(catalog, selected[1]) == id then
                trace.read('selection-completion-guard', before.stateToken)
                return developSelected(catalog, photo, request, trace)
            end
            if U.now() >= untilTime then break end
            LrTasks.sleep(0.1)
        until false
        U.fail('IMPORT_UNVERIFIED', 'Lightroom did not select exactly the imported original; inspect the catalog before retrying.')
    end

    function O.reveal_photo(params, request)
        U.keys(params, { photoId = true })
        local catalog, photo = target(params.photoId, false, false)
        rawOnly(photo)
        available(photo)
        return developSelected(catalog, photo, request)
    end

    function O.read_state(params)
        U.keys(params, { photoId = true })
        local catalog, photo = target(params.photoId, false, false)
        return state(catalog, photo)
    end

    function O.selected_mask(params)
        U.keys(params, { photoId = true, maskId = true })
        if params.maskId ~= nil then U.text(params.maskId, 'maskId') end
        local catalog, photo = target(params.photoId, false, true)
        local before = state(catalog, photo)
        local context = maskContext(params.maskId, before.settings)
        target(params.photoId, false, true)
        local after = expected(catalog, photo, before.stateToken)
        if LrDevelopController.getSelectedMask() ~= context.selectedMaskId then
            U.fail('MASK_TARGET_CHANGED', 'Mask selection changed while reading its controls.')
        end
        return { state = after, maskContext = context }
    end

    function O.select_mask(params, request)
        U.keys(params, { photoId = true, expectedStateToken = true, maskId = true })
        local _, _, current, context = selectExistingMask(params, request, true)
        return { state = current, maskContext = context }
    end

    function O.create_working_copy(params, request)
        U.keys(params, { photoId = true, copyName = true })
        local catalog, source = target(params.photoId, false, false)
        rawOnly(source)
        available(source)
        local name = U.text(params.copyName, 'copyName', 160)
        local original = state(catalog, source)
        U.checkDeadline(request)
        target(params.photoId, false, false)
        -- SDK requires an async task, not an enclosing write-access transaction.
        request._mutationStarted = true
        local copies = catalog:createVirtualCopies(name)
        if type(copies) ~= 'table' or #copies ~= 1 then
            U.fail('VERIFY_FAILED', 'Expected exactly one new virtual copy; inspect Lightroom before retrying.')
        end
        local copy = copies[1]
        local id = photoId(catalog, copy)
        if id == params.photoId or copy:getRawMetadata('isVirtualCopy') ~= true
            or copy:getRawMetadata('path') ~= source:getRawMetadata('path') then
            U.fail('VERIFY_FAILED', 'New virtual copy identity did not match its source.')
        end
        -- The SDK can return the new copy before its selection is observable.
        -- Only observe that one creation: never reselect or create another copy.
        -- Waiting is permitted while the exact source remains selected; any
        -- other selection or settings change is an uncertain outcome, not a retry.
        local untilTime = math.min(request.deadlineAt, U.now() + 5000)
        repeat
            U.checkDeadline(request)
            sameCatalog(catalog)
            if state(catalog, source).stateToken ~= original.stateToken then
                U.fail('VERIFY_FAILED', 'The source state changed while creating the copy; inspect Lightroom.')
            end
            local copyState = state(catalog, copy)
            if U.hash(copyState.settings) ~= U.hash(original.settings) then
                U.fail('VERIFY_FAILED', 'The new copy settings differ from the source; inspect Lightroom.')
            end
            local selected = selection(catalog)
            if #selected ~= 1 then
                U.fail('SELECTION_REQUIRED', 'Selection changed while waiting for the new copy; inspect Lightroom before recovery.')
            end
            local selectedId = photoId(catalog, selected[1])
            if selectedId == id then
                target(id, true, false)
                U.checkDeadline(request)
                return { photoId = id, sourcePhotoId = params.photoId, photo = describe(catalog, copy), state = copyState }
            end
            if selectedId ~= params.photoId then
                U.fail('TARGET_CHANGED', 'Another photo was selected while waiting for the new copy; no selection was changed.')
            end
            if U.now() >= untilTime then break end
            LrTasks.sleep(0.1)
        until false
        U.fail('COPY_SELECTION_UNVERIFIED', 'The new copy was created but its selection did not verify; inspect Lightroom before recovery. No retry was attempted.')
    end

    function O.checkpoint(params, request)
        U.keys(params, { photoId = true, name = true })
        local catalog, photo = target(params.photoId, true, false)
        local name = U.text(params.name, 'name', 160) .. ' [RPA ' .. request.id .. ']'
        local before = state(catalog, photo)
        write(catalog, request, 'Raw Photo Agent checkpoint', function()
            target(params.photoId, true, false)
            expected(catalog, photo, before.stateToken)
            request._mutationStarted = true
            if not photo:createDevelopSnapshot(name, false) then
                U.fail('SNAPSHOT_FAILED', 'Lightroom did not create a new snapshot.')
            end
        end)
        target(params.photoId, true, false)
        local snapshotId
        for _, snapshot in pairs(photo:getDevelopSnapshots()) do
            if snapshot.name == name then snapshotId = tostring(snapshot.snapshotID) end
        end
        if not snapshotId or snapshotId == 'nil' then
            U.fail('SNAPSHOT_FAILED', 'The newly created native snapshot could not be resolved.')
        end
        local after = state(catalog, photo)
        if after.stateToken ~= before.stateToken then
            U.fail('VERIFY_FAILED', 'Develop state changed during checkpoint creation; do not use this checkpoint.')
        end
        U.writeJson(checkpointPath(params.photoId, snapshotId), {
            photoId = params.photoId, snapshotId = snapshotId, name = name, state = after,
            createdAt = U.now(), lightroomVersion = LrApplication.versionString(),
        })
        return { snapshotId = snapshotId, name = name, state = after }
    end

    function O.apply(params, request)
        U.keys(params, { photoId = true, expectedStateToken = true, adjustments = true })
        local catalog, photo = target(params.photoId, true, false)
        rawOnly(photo)
        available(photo)
        local before = expected(catalog, photo, params.expectedStateToken)
        if type(params.adjustments) ~= 'table' or next(params.adjustments) == nil then
            U.fail('INVALID_PARAMS', 'adjustments must be a nonempty object.')
        end
        local values = {}
        for key, value in pairs(params.adjustments) do
            local range = numericRanges[key]
            if key == 'WhiteBalance' and value == 'Custom' then
                values[key] = value
            elseif range and U.finite(value) and value >= range[1] and value <= range[2] then
                if type(before.settings[key]) ~= 'number' then
                    U.fail('UNSUPPORTED_PARAMETER', key .. ' is not a numeric setting on the selected RAW/process version.')
                end
                values[key] = value
            else
                U.fail('INVALID_ADJUSTMENT', 'Unsupported adjustment or out-of-range value: ' .. tostring(key))
            end
        end
        if values.Temperature or values.Tint then values.WhiteBalance = 'Custom' end
        write(catalog, request, 'Raw Photo Agent adjustments', function()
            target(params.photoId, true, false)
            expected(catalog, photo, params.expectedStateToken)
            request._mutationStarted = true
            photo:applyDevelopSettings(values, 'Raw Photo Agent ' .. request.id, true)
        end)
        target(params.photoId, true, false)
        local after = state(catalog, photo)
        for key, value in pairs(values) do
            local observed = after.settings[key]
            local matches = type(value) == 'number' and type(observed) == 'number'
                and math.abs(observed - value) <= 0.0001 or observed == value
            if not matches then
                U.fail('VERIFY_FAILED', key .. ' did not read back as requested. The edit may have applied; inspect read_state before recovery.')
            end
        end
        return { state = after, appliedAdjustments = values }
    end

    function O.restore(params, request)
        U.keys(params, { photoId = true, snapshotId = true, expectedStateToken = true })
        local catalog, photo = target(params.photoId, true, true)
        expected(catalog, photo, params.expectedStateToken)
        local id = U.text(params.snapshotId, 'snapshotId')
        local recordPath = checkpointPath(params.photoId, id)
        if not LrFileUtils.exists(recordPath) then
            U.fail('SNAPSHOT_NOT_FOUND', 'Only checkpoints recorded by this bridge can be restored and verified.')
        end
        local record = U.readJson(recordPath)
        if record.photoId ~= params.photoId or record.snapshotId ~= id or type(record.state) ~= 'table' then
            U.fail('SNAPSHOT_MISMATCH', 'Checkpoint record does not match this photo.')
        end
        local nativeId
        for _, snapshot in pairs(photo:getDevelopSnapshots()) do
            if tostring(snapshot.snapshotID) == id and snapshot.name == record.name then nativeId = snapshot.snapshotID end
        end
        if not nativeId then U.fail('SNAPSHOT_NOT_FOUND', 'The recorded native snapshot no longer exists.') end
        write(catalog, request, 'Raw Photo Agent restore', function()
            target(params.photoId, true, true)
            expected(catalog, photo, params.expectedStateToken)
            request._mutationStarted = true
            photo:applyDevelopSnapshot(nativeId)
        end)
        -- A native snapshot may refresh asynchronously. Observe without issuing
        -- additional writes; never blindly retry or fall back to slider replay.
        local after
        local untilTime = math.min(request.deadlineAt, U.now() + 5000)
        repeat
            target(params.photoId, true, true)
            after = state(catalog, photo)
            if after.stateToken == record.state.stateToken then
                return { state = after, snapshotId = id, settingsVerified = true, renderComparisonRequired = true }
            end
            if U.now() >= untilTime then break end
            LrTasks.sleep(0.1)
        until false
        U.fail('RESTORE_UNVERIFIED', 'Snapshot was invoked but saved settings were not recovered. Inspect Lightroom and read_state; no fallback write was attempted.')
    end

    function O.render(params, request)
        U.keys(params, { photoId = true, expectedStateToken = true, outputPath = true, maxEdge = true, format = true })
        local catalog, photo = target(params.photoId, false, false)
        available(photo)
        local before = expected(catalog, photo, params.expectedStateToken)
        local format = params.format or 'JPEG'
        if format ~= 'JPEG' and format ~= 'TIFF' then U.fail('INVALID_PARAMS', 'format must be JPEG or TIFF.') end
        local extension = format == 'TIFF' and 'tif' or 'jpg'
        local output = U.text(params.outputPath, 'outputPath', 2048)
        local basename = output:sub(#config.exportRoot + 2)
        if output:sub(1, #config.exportRoot + 1) ~= config.exportRoot .. '/'
            or not basename:match('^[A-Za-z0-9][A-Za-z0-9._-]*%.' .. extension .. '$')
            or basename:find('..', 1, true) then
            U.fail('INVALID_OUTPUT_PATH', 'outputPath must be a safe .' .. extension .. ' filename directly within exportRoot.')
        end
        if LrFileUtils.resolveAllAliases(config.exportRoot) ~= config.exportRoot
            or LrFileUtils.resolveAllAliases(output) ~= output then
            U.fail('INVALID_OUTPUT_PATH', 'Aliases or redirected export paths are not permitted.')
        end
        if LrFileUtils.exists(output) then U.fail('FILE_EXISTS', 'Render output already exists; use a unique filename.') end
        local edge = params.maxEdge or 2048
        if not U.finite(edge) or edge ~= math.floor(edge) or edge < 256 or edge > 8192 then
            U.fail('INVALID_PARAMS', 'maxEdge must be an integer from 256 to 8192.')
        end
        local scratch = LrPathUtils.child(config.scratch, request.id)
        U.directory(scratch)
        U.checkDeadline(request)
        target(params.photoId, false, false)
        expected(catalog, photo, before.stateToken)
        local session = LrExportSession({
            photosToExport = { photo },
            exportSettings = {
                LR_exportServiceProvider = 'com.adobe.ag.export.file',
                LR_export_destinationType = 'specificFolder',
                LR_export_destinationPathPrefix = scratch, LR_export_useSubfolder = false,
                LR_collisionHandling = 'skip', LR_reimportExportedPhoto = false,
                LR_renamingTokensOn = true, LR_tokens = '{{custom_token}}',
                LR_tokenCustomString = request.id, LR_extensionCase = 'lowercase',
                LR_format = format, LR_jpeg_quality = 0.9, LR_jpeg_useLimitSize = false,
                LR_tiff_bitDepth = 16, LR_tiff_compressionMethod = 'compressionMethod_None',
                LR_export_colorSpace = 'sRGB',
                LR_size_doConstrain = true, LR_size_doNotEnlarge = true,
                LR_size_resizeType = 'longEdge', LR_size_maxHeight = edge, LR_size_maxWidth = edge,
                LR_size_units = 'pixels', LR_size_resolution = 72, LR_size_resolutionUnits = 'inch',
                LR_outputSharpeningOn = false, LR_useWatermark = false,
                LR_minimizeEmbeddedMetadata = true, LR_embeddedMetadataOption = 'copyrightOnly',
                LR_removeLocationMetadata = true,
            },
        })
        local renderedPath, count = nil, 0
        for _, rendition in session:renditions({ stopIfCanceled = false }) do
            count = count + 1
            local ok, pathOrError = rendition:waitForRender()
            if not ok or rendition.wasSkipped then
                U.fail('RENDER_FAILED', tostring(pathOrError or 'Lightroom skipped the render.'))
            end
            renderedPath = pathOrError
        end
        if count ~= 1 or not renderedPath or LrFileUtils.exists(renderedPath) ~= 'file' then
            U.fail('RENDER_FAILED', 'Lightroom did not produce exactly one complete image.')
        end
        target(params.photoId, false, false)
        expected(catalog, photo, before.stateToken)
        local attrs = LrFileUtils.fileAttributes(renderedPath)
        if not attrs.fileSize or attrs.fileSize <= 0 then U.fail('RENDER_FAILED', 'Lightroom produced an empty image.') end
        local ok, reason = LrFileUtils.move(renderedPath, output)
        if not ok then U.fail('IO_ERROR', 'Cannot publish completed render: ' .. tostring(reason)) end
        return { outputPath = output, photoId = params.photoId, stateToken = before.stateToken,
            maxEdge = edge, colorSpace = 'sRGB', format = format,
            bitDepth = format == 'TIFF' and 16 or 8, outputSharpening = false, bytes = attrs.fileSize }
    end

    local function createMask(params, request, kind)
        U.keys(params, { photoId = true, expectedStateToken = true })
        if not maskCreationAvailable() then U.fail('UNSUPPORTED', 'Required native mask APIs are unavailable.') end
        local catalog, photo = target(params.photoId, true, true)
        rawOnly(photo)
        available(photo)
        local before = expected(catalog, photo, params.expectedStateToken)
        local existing, existingCount = {}, 0
        for _, group in ipairs(before.settings.MaskGroupBasedCorrections or {}) do
            if type(group.CorrectionID) ~= 'string' or group.CorrectionID == '' or existing[group.CorrectionID] then
                U.fail('STATE_UNAVAILABLE', 'Existing mask groups have missing or duplicate identities.')
            end
            existing[group.CorrectionID], existingCount = U.hash(group), existingCount + 1
        end
        local ignored = { MaskGroupBasedCorrections = true }
        -- Creating the first mask can introduce/enable the mask collection. An
        -- existing disabled collection must not silently be enabled as a side effect.
        if existingCount == 0 then ignored.EnableMaskGroupBasedCorrections = true end
        local protectedHash = excludingSettings(before.settings, ignored)
        openMasking(catalog, photo, before, request)
        U.checkDeadline(request)
        target(params.photoId, true, true)
        expected(catalog, photo, before.stateToken)
        request._mutationStarted = true
        LrDevelopController.createNewMask('aiSelection', kind)
        local untilTime = math.min(request.deadlineAt, U.now() + 30000)
        local stableToken, stableSince
        repeat
            U.checkDeadline(request)
            target(params.photoId, true, true)
            local after = state(catalog, photo)
            if excludingSettings(after.settings, ignored) ~= protectedHash then
                U.fail('VERIFY_FAILED', 'A setting outside the new mask changed; inspect state before recovery.')
            end
            local added, seen = nil, {}
            for _, group in ipairs(after.settings.MaskGroupBasedCorrections or {}) do
                local groupId = group.CorrectionID
                if type(groupId) ~= 'string' or groupId == '' or seen[groupId] then
                    U.fail('VERIFY_FAILED', 'Mask creation produced missing or duplicate group identities.')
                end
                seen[groupId] = true
                if existing[groupId] then
                    if U.hash(group) ~= existing[groupId] then
                        U.fail('VERIFY_FAILED', 'An existing mask changed while creating the new mask.')
                    end
                elseif added then
                    U.fail('VERIFY_FAILED', 'More than one new mask appeared; inspect state before recovery.')
                else
                    added = group
                end
            end
            for groupId in pairs(existing) do
                if not seen[groupId] then U.fail('VERIFY_FAILED', 'An existing mask disappeared during creation.') end
            end
            if LrDevelopController.getSelectedTool() ~= 'masking' then
                U.fail('MASK_TARGET_CHANGED', 'Masking closed during mask creation; inspect Lightroom before recovery.')
            end
            local selectedId, componentId = LrDevelopController.getSelectedMask(), LrDevelopController.getSelectedMaskTool()
            local componentFound = false
            if added and selectedId == added.CorrectionID and type(componentId) == 'string' and componentId ~= '' then
                for _, component in ipairs(added.CorrectionMasks or {}) do
                    if component.MaskID == componentId then componentFound = true end
                end
            end
            if componentFound then
                -- SDK exposes no documented AI-completion callback. Require
                -- saved group/component identity plus a stable readback window,
                -- then let the caller validate rendered coverage and rollback.
                if stableToken ~= after.stateToken then stableToken, stableSince = after.stateToken, U.now() end
                if U.now() - stableSince >= 300 then
                    local context = maskContext(added.CorrectionID, after.settings)
                    target(params.photoId, true, true)
                    expected(catalog, photo, after.stateToken)
                    U.checkDeadline(request)
                    if LrDevelopController.getSelectedTool() ~= 'masking'
                        or LrDevelopController.getSelectedMask() ~= added.CorrectionID
                        or LrDevelopController.getSelectedMaskTool() ~= componentId then
                        U.fail('MASK_TARGET_CHANGED', 'Mask selection changed while verifying its controls.')
                    end
                    return { state = after, maskId = added.CorrectionID, maskKind = kind,
                        maskContext = context, completion = 'stored-and-selected',
                        pixelCoverageVerified = false, renderComparisonRequired = true }
                end
            else
                stableToken, stableSince = nil, nil
            end
            if U.now() >= untilTime then break end
            LrTasks.sleep(0.1)
        until false
        U.fail('MASK_CREATION_UNVERIFIED', 'A new stored and selected mask/component did not verify; inspect read_state before recovery. No retry was attempted.')
    end

    function O.create_subject_mask(params, request) return createMask(params, request, 'subject') end
    function O.create_background_mask(params, request) return createMask(params, request, 'background') end

    function O.auto_tone(params, request)
        U.keys(params, { photoId = true, expectedStateToken = true })
        if type(LrDevelopController.setAutoTone) ~= 'function' then U.fail('UNSUPPORTED', 'Native Auto Tone is unavailable.') end
        local catalog, photo = target(params.photoId, true, true)
        rawOnly(photo)
        available(photo)
        local before = expected(catalog, photo, params.expectedStateToken)
        for key in pairs(autoToneSettings) do
            if numericRanges[key] and not U.finite(before.settings[key]) then
                U.fail('UNSUPPORTED_PARAMETER', 'Auto Tone requires modern numeric tone settings: ' .. key)
            end
        end
        local protectedHash = excludingSettings(before.settings, autoToneSettings)
        U.checkDeadline(request)
        target(params.photoId, true, true)
        expected(catalog, photo, before.stateToken)
        request._mutationStarted = true
        LrDevelopController.setAutoTone()
        local untilTime = math.min(request.deadlineAt, U.now() + 10000)
        local stableToken, stableSince
        repeat
            U.checkDeadline(request)
            target(params.photoId, true, true)
            local after = state(catalog, photo)
            if excludingSettings(after.settings, autoToneSettings) ~= protectedHash then
                U.fail('VERIFY_FAILED', 'Auto Tone changed a setting outside its allowed tone controls; inspect state before recovery.')
            end
            if after.stateToken ~= before.stateToken then
                if stableToken ~= after.stateToken then stableToken, stableSince = after.stateToken, U.now() end
                if U.now() - stableSince >= 300 then
                    local changed = {}
                    for key in pairs(autoToneSettings) do
                        local value = after.settings[key]
                        if numericRanges[key] and not U.finite(value) then
                            U.fail('VERIFY_FAILED', 'Auto Tone returned a nonnumeric tone control: ' .. key)
                        end
                        if value ~= before.settings[key] then changed[key] = value end
                    end
                    return { state = after, changedSettings = changed, renderComparisonRequired = true }
                end
            else
                stableToken, stableSince = nil, nil
            end
            if U.now() >= untilTime then break end
            LrTasks.sleep(0.1)
        until false
        U.fail('AUTO_TONE_UNVERIFIED', 'Auto Tone was invoked but no stable changed tone state was observed; inspect Lightroom before recovery.')
    end

    function O.adjust_mask(params, request)
        U.keys(params, { photoId = true, expectedStateToken = true, maskId = true, adjustments = true })
        local id = U.text(params.maskId, 'maskId')
        local catalog, photo = target(params.photoId, true, true)
        rawOnly(photo)
        available(photo)
        local current = expected(catalog, photo, params.expectedStateToken)
        if type(params.adjustments) ~= 'table' or next(params.adjustments) == nil then
            U.fail('INVALID_PARAMS', 'adjustments must be a nonempty object.')
        end
        -- Reject unsupported names/non-numbers before changing even tool selection.
        for key, value in pairs(params.adjustments) do
            if not localSettings[key] or not U.finite(value) then
                U.fail('INVALID_ADJUSTMENT', 'Unsupported local adjustment: ' .. tostring(key))
            end
        end
        local _, _, selectedState, context = selectExistingMask(params, request)
        current = selectedState
        local keys = {}
        for key, value in pairs(params.adjustments) do
            local range = context.parameters[key]
            if not localSettings[key] or not range or not U.finite(value)
                or value < range.min or value > range.max then
                U.fail('INVALID_ADJUSTMENT', 'Unsupported local adjustment or value outside its native range: ' .. tostring(key))
            end
            if not U.finite(correction(current.settings, id)[localSettings[key]]) then
                U.fail('UNSUPPORTED_PARAMETER', 'The existing mask has no numeric ' .. localSettings[key] .. ' setting.')
            end
            keys[#keys + 1] = key
        end
        table.sort(keys)
        for _, key in ipairs(keys) do
            U.checkDeadline(request)
            target(params.photoId, true, true)
            expected(catalog, photo, current.stateToken)
            local beforeContext = maskContext(id, current.settings)
            for nativeKey, parameter in pairs(context.parameters) do
                if math.abs(beforeContext.parameters[nativeKey].value - parameter.value) > 0.0001 then
                    U.fail('STALE_STATE', 'Native mask controls changed before the adjustment.')
                end
            end
            local value, rawKey = params.adjustments[key], localSettings[key]
            local previous = correction(current.settings, id)[rawKey]
            local protectedHash = excludingMaskParameter(current.settings, id, rawKey)
            local wasNoop = math.abs(beforeContext.parameters[key].value - value) <= 0.0001
            -- Controller APIs operate on the current UI target and manage their
            -- own Develop transaction. Do not wrap them in a catalog write gate.
            U.checkDeadline(request)
            target(params.photoId, true, true)
            if LrDevelopController.getSelectedTool() ~= 'masking'
                or LrDevelopController.getSelectedMask() ~= id then
                U.fail('MASK_TARGET_CHANGED', 'Mask target changed immediately before the adjustment.')
            end
            request._mutationStarted = true
            LrDevelopController.setValue(key, value)
            local untilTime = math.min(request.deadlineAt, U.now() + 5000)
            local verified = false
            repeat
                target(params.photoId, true, true)
                local after = state(catalog, photo)
                local afterContext = maskContext(id, after.settings)
                if excludingMaskParameter(after.settings, id, rawKey) ~= protectedHash then
                    U.fail('VERIFY_FAILED', 'A setting outside the requested mask parameter changed; inspect state before recovery.')
                end
                local observed = correction(after.settings, id)[rawKey]
                if math.abs(afterContext.parameters[key].value - value) <= 0.0001
                    and U.finite(observed) and (wasNoop or observed ~= previous) then
                    current, context, verified = after, afterContext, true
                    break
                end
                if U.now() >= untilTime then break end
                LrTasks.sleep(0.1)
            until false
            if not verified then
                U.fail('VERIFY_FAILED', 'Native mask value and saved correction did not verify; inspect read_state before recovery.')
            end
        end
        return { state = current, maskId = id, appliedAdjustments = params.adjustments,
            maskContext = context, renderComparisonRequired = true }
    end

    return O
end
