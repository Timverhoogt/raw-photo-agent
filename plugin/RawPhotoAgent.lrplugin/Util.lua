local LrDate = import 'LrDate'
local LrFileUtils = import 'LrFileUtils'
local LrMD5 = import 'LrMD5'
local LrPathUtils = import 'LrPathUtils'
local json = dofile(_PLUGIN.path .. '/vendor/json.lua')

local U = { json = json, version = '0.1.0', sequence = 0 }
local arrayMarker = {}

function U.fail(code, message)
    error({ code = code, message = message }, 0)
end

function U.now()
    return math.floor(LrDate.timeToPosixDate(LrDate.currentTime()) * 1000)
end

function U.array(value)
    return setmetatable(value or {}, arrayMarker)
end

-- Canonical encoding makes tokens independent of Lua hash-table iteration order.
-- Empty tables are objects unless explicitly marked as protocol arrays.
local function encode(value, stack)
    if type(value) ~= 'table' then return json.encode(value) end
    if stack[value] then U.fail('UNSERIALIZABLE_STATE', 'Cyclic table in Lightroom state.') end
    stack[value] = true
    local numeric, strings, count, highest = false, false, 0, 0
    for key in pairs(value) do
        count = count + 1
        if type(key) == 'number' and key >= 1 and key == math.floor(key) then
            numeric = true
            highest = math.max(highest, key)
        elseif type(key) == 'string' then
            strings = true
        else
            U.fail('UNSERIALIZABLE_STATE', 'Unsupported Lightroom table key.')
        end
    end
    local parts = {}
    local isArray = getmetatable(value) == arrayMarker or (numeric and not strings)
    if isArray then
        if strings or highest ~= count then U.fail('UNSERIALIZABLE_STATE', 'Sparse or mixed Lightroom array.') end
        for i = 1, highest do parts[#parts + 1] = encode(value[i], stack) end
    else
        if numeric then U.fail('UNSERIALIZABLE_STATE', 'Mixed Lightroom object keys.') end
        local keys = {}
        for key in pairs(value) do keys[#keys + 1] = key end
        table.sort(keys)
        for _, key in ipairs(keys) do
            parts[#parts + 1] = json.encode(key) .. ':' .. encode(value[key], stack)
        end
    end
    stack[value] = nil
    return (isArray and '[' or '{') .. table.concat(parts, ',') .. (isArray and ']' or '}')
end

function U.encode(value) return encode(value, {}) end
function U.hash(value) return LrMD5.digest(U.encode(value)) end

function U.directory(path)
    local ok, reason = LrFileUtils.createAllDirectories(path)
    if not ok then U.fail('IO_ERROR', 'Cannot create directory: ' .. tostring(reason)) end
end

function U.readJson(path)
    local data = LrFileUtils.readFile(path)
    if type(data) ~= 'string' then U.fail('IO_ERROR', 'Cannot read ' .. path) end
    if #data > 4 * 1024 * 1024 then U.fail('INVALID_REQUEST', 'JSON file exceeds 4 MiB.') end
    return json.decode(data)
end

function U.writeJson(path, value, replace)
    if not replace and LrFileUtils.exists(path) then
        U.fail('FILE_EXISTS', 'Refusing to replace existing file: ' .. path)
    end
    local data = U.encode(value)
    U.sequence = U.sequence + 1
    local temporary = path .. '.tmp-' .. tostring(U.now()) .. '-' .. tostring(U.sequence)
    local file, reason = io.open(temporary, 'wb')
    if not file then U.fail('IO_ERROR', 'Cannot create temporary file: ' .. tostring(reason)) end
    local written, writeError = file:write(data)
    local closed, closeError = file:close()
    if not written or not closed then
        U.fail('IO_ERROR', 'Cannot finish file: ' .. tostring(writeError or closeError))
    end
    local ok, moveError
    if replace and os and type(os.rename) == 'function' then
        -- POSIX rename replaces one complete heartbeat with another on macOS.
        ok, moveError = os.rename(temporary, path)
    else
        -- Responses and receipts are immutable; SDK move refuses overwrite.
        -- Heartbeats alone may have a short missing-file window without os.rename.
        if replace and LrFileUtils.exists(path) then LrFileUtils.delete(path) end
        ok, moveError = LrFileUtils.move(temporary, path)
    end
    if not ok then U.fail('IO_ERROR', 'Cannot publish file: ' .. tostring(moveError)) end
end

function U.absoluteDirectory(path, label)
    if type(path) ~= 'string' or not LrPathUtils.isAbsolute(path) or path:find('%z')
        or path:find('\\') or path:find('//', 1, true) then
        U.fail('INVALID_CONFIG', label .. ' must be a normalized absolute macOS path.')
    end
    for part in path:gmatch('[^/]+') do
        if part == '.' or part == '..' then U.fail('INVALID_CONFIG', label .. ' cannot contain dot path segments.') end
    end
    path = path:gsub('/+$', '')
    if path == '' then U.fail('INVALID_CONFIG', label .. ' cannot be the filesystem root.') end
    return path
end

function U.text(value, label, maxLength)
    if type(value) ~= 'string' or #value == 0 or #value > (maxLength or 512) or value:find('%z') then
        U.fail('INVALID_PARAMS', label .. ' must be a nonempty string of bounded length.')
    end
    return value
end

function U.keys(value, allowed)
    if type(value) ~= 'table' then U.fail('INVALID_PARAMS', 'params must be an object.') end
    for key in pairs(value) do
        if not allowed[key] then U.fail('INVALID_PARAMS', 'Unknown parameter: ' .. tostring(key)) end
    end
end

function U.finite(value)
    return type(value) == 'number' and value == value and value ~= math.huge and value ~= -math.huge
end

function U.checkDeadline(request)
    if U.now() >= request.deadlineAt then U.fail('EXPIRED', 'Request deadline passed before the operation could start.') end
end

function U.errorObject(value)
    if type(value) == 'table' and type(value.code) == 'string' and type(value.message) == 'string' then
        return { code = value.code, message = value.message }
    end
    return { code = 'SDK_ERROR', message = tostring(value) }
end

return U
