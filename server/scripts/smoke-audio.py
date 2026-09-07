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

Wait for capture to acknowledge startup before playing the test sound. Playing
it during ScreenCaptureKit initialization previously produced false negatives.
"""
import base64
import json
import subprocess
import threading
import time
from pathlib import Path

HELPER = Path(__file__).resolve().parent.parent / "native" / "BelayHostMac"
CAPTURE_SECONDS = 5
START_TIMEOUT_SECONDS = 12


def main() -> int:
    p = subprocess.Popen([str(HELPER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    frames: list[dict] = []
    replies: list[dict] = []
    start_reply = threading.Event()

    def reader() -> None:
        for line in p.stdout:
            try:
                m = json.loads(line)
            except ValueError:
                continue
            (frames if m.get("type") == "audio" else replies).append(m)
            if m.get("id") == 1:
                start_reply.set()

    t = threading.Thread(target=reader, daemon=True)
    t.start()

    sound = None
    try:
        p.stdin.write('{"id":1,"cmd":"audiostart"}\n')
        p.stdin.flush()
        if not start_reply.wait(START_TIMEOUT_SECONDS):
            print("FAIL: audio capture did not acknowledge startup", replies)
            return 1
        started = next(reply for reply in replies if reply.get("id") == 1)
        if started.get("ok") is not True or started.get("capturing") is not True:
            print("FAIL: audio capture could not start", started)
            return 1
        # Only play once SCK is listening, not while it is starting up.
        sound = subprocess.Popen(["afplay", "-v", "0.2", "/System/Library/Sounds/Submarine.aiff"])
        time.sleep(CAPTURE_SECONDS)
        p.stdin.write('{"id":2,"cmd":"audiostop"}\n')
        p.stdin.flush()
    finally:
        p.stdin.close()
        try:
            p.wait(timeout=3)
        except subprocess.TimeoutExpired:
            p.terminate()
            try:
                p.wait(timeout=3)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait()
        t.join(timeout=3)
        p.stdout.close()
        if sound is not None:
            if sound.poll() is None:
                sound.terminate()
            sound.wait()

    print("replies:", replies)
    print("audio frames:", len(frames))
    if not frames:
        print("FAIL: no audio frames at all")
        return 1
    first = frames[0]
    payload = base64.b64decode(first["data"])
    print("first: seq", first["seq"], "ts", first["ts"], "codec", first["codec"],
          "sr", first["sr"], "ch", first["ch"], "payload_bytes", len(payload))
    seqs = [f["seq"] for f in frames]
    contiguous = all(b == (a + 1) % 65536 for a, b in zip(seqs, seqs[1:]))
    print("contiguous seqs:", contiguous)
    ts = [f["ts"] for f in frames]
    correct_timestamps = all((b - a) % (2**32) == 960 for a, b in zip(ts, ts[1:]))
    print("ts step 960 everywhere:", correct_timestamps)
    nonzero = [f for f in frames if any(b != 0 for b in base64.b64decode(f["data"]))]
    print("frames with nonzero samples:", len(nonzero), "of", len(frames))
    passed = bool(nonzero) and contiguous and correct_timestamps
    print("VERDICT:", "SOUND CAPTURED" if passed else
          "FAIL — capture must contain nonzero audio with valid sequence and timestamps")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
