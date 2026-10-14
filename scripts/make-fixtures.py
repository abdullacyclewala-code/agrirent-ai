#!/usr/bin/env python3
"""Generate the JPEG fixtures used by the trust-layer tests.

Both suites use these files:
  - node scripts/test-trust.mjs   (EXIF parse/preserve, hashing math, policy)
  - cd backend && pytest tests/   (server-side dHash duplicate detection over
                                   decoded pixels, quality metrics, signals, AI mocked)

They are synthetic on purpose, and deliberately textured (noise + large
tonal regions + a machine block), because a perceptual hash on a flat or
repetitive image carries no information: an early flat-grid version of this
generator made two genuinely different scenes hash 3 bits apart, which would
have quietly made the duplicate detector useless. What these fixtures must
guarantee, and what the tests assert:

  * handover vs return            -> clearly DIFFERENT (> 6 bits apart)
  * return vs its re-saved copy   -> a DUPLICATE (<= 6 bits, in practice 0)
  * blurry = the handover scene, out of focus -> fails the quality gate
  * noexif  = no camera metadata at all

Usage:  python3 scripts/make-fixtures.py [outdir]     (default /tmp/fixtures)
"""
import io
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFilter

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/fixtures"

W, H = 1600, 1200


def base_scene(kind: str) -> Image.Image:
    """Two genuinely different framings of 'the same machine'."""
    im = Image.new("RGB", (W, H), (150, 160, 130))
    d = ImageDraw.Draw(im)
    rnd = random.Random(7 if kind == "handover" else 21)

    if kind == "handover":
        d.rectangle([0, 0, W, 300], fill=(170, 190, 210))          # sky band
        machine = [200, 420, 900, 1050]
        meter = [1150, 700, 1450, 900]
    else:
        d.rectangle([0, 0, W, 520], fill=(165, 185, 205))          # more sky: different angle
        machine = [820, 380, 1500, 1080]
        meter = [180, 780, 430, 950]

    # soil texture — gives the downsample something to actually hash
    for _ in range(2600):
        x, y = rnd.randrange(W), rnd.randrange(300, H)
        v = rnd.randrange(-18, 19)
        d.point((x, y), fill=(140 + v, 120 + v, 85 + v))

    # the machine
    d.rectangle(machine, fill=(70, 72, 78), outline=(25, 26, 30), width=8)
    d.rectangle([machine[0] + 60, machine[1] - 120, machine[0] + 260, machine[1]], fill=(50, 52, 58))
    d.ellipse([machine[0], machine[3] - 160, machine[0] + 220, machine[3] + 60], fill=(35, 35, 38))
    d.ellipse([machine[2] - 240, machine[3] - 160, machine[2], machine[3] + 60], fill=(35, 35, 38))

    # hour-meter plate
    d.rectangle(meter, fill=(230, 230, 225), outline=(40, 40, 40), width=6)
    reading = "1240.5 h" if kind == "handover" else "1258.0 h"
    d.text((meter[0] + 24, meter[1] + 40), reading, fill=(15, 15, 15))

    if kind == "return":
        d.line([(420, 520), (900, 860)], fill=(35, 25, 18), width=12)   # the new crack

    return im


def jpeg_bytes(img: Image.Image, quality: int, exif=None) -> bytes:
    buf = io.BytesIO()
    # Pillow rejects exif=None explicitly; omit the kwarg entirely for the
    # no-metadata fixture.
    if exif is None:
        img.save(buf, format="JPEG", quality=quality)
    else:
        img.save(buf, format="JPEG", quality=quality, exif=exif)
    return buf.getvalue()


def main():
    os.makedirs(OUT, exist_ok=True)
    handover_img = base_scene("handover")
    return_img = base_scene("return")

    # 1. handover — clean machine, meter 1240.5, real EXIF + GPS
    ex = handover_img.getexif()
    ex[0x010F] = "Xiaomi"
    ex[0x0110] = "Redmi Note 12"
    ex[0x0131] = "MIUI Camera"
    ex[0x0132] = "2026:10:14 09:41:07"
    ex.get_ifd(0x8769)[0x9003] = "2026:10:14 09:41:07"
    gps = ex.get_ifd(0x8825)
    gps[0x0001] = "N"
    gps[0x0002] = [19.0, 7.0, 48.0]
    gps[0x0003] = "E"
    gps[0x0004] = [72.0, 52.0, 12.0]
    open(os.path.join(OUT, "handover.jpg"), "wb").write(jpeg_bytes(handover_img, 88, ex))

    # 2. return — same machine, meter 1258.0, a new crack, EXIF dated 4 days later
    ex2 = return_img.getexif()
    ex2[0x010F] = "Xiaomi"
    ex2[0x0110] = "Redmi Note 12"
    ex2[0x0132] = "2026:10:18 17:12:00"
    ex2.get_ifd(0x8769)[0x9003] = "2026:10:18 17:12:00"
    open(os.path.join(OUT, "return.jpg"), "wb").write(jpeg_bytes(return_img, 88, ex2))
    # the same scene re-saved = the "filed the handover photo as the return photo" case
    open(os.path.join(OUT, "return_recompressed.jpg"), "wb").write(jpeg_bytes(return_img, 70, ex2))

    # 3. no EXIF at all (screenshot / canvas output / forwarded image)
    flat = Image.new("RGB", (800, 600), (200, 200, 205))
    d = ImageDraw.Draw(flat)
    for i in range(0, 800, 60):
        d.line([(i, 0), (i, 600)], fill=(190, 190, 196), width=3)
    open(os.path.join(OUT, "noexif.jpg"), "wb").write(jpeg_bytes(flat, 80))

    # 4. the handover scene, badly out of focus
    open(os.path.join(OUT, "blurry.jpg"), "wb").write(
        jpeg_bytes(handover_img.filter(ImageFilter.GaussianBlur(9)), 85, ex)
    )

    for name in ["handover.jpg", "return.jpg", "return_recompressed.jpg", "noexif.jpg", "blurry.jpg"]:
        print(f"  {name:28} {os.path.getsize(os.path.join(OUT, name)):>8} bytes")
    print(f"fixtures written to {OUT}")


if __name__ == "__main__":
    main()
