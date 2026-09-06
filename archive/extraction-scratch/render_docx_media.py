from __future__ import annotations

import math
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "tmp" / "docx_media"
OUT.mkdir(parents=True, exist_ok=True)


def make_contact_sheet(images: list[Path], out_path: Path, start_index: int) -> None:
    cols, rows = 3, 3
    cell_w, cell_h = 520, 390
    canvas = Image.new("RGB", (cols * cell_w, rows * cell_h), "white")
    draw = ImageDraw.Draw(canvas)
    for offset, img_path in enumerate(images):
        idx = start_index + offset
        try:
            with Image.open(img_path) as im:
                im = im.convert("RGB")
                im.thumbnail((cell_w - 20, cell_h - 38))
                x = (offset % cols) * cell_w + (cell_w - im.width) // 2
                y = (offset // cols) * cell_h + 26 + (cell_h - 32 - im.height) // 2
                canvas.paste(im, (x, y))
        except Exception as exc:
            draw.text(((offset % cols) * cell_w + 10, (offset // cols) * cell_h + 50), str(exc), fill="red")
        draw.text(((offset % cols) * cell_w + 8, (offset // cols) * cell_h + 6), f"{idx}: {img_path.name}", fill="black")
    canvas.save(out_path, quality=90)


for docx_path in [ROOT / "PAPA SEMINOR.docx", ROOT / "New Microsoft Word Document (1).docx"]:
    target = OUT / docx_path.stem
    target.mkdir(exist_ok=True)
    with zipfile.ZipFile(docx_path) as zf:
        names = sorted(name for name in zf.namelist() if name.startswith("word/media/"))
        files = []
        for i, name in enumerate(names, 1):
            suffix = Path(name).suffix.lower() or ".bin"
            dest = target / f"{i:03d}{suffix}"
            dest.write_bytes(zf.read(name))
            files.append(dest)
    for sheet_num, start in enumerate(range(0, len(files), 9), 1):
        make_contact_sheet(files[start:start + 9], target / f"contact_{sheet_num:02d}.jpg", start + 1)
    print(f"{docx_path.name}: {len(files)} media files, {math.ceil(len(files)/9)} contact sheets")
