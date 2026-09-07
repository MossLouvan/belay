// The two axes the user picks for the picture: quality (how the host encodes)
// and resolution (what the host renders), plus the host-capability probes
// that gate what each picker may offer.

import { useEffect, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { api } from '../api';
import {
  availableQuality,
  DEFAULT_QUALITY,
  findQuality,
  findResolution,
  PHYSICAL_RESOLUTION_ID,
  resolutionOptions,
  resolveQualityId,
  virtualRequestFor,
} from './model';
import type { QualityId, QualityPreset, ResolutionOption, Size, VirtualRequest } from './model';

export interface StreamPresets {
  readonly qualityId: QualityId;
  readonly setQualityId: Dispatch<SetStateAction<QualityId>>;
  readonly quality: QualityPreset;
  readonly resolutionId: string;
  readonly setResolutionId: Dispatch<SetStateAction<string>>;
  readonly resolutions: readonly ResolutionOption[];
  readonly resolution: ResolutionOption;
  /** The host advertises the virtual display driver: the resolution picker may show. */
  readonly vdAvailable: boolean;
  /** What the stream asks the host to render: null means the physical screen. */
  readonly virtualRequest: VirtualRequest | null;
}

/**
 * @param active Paired and focused — the capability probe runs once per
 *   active session and resets when the session ends.
 * @param device The phone's own pixel size, for the "Match my phone" option.
 */
export function useStreamPresets(active: boolean, device: Size): StreamPresets {
  const [qualityId, setQualityId] = useState<QualityId>(DEFAULT_QUALITY);
  // The NEW true-resolution axis (Parsec-style), orthogonal to quality:
  // `resolutionId` picks WHAT the host renders, quality picks how it is encoded.
  // Defaults to the physical screen, which every host can do; the virtual
  // options only take effect once the host advertises `vdAvailable`.
  const [resolutionId, setResolutionId] = useState<string>(PHYSICAL_RESOLUTION_ID);
  const [vdAvailable, setVdAvailable] = useState(false);

  const quality = useMemo(() => findQuality(qualityId), [qualityId]);
  const resolutions = useMemo(() => resolutionOptions(device), [device]);
  const resolution = useMemo(() => findResolution(resolutionId, resolutions), [resolutionId, resolutions]);
  // The request handed to the stream: null (physical) unless the host both
  // advertises the feature AND this option maps to a real size. That gate is
  // the app-side half of the graceful fallback — a host without it never even
  // gets asked, so the shipping downscale path is what runs.
  const virtualRequest = useMemo(
    () => (vdAvailable ? virtualRequestFor(resolution) : null),
    [vdAvailable, resolution]
  );

  // Probe once per active session whether this host can render at a chosen
  // resolution. A 403 (flag off) or an unreachable host resolves to false
  // inside the api helper, so the true-resolution picker simply stays hidden
  // on hosts that cannot do it — no error, no broken option.
  useEffect(() => {
    if (!active) { setVdAvailable(false); return; }
    let disposed = false;
    void api.virtualDisplayStatus().then((s) => {
      if (!disposed) setVdAvailable(s.available);
    });
    return () => { disposed = true; };
  }, [active]);

  return {
    qualityId,
    setQualityId,
    quality,
    resolutionId,
    setResolutionId,
    resolutions,
    resolution,
    vdAvailable,
    virtualRequest,
  };
}

/**
 * Only the presets this host can actually honour. Performance and Ultra need
 * a hardware encoder; offering them to a host without one costs the user a
 * decision and then disappoints it — the same discipline the resolution
 * picker already applies with vdAvailable.
 *
 * Derived AFTER the stream, because the capability is something the host
 * reports once connected. The selection is then corrected as state rather
 * than around it: `quality` feeds useScreenStream, so deriving it back out of
 * the stream would be circular. Correcting the id converges on the next
 * render instead.
 */
export function useQualityAvailability(
  bwpPath: string | null,
  presets: Pick<StreamPresets, 'qualityId' | 'setQualityId'>,
  gamingEnabled: boolean
): readonly QualityPreset[] {
  const { qualityId, setQualityId } = presets;
  const qualityChoices = useMemo(() => availableQuality(bwpPath), [bwpPath]);
  useEffect(() => {
    if (gamingEnabled) return;
    const supported = resolveQualityId(qualityId, qualityChoices);
    if (supported !== qualityId) setQualityId(supported);
  }, [qualityId, qualityChoices, gamingEnabled, setQualityId]);
  return qualityChoices;
}
