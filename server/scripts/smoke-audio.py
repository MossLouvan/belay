#!/usr/bin/env python3
"""On-device smoke test for the macOS helper's driverless audio capture.

Drives BelayHostMac over its stdio protocol: audiostart, capture for a few
seconds while a sound plays, audiostop — then checks that `type:"audio"` frames
arrive with contiguous seqs, a 960-sample timestamp step, and (the part no CI
can check) NON-ZERO samples, i.e. actual sound.

Usage:
    bash native/build-mac.sh
    python3 scripts/smoke-audio.py

Set BELAY_AUDIO_DEBUG=1 in the environment to make the helper print the
delivered AudioBufferList format to stderr (see AudioCapture.swift).

Known state (2026-09-02, macOS 26 / Apple silicon): frames flow at a perfect
20 ms cadence but every sample is ZERO even while audio is audibly playing —
see the "silent capture" caveat in docs/AUDIO.md before trusting this path.
"""
import base64
import json
import subprocess
import threading
import time
from pathlib import Path

HELPER = Path(__file__).resolve().parent.parent / "native" / "BelayHostMac"
CAPTURE_SECONDS = 5


def main() -> None:
    p = subprocess.Popen([str(HELPER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    frames: list[dict] = []
    replies: list[dict] = []

    def reader() -> None:
        for line in p.stdout:
            try:
                m = json.loads(line)
            except ValueError:
                continue
            (frames if m.get("type") == "audio" else replies).append(m)

    t = threading.Thread(target=reader, daemon=True)
    t.start()

    p.stdin.write('{"id":1,"cmd":"audiostart"}\n')
    p.stdin.flush()
    # Something for the capture to hear. Quiet, but decidedly not silence.
    subprocess.Popen(["afplay", "-v", "0.2", "/System/Library/Sounds/Submarine.aiff"])
    time.sleep(CAPTURE_SECONDS)
    p.stdin.write('{"id":2,"cmd":"audiostop"}\n')
    p.stdin.flush()
    time.sleep(0.5)
    p.stdin.close()
    t.join(timeout=3)
    p.terminate()

    print("replies:", replies)
    print("audio frames:", len(frames))
    if not frames:
        print("FAIL: no audio frames at all")
        return
    first = frames[0]
    payload = base64.b64decode(first["data"])
    print("first: seq", first["seq"], "ts", first["ts"], "codec", first["codec"],
          "sr", first["sr"], "ch", first["ch"], "payload_bytes", len(payload))
    seqs = [f["seq"] for f in frames]
    print("contiguous seqs:", all(b == (a + 1) % 65536 for a, b in zip(seqs, seqs[1:])))
    ts = [f["ts"] for f in frames]
    print("ts step 960 everywhere:", all((b - a) % (2**32) == 960 for a, b in zip(ts, ts[1:])))
    nonzero = [f for f in frames if any(b != 0 for b in base64.b64decode(f["data"]))]
    print("frames with nonzero samples:", len(nonzero), "of", len(frames))
    print("VERDICT:", "SOUND CAPTURED" if nonzero else
          "SILENT CAPTURE — see the caveat in docs/AUDIO.md (delivery works, content is zeros)")


if __name__ == "__main__":
    main()
