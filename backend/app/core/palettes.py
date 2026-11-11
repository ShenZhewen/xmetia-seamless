# -*- coding: utf-8 -*-
"""业务色标：和前端 colormap.js 同一套数值，服务端出图与图例共用。

色标只描述"显示单位"下的颜色；物理量先按 VARIABLES 的 scale/offset
换算成显示单位，再上色。分级色标在起始阈值以下是透明的（无降水不填色）。
"""
from __future__ import annotations

import numpy as np

PALETTE_VERSION = 1
LUT_SIZE = 1024

# ── 官方降水色表 ────────────────────────────────────────────────────────
TP24_EDGES = [0.1, 10, 25, 50, 100, 250, 400, 600, 800, 1000]
TP24_COLORS = [
    [161, 241, 141], [61, 186, 61], [96, 184, 255], [0, 0, 255],
    [250, 0, 250], [128, 0, 64], [255, 170, 0], [255, 102, 0],
    [230, 0, 0], [80, 45, 10],
]

TP6_EDGES = [
    0.1, 1.4, 2.7, 4.0, 7.7, 11.3, 15.0, 18.3,
    21.7, 25.0, 36.7, 48.3, 60.0, 80.0, 100.0, 120.0,
]
TP6_COLORS = [
    [165, 243, 141], [130, 223, 115], [95, 204, 89], [61, 185, 63],
    [73, 184, 125], [86, 184, 187], [99, 184, 249], [66, 122, 250],
    [33, 61, 252], [0, 0, 254], [81, 1, 248], [162, 3, 243],
    [243, 5, 238], [205, 3, 180], [167, 1, 122], [120, 0, 60],
]


def _scale_edges(factor: float) -> list:
    return [round(value * factor, 1) for value in TP24_EDGES]


# d3 interpolateRdBu 的 11 个 ColorBrewer 色阶（红 → 蓝）。
# 前端图例负值取蓝端、正值取红端，所以分档表按蓝 → 红给。
_RDBU = [
    [103, 0, 31], [178, 24, 43], [214, 96, 77], [244, 165, 130],
    [253, 219, 199], [247, 247, 247], [209, 229, 240], [146, 197, 222],
    [67, 147, 195], [33, 102, 172], [5, 48, 97],
]
_RDBU_BLUE_TO_RED = _RDBU[::-1]


PALETTES = {
    "tp6": {
        "type": "classes", "edges": TP6_EDGES, "colors": TP6_COLORS,
        "below": TP6_EDGES[0], "belowLabel": "无降水",
    },
    "tp24": {
        "type": "classes", "edges": TP24_EDGES, "colors": TP24_COLORS,
        "below": TP24_EDGES[0], "belowLabel": "无降水",
    },
    "tp48": {
        "type": "classes", "edges": _scale_edges(2), "colors": TP24_COLORS,
        "below": TP24_EDGES[0] * 2, "belowLabel": "无降水",
    },
    "tp72": {
        "type": "classes", "edges": _scale_edges(3), "colors": TP24_COLORS,
        "below": TP24_EDGES[0] * 3, "belowLabel": "无降水",
    },
    "wind": {
        "type": "classes",
        "edges": [0, 2, 4, 6, 8, 12, 16, 20, 25],
        "colors": [
            [120, 160, 200], [100, 200, 180], [130, 220, 120],
            [220, 230, 100], [250, 200, 80], [250, 150, 60],
            [240, 90, 50], [210, 40, 40], [150, 20, 90],
        ],
    },
    "temperature": {
        "type": "stops",
        "stops": [
            [-40, [40, 10, 80]], [-30, [80, 30, 140]], [-20, [70, 70, 200]],
            [-10, [40, 120, 235]], [0, [120, 200, 240]], [10, [140, 225, 150]],
            [20, [255, 235, 110]], [30, [255, 160, 60]], [40, [210, 40, 40]],
            [50, [120, 0, 0]],
        ],
        "tickValues": [-40, -20, 0, 20, 40],
    },
    "pressure": {
        "type": "stops",
        "stops": [
            [950, [30, 40, 120]], [980, [60, 110, 220]],
            [1000, [140, 190, 245]], [1010, [235, 240, 250]],
            [1013, [255, 255, 255]], [1020, [250, 235, 160]],
            [1030, [250, 180, 80]], [1040, [220, 80, 40]],
            [1060, [120, 20, 20]],
        ],
        "tickValues": [950, 1000, 1013, 1030, 1050],
    },
    "height": {
        "type": "stops",
        "stops": [
            [480, [20, 20, 90]], [500, [30, 80, 180]], [520, [40, 150, 210]],
            [540, [80, 190, 130]], [560, [220, 220, 100]],
            [580, [240, 150, 60]], [600, [200, 50, 40]],
        ],
        "tickValues": [480, 510, 540, 570, 600],
    },
    "moisture": {
        "type": "stops",
        "stops": [
            [0, [120, 80, 50]], [3, [190, 150, 105]], [6, [235, 220, 190]],
            [9, [180, 220, 150]], [12, [90, 185, 140]], [16, [45, 130, 200]],
            [20, [30, 70, 170]], [24, [45, 30, 120]],
        ],
        "tickValues": [0, 5, 10, 15, 20],
    },
    "component": {
        "type": "diverging", "center": 0, "colors": _RDBU_BLUE_TO_RED,
    },
    "diff": {
        "type": "diverging", "center": 0, "colors": _RDBU_BLUE_TO_RED,
    },
}

# 前端 colormap.js 里负值取蓝端、正值取红端；和 _RDBU_BLUE_TO_RED 一致。

DEFAULT_PALETTE = "temperature"


def _interp_stops(stops: list, value: float) -> list:
    if value <= stops[0][0]:
        return list(stops[0][1])
    if value >= stops[-1][0]:
        return list(stops[-1][1])
    for index in range(1, len(stops)):
        hi_value, hi_color = stops[index]
        if value <= hi_value:
            lo_value, lo_color = stops[index - 1]
            delta = hi_value - lo_value or 1.0
            t = (value - lo_value) / delta
            return [
                int(round(lo_color[0] + (hi_color[0] - lo_color[0]) * t)),
                int(round(lo_color[1] + (hi_color[1] - lo_color[1]) * t)),
                int(round(lo_color[2] + (hi_color[2] - lo_color[2]) * t)),
            ]
    return list(stops[-1][1])


def _interp_rgba(table: list, t: float) -> list:
    """在离散色阶上线性插值；t∈[0,1]。"""
    t = min(1.0, max(0.0, t))
    pos = t * (len(table) - 1)
    index = min(len(table) - 2, int(pos))
    frac = pos - index
    lo, hi = table[index], table[index + 1]
    return [
        int(round(lo[channel] + (hi[channel] - lo[channel]) * frac))
        for channel in range(3)
    ]


def palette_of(meta: dict) -> dict:
    return PALETTES.get(meta.get("palette"), PALETTES[DEFAULT_PALETTE])


def _build_lut(meta: dict, size: int = LUT_SIZE) -> np.ndarray | None:
    """连续色标预生成 [lo, hi] 上的 RGBA 表；分级色标不需要。"""
    palette = palette_of(meta)
    lo, hi = [float(item) for item in meta["range"]]
    lut = np.zeros((size, 4), dtype=np.uint8)
    for index in range(size):
        value = lo + (hi - lo) * index / (size - 1)
        if palette["type"] == "stops":
            rgb = _interp_stops(palette["stops"], value)
        elif palette["type"] == "diverging":
            t = index / (size - 1)
            rgb = _interp_rgba(_RDBU_BLUE_TO_RED, t)  # 低值蓝、高值红
        else:
            return None
        lut[index] = [rgb[0], rgb[1], rgb[2], 255]
    return lut


def colorize(values: np.ndarray, meta: dict) -> np.ndarray:
    """物理量 (H, W) → RGBA (H, W, 4)，NaN 和分级起始阈值以下透明。"""
    scale = float(meta.get("scale", 1.0))
    offset = float(meta.get("offset", 0.0))
    display = np.asarray(values, dtype="f8") * scale + offset
    finite = np.isfinite(display)
    shape = display.shape
    rgba = np.zeros((shape[0], shape[1], 4), dtype=np.uint8)

    palette = palette_of(meta)
    if palette["type"] == "classes":
        edges = np.asarray(palette["edges"], dtype="f4")
        colors = np.asarray(palette["colors"], dtype=np.uint8)
        index = np.searchsorted(edges, display, side="right") - 1
        valid = finite & (index >= 0)
        clipped = np.clip(index, 0, len(colors) - 1)
        rgba[..., :3] = colors[clipped]
        rgba[..., 3] = np.where(valid, 255, 0)
        return rgba

    lut = _build_lut(meta)
    lo, hi = [float(item) for item in meta["range"]]
    center = float(palette.get("center", 0.0))
    if palette["type"] == "diverging" and lo < center < hi:
        t = np.where(
            display <= center,
            0.5 * np.clip((display - lo) / (center - lo), 0, 1),
            0.5 + 0.5 * np.clip((display - center) / (hi - center), 0, 1),
        )
    else:
        t = np.clip((display - lo) / (hi - lo or 1.0), 0, 1)
    index = np.rint(t * (len(lut) - 1)).astype("i4")
    rgba[..., :3] = lut[index, :3]
    rgba[..., 3] = np.where(finite, 255, 0)
    return rgba


def catalog_palettes() -> dict:
    """目录接口里的色标定义：前端图例/自适应配色直接用，不用再抄一份。"""
    return {
        "version": PALETTE_VERSION,
        "palettes": PALETTES,
    }
