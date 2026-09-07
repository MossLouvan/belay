#include <windows.h>
#include <d3d11.h>
#include <stdint.h>
#include <array>
#include <deque>
#include <vector>
#include <string>
#include <stdexcept>
#include <memory>
#include <cstring>
#include <cstdio>
#include <algorithm>
#include "nvEncodeAPI.h"

namespace {
struct Slot {
    ID3D11Texture2D* texture = nullptr;
    NV_ENC_REGISTERED_PTR registered = nullptr;
    NV_ENC_INPUT_PTR mapped = nullptr;
    NV_ENC_OUTPUT_PTR output = nullptr;
    HANDLE event = nullptr;
    bool event_registered = false;
};
struct Encoder {
    HMODULE dll = nullptr;
    ID3D11Device* device = nullptr;
    ID3D11DeviceContext* immediate = nullptr;
    void* session = nullptr;
    NV_ENCODE_API_FUNCTION_LIST api = {};
    NV_ENC_CONFIG config = {};
    NV_ENC_INITIALIZE_PARAMS init = {};
    std::array<Slot, 4> slots;
    std::deque<size_t> pending;
    std::vector<uint8_t> bytes;
    std::string error;
    bool initialized = false;
    bool trace = GetEnvironmentVariableW(L"BELAY_NVENC_TRACE", nullptr, 0) != 0;
    uint32_t submitted = 0;
    uint32_t delivered = 0;
    void check(NVENCSTATUS status, const char* operation) {
        if (status != NV_ENC_SUCCESS) {
            std::string detail = operation;
            detail += " failed (NVENC " + std::to_string(status) + ")";
            if (session && api.nvEncGetLastErrorString) {
                const char* last = api.nvEncGetLastErrorString(session);
                if (last) detail += std::string(": ") + last;
            }
            throw std::runtime_error(detail);
        }
    }
    ~Encoder() {
        if (session) {
            // Flush before releasing registered resources. A single deadline bounds
            // application waits; the driver destroy call itself has no timeout API.
            bool completed = true;
            if (initialized && !pending.empty()) {
                NV_ENC_PIC_PARAMS eos = {}; eos.version = NV_ENC_PIC_PARAMS_VER;
                eos.encodePicFlags = NV_ENC_PIC_FLAG_EOS;
                api.nvEncEncodePicture(session, &eos);
                ULONGLONG deadline = GetTickCount64() + 2000;
                for (size_t index : pending) {
                    ULONGLONG now = GetTickCount64();
                    if (WaitForSingleObject(slots[index].event,
                        now < deadline ? static_cast<DWORD>(deadline - now) : 0) != WAIT_OBJECT_0) completed = false;
                }
            }
            // Destroy the session before releasing D3D textures, including on a
            // timeout: the driver owns the synchronization of outstanding work.
            for (auto& slot : slots) {
                if (completed) {
                    if (slot.mapped) api.nvEncUnmapInputResource(session, slot.mapped);
                    if (slot.registered) api.nvEncUnregisterResource(session, slot.registered);
                    if (slot.output) api.nvEncDestroyBitstreamBuffer(session, slot.output);
                }
                if (slot.event_registered) {
                    NV_ENC_EVENT_PARAMS e = {}; e.version = NV_ENC_EVENT_PARAMS_VER;
                    e.completionEvent = slot.event;
                    api.nvEncUnregisterAsyncEvent(session, &e);
                }
            }
            api.nvEncDestroyEncoder(session);
        }
        for (auto& slot : slots) {
            if (slot.event) CloseHandle(slot.event);
            if (slot.texture) slot.texture->Release();
        }
        if (immediate) immediate->Release();
        if (device) device->Release();
        if (dll) FreeLibrary(dll);
    }
};
void copy_error(char* output, size_t cap, const char* message) {
    if (!output || !cap) return;
    size_t n = std::min(cap - 1, strlen(message));
    memcpy(output, message, n); output[n] = 0;
}
void rate(NV_ENC_CONFIG& config, uint32_t bitrate, uint32_t fps) {
    config.rcParams.rateControlMode = NV_ENC_PARAMS_RC_CBR;
    config.rcParams.averageBitRate = bitrate;
    config.rcParams.maxBitRate = bitrate;
    config.rcParams.vbvBufferSize = std::max(1u, bitrate / fps);
    config.rcParams.vbvInitialDelay = config.rcParams.vbvBufferSize;
}
}
extern "C" int belay_nvenc_create(void* device, uint32_t width, uint32_t height,
    uint32_t fps, uint32_t bitrate, uint32_t gop, void** out, char* error, size_t cap) {
    if (out) *out = nullptr;
    try {
        if (!out || !device || !width || !height || (width & 1) || (height & 1)
            || width > 16384 || height > 16384 || !fps || fps > 1000 || !bitrate || !gop)
            throw std::runtime_error("Invalid NVENC configuration");
        auto e = std::make_unique<Encoder>();
        e->device = static_cast<ID3D11Device*>(device); e->device->AddRef();
        e->device->GetImmediateContext(&e->immediate);
        e->dll = LoadLibraryExW(L"nvEncodeAPI64.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
        if (!e->dll) throw std::runtime_error("Cannot load system nvEncodeAPI64.dll");
        using MaxVersion = NVENCSTATUS (NVENCAPI*)(uint32_t*);
        using Create = NVENCSTATUS (NVENCAPI*)(NV_ENCODE_API_FUNCTION_LIST*);
        auto max_version = reinterpret_cast<MaxVersion>(GetProcAddress(e->dll, "NvEncodeAPIGetMaxSupportedVersion"));
        auto create = reinterpret_cast<Create>(GetProcAddress(e->dll, "NvEncodeAPICreateInstance"));
        if (!max_version || !create) throw std::runtime_error("NVENC entry points unavailable");
        uint32_t version = 0; e->check(max_version(&version), "GetMaxSupportedVersion");
        if (version < ((NVENCAPI_MAJOR_VERSION << 4) | NVENCAPI_MINOR_VERSION))
            throw std::runtime_error("NVIDIA driver must support NVENC API 13.0");
        e->api.version = NV_ENCODE_API_FUNCTION_LIST_VER;
        e->check(create(&e->api), "CreateInstance");
        NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS open = {};
        open.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
        open.apiVersion = NVENCAPI_VERSION; open.device = device;
        open.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX;
        e->check(e->api.nvEncOpenEncodeSessionEx(&open, &e->session), "OpenEncodeSession");
        NV_ENC_CAPS_PARAM caps = {}; caps.version = NV_ENC_CAPS_PARAM_VER;
        caps.capsToQuery = NV_ENC_CAPS_ASYNC_ENCODE_SUPPORT;
        int async = 0;
        e->check(e->api.nvEncGetEncodeCaps(e->session, NV_ENC_CODEC_H264_GUID, &caps, &async), "Query async support");
        if (!async) throw std::runtime_error("Asynchronous NVENC unsupported");
        NV_ENC_PRESET_CONFIG preset = {}; preset.version = NV_ENC_PRESET_CONFIG_VER;
        preset.presetCfg.version = NV_ENC_CONFIG_VER;
        e->check(e->api.nvEncGetEncodePresetConfigEx(e->session, NV_ENC_CODEC_H264_GUID,
            NV_ENC_PRESET_P1_GUID, NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY, &preset), "GetPreset");
        e->config = preset.presetCfg; e->config.version = NV_ENC_CONFIG_VER;
        if (e->trace) {
            const auto& rc = e->config.rcParams;
            fprintf(stderr, "NVENC preset entropy=%u\n", unsigned(e->config.encodeCodecConfig.h264Config.entropyCodingMode));
            fprintf(stderr, "NVENC preset rc=%u minQP=%u:%u/%u/%u maxQP=%u:%u/%u/%u initialQP=%u lookahead=%u level=%u multipass=%u\n",
                unsigned(rc.rateControlMode), rc.enableMinQP, rc.minQP.qpIntra, rc.minQP.qpInterP, rc.minQP.qpInterB,
                rc.enableMaxQP, rc.maxQP.qpIntra, rc.maxQP.qpInterP, rc.maxQP.qpInterB,
                rc.enableInitialRCQP, rc.enableLookahead, unsigned(rc.lookaheadLevel), unsigned(rc.multiPass));
            for (auto capability : {NV_ENC_CAPS_SUPPORTED_RATECONTROL_MODES, NV_ENC_CAPS_SUPPORT_DYN_BITRATE_CHANGE}) {
                caps.capsToQuery = capability; int value = 0;
                e->check(e->api.nvEncGetEncodeCaps(e->session, NV_ENC_CODEC_H264_GUID, &caps, &value), "Query rate control capability");
                fprintf(stderr, "NVENC capability %u=%d\n", unsigned(capability), value);
            }
        }
        e->config.profileGUID = NV_ENC_H264_PROFILE_HIGH_GUID;
        e->config.gopLength = gop; e->config.frameIntervalP = 1;
        e->config.rcParams.enableLookahead = 0; e->config.rcParams.lookaheadDepth = 0;
        e->config.rcParams.zeroReorderDelay = 1;
        e->config.rcParams.enableAQ = 0; e->config.rcParams.enableTemporalAQ = 0;
        e->config.rcParams.multiPass = NV_ENC_MULTI_PASS_DISABLED;
        rate(e->config, bitrate, fps);
        e->config.encodeCodecConfig.h264Config.idrPeriod = gop;
        e->config.encodeCodecConfig.h264Config.repeatSPSPPS = 1;

        e->init.version = NV_ENC_INITIALIZE_PARAMS_VER;
        e->init.encodeGUID = NV_ENC_CODEC_H264_GUID; e->init.presetGUID = NV_ENC_PRESET_P1_GUID;
        e->init.encodeWidth = e->init.darWidth = e->init.maxEncodeWidth = width;
        e->init.encodeHeight = e->init.darHeight = e->init.maxEncodeHeight = height;
        e->init.frameRateNum = fps; e->init.frameRateDen = 1;
        e->init.enableEncodeAsync = 1; e->init.enablePTD = 1;
        e->init.tuningInfo = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;
        e->init.encodeConfig = &e->config;
        e->check(e->api.nvEncInitializeEncoder(e->session, &e->init), "InitializeEncoder");
        e->initialized = true;
        for (auto& slot : e->slots) {
            D3D11_TEXTURE2D_DESC desc = {}; desc.Width = width; desc.Height = height;
            desc.MipLevels = 1; desc.ArraySize = 1; desc.Format = DXGI_FORMAT_NV12;
            desc.SampleDesc.Count = 1; desc.Usage = D3D11_USAGE_DEFAULT;
            desc.BindFlags = D3D11_BIND_RENDER_TARGET;
            if (FAILED(e->device->CreateTexture2D(&desc, nullptr, &slot.texture)))
                throw std::runtime_error("Cannot allocate NVENC NV12 snapshot");
            NV_ENC_REGISTER_RESOURCE r = {}; r.version = NV_ENC_REGISTER_RESOURCE_VER;
            r.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;
            r.resourceToRegister = slot.texture; r.width = width; r.height = height;
            r.bufferFormat = NV_ENC_BUFFER_FORMAT_NV12; r.bufferUsage = NV_ENC_INPUT_IMAGE;
            e->check(e->api.nvEncRegisterResource(e->session, &r), "RegisterResource");
            slot.registered = r.registeredResource;
            NV_ENC_CREATE_BITSTREAM_BUFFER b = {}; b.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
            e->check(e->api.nvEncCreateBitstreamBuffer(e->session, &b), "CreateBitstreamBuffer");
            slot.output = b.bitstreamBuffer;
            slot.event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
            if (!slot.event) throw std::runtime_error("Cannot allocate NVENC completion event");
            NV_ENC_EVENT_PARAMS ev = {}; ev.version = NV_ENC_EVENT_PARAMS_VER;
            ev.completionEvent = slot.event;
            e->check(e->api.nvEncRegisterAsyncEvent(e->session, &ev), "RegisterAsyncEvent");
            slot.event_registered = true;
        }
        *out = e.release(); return 0;
    } catch (const std::exception& ex) { copy_error(error, cap, ex.what()); return -1; }
      catch (...) { copy_error(error, cap, "Unknown NVENC create failure"); return -1; }
}
extern "C" int belay_nvenc_submit(void* context, void* texture, int64_t timestamp, int forceidr) {
    auto* e = static_cast<Encoder*>(context); if (!e) return -1;
    try {
        if (!texture) throw std::runtime_error("Null NVENC texture");
        if (e->pending.size() >= 2) return 1;
        auto* input = static_cast<ID3D11Texture2D*>(texture);
        D3D11_TEXTURE2D_DESC desc = {}; input->GetDesc(&desc);
        ID3D11Device* owner = nullptr; input->GetDevice(&owner);
        bool same_device = owner == e->device; if (owner) owner->Release();
        if (!same_device || desc.Width != e->init.encodeWidth || desc.Height != e->init.encodeHeight
            || desc.Format != DXGI_FORMAT_NV12 || desc.ArraySize != 1 || desc.MipLevels != 1 || desc.SampleDesc.Count != 1)
            throw std::runtime_error("NVENC requires matching device and single-plane NV12 texture dimensions");
        size_t index = 0; while (std::find(e->pending.begin(), e->pending.end(), index) != e->pending.end()) ++index;
        auto& slot = e->slots[index];
        e->immediate->CopyResource(slot.texture, input);
        e->immediate->Flush();
        NV_ENC_MAP_INPUT_RESOURCE map = {}; map.version = NV_ENC_MAP_INPUT_RESOURCE_VER;
        map.registeredResource = slot.registered;
        e->check(e->api.nvEncMapInputResource(e->session, &map), "MapInputResource");
        slot.mapped = map.mappedResource;
        NV_ENC_PIC_PARAMS pic = {}; pic.version = NV_ENC_PIC_PARAMS_VER;
        pic.inputWidth = desc.Width; pic.inputHeight = desc.Height;
        pic.inputPitch = desc.Width; pic.frameIdx = e->submitted;
        pic.inputBuffer = slot.mapped; pic.bufferFmt = NV_ENC_BUFFER_FORMAT_NV12;
        pic.outputBitstream = slot.output; pic.completionEvent = slot.event;
        pic.pictureStruct = NV_ENC_PIC_STRUCT_FRAME; pic.inputTimeStamp = static_cast<uint64_t>(timestamp);
        if (forceidr) pic.encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;
        ResetEvent(slot.event);
        auto status = e->api.nvEncEncodePicture(e->session, &pic);
        if (status != NV_ENC_SUCCESS && status != NV_ENC_ERR_NEED_MORE_INPUT) {
            e->api.nvEncUnmapInputResource(e->session, slot.mapped); slot.mapped = nullptr;
            if (status == NV_ENC_ERR_ENCODER_BUSY) return 1;
            e->check(status, "EncodePicture");
        }
        e->pending.push_back(index); ++e->submitted; return 0;
    } catch (const std::exception& ex) { e->error = ex.what(); return -1; }
      catch (...) { e->error = "Unknown NVENC submit failure"; return -1; }
}
extern "C" int belay_nvenc_poll(void* context, const uint8_t** data, size_t* len, int64_t* timestamp, int* keyframe) {
    auto* e = static_cast<Encoder*>(context); if (!e) return -1;
    try {
        if (!data || !len || !timestamp || !keyframe) throw std::runtime_error("Invalid poll outputs");
        *data = nullptr; *len = 0;
        if (e->pending.empty()) return 1;
        auto& slot = e->slots[e->pending.front()];
        DWORD wait = WaitForSingleObject(slot.event, 0);
        if (wait == WAIT_TIMEOUT) return 1;
        if (wait != WAIT_OBJECT_0) throw std::runtime_error("NVENC completion event failed");
        NV_ENC_LOCK_BITSTREAM lock = {}; lock.version = NV_ENC_LOCK_BITSTREAM_VER;
        lock.outputBitstream = slot.output; lock.doNotWait = 1;
        auto status = e->api.nvEncLockBitstream(e->session, &lock);
        if (status == NV_ENC_ERR_LOCK_BUSY) { SetEvent(slot.event); return 1; }
        e->check(status, "LockBitstream");
        try {
            if (lock.bitstreamSizeInBytes > 16 * 1024 * 1024) throw std::runtime_error("NVENC access unit exceeds 16 MiB bound");
            auto* start = static_cast<const uint8_t*>(lock.bitstreamBufferPtr);
            e->bytes.assign(start, start + lock.bitstreamSizeInBytes);
        } catch (...) { e->api.nvEncUnlockBitstream(e->session, slot.output); throw; }
        if (e->trace && e->delivered % 60 == 0)
            fprintf(stderr, "NVENC frame=%u bytes=%u avgQP=%u type=%u target=%u vbv=%u\n",
                e->delivered, lock.bitstreamSizeInBytes, lock.frameAvgQP, unsigned(lock.pictureType),
                e->config.rcParams.averageBitRate, e->config.rcParams.vbvBufferSize);
        ++e->delivered;
        *timestamp = static_cast<int64_t>(lock.outputTimeStamp);
        *keyframe = lock.pictureType == NV_ENC_PIC_TYPE_IDR;
        e->check(e->api.nvEncUnlockBitstream(e->session, slot.output), "UnlockBitstream");
        e->check(e->api.nvEncUnmapInputResource(e->session, slot.mapped), "UnmapInputResource");
        slot.mapped = nullptr; e->pending.pop_front();
        *data = e->bytes.data(); *len = e->bytes.size(); return 0;
    } catch (const std::exception& ex) { e->error = ex.what(); return -1; }
      catch (...) { e->error = "Unknown NVENC poll failure"; return -1; }
}
extern "C" int belay_nvenc_set_bitrate(void* context, uint32_t bitrate) {
    auto* e = static_cast<Encoder*>(context); if (!e) return -1;
    try {
        if (!bitrate) throw std::runtime_error("NVENC bitrate must be positive");
        NV_ENC_CONFIG config = e->config; rate(config, bitrate, e->init.frameRateNum);
        NV_ENC_RECONFIGURE_PARAMS r = {}; r.version = NV_ENC_RECONFIGURE_PARAMS_VER;
        r.reInitEncodeParams = e->init; r.reInitEncodeParams.encodeConfig = &config;
        e->check(e->api.nvEncReconfigureEncoder(e->session, &r), "ReconfigureEncoder");
        e->config = config; return 0;
    } catch (const std::exception& ex) { e->error = ex.what(); return -1; }
      catch (...) { e->error = "Unknown NVENC reconfigure failure"; return -1; }
}
extern "C" const char* belay_nvenc_error(void* context) {
    auto* e = static_cast<Encoder*>(context); return e ? e->error.c_str() : "Null NVENC context";
}
extern "C" void belay_nvenc_destroy(void* context) { delete static_cast<Encoder*>(context); }
