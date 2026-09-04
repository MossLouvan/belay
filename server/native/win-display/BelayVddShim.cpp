// BelayVddShim.cpp — the smallest possible native companion to BelayVDD.
//
// WHY THIS EXISTS
// ---------------
// SwDeviceCreate requires a creation callback, and it pins the module that owns
// that callback for the lifetime of the device (GetModuleHandleEx with
// GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS) so the code cannot be unloaded out
// from under it.
//
// A CLR delegate's function pointer is a runtime-generated thunk living in
// memory that belongs to NO loaded module, so that lookup fails and the whole
// call returns HRESULT_FROM_WIN32(ERROR_MOD_NOT_FOUND) = 0x8007007E — before
// the device is created and before the callback is ever invoked. This was
// verified on Windows 11 26200: identical parameters succeed from native C++
// (hr=0) and fail from .NET three different ways (plain DllImport, raw IntPtr
// struct, and GetProcAddress + GetDelegateForFunctionPointer). Passing a null
// callback is rejected outright with E_INVALIDARG, and passing a pointer that
// does live inside a module makes the call succeed — which is the experiment
// that pinned the cause down.
//
// So the callback has to live in a real DLL. That is all this file is.
//
// The alternative was to create a root-enumerated device with SetupAPI, which
// needs no callback but produces a PERSISTENT devnode — a host crash would
// leave an orphaned virtual display on the desktop. Keeping SwDeviceCreate
// keeps the structural guarantee documented in docs/VIRTUAL-DISPLAY.md: the
// device exists only while this process holds the handle, so a crash removes
// it. That guarantee is worth one small DLL.
//
// This ships beside BelayHost.exe and is built by build-driver.ps1, which
// already requires the MSVC toolchain for the driver itself — so it adds no
// new build dependency to anyone who can build BelayVDD at all.

#include <windows.h>
#include <swdevice.h>

namespace {

// Signalled once Windows reports the outcome of device creation.
struct CreateState {
    HANDLE  done;
    HRESULT hr;
};

// The whole point of the file: a callback with a real module-backed address.
VOID WINAPI OnCreated(HSWDEVICE /*hSwDevice*/, HRESULT hrCreate, PVOID pContext,
                      PCWSTR /*pszDeviceInstanceId*/)
{
    auto* state = static_cast<CreateState*>(pContext);
    if (state) {
        state->hr = hrCreate;
        SetEvent(state->done);
    }
}

} // namespace

extern "C" {

// Create the BelayVDD software device and wait for Windows to report the
// result. Returns S_OK and a handle the caller must hold for as long as the
// display should exist; closing it (or dying) removes the device.
//
// timeoutMs bounds the wait for the creation callback so a wedged PnP stack
// surfaces as a timeout instead of hanging the host.
__declspec(dllexport)
HRESULT __stdcall BelayVddShimCreate(PCWSTR instanceId,
                                     PCWSTR hardwareId,
                                     ULONG  capabilityFlags,
                                     DWORD  timeoutMs,
                                     HSWDEVICE* outHandle)
{
    if (!instanceId || !hardwareId || !outHandle) return E_INVALIDARG;
    *outHandle = nullptr;

    // pszzHardwareIds is a MULTI_SZ: one id, then the list terminator.
    size_t len = wcslen(hardwareId);
    if (len == 0 || len > 512) return E_INVALIDARG;
    wchar_t hwids[520] = {0};
    memcpy(hwids, hardwareId, len * sizeof(wchar_t));
    hwids[len]     = L'\0';   // terminates the single id
    hwids[len + 1] = L'\0';   // terminates the list

    CreateState state = {};
    state.hr   = E_FAIL;
    state.done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!state.done) return HRESULT_FROM_WIN32(GetLastError());

    SW_DEVICE_CREATE_INFO info = {0};
    info.cbSize               = sizeof(info);
    info.pszInstanceId        = instanceId;
    info.pszzHardwareIds      = hwids;
    info.pszzCompatibleIds    = nullptr;
    info.pszDeviceDescription = L"Belay Virtual Display Adapter";
    info.CapabilityFlags      = capabilityFlags;

    HSWDEVICE h = nullptr;
    HRESULT hr = SwDeviceCreate(L"BelayVDD", L"HTREE\\ROOT\\0", &info,
                                0, nullptr, OnCreated, &state, &h);
    if (FAILED(hr)) {
        CloseHandle(state.done);
        return hr;
    }

    DWORD wait = WaitForSingleObject(state.done, timeoutMs);
    CloseHandle(state.done);

    if (wait != WAIT_OBJECT_0) {
        SwDeviceClose(h);
        return HRESULT_FROM_WIN32(ERROR_TIMEOUT);
    }
    if (FAILED(state.hr)) {
        SwDeviceClose(h);
        return state.hr;
    }

    *outHandle = h;
    return S_OK;
}

// Drop the device. Idempotent from the caller's perspective: a null handle is
// simply nothing to do.
__declspec(dllexport)
void __stdcall BelayVddShimClose(HSWDEVICE handle)
{
    if (handle) SwDeviceClose(handle);
}

} // extern "C"
