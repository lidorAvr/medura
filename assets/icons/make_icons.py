"""Generate the Medura app icons (campfire + tent on a warm dusk sky).

Run from the project root:
    .venv\\Scripts\\python.exe assets\\icons\\make_icons.py

Outputs (next to this file): icon-192.png, icon-512.png, maskable-512.png,
apple-touch-icon.png (180), badge-96.png (monochrome, for notifications),
og-image.png (1200x630 link preview for WhatsApp).
"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent
SS = 2048  # supersampled working size for the square mark


def hex_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def vertical_gradient(w: int, h: int, stops: list[tuple[float, str]]) -> Image.Image:
    """RGBA image with a vertical multi-stop gradient."""
    cols = [(p, hex_rgb(c)) for p, c in stops]
    strip = Image.new("RGBA", (1, h))
    px = strip.load()
    for y in range(h):
        t = y / max(1, h - 1)
        for i in range(len(cols) - 1):
            p0, c0 = cols[i]
            p1, c1 = cols[i + 1]
            if p0 <= t <= p1:
                k = 0 if p1 == p0 else (t - p0) / (p1 - p0)
                px[0, y] = (*lerp(c0, c1, k), 255)
                break
        else:
            px[0, y] = (*cols[-1][1], 255)
    return strip.resize((w, h))


def radial_glow(size: int, cx: float, cy: float, r: float, color: str, alpha: int) -> Image.Image:
    """Soft radial glow layer (RGBA)."""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    steps = 60
    for i in range(steps, 0, -1):
        rr = r * i / steps
        a = int(alpha * (1 - i / steps) ** 1.6)
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=a)
    solid = Image.new("RGBA", (size, size), (*hex_rgb(color), 255))
    layer.paste(solid, (0, 0), mask)
    return layer


def teardrop(cx: float, base_y: float, w: float, h: float, lean: float = 0.0, m: float = 1.35, n: int = 240):
    """Flame outline: a teardrop with the tip on top; `lean` bends the tip sideways."""
    raw = []
    for i in range(n):
        t = 2 * math.pi * i / n
        x = math.sin(t) * (abs(math.sin(t / 2)) ** m)
        y = math.cos(t)  # 1 = tip, -1 = bottom
        raw.append((x, y))
    max_x = max(abs(x) for x, _ in raw) or 1
    pts = []
    for x, y in raw:
        up = (y + 1) / 2  # 0 bottom → 1 tip
        sx = cx + (x / max_x) * (w / 2) + lean * (up ** 2.2) * w
        sy = base_y - up * h
        pts.append((sx, sy))
    return pts


def fill_shape(canvas: Image.Image, draw_mask, paint: Image.Image) -> None:
    mask = Image.new("L", canvas.size, 0)
    draw_mask(ImageDraw.Draw(mask))
    canvas.alpha_composite(Image.composite(paint, Image.new("RGBA", canvas.size, (0, 0, 0, 0)), mask))


def solid(size, color: str, alpha: int = 255) -> Image.Image:
    return Image.new("RGBA", size, (*hex_rgb(color), alpha))


def rotated_rect(cx, cy, length, thickness, angle_deg):
    a = math.radians(angle_deg)
    dx, dy = math.cos(a) * length / 2, math.sin(a) * length / 2
    nx, ny = -math.sin(a) * thickness / 2, math.cos(a) * thickness / 2
    return [(cx - dx + nx, cy - dy + ny), (cx + dx + nx, cy + dy + ny), (cx + dx - nx, cy + dy - ny), (cx - dx - nx, cy - dy - ny)]


def sparkle(d: ImageDraw.ImageDraw, x, y, r, fill):
    k = r * 0.28
    d.polygon([(x, y - r), (x + k, y - k), (x + r, y), (x + k, y + k), (x, y + r), (x - k, y + k), (x - r, y), (x - k, y - k)], fill=fill)


def draw_campfire(img: Image.Image, cx: float, base_y: float, scale: float) -> None:
    """Logs + three-layer flame centered at cx, sitting on base_y."""
    size = img.size
    s = scale
    # glow
    img.alpha_composite(radial_glow(size[0], cx, base_y - 170 * s, 480 * s, "#FFB547", 185))
    # logs
    d = ImageDraw.Draw(img)
    for ang in (-16, 16):
        pts = rotated_rect(cx, base_y + 8 * s, 420 * s, 70 * s, ang)
        d.polygon(pts, fill=(*hex_rgb("#7A4526"), 255))
        # lighter log ends
        a = math.radians(ang)
        for sign in (-1, 1):
            ex = cx + sign * math.cos(a) * 210 * s
            ey = base_y + 8 * s + sign * math.sin(a) * 210 * s
            d.ellipse([ex - 36 * s, ey - 36 * s, ex + 36 * s, ey + 36 * s], fill=(*hex_rgb("#C98A55"), 255))
            d.ellipse([ex - 16 * s, ey - 16 * s, ex + 16 * s, ey + 16 * s], fill=(*hex_rgb("#A86B3C"), 255))
    # flames (outer → inner)
    layers = [
        (330 * s, 560 * s, -0.10, [(0, "#FFB23F"), (0.55, "#F9772F"), (1, "#E4492B")]),
        (230 * s, 400 * s, 0.07, [(0, "#FFE07A"), (1, "#FFA43A")]),
        (120 * s, 220 * s, -0.05, [(0, "#FFFBE6"), (1, "#FFE38A")]),
    ]
    for w, h, lean, stops in layers:
        top = int(base_y - h - 10 * s)
        grad = Image.new("RGBA", size, (0, 0, 0, 0))
        g = vertical_gradient(size[0], int(h + 40 * s), stops)
        grad.paste(g, (0, max(0, top)))
        shapes = [teardrop(cx, base_y - 12 * s, w, h, lean)]
        if w > 200 * s:  # side tongues make it read as fire, not a droplet
            shapes.append(teardrop(cx - w * 0.3, base_y - 20 * s, w * 0.5, h * 0.58, -0.42))
            shapes.append(teardrop(cx + w * 0.3, base_y - 20 * s, w * 0.46, h * 0.5, 0.4))

        def paint(dm, shapes=shapes):
            for p in shapes:
                dm.polygon(p, fill=255)

        fill_shape(img, paint, grad)


def draw_tent(img: Image.Image, left: float, right: float, base_y: float, apex_y: float) -> None:
    d = ImageDraw.Draw(img)
    apex_x = (left + right) / 2
    d.polygon([(left, base_y), (apex_x, apex_y), (right, base_y)], fill=(*hex_rgb("#FFF1DC"), 255))
    # shaded right half
    d.polygon([(apex_x, apex_y), (right, base_y), (apex_x + (right - apex_x) * 0.18, base_y)], fill=(*hex_rgb("#F2D3A6"), 255))
    # door
    door_h = (base_y - apex_y) * 0.52
    door_w = (right - left) * 0.2
    d.polygon([(apex_x - door_w, base_y), (apex_x, base_y - door_h), (apex_x + door_w, base_y)], fill=(*hex_rgb("#3A2618"), 255))
    # ridge pole tip
    d.line([(apex_x, apex_y), (apex_x - (right - left) * 0.06, apex_y - (base_y - apex_y) * 0.1)], fill=(*hex_rgb("#FFF1DC"), 255), width=max(2, int((right - left) * 0.03)))


def scene_square(size: int = SS, mark_scale: float = 1.0) -> Image.Image:
    """Full-bleed square scene. `mark_scale` < 1 shrinks the drawing toward the center (maskable safe zone)."""
    img = vertical_gradient(size, size, [(0, "#34275E"), (0.42, "#8E3561"), (0.7, "#E0613A"), (1, "#F5A54A")])
    k = size / 1024

    def S(v):  # scale around the center for the mark
        return v * k

    cxs = size / 2
    ms = mark_scale

    def P(x, y):  # map 1024-space point with the mark scale about the center
        return (cxs + (x - 512) * k * ms, cxs + (y - 512) * k * ms)

    # sun glow on the horizon
    sx, sy = P(560, 640)
    img.alpha_composite(radial_glow(size, sx, sy, S(520) * ms, "#FFD27A", 170))
    d = ImageDraw.Draw(img)
    # stars
    for (x, y, r) in [(210, 190, 16), (800, 150, 12), (660, 250, 8), (330, 110, 7), (880, 330, 7)]:
        px, py = P(x, y)
        sparkle(d, px, py, S(r) * ms * 1.6, (255, 244, 214, 235))
    # back hill
    x0, y0 = P(-300, 640)
    x1, y1 = P(760, 1260)
    d.ellipse([x0, y0, x1, y1], fill=(*hex_rgb("#2E5A43"), 255))
    # front hill (full width so the ground always reaches the edges)
    fx0, fy0 = P(-420, 700)
    fx1, fy1 = P(1444, 1560)
    d.ellipse([min(fx0, -size * 0.2), fy0, max(fx1, size * 1.2), max(fy1, size * 1.4)], fill=(*hex_rgb("#1D3A2B"), 255))
    # pines on the back hill
    for (x, base, h) in [(95, 690, 170), (170, 676, 125)]:
        bx, by = P(x, base)
        hh = S(h) * ms
        d.polygon([(bx - hh * 0.32, by), (bx, by - hh), (bx + hh * 0.32, by)], fill=(*hex_rgb("#173226"), 255))
    # tent (left)
    l, b = P(140, 735)
    r, _ = P(450, 735)
    _, a = P(0, 470)
    draw_tent(img, l, r, b, a)
    # campfire (center-right)
    fx, fy = P(690, 770)
    draw_campfire(img, fx, fy, 0.74 * k * ms)
    return img


def rounded(img: Image.Image, radius_ratio: float = 0.225) -> Image.Image:
    size = img.size[0]
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * radius_ratio), fill=255)
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def badge(size: int = 96) -> Image.Image:
    big = 1024
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    mask = Image.new("L", (big, big), 0)
    d = ImageDraw.Draw(mask)
    d.polygon(teardrop(512, 900, 560, 800, -0.08), fill=255)
    d.polygon(teardrop(330, 880, 300, 470, -0.42), fill=255)
    d.polygon(teardrop(700, 880, 280, 420, 0.4), fill=255)
    # cut an inner flame so it reads as fire, not a blob
    hole = Image.new("L", (big, big), 0)
    ImageDraw.Draw(hole).polygon(teardrop(530, 860, 230, 360, 0.06), fill=255)
    mask = ImageChops.subtract(mask, hole)
    img.paste((255, 255, 255, 255), (0, 0), mask)
    return img.resize((size, size), Image.LANCZOS)


def og_image() -> Image.Image:
    w, h = 1200, 630
    img = vertical_gradient(w, h, [(0, "#2C2254"), (0.5, "#8A3460"), (0.82, "#E0613A"), (1, "#F5A54A")])
    img.alpha_composite(_glow_rect(w, h, 300, 560, 520))
    d = ImageDraw.Draw(img)
    for (x, y, r) in [(120, 90, 10), (300, 60, 6), (520, 120, 7), (1080, 70, 9), (980, 170, 5), (700, 40, 5)]:
        sparkle(d, x, y, r * 1.8, (255, 244, 214, 230))
    d.ellipse([-200, 430, 700, 900], fill=(*hex_rgb("#2E5A43"), 255))
    d.ellipse([-300, 500, 1500, 1100], fill=(*hex_rgb("#1D3A2B"), 255))
    draw_tent(img, 330, 510, 540, 400)
    draw_campfire(img, 180, 560, 0.36)
    # Hebrew wordmark (right-aligned; reversed because PIL's basic layout is LTR-only)
    fonts = Path("C:/Windows/Fonts")
    try:
        title_font = ImageFont.truetype(str(fonts / "segoeuib.ttf"), 150)
        sub_font = ImageFont.truetype(str(fonts / "segoeui.ttf"), 50)
    except OSError:
        title_font = sub_font = ImageFont.load_default()
    title = "מדורה"[::-1]
    sub = "כל החבר'ה סביב המדורה"[::-1]
    right = 1120
    tw = d.textlength(title, font=title_font)
    d.text((right - tw, 110), title, font=title_font, fill=(255, 248, 236, 255))
    sw = d.textlength(sub, font=sub_font)
    d.text((right - sw, 300), sub, font=sub_font, fill=(255, 226, 190, 255))
    return img.convert("RGB")


def _glow_rect(w, h, cx, cy, r):
    side = max(w, h)
    return radial_glow(side, cx, cy, r, "#FFD27A", 150).crop((0, 0, w, h))


def main() -> None:
    full = scene_square(SS, 1.0)
    rounded(full).resize((512, 512), Image.LANCZOS).save(OUT / "icon-512.png", optimize=True)
    rounded(full).resize((192, 192), Image.LANCZOS).save(OUT / "icon-192.png", optimize=True)
    full.convert("RGB").resize((180, 180), Image.LANCZOS).save(OUT / "apple-touch-icon.png", optimize=True)
    scene_square(SS, 0.78).convert("RGB").resize((512, 512), Image.LANCZOS).save(OUT / "maskable-512.png", optimize=True)
    badge(96).save(OUT / "badge-96.png", optimize=True)
    og_image().save(OUT / "og-image.png", optimize=True)
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
