#!/usr/bin/env python3
"""Create original, silent local animation clips; no external footage or model calls.

Requires Pillow and NumPy. If FFmpeg is not on PATH, install imageio-ffmpeg in
mobile/.local/tools or set Q_FFMPEG to an existing encoder executable.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw

MOBILE = Path(__file__).resolve().parents[1]
OUTPUT = MOBILE / "native/assets/video"
WIDTH, HEIGHT, SCALE, FPS, SECONDS = 360, 640, 2, 24, 5
W, H = WIDTH * SCALE, HEIGHT * SCALE
TAU = math.tau


def encoder() -> str:
    configured = os.environ.get("Q_FFMPEG") or shutil.which("ffmpeg")
    if configured:
        return configured
    sys.path.insert(0, str(MOBILE / ".local/tools"))
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def gradient(top: tuple, bottom: tuple) -> Image.Image:
    blend = np.linspace(0, 1, H, dtype=np.float32)[:, None, None]
    values = np.array(top)[None, None, :] * (1 - blend) + np.array(bottom)[None, None, :] * blend
    return Image.fromarray(np.tile(values.astype(np.uint8), (1, W, 1)))


def points(values):
    return [(round(x * SCALE), round(y * SCALE)) for x, y in values]


def ellipse(draw, box, fill, outline=None, width=1):
    draw.ellipse(tuple(round(value * SCALE) for value in box), fill=fill, outline=outline, width=max(1, round(width * SCALE)))


def line(draw, values, fill, width=1):
    draw.line(points(values), fill=fill, width=max(1, round(width * SCALE)), joint="curve")


def polygon(draw, values, fill):
    draw.polygon(points(values), fill=fill)


def wave(y, amplitude, phase, wavelength=220):
    return [(x, y + amplitude * math.sin(x / wavelength * TAU + phase)) for x in range(-10, WIDTH + 12, 3)]


def coast(phase: float) -> Image.Image:
    image = gradient((247, 222, 190), (237, 244, 235))
    draw = ImageDraw.Draw(image, "RGBA")
    sun_x, sun_y = 255 + 3 * math.sin(phase), 155 + 6 * math.cos(phase)
    for radius, opacity in [(70, 12), (61, 17), (52, 28)]:
        ellipse(draw, (sun_x - radius, sun_y - radius, sun_x + radius, sun_y + radius), (255, 244, 209, opacity))
    ellipse(draw, (sun_x - 43, sun_y - 43, sun_x + 43, sun_y + 43), (255, 247, 214, 255))
    polygon(draw, [(-10, 280), (45, 263), (100, 278), (146, 269), (190, 285), (370, 285), (370, 330), (-10, 330)], (145, 177, 170, 255))
    polygon(draw, [(-10, 292), (370, 292), (370, 650), (-10, 650)], (66, 151, 164, 255))
    for index in range(15):
        y = 305 + index * 17
        color = (166, 215, 208, 115 - index * 3)
        line(draw, wave(y, 2 + index * .27, phase + index * .8, 150 + index * 13), color, .8 + index * .04)
    for index in range(19):
        y = 301 + index * 8.5
        spread = 5 + index * 1.2 + 4 * math.sin(phase + index * .9)
        center = sun_x + 7 * math.sin(phase + index * .55)
        line(draw, [(center - spread, y), (center + spread, y)], (255, 239, 190, 185 - index * 5), 1.5)
    shore = [(x, 495 + 31 * math.sin(x / 210 + .3) + 5 * math.sin(phase + x / 120)) for x in range(-10, 372, 3)]
    polygon(draw, shore + [(372, 650), (-10, 650)], (238, 218, 183, 255))
    line(draw, [(x, y - 11) for x, y in shore], (207, 235, 223, 170), 7)
    line(draw, [(x, y - 17) for x, y in shore], (245, 246, 221, 205), 1.7)
    line(draw, [(x, y + 4) for x, y in shore], (214, 194, 158, 90), 1)
    for bx, by, delay in [(71, 184, 0), (94, 169, 1.2)]:
        x = bx + 10 * math.sin(phase + delay)
        flap = 2 + 1.3 * math.sin(phase * 2 + delay)
        line(draw, [(x - 7, by - flap), (x, by), (x + 7, by - flap)], (86, 115, 115, 190), 1.3)
    return image.convert("RGB")


def blue_flow(phase: float) -> Image.Image:
    image = gradient((13, 33, 75), (39, 113, 167))
    draw = ImageDraw.Draw(image, "RGBA")
    for index in range(6):
        y = 185 + index * 79
        curve = [(x, y + 45 * math.sin(x / 260 * math.pi + phase + index * .45)) for x in range(-20, 382, 3)]
        color = [(35, 105, 167, 120), (50, 143, 191, 110), (81, 185, 210, 95), (123, 212, 224, 90), (48, 139, 191, 110), (12, 64, 125, 120)][index]
        polygon(draw, curve + [(382, 660), (-20, 660)], color)
        line(draw, curve, (160, 226, 243, 75), 1.1)
    spheres = [(103, 231, 57, .1), (252, 400, 83, 2.5), (265, 143, 22, 4.1), (66, 491, 20, 5.0)]
    for x, y, radius, delay in spheres:
        cx, cy = x + 15 * math.sin(phase + delay), y + 21 * math.cos(phase + delay)
        ellipse(draw, (cx - radius, cy - radius, cx + radius, cy + radius), (119, 205, 235, 65), (186, 236, 248, 160), 1)
        for inset in range(int(radius), 2, -3):
            offset = (radius - inset) * .22
            ellipse(draw, (cx - inset - offset, cy - inset - offset, cx + inset - offset, cy + inset - offset), (170, 231, 247, 3))
        arc = [(cx + radius * .78 * math.cos(a), cy + radius * .78 * math.sin(a)) for a in np.linspace(3.6, 4.9, 30)]
        line(draw, arc, (214, 250, 255, 190), 1.5)
    for index in range(7):
        y = 119 + index * 62 + 12 * math.cos(phase + index)
        x = 25 + (index * 49) % 310 + 6 * math.sin(phase + index)
        ellipse(draw, (x - 1, y - 1, x + 1, y + 1), (209, 244, 250, 135))
    return image.convert("RGB")


PAPER = gradient((245, 241, 228), (231, 225, 207))
paper_pixels = np.array(PAPER).astype(np.int16)
paper_noise = np.random.default_rng(29).integers(-2, 3, size=(H, W, 1), dtype=np.int16)
PAPER = Image.fromarray(np.clip(paper_pixels + paper_noise, 0, 255).astype(np.uint8))


def paper_hills(phase: float) -> Image.Image:
    image = PAPER.copy()
    draw = ImageDraw.Draw(image, "RGBA")
    sun_y = 184 + 4 * math.sin(phase)
    ellipse(draw, (200, sun_y - 41, 282, sun_y + 41), (207, 149, 96, 255))
    layers = [(325, 48, 270, .0, (189, 195, 166)), (375, 48, 325, 1.5, (149, 166, 142)), (450, 61, 290, 3.0, (104, 137, 121)), (536, 46, 330, 4.6, (64, 106, 96))]
    for index, (y, amplitude, stretch, offset, color) in enumerate(layers):
        drift = 11 * math.sin(phase + offset)
        ridge = [(x, y + amplitude * math.sin((x + drift) / stretch * math.pi + offset) + 4 * math.cos(phase + offset)) for x in range(-15, 378, 3)]
        line(draw, [(x, yy + 4) for x, yy in ridge], (58, 78, 63, 30), 6)
        polygon(draw, ridge + [(378, 660), (-15, 660)], (*color, 255))
        line(draw, ridge, (245, 246, 220, 70), 1.1)
    for index in range(3):
        x = 83 + index * 18 + 9 * math.sin(phase + index * .3)
        y = 228 - index * 8 + 3 * math.cos(phase + index)
        line(draw, [(x - 5, y - 2), (x, y), (x + 5, y - 2)], (105, 117, 94, 150), 1.1)
    return image.convert("RGB")


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    ffmpeg = encoder()
    clips = [("coastal-light", coast), ("blue-flow", blue_flow), ("paper-hills", paper_hills)]
    manifest = {"origin": "Original procedural artwork drawn locally with Pillow/NumPy. No third-party footage, audio, logos or generative-model output.", "clips": []}
    posters = []
    for name, render in clips:
        target = OUTPUT / f"{name}.mp4"
        command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{WIDTH}x{HEIGHT}", "-r", str(FPS), "-i", "pipe:0", "-an", "-c:v", "libx264", "-profile:v", "baseline", "-level", "3.0", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "25", "-movflags", "+faststart", "-t", str(SECONDS), str(target)]
        process = subprocess.Popen(command, stdin=subprocess.PIPE)
        for frame in range(FPS * SECONDS):
            image = render(TAU * frame / (FPS * SECONDS)).resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)
            if frame == 0:
                image.save(OUTPUT / f"{name}.png")
                posters.append(image)
            process.stdin.write(image.tobytes())
        process.stdin.close()
        if process.wait() != 0:
            raise RuntimeError(f"Encoding failed for {name}")
        subprocess.run([ffmpeg, "-v", "error", "-i", str(target), "-f", "null", "-"], check=True)
        entry = {"file": target.name, "poster": f"{name}.png", "width": WIDTH, "height": HEIGHT, "fps": FPS, "duration_seconds": SECONDS, "codec": "H.264 Constrained Baseline", "pixel_format": "yuv420p", "audio": False, "faststart": True, "bytes": target.stat().st_size, "sha256": hashlib.sha256(target.read_bytes()).hexdigest()}
        if entry["bytes"] >= 1_000_000:
            raise RuntimeError(f"{name} exceeds the requested 1 MB target")
        manifest["clips"].append(entry)
        print(json.dumps(entry), flush=True)
    contact = Image.new("RGB", (WIDTH * 3, HEIGHT))
    for index, poster in enumerate(posters):
        contact.paste(poster, (WIDTH * index, 0))
    contact.save(OUTPUT / "preview-sheet.png")
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
