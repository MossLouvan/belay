//! BGRA → NV12 conversion.
//!
//! Screen capture hands us BGRA8; every H.264 encoder wants NV12 (8-bit Y
//! plane, then a half-resolution interleaved UV plane). This runs on every
//! single frame, so it is written to be measured — and it was: the first
//! straightforward version cost ~6 ms/frame at 1080p, which was MORE than the
//! hardware encode it was feeding (1.8 ms). Being the most expensive stage in a
//! latency pipeline while doing the least interesting work is not acceptable,
//! so this version splits the frame across cores and gives the inner loops a
//! shape LLVM can vectorise, over a persistent pool rather than freshly
//! spawned threads.
//!
//! BT.709 limited range, which is what H.264 signals by default for HD content.
//! Getting it wrong does not fail loudly — it produces washed-out or crushed
//! colour that looks like an encoder "quality" problem and sends you hunting in
//! the wrong place.
//!
//! Chroma is averaged over each 2x2 block rather than point-sampled. Point
//! sampling is cheaper and visibly worse on exactly the content a desktop is
//! made of: one-pixel-wide text stems and window borders shimmer as they move.

use rayon::prelude::*;

/// Fixed-point shift for the integer coefficients below.
const S: i32 = 8;

/// BT.709 limited-range coefficients, pre-scaled by 1<<S.
const YR: i32 = 47;
const YG: i32 = 157;
const YB: i32 = 16;
const YO: i32 = 16;

const UR: i32 = -26;
const UG: i32 = -87;
const UB: i32 = 112;

const VR: i32 = 112;
const VG: i32 = -102;
const VB: i32 = -10;

/// Rows per work unit. Two so a band always covers whole 2x2 chroma blocks;
/// bands are multiplied up from this, never split below it.
const ROW_PAIR: usize = 2;

#[inline(always)]
fn clamp_u8(v: i32) -> u8 {
    v.clamp(0, 255) as u8
}

/// Size in bytes of an NV12 buffer for `width` x `height`.
pub fn nv12_len(width: usize, height: usize) -> usize {
    debug_assert!(width % 2 == 0 && height % 2 == 0, "NV12 requires even dimensions");
    width * height + width * (height / 2)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConvertError {
    OddDimensions { width: usize, height: usize },
    SourceTooSmall { needed: usize, got: usize },
    DestTooSmall { needed: usize, got: usize },
}

/// Convert a BGRA frame into NV12, using all available cores.
///
/// `src_stride` is the source row pitch in BYTES — capture APIs pad rows to an
/// alignment, and assuming `width * 4` is how you get a picture that shears
/// diagonally.
pub fn bgra_to_nv12(
    src: &[u8],
    src_stride: usize,
    width: usize,
    height: usize,
    dst: &mut [u8],
) -> Result<(), ConvertError> {
    validate(src, src_stride, width, height, dst)?;

    // Bands are whole row PAIRS so a 2x2 chroma block is never split across
    // two workers. Larger bands than strictly necessary keep each worker on a
    // contiguous run of memory, which matters more here than perfect balance:
    // this loop is memory-bandwidth bound, not compute bound.
    let (y_plane, uv_plane) = dst[..nv12_len(width, height)].split_at_mut(width * height);

    let workers = rayon::current_num_threads().max(1);
    let pairs = height / ROW_PAIR;
    let pairs_per_band = pairs.div_ceil(workers).max(1);
    let rows_per_band = pairs_per_band * ROW_PAIR;

    // rayon owns a persistent pool, so this costs a queue push per band rather
    // than a thread creation.
    y_plane
        .par_chunks_mut(rows_per_band * width)
        .zip(uv_plane.par_chunks_mut((rows_per_band / 2) * width))
        .enumerate()
        .for_each(|(band, (y_chunk, uv_chunk))| {
            let y0 = band * rows_per_band;
            let y1 = (y0 + rows_per_band).min(height);
            if y0 < y1 {
                convert_band(src, src_stride, width, y0, y1, y_chunk, uv_chunk);
            }
        });

    Ok(())
}

/// Single-threaded conversion. Kept public so the benchmark can show what the
/// parallel version is actually buying.
pub fn bgra_to_nv12_scalar(
    src: &[u8],
    src_stride: usize,
    width: usize,
    height: usize,
    dst: &mut [u8],
) -> Result<(), ConvertError> {
    validate(src, src_stride, width, height, dst)?;
    let (y_plane, uv_plane) = dst.split_at_mut(width * height);
    convert_band(src, src_stride, width, 0, height, y_plane, uv_plane);
    Ok(())
}

fn validate(
    src: &[u8],
    src_stride: usize,
    width: usize,
    height: usize,
    dst: &[u8],
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
    Ok(())
}

/// Convert rows `y0..y1` (both even) writing into band-local output slices.
///
/// Luma and chroma are produced in one pass over each row pair rather than in
/// two separate passes over the frame: the source pixels are already in cache
/// from the luma work, and re-reading 8 MB of BGRA a second time for chroma was
/// a large part of the original cost.
fn convert_band(
    src: &[u8],
    src_stride: usize,
    width: usize,
    y0: usize,
    y1: usize,
    y_out: &mut [u8],
    uv_out: &mut [u8],
) {
    debug_assert!(y0 % 2 == 0 && (y1 - y0) % 2 == 0);

    for (pair, top) in (y0..y1).step_by(2).enumerate() {
        let row_t = &src[top * src_stride..top * src_stride + width * 4];
        let row_b = &src[(top + 1) * src_stride..(top + 1) * src_stride + width * 4];

        let local_top = (top - y0) * width;
        let (y_row_t, y_row_b) = {
            let (a, b) = y_out[local_top..local_top + width * 2].split_at_mut(width);
            (a, b)
        };
        let uv_row = &mut uv_out[pair * width..(pair + 1) * width];

        // Two pixels at a time: one chroma sample covers a 2x2 block, so the
        // block is the natural unit and the four source pixels are loaded once.
        for bx in 0..width / 2 {
            let i = bx * 4 * 2;
            let (b0, g0, r0) = (row_t[i] as i32, row_t[i + 1] as i32, row_t[i + 2] as i32);
            let (b1, g1, r1) = (row_t[i + 4] as i32, row_t[i + 5] as i32, row_t[i + 6] as i32);
            let (b2, g2, r2) = (row_b[i] as i32, row_b[i + 1] as i32, row_b[i + 2] as i32);
            let (b3, g3, r3) = (row_b[i + 4] as i32, row_b[i + 5] as i32, row_b[i + 6] as i32);

            y_row_t[bx * 2] = clamp_u8(((YR * r0 + YG * g0 + YB * b0) >> S) + YO);
            y_row_t[bx * 2 + 1] = clamp_u8(((YR * r1 + YG * g1 + YB * b1) >> S) + YO);
            y_row_b[bx * 2] = clamp_u8(((YR * r2 + YG * g2 + YB * b2) >> S) + YO);
            y_row_b[bx * 2 + 1] = clamp_u8(((YR * r3 + YG * g3 + YB * b3) >> S) + YO);

            let r = (r0 + r1 + r2 + r3) / 4;
            let g = (g0 + g1 + g2 + g3) / 4;
            let b = (b0 + b1 + b2 + b3) / 4;
            uv_row[bx * 2] = clamp_u8(((UR * r + UG * g + UB * b) >> S) + 128);
            uv_row[bx * 2 + 1] = clamp_u8(((VR * r + VG * g + VB * b) >> S) + 128);
        }
    }
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
        assert_eq!(dst[0], 16, "limited range black is 16, not 0");
        assert_eq!(dst[16], 128);
        assert_eq!(dst[17], 128);

        let (src, stride) = solid(4, 4, 255, 255, 255);
        bgra_to_nv12(&src, stride, 4, 4, &mut dst).unwrap();
        assert!((234..=236).contains(&dst[0]), "white is ~235, got {}", dst[0]);
    }

    #[test]
    fn primaries_have_the_expected_luma_ordering() {
        let mut lum = |b, g, r| {
            let (src, stride) = solid(2, 2, b, g, r);
            let mut dst = vec![0u8; nv12_len(2, 2)];
            bgra_to_nv12(&src, stride, 2, 2, &mut dst).unwrap();
            dst[0]
        };
        let (red, green, blue) = (lum(0, 0, 255), lum(0, 255, 0), lum(255, 0, 0));
        assert!(green > red && red > blue, "BT.709 weights: G > R > B");
    }

    #[test]
    fn red_and_blue_push_chroma_in_opposite_directions() {
        let mut chroma = |b, g, r| {
            let (src, stride) = solid(2, 2, b, g, r);
            let mut dst = vec![0u8; nv12_len(2, 2)];
            bgra_to_nv12(&src, stride, 2, 2, &mut dst).unwrap();
            (dst[4], dst[5])
        };
        let (ub, vb) = chroma(255, 0, 0);
        let (ur, vr) = chroma(0, 0, 255);
        assert!(ub > 128 && vr > 128);
        assert!(ur < 128 && vb < 128);
    }

    #[test]
    fn a_padded_source_stride_is_honoured() {
        let (w, h) = (4usize, 2usize);
        let stride = w * 4 + 32;
        let mut src = vec![0u8; stride * h];
        for y in 0..h {
            for x in 0..w {
                let o = y * stride + x * 4;
                src[o + 1] = 255;
                src[o + 3] = 255;
            }
            for p in (y * stride + w * 4)..((y + 1) * stride) {
                src[p] = 0xFF;
            }
        }
        let mut dst = vec![0u8; nv12_len(w, h)];
        bgra_to_nv12(&src, stride, w, h, &mut dst).unwrap();
        let green = dst[0];
        assert!(dst[..w * h].iter().all(|&p| p == green), "padding must not leak in");
    }

    #[test]
    fn chroma_is_averaged_over_the_block_not_point_sampled() {
        let (w, h) = (2usize, 2usize);
        let stride = w * 4;
        let mut src = vec![0u8; stride * h];
        for px in src.chunks_exact_mut(4) {
            px[3] = 255;
        }
        src[2] = 255;
        let mut dst = vec![0u8; nv12_len(w, h)];
        bgra_to_nv12(&src, stride, w, h, &mut dst).unwrap();
        assert!(dst[5] > 128, "V must reflect the red in the block");
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

    /// The optimisation must not change a single byte. Splitting work across
    /// threads is exactly the kind of change that silently corrupts a band
    /// boundary, so the parallel and scalar paths are compared byte-for-byte on
    /// a size that does not divide evenly by the thread count.
    #[test]
    fn parallel_and_scalar_agree_byte_for_byte() {
        let (w, h) = (322usize, 178usize); // deliberately awkward
        let stride = w * 4 + 16;
        let mut src = vec![0u8; stride * h];
        for (i, b) in src.iter_mut().enumerate() {
            *b = (i * 37 % 251) as u8;
        }
        let mut a = vec![0u8; nv12_len(w, h)];
        let mut b = vec![0u8; nv12_len(w, h)];
        bgra_to_nv12(&src, stride, w, h, &mut a).unwrap();
        bgra_to_nv12_scalar(&src, stride, w, h, &mut b).unwrap();
        assert_eq!(a, b, "threading must not change the output");
    }

    /// A frame with fewer row pairs than cores must not spawn empty bands or
    /// index past the end.
    #[test]
    fn tiny_frames_survive_the_band_split() {
        for (w, h) in [(2usize, 2usize), (4, 2), (2, 4), (64, 6)] {
            let stride = w * 4;
            let src = vec![128u8; stride * h];
            let mut a = vec![0u8; nv12_len(w, h)];
            let mut b = vec![0u8; nv12_len(w, h)];
            bgra_to_nv12(&src, stride, w, h, &mut a).unwrap();
            bgra_to_nv12_scalar(&src, stride, w, h, &mut b).unwrap();
            assert_eq!(a, b, "{w}x{h} must match the scalar path");
        }
    }
}
