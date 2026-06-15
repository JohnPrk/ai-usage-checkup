#!/usr/bin/env python3
"""9티어 엠블럼 시트(3x3 한 장)를 개별 PNG로 분할 + 동일 크기/투명 정규화.

방식(스케일 안 함):
  - 시트는 생성기가 한 번에 같은 스케일로 그렸으므로 확대/축소하지 않는다.
  - 흰 배경을 투명화(바깥 흰색만, 보석 스파클 보존).
  - 9개를 "같은 크기 박스"에 네이티브 그대로 배치:
      박스 = 가장 넓은 폭 × 가장 높은 높이(= 챌린저 왕관~바닥 꼭지) + 여백.
      각 엠블럼은 바닥 꼭지 정렬 + 가로 중앙. → 출력 W·H 가 전부 동일.
셀 경계는 흰 거터(여백)를 자동 탐지(불균등 간격 OK), 실패 시 균등 3등분.

사용: 재생성한 9티어 시트를 ~/Downloads 에 저장 → python3 scripts/normalize-emblems.py
"""
from pathlib import Path
import glob
import os
import numpy as np
from PIL import Image, ImageDraw

DL = Path.home() / "Downloads"
OUT = DL / "emblems_normalized"
SHEET = None          # None 이면 ~/Downloads 최신 Gemini 이미지 자동 사용
COLS, ROWS = 3, 3
PAD = 24              # 박스 가장자리 여백(px)
FLOOD_THRESH = 40     # 바깥 흰색 flood-fill 색차
WHITE = 238           # 코너가 이 값 이상이면 흰 배경

TIER_NAMES = [
    "1_bronze", "2_silver", "3_gold",
    "4_platinum", "5_emerald", "6_diamond",
    "7_master", "8_grandmaster", "9_challenger",
]


def newest_sheet():
    files = glob.glob(str(DL / "Gemini_Generated_Image_*.png"))
    return Path(max(files, key=os.path.getmtime)) if files else None


def to_transparent(rgb):
    """가장자리에 닿은 흰색만 투명. 안쪽 흰색(보석 스파클)은 보존."""
    work = rgb.copy()
    SENT = (255, 0, 255)
    W, H = work.size
    for seed in [(0, 0), (W - 1, 0), (0, H - 1), (W - 1, H - 1)]:
        if min(rgb.getpixel(seed)) >= WHITE:
            ImageDraw.floodfill(work, seed, SENT, thresh=FLOOD_THRESH)
    a = np.array(work)
    rgba = np.dstack([np.array(rgb), np.full((H, W), 255, np.uint8)])
    rgba[(a[:, :, 0] == 255) & (a[:, :, 1] == 0) & (a[:, :, 2] == 255), 3] = 0
    return Image.fromarray(rgba, "RGBA")


def runs(on):
    out, i, n = [], 0, len(on)
    while i < n:
        if on[i]:
            j = i
            while j < n and on[j]:
                j += 1
            out.append((i, j)); i = j
        else:
            i += 1
    return out


def bands(alpha, axis, want):
    """투명도 투영으로 want 개의 콘텐츠 밴드(좌표 범위) 탐지. 실패 시 균등 분할."""
    proj = alpha.sum(axis=axis)
    thr = max(proj.max() * 0.01, 255 * 3)
    rs = runs(proj > thr)
    if len(rs) != want:
        L = len(proj)
        return [(round(k * L / want), round((k + 1) * L / want)) for k in range(want)]
    return rs


def tight_bbox(cell):
    """AA 잔털(아주 옅은 알파)은 무시하고 또렷한 본체 bbox 만. → '꼭지' 정렬 일관성."""
    ca = np.array(cell.split()[3])
    m = (ca > 24).astype(np.uint8) * 255
    return Image.fromarray(m).getbbox()


def process_sheet(path):
    img = Image.open(path).convert("RGBA")
    # 입력이 이미 투명(배경 제거됨)이면 그 알파를 신뢰. 아니면 흰배경 floodfill.
    if (np.array(img.split()[3]) == 0).mean() > 0.05:
        full = img
    else:
        full = to_transparent(img.convert("RGB"))
    alpha = np.array(full.split()[3])
    xb = bands(alpha, 0, COLS)
    yb = bands(alpha, 1, ROWS)
    # 1패스: 셀별 tight crop (네이티브 스케일 그대로, 확대/축소 없음)
    crops = []
    for (y0, y1) in yb:
        for (x0, x1) in xb:
            cell = full.crop((x0, y0, x1, y1))
            bb = tight_bbox(cell)
            crops.append(cell.crop(bb) if bb else None)
    valid = [c for c in crops if c]
    if not valid:
        return []
    # 공통 박스: 최대 폭 × 최대 높이(챌린저 왕관~바닥) + 여백 → 모두 동일 크기
    box_w = max(c.width for c in valid) + 2 * PAD
    box_h = max(c.height for c in valid) + 2 * PAD
    OUT.mkdir(parents=True, exist_ok=True)
    res = []
    for i, crop in enumerate(crops):
        if crop is None:
            continue
        canvas = Image.new("RGBA", (box_w, box_h), (0, 0, 0, 0))
        x = (box_w - crop.width) // 2            # 가로 중앙
        y = box_h - PAD - crop.height            # 바닥 꼭지 정렬(아래 기준)
        canvas.paste(crop, (x, y), crop)
        name = TIER_NAMES[i] if i < len(TIER_NAMES) else f"cell_{i}"
        canvas.save(OUT / f"{name}.png")
        res.append((name, crop.size, (box_w, box_h)))
    return res


def contact(results):
    """체크무늬 위 미리보기. 모든 출력이 동일 박스라 같은 배율로 표시."""
    ims = [Image.open(OUT / f"{n}.png").convert("RGBA") for n, _, _ in results]
    if not ims:
        return
    cell = 360
    cols = 3
    rows = (len(ims) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * cell, rows * cell))
    c = 18
    px = sheet.load()
    for y in range(sheet.height):
        for x in range(sheet.width):
            px[x, y] = (205, 210, 215, 255) if ((x // c + y // c) % 2 == 0) else (235, 238, 240, 255)
    bw, bh = ims[0].size
    f = min(cell / bw, cell / bh)
    disp = (round(bw * f), round(bh * f))
    for i, im in enumerate(ims):
        r, cc = divmod(i, cols)
        th = im.resize(disp)
        ox = cc * cell + (cell - disp[0]) // 2
        oy = r * cell + (cell - disp[1]) // 2
        sheet.alpha_composite(th, (ox, oy))
    sheet.convert("RGB").save(OUT / "_contact9.png")


def main():
    sheet = Path(SHEET) if SHEET else newest_sheet()
    if not sheet or not sheet.exists():
        print("시트 없음 → 재생성한 9티어 시트를 ~/Downloads 에 저장 후 다시 실행.")
        return
    print(f"시트: {sheet.name}")
    res = process_sheet(sheet)
    for name, (cw, ch), (bw, bh) in res:
        print(f"[ok] {name}: native {cw}x{ch}  -> box {bw}x{bh}")
    contact(res)
    print(f"미리보기: {OUT / '_contact9.png'}")


if __name__ == "__main__":
    main()
