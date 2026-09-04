//! BGRA → NV12 conversion.
//!
//! Screen capture hands us BGRA8; every H.264 encoder wants NV12 (8-bit Y
//! plane, then a half-resolution interleaved UV plane). This conversion sits on
//! the hot path for every single frame, so it is written to be measured, and it
//! is pure so its correctness is settled by tests rather than by looking at a
//! picture and deciding it seems fine.
//!
//! BT.709 limited range, which is what H.264 signals by default for HD content
//! and what every decoder on the other end will assume. Getting this wrong does
//! not fail loudly — it produces washed-out or crushed colour that looks like a
//! "quality" problem and sends you hunting in the encoder.
//!
//! Chroma is averaged over each 2x2 block rather than point-sampled. Point
//! sampling is one line of code cheaper and visibly worse on exactly the content
//! a desktop is made of: one-pixel-wide text stems and window borders shimmer as
//! they move.

/// Fixed-point shift for the integer coefficients below.
const S: i32 = 8;

/// BT.709 limited-range coefficients, pre-scaled by 1<<S.
///  Y = 0.2126R + 0.7152G + 0.0722B, scaled to 16..235
///  U/V centred on 128, scaled to 16..240
const YR: i32 = 47; // 0.1826 * 256
const YG: i32 = 157; // 0.6142 * 256
const YB: i32 = 16; // 0.0620 * 256
const YO: i32 = 16; // luma offset

const UR: i32 = -26; // -0.1006 * 256
const UG: i32 = -87; // -0.3386 * 256
const UB: i32 = 112; //  0.4392 * 256

const VR: i32 = 112; //  0.4392 * 256
const VG: i32 = -102; // -0.3989 * 256
const VB: i32 = -10; // -0.0403 * 256

#[inline(always)]
fn clamp_u8(v: i32) -> u8 {
    if v < 0 {
        0
    } else if v > 255 {
        255
    } else {
        v as u8
    }
}

/// Size in bytes of an NV12 buffer for `width` x `height`.
///
/// Both dimensions must be even; NV12's chroma plane is half resolution in each
/// axis, so an odd dimension has no representation. The encoder contract in
/// `BelayVddIoctl.h` already forces even dimensions for exactly this reason.
pub fn nv12_len(width: usize, height: usize) -> usize {
    debug_assert!(width % 2 == 0 && height % 2 == 0, "NV12 requires even dimensions");
    width * height + width * (height / 2)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConvertError {
    OddDimensions { width: usize, height: usize },
    /// Source is smaller than `stride * height`.
    SourceTooSmall { needed: usize, got: usize },
    /// Destination is smaller than `nv12_len`.
    DestTooSmall { needed: usize, got: usize },
}

/// Convert a BGRA frame into NV12.
///
/// `src_stride` is the source row pitch in BYTES — capture APIs hand back rows
/// padded to an alignment, and assuming `width * 4` is how you get a picture
/// that shears diagonally.
pub fn bgra_to_nv12(
    src: &[u8],
    src_stride: usize,
    width: usize,
    height: usize,
    dst: &mut [u8],
) -> Result<(), ConvertError> {
    if width % 2 != 0 || height % 2 != 0 {
        return Err(ConvertError::OddDimensions { width, height });
    }
    let needed_src = src_stride * height;
    if src.len() < needed_src {
        return Err(ConvertError::SourceTooSmall { needed: needed_src, got: src.len() });
    }
    let needed_dst = nv12_len(width, height);
    if dst.len() < needed_dst {
        return Err(ConvertError::DestTooSmall { needed: needed_dst, got: dst.len() });
    }

    let (y_plane, uv_plane) = dst.split_at_mut(width * height);

    for y in 0..height {
        let row = &src[y * src_stride..y * src_stride + width * 4];
        let y_row = &mut y_plane[y * width..(y + 1) * width];
        for x in 0..width {
            let b = row[x * 4] as i32;
            let g = row[x * 4 + 1] as i32;
            let r = row[x * 4 + 2] as i32;
            y_row[x] = clamp_u8(((YR * r + YG * g + YB * b) >> S) + YO);
        }
    }

    // Chroma: one sample per 2x2 luma block, averaged over the block.
    for by in 0..height / 2 {
        let uv_row = &mut uv_plane[by * width..(by + 1) * width];
        for bx in 0..width / 2 {
            let mut r = 0i32;
            let mut g = 0i32;
            let mut b = 0i32;
            for dy in 0..2 {
                let sy = by * 2 + dy;
                let row = &src[sy * src_stride..sy * src_stride + width * 4];
                for dx in 0..2 {
                    let sx = bx * 2 + dx;
                    b += row[sx * 4] as i32;
                    g += row[sx * 4 + 1] as i32;
                    r += row[sx * 4 + 2] as i32;
                }
            }
            // Average of the 2x2 block.
            let (r, g, b) = (r / 4, g / 4, b / 4);
            uv_row[bx * 2] = clamp_u8(((UR * r + UG * g + UB * b) >> S) + 128);
            uv_row[bx * 2 + 1] = clamp_u8(((VR * r + VG * g + VB * b) >> S) + 128);
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: usize, height: usize, b: u8, g: u8, r: u8) -> (Vec<u8>, usize) {
        let stride = width * 4;
        let mut v = vec![0u8; stride * height];
        for px in v.chunks_exact_mut(4) {
            px[0] = b;
            px[1] = g;
            px[2] = r;
            px[3] = 255;
        }
        (v, stride)
    }

    #[test]
    fn nv12_length_is_one_and_a_half_bytes_per_pixel() {
        assert_eq!(nv12_len(1920, 1080), 1920 * 1080 * 3 / 2);
        assert_eq!(nv12_len(2, 2), 6);
    }

    #[test]
    fn black_and_white_land_on_the_limited_range_endpoints() {
        let (src, stride) = solid(4, 4, 0, 0, 0);
        let mut dst = vec![0u8; nv12_len(4, 4)];
        bgra_to_nv12(&src, stride, 4, 4, &mut dst).unwrap();
        // Limited range: black is 16, not 0. Getting this wrong crushes shadows.
        assert_eq!(dst[0], 16);
        // Neutral colour sits at the chroma centre.
        assert_eq!(dst[16], 128);
        assert_eq!(dst[17], 128);

        let (src, stride) = solid(4, 4, 255, 255, 255);
        bgra_to_nv12(&src, stride, 4, 4, &mut dst).unwrap();
        assert!((234..=236).contains(&dst[0]), "white is ~235, got {}", dst[0]);
        assert!((127..=129).contains(&dst[16]));
    }

    #[test]
    fn primaries_have_the_expected_luma_ordering() {
        // BT.709 weights green far above red above blue. If the coefficients
        // were transposed this ordering breaks, and the picture looks subtly
        // wrong in a way that is easy to blame on the encoder.
        let mut lum = |b, g, r| {
            let (src, stride) = solid(2, 2, b, g, r);
            let mut dst = vec![0u8; nv12_len(2, 2)];
            bgra_to_nv12(&src, stride, 2, 2, &mut dst).unwrap();
            dst[0]
        };
        let red = lum(0, 0, 255);
        let green = lum(0, 255, 0);
        let blue = lum(255, 0, 0);
        assert!(green > red, "green {green} must exceed red {red}");
        assert!(red > blue, "red {red} must exceed blue {blue}");
    }

    #[test]
    fn red_and_blue_push_chroma_in_opposite_directions() {
        let mut chroma = |b, g, r| {
            let (src, stride) = solid(2, 2, b, g, r);
            let mut dst = vec![0u8; nv12_len(2, 2)];
            bgra_to_nv12(&src, stride, 2, 2, &mut dst).unwrap();
            (dst[4], dst[5]) // U, V
        };
        let (ub, vb) = chroma(255, 0, 0); // blue
        let (ur, vr) = chroma(0, 0, 255); // red
        assert!(ub > 128, "blue raises U");
        assert!(vr > 128, "red raises V");
        assert!(ur < 128 && vb < 128, "and each lowers the other");
    }

    /// Capture APIs pad rows. Assuming width*4 shears the image diagonally —
    /// a bug that looks like a decoder problem.
    #[test]
    fn a_padded_source_stride_is_honoured() {
        let (w, h) = (4usize, 2usize);
        let stride = w * 4 + 32; // padding the naive path would misread
        let mut src = vec![0u8; stride * h];
        for y in 0..h {
            for x in 0..w {
                let o = y * stride + x * 4;
                src[o] = 0;
                src[o + 1] = 255; // green
                src[o + 2] = 0;
                src[o + 3] = 255;
            }
            // Poison the padding: if it is read, luma will not match green.
            for p in (y * stride + w * 4)..((y + 1) * stride) {
                src[p] = 0xFF;
            }
        }
        let mut dst = vec![0u8; nv12_len(w, h)];
        bgra_to_nv12(&src, stride, w, h, &mut dst).unwrap();
        let green_luma = dst[0];
        assert!(dst[..w * h].iter().all(|&p| p == green_luma), "padding must not leak in");
    }

    #[test]
    fn chroma_is_averaged_over_the_block_not_point_sampled() {
        // A 2x2 with three black pixels and one red. Point sampling the
        // top-left would report pure black; averaging must show a red tint.
        let (w, h) = (2usize, 2usize);
        let stride = w * 4;
        let mut src = vec![0u8; stride * h];
        for px in src.chunks_exact_mut(4) {
            px[3] = 255;
        }
        src[2] = 255; // top-left red
        let mut dst = vec![0u8; nv12_len(w, h)];
        bgra_to_nv12(&src, stride, w, h, &mut dst).unwrap();
        assert!(dst[5] > 128, "V must reflect the red in the block, got {}", dst[5]);
    }

    #[test]
    fn bad_geometry_is_refused_rather_than_producing_garbage() {
        let (src, stride) = solid(4, 4, 0, 0, 0);
        let mut dst = vec![0u8; nv12_len(4, 4)];
        assert_eq!(
            bgra_to_nv12(&src, stride, 3, 4, &mut dst),
            Err(ConvertError::OddDimensions { width: 3, height: 4 })
        );
        assert!(matches!(
            bgra_to_nv12(&src[..8], stride, 4, 4, &mut dst),
            Err(ConvertError::SourceTooSmall { .. })
        ));
        let mut tiny = [0u8; 4];
        assert!(matches!(
            bgra_to_nv12(&src, stride, 4, 4, &mut tiny),
            Err(ConvertError::DestTooSmall { .. })
        ));
    }
}
