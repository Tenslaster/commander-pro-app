"""Regenerate all app icons from assets/icon.png (source of truth)."""
from pathlib import Path
from PIL import Image, ImageOps, ImageEnhance

assets = Path(__file__).resolve().parent
# Prefer original if present as icon-source; otherwise current icon.png
candidates = [assets / "icon-source.png", assets / "icon.png"]
src = next(p for p in candidates if p.is_file())
im = Image.open(src).convert("RGBA")
print("source", src.name, im.size)

def save(img, name, size=None):
    out = img.copy()
    if size:
        out = out.resize((size, size), Image.Resampling.LANCZOS)
    path = assets / name
    out.save(path, "PNG", optimize=True)
    print(f"wrote {name} {out.size} {path.stat().st_size}")


def adaptive_foreground(base, canvas=1024, scale=0.72):
    canvas_im = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    side = int(canvas * scale)
    logo = base.resize((side, side), Image.Resampling.LANCZOS)
    x = (canvas - side) // 2
    canvas_im.paste(logo, (x, x), logo)
    return canvas_im


# Keep a high-res source backup if we overwrite icon.png from larger original
if im.size[0] >= 1024 and src.name != "icon-source.png":
    # backup original before resize overwrite
    backup = assets / "icon-source.png"
    if not backup.exists() or backup.stat().st_size < src.stat().st_size:
        im.save(backup, "PNG")
        print("backed up icon-source.png", im.size)

# Main app icon 1024
save(im, "icon.png", 1024)
save(im, "splash-icon.png", 1024)

fg = adaptive_foreground(im)
save(fg, "android-icon-foreground.png", 1024)

bg = Image.new("RGBA", (1024, 1024), (0, 0, 0, 255))
save(bg, "android-icon-background.png", 1024)

# Monochrome: white glyph, alpha from luminance
gray = ImageOps.grayscale(im)
gray = ImageEnhance.Contrast(gray).enhance(1.4)
mono_rgb = Image.new("RGBA", im.size, (255, 255, 255, 0))
mono_rgb.putalpha(gray)
mono_fg = adaptive_foreground(mono_rgb)
save(mono_fg, "android-icon-monochrome.png", 1024)

save(im, "favicon.png", 196)

notif = mono_rgb.resize((96, 96), Image.Resampling.LANCZOS)
notif_path = assets / "notification-icon.png"
notif.save(notif_path, "PNG", optimize=True)
print("wrote notification-icon.png", notif.size, notif_path.stat().st_size)
print("DONE")
