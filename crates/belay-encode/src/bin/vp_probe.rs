//! Diagnostic: what does this driver actually accept as a video processor
//! input? Written because `CreateVideoProcessorInputView` returns a bare
//! E_INVALIDARG that names none of the several things it could be objecting to.

#[cfg(not(windows))]
fn main() {}

#[cfg(windows)]
fn main() -> windows::core::Result<()> {
    use windows::core::Interface;
    use windows::Win32::Graphics::Direct3D::*;
    use windows::Win32::Graphics::Direct3D11::*;
    use windows::Win32::Graphics::Dxgi::Common::*;

    const W: u32 = 1920;
    const H: u32 = 1080;

    let mut device: Option<ID3D11Device> = None;
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            None,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            None,
        )?
    };
    let device = device.unwrap();
    // No video device at all is the normal answer on a GPU-less VM. Say so and
    // exit rather than returning a bare E_NOINTERFACE that reads like a bug.
    let vd: ID3D11VideoDevice = match device.cast() {
        Ok(v) => v,
        Err(e) => {
            println!("no ID3D11VideoDevice on this machine ({:?}) — CPU path only", e.code());
            return Ok(());
        }
    };

    let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
        InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
        InputWidth: W,
        InputHeight: H,
        OutputWidth: W,
        OutputHeight: H,
        Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
        ..Default::default()
    };
    let en = match unsafe { vd.CreateVideoProcessorEnumerator(&desc) } {
        Ok(e) => e,
        Err(e) => {
            println!("no video processor ({:?}) — CPU path only", e.code());
            return Ok(());
        }
    };

    for (name, fmt) in [
        ("B8G8R8A8_UNORM", DXGI_FORMAT_B8G8R8A8_UNORM),
        ("B8G8R8X8_UNORM", DXGI_FORMAT_B8G8R8X8_UNORM),
        ("R8G8B8A8_UNORM", DXGI_FORMAT_R8G8B8A8_UNORM),
        ("NV12", DXGI_FORMAT_NV12),
    ] {
        let flags = unsafe { en.CheckVideoProcessorFormat(fmt) };
        println!("{name:<16} caps = {flags:?}");
    }

    let combos: [(&str, u32, u32); 5] = [
        ("SHADER_RESOURCE", D3D11_BIND_SHADER_RESOURCE.0 as u32, 0),
        ("RENDER_TARGET", D3D11_BIND_RENDER_TARGET.0 as u32, 0),
        (
            "SR|RT",
            (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
            0,
        ),
        ("none", 0, 0),
        ("SR + SHARED", D3D11_BIND_SHADER_RESOURCE.0 as u32, D3D11_RESOURCE_MISC_SHARED.0 as u32),
    ];

    for (label, bind, misc) in combos {
        let td = D3D11_TEXTURE2D_DESC {
            Width: W,
            Height: H,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: bind,
            CPUAccessFlags: 0,
            MiscFlags: misc,
        };
        let mut tex: Option<ID3D11Texture2D> = None;
        if unsafe { device.CreateTexture2D(&td, None, Some(&mut tex)) }.is_err() {
            println!("{label:<16} texture creation refused");
            continue;
        }
        let tex = tex.unwrap();

        let iv = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            FourCC: 0,
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            ..Default::default()
        };
        let mut view: Option<ID3D11VideoProcessorInputView> = None;
        match unsafe { vd.CreateVideoProcessorInputView(&tex, &en, &iv, Some(&mut view)) } {
            Ok(()) => println!("{label:<16} input view OK"),
            Err(e) => println!("{label:<16} input view FAILED {:?}", e.code()),
        }
    }
    Ok(())
}
