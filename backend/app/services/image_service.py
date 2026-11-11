# -*- coding: utf-8 -*-
"""服务端渲染色块图：全球图与地区块，输出 WebP。

- 投影：equirect 直接按等经纬网格铺；mercator 逐像素反算经纬度再采样，
  和前端贴图几何一致（全球 ±85.05112878°，地区块按 Mercator 宽高比定尺寸）；
- 采样：全分辨率场双线性插值，规则和前端原来的客户端出图一致：
  四角都有值才插值，缺测时取第一个有值的角点，全缺测透明；
- 掩膜：land / ocean 用 Natural Earth 1:50m 栅格化的 0.1° 掩膜
  （与前端 public/land-mask.png 同一张），按目标像素中心取最近格；
- 颜色、缺测透明、分级阈值都走 app.core.palettes，与 /api/catalog 的图例同源；
- 每个 (起报, 变量, 时效, 尺寸, bbox, 投影, 掩膜) 的产物落盘到 <起报>/images/，
  起报不可变，所以 HTTP 可以直接给一年期的 immutable 缓存。
"""
from __future__ import annotations

import hashlib
import io
import os
from functools import lru_cache
from pathlib import Path
from typing import Dict

import numpy as np
from PIL import Image

from app.core import config, palettes
from app.services import field_service

MAX_LAT = 85.05112878
PROJECTIONS = ("equirect", "mercator")
MASKS = ("none", "land", "ocean")


def _parse_bbox(bbox: tuple | None) -> tuple | None:
    if bbox is None:
        return None
    lon0, lat0, lon1, lat1 = [float(item) for item in bbox]
    if not (-0.001 <= lon0 < lon1 <= 360.001):
        raise ValueError("bbox 经度需在 0..360 且 lon0 < lon1")
    if not (-90.001 <= lat0 < lat1 <= 90.001):
        raise ValueError("bbox 纬度需在 -90..90 且 lat0 < lat1")
    return (lon0, lat0, lon1, lat1)


def _size(bbox: tuple | None, width: int | None, height: int | None,
          projection: str) -> tuple:
    limit = config.IMAGE_MAX_SIDE
    if projection == "mercator":
        if bbox is None:
            default_width = default_height = int(config.IMAGE_MERCATOR_SIZE)
        else:
            lon0, lat0, lon1, lat1 = bbox
            y0 = float(_mercator_y(lat0))
            y1 = float(_mercator_y(lat1))
            ratio = ((lon1 - lon0) / 360.0) / max(1e-9, (y1 - y0) / (2 * np.pi))
            max_side = int(config.IMAGE_BBOX_MAX_SIDE)
            if ratio >= 1:
                default_width = max_side
                default_height = int(round(max_side / ratio))
            else:
                default_height = max_side
                default_width = int(round(max_side * ratio))
            low = int(config.IMAGE_BBOX_MIN_SIDE)
            default_width = min(limit, max(low, default_width))
            default_height = min(limit, max(low, default_height))
        width = default_width if width is None else int(width)
        height = default_height if height is None else int(height)
    else:
        if width is None:
            width = config.IMAGE_WIDTH if bbox is None else config.IMAGE_BBOX_WIDTH
        width = int(width)
        if height is None:
            if bbox is None:
                height = config.IMAGE_HEIGHT
            else:
                lon0, lat0, lon1, lat1 = bbox
                aspect = (lat1 - lat0) / max(1e-6, lon1 - lon0)
                height = max(16, min(limit, int(round(width * aspect))))
        height = int(height)
    if not (16 <= width <= limit and 16 <= height <= limit):
        raise ValueError("图片尺寸需在 16..%d 之间" % limit)
    return width, height


def _read_values(store, init: str, meta: Dict, lead: int,
                 bbox: tuple | None) -> tuple:
    """全分辨率场；风变量先按格点合成风速再采样（和 /api/field 的口径一致）。"""
    try:
        if meta.get("kind") == "wind":
            u = store.read_field(init, meta["source_fields"][0], lead, 1, bbox)
            v = store.read_field(init, meta["source_fields"][1], lead, 1, bbox)
            return np.hypot(u["values"], v["values"]), u["lat"], u["lon"]
        hit = store.read_field(init, meta["field"], lead, 1, bbox)
    except KeyError:
        raise ValueError(
            "当前数据没有 %s（%s）变量，等数据接入后再看"
            % (meta["id"], meta.get("label", meta["id"]))
        )
    return hit["values"], hit["lat"], hit["lon"]


def _axis_step(axis: np.ndarray) -> float:
    return float((axis[-1] - axis[0]) / (axis.size - 1)) if axis.size > 1 else 0.0


def _fraction(axis: np.ndarray, targets: np.ndarray, wrap: bool) -> np.ndarray:
    """目标经纬度 → 轴上的浮点下标；和前端 fieldImage.fractionFor 同一规则。"""
    n = axis.size
    step = _axis_step(axis)
    if step == 0:
        return np.zeros(targets.shape, dtype="f8")
    if wrap:
        fraction = np.mod(targets - axis[0], 360.0) / step
        return np.where(fraction >= n, fraction - n, fraction)
    return np.clip((targets - axis[0]) / step, 0.0, n - 1.0)


def _sample(values: np.ndarray, lat_axis: np.ndarray, lon_axis: np.ndarray,
            lat_targets: np.ndarray, lon_targets: np.ndarray) -> np.ndarray:
    lat_wrap = abs(_axis_step(lat_axis)) * lat_axis.size > 359
    lon_wrap = abs(_axis_step(lon_axis)) * lon_axis.size > 359
    fy = _fraction(lat_axis, lat_targets, lat_wrap)
    fx = _fraction(lon_axis, lon_targets, lon_wrap)

    ny, nx = values.shape
    j0 = np.clip(np.floor(fy).astype("i8"), 0, ny - 1)
    i0 = np.clip(np.floor(fx).astype("i8"), 0, nx - 1)
    wy = (fy - j0).astype("f4")
    wx = (fx - i0).astype("f4")
    j1 = (j0 + 1) % ny if lat_wrap else np.minimum(j0 + 1, ny - 1)
    i1 = (i0 + 1) % nx if lon_wrap else np.minimum(i0 + 1, nx - 1)

    a = values[np.ix_(j0, i0)]
    b = values[np.ix_(j0, i1)]
    c = values[np.ix_(j1, i0)]
    d = values[np.ix_(j1, i1)]
    full = np.isfinite(a) & np.isfinite(b) & np.isfinite(c) & np.isfinite(d)
    top = a + (b - a) * wx[None, :]
    bottom = c + (d - c) * wx[None, :]
    bilinear = top + (bottom - top) * wy[:, None]
    fallback = np.where(
        np.isfinite(a), a,
        np.where(np.isfinite(b), b, np.where(np.isfinite(c), c, d)),
    )
    return np.where(full, bilinear, fallback).astype("f4")


def _mercator_y(lat: float | np.ndarray) -> np.ndarray:
    lat = np.clip(np.asarray(lat, dtype="f8"), -MAX_LAT, MAX_LAT)
    return np.log(np.tan(np.pi / 4 + lat * np.pi / 360))


def _lat_from_mercator_y(y: np.ndarray) -> np.ndarray:
    return np.degrees(np.arctan(np.sinh(np.asarray(y, dtype="f8"))))


def _mercator_targets(lat_axis: np.ndarray, lon_axis: np.ndarray,
                      bbox: tuple | None, width: int,
                      height: int) -> tuple:
    """输出图每行/每列中心的经纬度。

    ImageData 第 0 行是图片顶边（北），Mercator y 从北界往南界走。
    """
    if bbox is None:
        west, east = -180.0, 180.0
    else:
        west, east = float(lon_axis.min()), float(lon_axis.max())
    south = float(lat_axis.min())
    north = float(lat_axis.max())
    y0 = float(_mercator_y(south))
    y1 = float(_mercator_y(north))

    lon_targets = west + (np.arange(width, dtype="f8") + 0.5) * (
        east - west
    ) / width
    mercator = y1 - (np.arange(height, dtype="f8") + 0.5) * (y1 - y0) / height
    return _lat_from_mercator_y(mercator), lon_targets


@lru_cache(maxsize=1)
def _mask_bits() -> np.ndarray:
    """陆/海掩膜：True=陆地。和前端 landMask.js 的取格规则一致。"""
    with Image.open(config.IMAGE_MASK_PATH) as image:
        gray = np.asarray(image.convert("L"))
    return gray > 127


def _apply_mask(rgba: np.ndarray, mask: str, lat_targets: np.ndarray,
                lon_targets: np.ndarray) -> np.ndarray:
    if mask == "none":
        return rgba
    bits = _mask_bits()
    rows = np.clip(
        ((90.0 - lat_targets) / 180.0 * bits.shape[0]).astype("i8"),
        0, bits.shape[0] - 1,
    )
    cols = np.clip(
        (np.mod(lon_targets + 180.0, 360.0) / 360.0 * bits.shape[1]).astype("i8"),
        0, bits.shape[1] - 1,
    )
    land = bits[np.ix_(rows, cols)]
    keep = land if mask == "land" else ~land
    rgba[..., 3] = np.where(keep, rgba[..., 3], 0)
    return rgba


def _nearest_resize(rgba: np.ndarray, height: int, width: int) -> np.ndarray:
    if rgba.shape[0] == height and rgba.shape[1] == width:
        return rgba
    rows = np.rint(np.linspace(0, rgba.shape[0] - 1, height)).astype("i8")
    cols = np.rint(np.linspace(0, rgba.shape[1] - 1, width)).astype("i8")
    return rgba[np.ix_(rows, cols)]


def _cache_path(store, init: str, var_id: str, lead: int, bbox: tuple | None,
                width: int, height: int, quality: int, projection: str,
                mask: str) -> Path:
    if bbox is None:
        extent = "global"
    else:
        raw = ",".join("%.4f" % item for item in bbox)
        extent = hashlib.md5(raw.encode("ascii")).hexdigest()[:10]
    name = "%s_h%03d_%dx%d_%s_%s_%s_q%d_p%d.webp" % (
        var_id.lower(), lead, width, height, extent, projection, mask, quality,
        palettes.PALETTE_VERSION,
    )
    return store.root / store.model / init / config.IMAGE_DIRNAME / \
        var_id.lower() / name


def render(model: str, init: str, var: str, lead: int,
           bbox: tuple | None = None, width: int | None = None,
           height: int | None = None, quality: int | None = None,
           projection: str = "equirect", mask: str = "none") -> Dict:
    """渲染（或命中缓存）一张图，返回路径和缓存键。"""
    projection = str(projection or "equirect").lower()
    if projection not in PROJECTIONS:
        raise ValueError("projection 只支持 equirect / mercator")
    mask = str(mask or "none").lower()
    if mask not in MASKS:
        raise ValueError("mask 只支持 none / land / ocean")

    store = field_service.require_run(model, init)
    var_id, meta = field_service.variable_meta(var)
    field_service.validate_lead(store, init, lead, meta)
    bbox = _parse_bbox(bbox)
    width, height = _size(bbox, width, height, projection)
    quality = int(quality if quality is not None else config.IMAGE_WEBP_QUALITY)
    if not (10 <= quality <= 100):
        raise ValueError("quality 需在 10..100 之间")

    path = _cache_path(store, init, var_id, lead, bbox, width, height, quality,
                       projection, mask)
    if path.is_file() and path.stat().st_size > 0:
        return {"path": path, "cached": True}

    values, lat_axis, lon_axis = _read_values(store, init, meta, lead, bbox)
    if projection == "mercator":
        lat_targets, lon_targets = _mercator_targets(
            lat_axis, lon_axis, bbox, width, height
        )
        rgba = palettes.colorize(
            _sample(values, lat_axis, lon_axis, lat_targets, lon_targets), meta
        )
    else:
        rgba = palettes.colorize(values, meta)
        rows = np.rint(np.linspace(0, values.shape[0] - 1, height)).astype("i8")
        cols = np.rint(np.linspace(0, values.shape[1] - 1, width)).astype("i8")
        rgba = rgba[np.ix_(rows, cols)]
        lat_targets = lat_axis[rows]
        lon_targets = lon_axis[cols]
    rgba = _apply_mask(rgba, mask, lat_targets, lon_targets)

    image = Image.fromarray(rgba, mode="RGBA")
    buffer = io.BytesIO()
    image.save(buffer, format="WEBP", quality=quality, method=4)

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(".%s.%d.tmp" % (path.name, os.getpid()))
    with open(tmp, "wb") as handle:
        handle.write(buffer.getvalue())
    os.replace(tmp, path)
    return {"path": path, "cached": False}
