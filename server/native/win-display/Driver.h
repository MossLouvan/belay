// Driver.h — BelayVDD, Belay's IddCx indirect display driver (UMDF 2).
//
// ============================================================================
// STATUS: WRITTEN-BUT-NOT-COMPILED.
// This source was authored on a machine with no Windows, no WDK and no MSVC.
// It has never been compiled, installed or exercised. Treat every line as a
// draft until the build + on-host verification runbook in
// docs/VIRTUAL-DISPLAY.md has been completed on real Windows hardware.
// ============================================================================
//
// PROVENANCE / LICENSE (decision recorded here and in docs/VIRTUAL-DISPLAY.md):
// architecture follows Microsoft's IddCx sample driver
// (github.com/microsoft/Windows-driver-samples, MS-PL) by way of SudoVDA
// (github.com/SudoMaker/SudoVDA, MIT/CC0) — the driver Apollo ships. Both are
// permissive; nothing GPL is in the lineage, so a proprietary Belay host may
// ship this. parsec-vdd was ruled out: its control library is MIT but the
// driver binary is Parsec's, proprietary and not redistributable.
//
// What BelayVDD is: a root-enumerated (HWID Root\BelayVDD) indirect display
// adapter that exposes AT MOST ONE monitor, whose mode list is whatever the
// Belay host asked for over an ACL'd control device. Frames presented to the
// virtual monitor are acknowledged and dropped — Belay's capture path reads
// the desktop via its existing capture route, so the driver's only job is to
// make Windows *render* at the client's exact resolution and refresh.

#pragma once

#include <windows.h>
#include <wdf.h>
#include <iddcx.h>

#include <dxgi1_5.h>
#include <d3d11_2.h>
#include <avrt.h>
#include <wrl.h>

#include <memory>

#include "BelayVddIoctl.h"

namespace BelayVdd {

/// D3D device opened on the render GPU IddCx hands us, used only to drain
/// the monitor's swap-chain. No pixels are read back.
struct Direct3DDevice {
    HRESULT Init(LUID adapterLuid);

    LUID AdapterLuid = {};
    Microsoft::WRL::ComPtr<IDXGIFactory5> DxgiFactory;
    Microsoft::WRL::ComPtr<IDXGIAdapter1> Adapter;
    Microsoft::WRL::ComPtr<ID3D11Device> Device;
    Microsoft::WRL::ComPtr<ID3D11DeviceContext> DeviceContext;
};

/// Drains IddCx swap-chain buffers on a dedicated thread. Acquire, report
/// progress, release, repeat — dropping every frame on purpose (see file
/// header). Lifetime: created on AssignSwapChain, destroyed on Unassign.
class SwapChainProcessor {
public:
    SwapChainProcessor(IDDCX_SWAPCHAIN swapChain,
                       std::shared_ptr<Direct3DDevice> device,
                       HANDLE newFrameEvent);
    ~SwapChainProcessor();

private:
    static DWORD CALLBACK RunThread(LPVOID argument);
    void Run();
    void RunCore();

    IDDCX_SWAPCHAIN m_hSwapChain;
    std::shared_ptr<Direct3DDevice> m_Device;
    HANDLE m_hAvailableBufferEvent;
    Microsoft::WRL::Wrappers::HandleT<Microsoft::WRL::Wrappers::HandleTraits::HANDLENullTraits> m_hThread;
    Microsoft::WRL::Wrappers::Event m_hTerminateEvent;
};

/// Per-adapter state: the one optional monitor, its requested mode, and the
/// swap-chain processor while a mode is committed.
class IndirectDeviceContext {
public:
    explicit IndirectDeviceContext(WDFDEVICE wdfDevice);
    ~IndirectDeviceContext();

    void InitAdapter();
    void AdapterInitFinished(NTSTATUS status);

    /// IOCTL entry points. Serialized by the WDF sequential queue, so no
    /// locking is needed around m_RequestedMode / m_Monitor.
    NTSTATUS PlugInMonitor(const BELAYVDD_MODE& mode);
    NTSTATUS UnplugMonitor();
    void QueryStatus(BELAYVDD_STATUS_OUT& out) const;

    const BELAYVDD_MODE& RequestedMode() const { return m_RequestedMode; }
    bool MonitorActive() const { return m_Monitor != nullptr; }

    void AssignSwapChain(IDDCX_SWAPCHAIN swapChain, LUID renderAdapter, HANDLE newFrameEvent);
    void UnassignSwapChain();

private:
    WDFDEVICE m_WdfDevice;
    IDDCX_ADAPTER m_Adapter = nullptr;
    IDDCX_MONITOR m_Monitor = nullptr;
    BELAYVDD_MODE m_RequestedMode = {};
    bool m_AdapterReady = false;
    std::unique_ptr<SwapChainProcessor> m_ProcessingThread;
};

/// True iff the mode satisfies the contract in BelayVddIoctl.h. The gatekeeper
/// for everything a user-mode caller can inject; used by the IOCTL handler.
bool IsValidMode(const BELAYVDD_MODE& mode);

} // namespace BelayVdd

// Deliberately at global scope. WDF_DECLARE_CONTEXT_TYPE token-pastes the type
// name into the accessor and type-info symbols (WdfObjectGet_<T>, _WDF_<T>_TYPE_INFO),
// so a namespace-qualified argument expands to an identifier containing "::"
// and will not compile. The wrapper therefore lives outside namespace BelayVdd.
struct IndirectDeviceContextWrapper {
    BelayVdd::IndirectDeviceContext* pContext;
    void Cleanup() { delete pContext; pContext = nullptr; }
};

WDF_DECLARE_CONTEXT_TYPE(IndirectDeviceContextWrapper);

extern "C" DRIVER_INITIALIZE DriverEntry;

EVT_WDF_DRIVER_DEVICE_ADD BelayVddDeviceAdd;
EVT_WDF_DEVICE_D0_ENTRY BelayVddDeviceD0Entry;
EVT_WDF_IO_QUEUE_IO_DEVICE_CONTROL BelayVddIoDeviceControl;

EVT_IDD_CX_ADAPTER_INIT_FINISHED BelayVddAdapterInitFinished;
EVT_IDD_CX_ADAPTER_COMMIT_MODES BelayVddAdapterCommitModes;
EVT_IDD_CX_PARSE_MONITOR_DESCRIPTION BelayVddParseMonitorDescription;
EVT_IDD_CX_MONITOR_GET_DEFAULT_DESCRIPTION_MODES BelayVddMonitorGetDefaultModes;
EVT_IDD_CX_MONITOR_QUERY_TARGET_MODES BelayVddMonitorQueryModes;
EVT_IDD_CX_MONITOR_ASSIGN_SWAPCHAIN BelayVddMonitorAssignSwapChain;
EVT_IDD_CX_MONITOR_UNASSIGN_SWAPCHAIN BelayVddMonitorUnassignSwapChain;
