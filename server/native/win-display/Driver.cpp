// Driver.cpp — BelayVDD, Belay's IddCx indirect display driver (UMDF 2).
//
// ============================================================================
// STATUS: WRITTEN-BUT-NOT-COMPILED. Authored without Windows/WDK/MSVC; never
// compiled, never installed, never run. Complete the runbook in
// docs/VIRTUAL-DISPLAY.md (build, test-sign, install on a disposable machine,
// verify every IOCTL) before trusting a line of it.
// ============================================================================
//
// See Driver.h for provenance and license (MS-PL sample -> SudoVDA MIT/CC0
// lineage; no copyleft). Structure mirrors the Microsoft IddCx sample's
// Driver.cpp; the deltas that make it Belay's:
//
//   1. HARDENED CONTROL SURFACE. The sample creates a world-openable device.
//      BelayVDD assigns an explicit SDDL — SYSTEM and Administrators only —
//      BEFORE WdfDeviceCreate, and every IOCTL validates buffer sizes and
//      field ranges (IsValidMode) before touching state. An ACL is policy,
//      not proof: validation happens even for callers the ACL admitted.
//   2. RENAMED IDENTITY. HWID Root\BelayVDD, its own interface GUID, its own
//      symbolic link. A stock IddSampleDriver on the same machine can never
//      be opened, or answered, by mistake.
//   3. NO MONITOR AT BOOT. The sample plugs in a fake monitor immediately.
//      BelayVDD exposes zero monitors until the host asks (ADD_MONITOR), and
//      the monitor leaves when the host says so or the device powers down —
//      the desktop never grows a screen nobody requested.
//   4. CLIENT-EXACT MODES. The monitor's mode list is the requested mode
//      first (preferred), plus two conservative fallbacks so Windows always
//      has a safe harbour if the compositor rejects the preferred mode.
//
// Frames: PRESENTED AND DROPPED, on purpose. Belay's capture pipeline reads
// the desktop through its existing (Desktop Duplication / GDI) path, which
// sees this monitor like any other. The swap-chain must still be drained —
// an unserviced swap-chain stalls the whole desktop compositor.

#include "Driver.h"

using namespace Microsoft::WRL;
using namespace Microsoft::WRL::Wrappers;
using namespace BelayVdd;

// SYSTEM and Administrators, full access; nobody else may even open the
// device. The Belay host runs in the user's session — elevation is required
// to manage the virtual display, which is the correct bar: creating displays
// is a machine-topology change, same trust class as installing the driver.
// (SDDL_DEVOBJ_SYS_ALL_ADM_ALL from wdmsec.h, written out so the dependency
// on that header is not needed in user mode.)
// NOTE: the ACL is applied by the INF, not by this file.
// WdfDeviceInitAssignSDDLString is a KMDF-only DDI - it does not exist in
// UMDF2, where a user-mode driver may not set its own device object's
// security descriptor. The equivalent for UMDF is the "Security" value under
// the devnode's hardware key, written by BelayVdd.inf's DDInstall.HW section:
//
//     HKR,,"Security",,"D:P(A;;GA;;;SY)(A;;GA;;;BA)"
//
// Same descriptor, same guarantee (SYSTEM + Administrators, full access, no
// inheritance), applied by the PnP manager before the device is startable.
// Keep the two in sync; the string below is the single source of truth for
// what the INF must say.

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

bool BelayVdd::IsValidMode(const BELAYVDD_MODE& mode)
{
    if (mode.Width < BELAYVDD_MIN_WIDTH || mode.Width > BELAYVDD_MAX_WIDTH) return false;
    if (mode.Height < BELAYVDD_MIN_HEIGHT || mode.Height > BELAYVDD_MAX_HEIGHT) return false;
    if ((mode.Width % 2) != 0 || (mode.Height % 2) != 0) return false; // encoder contract
    if (mode.RefreshHz < BELAYVDD_MIN_HZ || mode.RefreshHz > BELAYVDD_MAX_HZ) return false;
    return true;
}

// ---------------------------------------------------------------------------
// DriverEntry / device add
// ---------------------------------------------------------------------------

extern "C" NTSTATUS DriverEntry(PDRIVER_OBJECT pDriverObject, PUNICODE_STRING pRegistryPath)
{
    WDF_OBJECT_ATTRIBUTES attributes;
    WDF_OBJECT_ATTRIBUTES_INIT(&attributes);

    WDF_DRIVER_CONFIG config;
    WDF_DRIVER_CONFIG_INIT(&config, BelayVddDeviceAdd);

    return WdfDriverCreate(pDriverObject, pRegistryPath, &attributes, &config, WDF_NO_HANDLE);
}

NTSTATUS BelayVddDeviceAdd(WDFDRIVER, PWDFDEVICE_INIT pDeviceInit)
{
    NTSTATUS status = STATUS_SUCCESS;

    // Device security is set by BelayVdd.inf (HKR "Security" in the .HW
    // section) - see the note at the top of this file. UMDF2 has no
    // WdfDeviceInitAssignSDDLString, so there is nothing to do here.

    WDF_PNPPOWER_EVENT_CALLBACKS pnpPowerCallbacks;
    WDF_PNPPOWER_EVENT_CALLBACKS_INIT(&pnpPowerCallbacks);
    pnpPowerCallbacks.EvtDeviceD0Entry = BelayVddDeviceD0Entry;
    WdfDeviceInitSetPnpPowerEventCallbacks(pDeviceInit, &pnpPowerCallbacks);

    IDD_CX_CLIENT_CONFIG iddConfig;
    IDD_CX_CLIENT_CONFIG_INIT(&iddConfig);
    iddConfig.EvtIddCxAdapterInitFinished = BelayVddAdapterInitFinished;
    iddConfig.EvtIddCxAdapterCommitModes = BelayVddAdapterCommitModes;
    iddConfig.EvtIddCxParseMonitorDescription = BelayVddParseMonitorDescription;
    iddConfig.EvtIddCxMonitorGetDefaultDescriptionModes = BelayVddMonitorGetDefaultModes;
    iddConfig.EvtIddCxMonitorQueryTargetModes = BelayVddMonitorQueryModes;
    iddConfig.EvtIddCxMonitorAssignSwapChain = BelayVddMonitorAssignSwapChain;
    iddConfig.EvtIddCxMonitorUnassignSwapChain = BelayVddMonitorUnassignSwapChain;
    // BelayVDD's own control surface. IddCx redirects IoDeviceControl to an
    // internal queue, so this callback — not a WDF queue — is the only way a
    // custom control code reaches the driver.
    iddConfig.EvtIddCxDeviceIoControl = BelayVddIoDeviceControl;

    status = IddCxDeviceInitConfig(pDeviceInit, &iddConfig);
    if (!NT_SUCCESS(status)) return status;

    WDF_OBJECT_ATTRIBUTES deviceAttributes;
    WDF_OBJECT_ATTRIBUTES_INIT_CONTEXT_TYPE(&deviceAttributes, IndirectDeviceContextWrapper);
    deviceAttributes.EvtCleanupCallback = [](WDFOBJECT object) {
        auto* pWrapper = WdfObjectGet_IndirectDeviceContextWrapper(object);
        if (pWrapper) pWrapper->Cleanup();
    };

    WDFDEVICE device = nullptr;
    status = WdfDeviceCreate(&pDeviceInit, &deviceAttributes, &device);
    if (!NT_SUCCESS(status)) return status;

    status = WdfDeviceCreateDeviceInterface(device, &GUID_DEVINTERFACE_BELAYVDD, nullptr);
    if (!NT_SUCCESS(status)) return status;

    // Convenience symbolic link so the host can open \\.\BelayVDD directly.
    //
    // NOT fatal if it fails. The name is global, so a device that has not
    // finished tearing down still owns it and this returns
    // STATUS_OBJECT_NAME_COLLISION. Treating that as fatal made DeviceAdd fail
    // — and because this call sits after WdfDeviceCreateDeviceInterface, the
    // interface got rolled back with the device too, leaving user mode with no
    // way in at all. The observable symptom was create attempts alternating
    // pass/fail: a failed attempt leaves no link, so the next one succeeds, and
    // that one's link then breaks the attempt after it.
    //
    // The device interface registered above is the supported discovery
    // mechanism and is always present; the link is only a shortcut.
    DECLARE_CONST_UNICODE_STRING(symlink, L"\\DosDevices\\BelayVDD");
    status = WdfDeviceCreateSymbolicLink(device, &symlink);
    if (!NT_SUCCESS(status)) {
        // Deliberately swallowed: the host falls back to the interface GUID.
        status = STATUS_SUCCESS;
    }

    // No WDF I/O queue here on purpose. IddCx owns the device's I/O path and
    // redirects IoDeviceControl into a queue of its own, so control codes are
    // delivered through EvtIddCxDeviceIoControl (wired up above) instead.
    // Registering a WDF queue for them is not merely redundant, it does not
    // work: with a default queue every DeviceIoControl returned
    // ERROR_NOT_SUPPORTED, and moving them to a secondary queue with
    // WdfDeviceConfigureRequestDispatching was refused by the framework
    // outright (DeviceAdd failed, UMDF host reported 0xD0200204).
    //
    // Requests arrive serialised on IddCx's queue, so the device context still
    // needs no locking and add/remove can never interleave.
    status = IddCxDeviceInitialize(device);
    if (!NT_SUCCESS(status)) return status;

    auto* pWrapper = WdfObjectGet_IndirectDeviceContextWrapper(device);
    pWrapper->pContext = new IndirectDeviceContext(device);
    return STATUS_SUCCESS;
}

NTSTATUS BelayVddDeviceD0Entry(WDFDEVICE device, WDF_POWER_DEVICE_STATE)
{
    auto* pWrapper = WdfObjectGet_IndirectDeviceContextWrapper(device);
    pWrapper->pContext->InitAdapter();
    return STATUS_SUCCESS;
}

// ---------------------------------------------------------------------------
// IOCTL surface — every byte from user mode is validated here
// ---------------------------------------------------------------------------

// METHOD_BUFFERED: WDF hands us system-copied buffers, never user pointers.
// Retrieval APIs enforce minimum sizes; field ranges are checked after.
void BelayVddIoDeviceControl(WDFDEVICE device, WDFREQUEST request,
                             size_t /*outputBufferLength*/, size_t /*inputBufferLength*/,
                             ULONG ioControlCode)
{
    auto* pContext = WdfObjectGet_IndirectDeviceContextWrapper(device)->pContext;

    NTSTATUS status = STATUS_INVALID_DEVICE_REQUEST;
    size_t written = 0;

    switch (ioControlCode)
    {
    case IOCTL_BELAYVDD_VERSION:
    {
        PBELAYVDD_VERSION_OUT out = nullptr;
        status = WdfRequestRetrieveOutputBuffer(
            request, sizeof(BELAYVDD_VERSION_OUT), reinterpret_cast<PVOID*>(&out), nullptr);
        if (NT_SUCCESS(status)) {
            out->Protocol = BELAYVDD_PROTOCOL_VERSION;
            written = sizeof(BELAYVDD_VERSION_OUT);
        }
        break;
    }

    case IOCTL_BELAYVDD_ADD_MONITOR:
    {
        PBELAYVDD_MODE in = nullptr;
        status = WdfRequestRetrieveInputBuffer(
            request, sizeof(BELAYVDD_MODE), reinterpret_cast<PVOID*>(&in), nullptr);
        if (!NT_SUCCESS(status)) break;

        // Copy before validating: `in` is a system buffer, but reading it once
        // into a local removes any doubt about re-reads racing a rewrite.
        BELAYVDD_MODE mode = *in;
        if (!IsValidMode(mode)) { status = STATUS_INVALID_PARAMETER; break; }

        status = pContext->PlugInMonitor(mode);
        if (!NT_SUCCESS(status)) break;

        PBELAYVDD_MONITOR_OUT out = nullptr;
        NTSTATUS outStatus = WdfRequestRetrieveOutputBuffer(
            request, sizeof(BELAYVDD_MONITOR_OUT), reinterpret_cast<PVOID*>(&out), nullptr);
        if (NT_SUCCESS(outStatus)) {
            out->Mode = mode;
            out->Connected = 1;
            written = sizeof(BELAYVDD_MONITOR_OUT);
        }
        // The monitor exists even if the caller sent no output buffer;
        // that is their loss, not an error.
        break;
    }

    case IOCTL_BELAYVDD_REMOVE_MONITOR:
        status = pContext->UnplugMonitor();
        break;

    case IOCTL_BELAYVDD_STATUS:
    {
        PBELAYVDD_STATUS_OUT out = nullptr;
        status = WdfRequestRetrieveOutputBuffer(
            request, sizeof(BELAYVDD_STATUS_OUT), reinterpret_cast<PVOID*>(&out), nullptr);
        if (NT_SUCCESS(status)) {
            pContext->QueryStatus(*out);
            written = sizeof(BELAYVDD_STATUS_OUT);
        }
        break;
    }

    default:
        // Unknown control codes are rejected loudly, never ignored: an
        // unexpected caller probing the device should see failure, and the
        // host should never depend on an IOCTL this version does not define.
        status = STATUS_INVALID_DEVICE_REQUEST;
        break;
    }

    WdfRequestCompleteWithInformation(request, status, written);
}

// ---------------------------------------------------------------------------
// Direct3DDevice
// ---------------------------------------------------------------------------

HRESULT Direct3DDevice::Init(LUID adapterLuid)
{
    AdapterLuid = adapterLuid;

    HRESULT hr = CreateDXGIFactory2(0, IID_PPV_ARGS(&DxgiFactory));
    if (FAILED(hr)) return hr;

    hr = DxgiFactory->EnumAdapterByLuid(AdapterLuid, IID_PPV_ARGS(&Adapter));
    if (FAILED(hr)) return hr;

    hr = D3D11CreateDevice(Adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                           D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
                           D3D11_SDK_VERSION, &Device, nullptr, &DeviceContext);
    return hr;
}

// ---------------------------------------------------------------------------
// SwapChainProcessor — drain and drop (see file header for why)
// ---------------------------------------------------------------------------

SwapChainProcessor::SwapChainProcessor(IDDCX_SWAPCHAIN swapChain,
                                       std::shared_ptr<Direct3DDevice> device,
                                       HANDLE newFrameEvent)
    : m_hSwapChain(swapChain), m_Device(std::move(device)), m_hAvailableBufferEvent(newFrameEvent)
{
    m_hTerminateEvent.Attach(CreateEvent(nullptr, FALSE, FALSE, nullptr));
    m_hThread.Attach(CreateThread(nullptr, 0, RunThread, this, 0, nullptr));
}

SwapChainProcessor::~SwapChainProcessor()
{
    // Wake the thread and wait for it: destroying while the thread still owns
    // the swap-chain would hand IddCx a dangling pointer.
    if (m_hThread.Get()) {
        SetEvent(m_hTerminateEvent.Get());
        WaitForSingleObject(m_hThread.Get(), INFINITE);
    }
}

DWORD CALLBACK SwapChainProcessor::RunThread(LPVOID argument)
{
    reinterpret_cast<SwapChainProcessor*>(argument)->Run();
    return 0;
}

void SwapChainProcessor::Run()
{
    // The compositor treats this thread as part of the display pipeline; the
    // MMCSS "Distribution" class keeps it scheduled with that urgency so a
    // busy host cannot stall its own desktop through us.
    DWORD avTask = 0;
    HANDLE avTaskHandle = AvSetMmThreadCharacteristicsW(L"Distribution", &avTask);

    RunCore();

    // Always release the swap-chain, even on the error path out of RunCore —
    // an orphaned swap-chain wedges the whole desktop.
    WdfObjectDelete(reinterpret_cast<WDFOBJECT>(m_hSwapChain));
    m_hSwapChain = nullptr;

    if (avTaskHandle) AvRevertMmThreadCharacteristics(avTaskHandle);
}

void SwapChainProcessor::RunCore()
{
    ComPtr<IDXGIDevice> dxgiDevice;
    HRESULT hr = m_Device->Device.As(&dxgiDevice);
    if (FAILED(hr)) return;

    IDARG_IN_SWAPCHAINSETDEVICE setDevice = {};
    setDevice.pDevice = dxgiDevice.Get();
    if (FAILED(IddCxSwapChainSetDevice(m_hSwapChain, &setDevice))) return;

    for (;;)
    {
        ComPtr<IDXGIResource> acquiredBuffer;
        IDARG_OUT_RELEASEANDACQUIREBUFFER buffer = {};
        hr = IddCxSwapChainReleaseAndAcquireBuffer(m_hSwapChain, &buffer);

        if (hr == E_PENDING)
        {
            // No frame ready. Wait for one, or for termination; 16ms poll
            // guard so a lost event can never hang the pipeline forever.
            HANDLE waitHandles[] = { m_hAvailableBufferEvent, m_hTerminateEvent.Get() };
            DWORD wait = WaitForMultipleObjects(ARRAYSIZE(waitHandles), waitHandles, FALSE, 16);
            if (wait == WAIT_OBJECT_0 + 1) break;          // terminate
            if (wait == WAIT_OBJECT_0 || wait == WAIT_TIMEOUT) continue;
            break;                                          // wait failed: bail
        }
        else if (SUCCEEDED(hr))
        {
            // A frame arrived. Belay does not touch the pixels (capture goes
            // through the OS desktop APIs); take the reference and finish it.
            acquiredBuffer.Attach(buffer.MetaData.pSurface);
            acquiredBuffer.Reset();
            if (FAILED(IddCxSwapChainFinishedProcessingFrame(m_hSwapChain))) break;
        }
        else
        {
            break; // swap-chain torn down (mode change / monitor departure)
        }
    }
}

// ---------------------------------------------------------------------------
// IndirectDeviceContext — adapter + the one monitor
// ---------------------------------------------------------------------------

IndirectDeviceContext::IndirectDeviceContext(WDFDEVICE wdfDevice) : m_WdfDevice(wdfDevice) {}

IndirectDeviceContext::~IndirectDeviceContext() { m_ProcessingThread.reset(); }

void IndirectDeviceContext::InitAdapter()
{
    IDDCX_ADAPTER_CAPS adapterCaps = {};
    adapterCaps.Size = sizeof(adapterCaps);
    adapterCaps.MaxMonitorsSupported = 1;
    adapterCaps.EndPointDiagnostics.Size = sizeof(adapterCaps.EndPointDiagnostics);
    adapterCaps.EndPointDiagnostics.GammaSupport = IDDCX_FEATURE_IMPLEMENTATION_NONE;
    adapterCaps.EndPointDiagnostics.TransmissionType = IDDCX_TRANSMISSION_TYPE_OTHER;

    // The strings Windows shows in device manager / display settings, and the
    // strings server/src/displays.ts classifies by ("virtual" => virtual).
    adapterCaps.EndPointDiagnostics.pEndPointFriendlyName = L"Belay Virtual Display Adapter";
    adapterCaps.EndPointDiagnostics.pEndPointManufacturerName = L"Belay";
    adapterCaps.EndPointDiagnostics.pEndPointModelName = L"BelayVDD";

    IDDCX_ENDPOINT_VERSION version = {};
    version.Size = sizeof(version);
    version.MajorVer = 1;
    adapterCaps.EndPointDiagnostics.pFirmwareVersion = &version;
    adapterCaps.EndPointDiagnostics.pHardwareVersion = &version;

    WDF_OBJECT_ATTRIBUTES attributes;
    WDF_OBJECT_ATTRIBUTES_INIT_CONTEXT_TYPE(&attributes, IndirectDeviceContextWrapper);

    IDARG_IN_ADAPTER_INIT adapterInit = {};
    adapterInit.WdfDevice = m_WdfDevice;
    adapterInit.pCaps = &adapterCaps;
    adapterInit.ObjectAttributes = &attributes;

    IDARG_OUT_ADAPTER_INIT adapterInitOut = {};
    NTSTATUS status = IddCxAdapterInitAsync(&adapterInit, &adapterInitOut);
    if (!NT_SUCCESS(status)) return;

    m_Adapter = adapterInitOut.AdapterObject;
    auto* pWrapper = WdfObjectGet_IndirectDeviceContextWrapper(adapterInitOut.AdapterObject);
    pWrapper->pContext = this;
}

void IndirectDeviceContext::AdapterInitFinished(NTSTATUS status)
{
    // Unlike the sample, nothing is plugged in here — monitors arrive only on
    // the host's explicit ADD_MONITOR (delta #3 in the file header).
    m_AdapterReady = NT_SUCCESS(status);
}

NTSTATUS IndirectDeviceContext::PlugInMonitor(const BELAYVDD_MODE& mode)
{
    if (!m_AdapterReady || m_Adapter == nullptr) return STATUS_DEVICE_NOT_READY;

    // "Create" while one is active means the client changed resolution:
    // replace, never stack (the adapter caps promise MaxMonitorsSupported=1).
    if (m_Monitor != nullptr) {
        NTSTATUS unplugged = UnplugMonitor();
        if (!NT_SUCCESS(unplugged)) return unplugged;
    }

    m_RequestedMode = mode;

    WDF_OBJECT_ATTRIBUTES attributes;
    WDF_OBJECT_ATTRIBUTES_INIT_CONTEXT_TYPE(&attributes, IndirectDeviceContextWrapper);

    // No EDID: BelayVDD monitors describe themselves through
    // EvtIddCxMonitorGetDefaultDescriptionModes instead of a synthesized EDID
    // blob. Fewer fabricated bytes, and the mode list is the one artifact the
    // host actually controls.
    IDDCX_MONITOR_INFO monitorInfo = {};
    monitorInfo.Size = sizeof(monitorInfo);
    monitorInfo.MonitorType = DISPLAYCONFIG_OUTPUT_TECHNOLOGY_INDIRECT_WIRED;
    monitorInfo.ConnectorIndex = 0;
    monitorInfo.MonitorDescription.Size = sizeof(monitorInfo.MonitorDescription);
    // UNINITIALIZED, not EDID. "No description" is expressed by the TYPE, not by
    // an EDID of zero length: declaring EDID and then handing IddCx DataSize 0 /
    // pData null is self-contradictory, and IddCxMonitorCreate rejects it with
    // STATUS_INVALID_PARAMETER (surfacing as 0x80070057 on the ADD_MONITOR
    // ioctl) and takes the driver down with it.
    monitorInfo.MonitorDescription.Type = IDDCX_MONITOR_DESCRIPTION_TYPE_UNINITIALIZED;
    monitorInfo.MonitorDescription.DataSize = 0;
    monitorInfo.MonitorDescription.pData = nullptr;

    // Container ID: fixed GUID so Windows remembers layout/scale for the Belay
    // display across sessions. {b31ae04d-4b7a-4e2f-9a53-1c6d5f0e8b21}
    static const GUID kContainerId =
        { 0xb31ae04d, 0x4b7a, 0x4e2f, { 0x9a, 0x53, 0x1c, 0x6d, 0x5f, 0x0e, 0x8b, 0x21 } };
    monitorInfo.MonitorContainerId = kContainerId;

    IDARG_IN_MONITORCREATE monitorCreate = {};
    monitorCreate.ObjectAttributes = &attributes;
    monitorCreate.pMonitorInfo = &monitorInfo;

    IDARG_OUT_MONITORCREATE monitorCreateOut = {};
    NTSTATUS status = IddCxMonitorCreate(m_Adapter, &monitorCreate, &monitorCreateOut);
    if (!NT_SUCCESS(status)) return status;

    m_Monitor = monitorCreateOut.MonitorObject;
    auto* pWrapper = WdfObjectGet_IndirectDeviceContextWrapper(monitorCreateOut.MonitorObject);
    pWrapper->pContext = this;

    IDARG_OUT_MONITORARRIVAL arrivalOut = {};
    status = IddCxMonitorArrival(m_Monitor, &arrivalOut);
    if (!NT_SUCCESS(status)) {
        WdfObjectDelete(m_Monitor);
        m_Monitor = nullptr;
        return status;
    }
    return STATUS_SUCCESS;
}

NTSTATUS IndirectDeviceContext::UnplugMonitor()
{
    if (m_Monitor == nullptr) return STATUS_SUCCESS; // idempotent, like macOS

    m_ProcessingThread.reset();
    NTSTATUS status = IddCxMonitorDeparture(m_Monitor);
    m_Monitor = nullptr;
    m_RequestedMode = {};
    return status;
}

void IndirectDeviceContext::QueryStatus(BELAYVDD_STATUS_OUT& out) const
{
    out.Protocol = BELAYVDD_PROTOCOL_VERSION;
    out.MonitorActive = (m_Monitor != nullptr) ? 1u : 0u;
    out.Mode = (m_Monitor != nullptr) ? m_RequestedMode : BELAYVDD_MODE{};
}

void IndirectDeviceContext::AssignSwapChain(IDDCX_SWAPCHAIN swapChain, LUID renderAdapter,
                                            HANDLE newFrameEvent)
{
    m_ProcessingThread.reset();

    auto device = std::make_shared<Direct3DDevice>();
    if (FAILED(device->Init(renderAdapter))) {
        // No render device: give the swap-chain back rather than stalling it.
        WdfObjectDelete(swapChain);
        return;
    }
    m_ProcessingThread = std::make_unique<SwapChainProcessor>(swapChain, device, newFrameEvent);
}

void IndirectDeviceContext::UnassignSwapChain()
{
    m_ProcessingThread.reset();
}

// ---------------------------------------------------------------------------
// IddCx mode plumbing
// ---------------------------------------------------------------------------

static void FillSignalInfo(DISPLAYCONFIG_VIDEO_SIGNAL_INFO& info,
                           DWORD width, DWORD height, DWORD vsync, bool monitorMode)
{
    info.pixelRate = static_cast<UINT64>(width) * height * vsync;
    info.hSyncFreq.Numerator = static_cast<DWORD>(info.pixelRate);
    info.hSyncFreq.Denominator = height;
    info.vSyncFreq.Numerator = vsync;
    info.vSyncFreq.Denominator = 1;
    info.activeSize.cx = width;
    info.activeSize.cy = height;
    if (monitorMode) {
        info.totalSize.cx = width;
        info.totalSize.cy = height;
    } else {
        info.AdditionalSignalInfo.vSyncFreqDivider = 1;
        info.AdditionalSignalInfo.videoStandard = 255; // other
    }
    info.scanLineOrdering = DISPLAYCONFIG_SCANLINE_ORDERING_PROGRESSIVE;
}

static IDDCX_MONITOR_MODE MakeMonitorMode(DWORD width, DWORD height, DWORD vsync,
    IDDCX_MONITOR_MODE_ORIGIN origin = IDDCX_MONITOR_MODE_ORIGIN_DRIVER)
{
    IDDCX_MONITOR_MODE mode = {};
    mode.Size = sizeof(mode);
    mode.Origin = origin;
    FillSignalInfo(mode.MonitorVideoSignalInfo, width, height, vsync, true);
    return mode;
}

static IDDCX_TARGET_MODE MakeTargetMode(DWORD width, DWORD height, DWORD vsync)
{
    IDDCX_TARGET_MODE mode = {};
    mode.Size = sizeof(mode);
    FillSignalInfo(mode.TargetVideoSignalInfo.targetVideoSignalInfo, width, height, vsync, false);
    return mode;
}

/// The one mode policy, shared by both mode callbacks: the host-requested
/// mode first (preferred), then safe fallbacks the compositor can retreat
/// to. Duplicates of the requested mode are skipped so the list never lies
/// about how many distinct modes exist.
template <typename TMode, typename TMake>
static UINT BuildModeList(const BELAYVDD_MODE& requested, TMode* dest, UINT capacity, TMake make)
{
    struct { DWORD w, h, hz; } rows[] = {
        { requested.Width, requested.Height, requested.RefreshHz },
        { 1920, 1080, 60 },
        { 1280, 720, 60 },
    };
    UINT count = 0;
    for (const auto& row : rows) {
        // Skip a fallback row identical to the request (a 1080p60 request
        // must not list 1080p60 twice); fallbacks never duplicate each other.
        if (&row != &rows[0] &&
            row.w == requested.Width && row.h == requested.Height && row.hz == requested.RefreshHz) {
            continue;
        }
        if (count < capacity) dest[count++] = make(row.w, row.h, row.hz);
    }
    return count;
}

NTSTATUS BelayVddAdapterInitFinished(IDDCX_ADAPTER adapterObject,
                                     const IDARG_IN_ADAPTER_INIT_FINISHED* pInArgs)
{
    auto* pContext = WdfObjectGet_IndirectDeviceContextWrapper(adapterObject)->pContext;
    pContext->AdapterInitFinished(pInArgs->AdapterInitStatus);
    return STATUS_SUCCESS;
}

NTSTATUS BelayVddAdapterCommitModes(IDDCX_ADAPTER, const IDARG_IN_COMMITMODES*)
{
    // Nothing to reconfigure: the swap-chain arrives already sized for the
    // committed mode, and BelayVDD renders nothing of its own.
    return STATUS_SUCCESS;
}

NTSTATUS BelayVddParseMonitorDescription(const IDARG_IN_PARSEMONITORDESCRIPTION*,
                                         IDARG_OUT_PARSEMONITORDESCRIPTION*)
{
    // BelayVDD monitors carry no EDID (see PlugInMonitor), so IddCx should
    // never call this. Refusing loudly beats inventing modes from a
    // description that cannot exist.
    return STATUS_INVALID_PARAMETER;
}

NTSTATUS BelayVddMonitorGetDefaultModes(IDDCX_MONITOR monitorObject,
                                        const IDARG_IN_GETDEFAULTDESCRIPTIONMODES* pInArgs,
                                        IDARG_OUT_GETDEFAULTDESCRIPTIONMODES* pOutArgs)
{
    auto* pContext = WdfObjectGet_IndirectDeviceContextWrapper(monitorObject)->pContext;
    const BELAYVDD_MODE& requested = pContext->RequestedMode();

    IDDCX_MONITOR_MODE modes[3];
    UINT count = BuildModeList(requested, modes, ARRAYSIZE(modes),
        [](DWORD w, DWORD h, DWORD hz) { return MakeMonitorMode(w, h, hz); });

    pOutArgs->DefaultMonitorModeBufferOutputCount = count;
    if (pInArgs->DefaultMonitorModeBufferInputCount == 0) {
        return STATUS_SUCCESS; // size query
    }
    if (pInArgs->DefaultMonitorModeBufferInputCount < count) {
        return STATUS_BUFFER_TOO_SMALL;
    }
    for (UINT i = 0; i < count; i++) pInArgs->pDefaultMonitorModes[i] = modes[i];
    pOutArgs->PreferredMonitorModeIdx = 0; // the client's exact mode
    return STATUS_SUCCESS;
}

NTSTATUS BelayVddMonitorQueryModes(IDDCX_MONITOR monitorObject,
                                   const IDARG_IN_QUERYTARGETMODES* pInArgs,
                                   IDARG_OUT_QUERYTARGETMODES* pOutArgs)
{
    auto* pContext = WdfObjectGet_IndirectDeviceContextWrapper(monitorObject)->pContext;
    const BELAYVDD_MODE& requested = pContext->RequestedMode();

    IDDCX_TARGET_MODE modes[3];
    UINT count = BuildModeList(requested, modes, ARRAYSIZE(modes),
        [](DWORD w, DWORD h, DWORD hz) { return MakeTargetMode(w, h, hz); });

    pOutArgs->TargetModeBufferOutputCount = count;
    if (pInArgs->TargetModeBufferInputCount >= count) {
        for (UINT i = 0; i < count; i++) pInArgs->pTargetModes[i] = modes[i];
    }
    return STATUS_SUCCESS;
}

NTSTATUS BelayVddMonitorAssignSwapChain(IDDCX_MONITOR monitorObject,
                                        const IDARG_IN_SETSWAPCHAIN* pInArgs)
{
    auto* pContext = WdfObjectGet_IndirectDeviceContextWrapper(monitorObject)->pContext;
    pContext->AssignSwapChain(pInArgs->hSwapChain, pInArgs->RenderAdapterLuid,
                              pInArgs->hNextSurfaceAvailable);
    return STATUS_SUCCESS;
}

NTSTATUS BelayVddMonitorUnassignSwapChain(IDDCX_MONITOR monitorObject)
{
    auto* pContext = WdfObjectGet_IndirectDeviceContextWrapper(monitorObject)->pContext;
    pContext->UnassignSwapChain();
    return STATUS_SUCCESS;
}
