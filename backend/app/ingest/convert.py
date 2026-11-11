# -*- coding: utf-8 -*-
"""入库转换：逐时效 .nc → Zarr 数据集。

在 backend/ 目录下执行：
    python -m app.ingest convert --model tongyun_c116 --init 20260417

产物（config.DATA_STORE_ROOT/<模型>/<起报>/）：
    manifest.json   元数据与状态，API 只认 status=ready
    fields.zarr     13 个原始场 (lead, lat, lon)，float32
    derived.zarr    8 个派生场
    overview.zarr   1° 缩略层，全球图和全球读数直接读它

转换全程写在 <模型>/.tmp-* 里，成功后才整体 rename 发布；失败不会污染线上。
"""
from __future__ import annotations

import hashlib
import logging
import os
import shutil
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import xarray as xr
import zarr
from numcodecs import Blosc

from app.core import config
from app.ingest.manifest import (
    MANIFEST_NAME,
    SCHEMA_VERSION,
    read_manifest,
    write_manifest,
)

log = logging.getLogger(__name__)

CONVERTER_VERSION = 1
ZARR_COMPRESSOR = Blosc(cname="zstd", clevel=3, shuffle=Blosc.BITSHUFFLE)


# ── 源文件与网格 ───────────────────────────────────────────────────────
def _member_dirs(source: Path) -> List[Path]:
    """集合源：member_000/ .. member_NNN/，每个成员目录下是 001.nc.. 逐时效文件。"""
    return sorted(path for path in source.glob("member_*") if path.is_dir())


def _source_files(source: Path, n_leads: int,
                  ensemble: bool = False) -> Dict[int, List[Path]]:
    """每个时效对应的源文件列表：单预报是 1 个，集合是全部成员。"""
    if ensemble:
        members = _member_dirs(source)
        if len(members) < 2:
            raise FileNotFoundError(
                "%s 下只有 %d 个 member_* 目录，集合平均需要至少 2 个"
                % (source, len(members))
            )
        return {
            index: [member / f"{index:03d}.nc" for member in members]
            for index in range(1, n_leads + 1)
        }
    return {
        index: [source / f"{index:03d}.nc"] for index in range(1, n_leads + 1)
    }


def _grid_from_dataset(ds: xr.Dataset) -> Tuple[np.ndarray, np.ndarray]:
    lat = np.asarray(ds["lat"].values, dtype="f8")
    lon = np.asarray(ds["lon"].values, dtype="f8")
    return lat, lon


def _check_grid(lat: np.ndarray, lon: np.ndarray, spec: Dict) -> None:
    """源网格必须和模型定义一致；不一致直接报错，不悄悄重采样。"""
    for name, values, want in (("lat", lat, spec["grid"]["lat"]),
                               ("lon", lon, spec["grid"]["lon"])):
        if values.size != int(want["size"]):
            raise ValueError(
                "%s 长度 %d 与模型定义 %d 不一致"
                % (name, values.size, int(want["size"]))
            )
        if values.size > 1:
            step = float(values[1] - values[0])
            if abs(step - float(want["step"])) > 1e-6:
                raise ValueError(
                    "%s 步长 %.6f 与模型定义 %.6f 不一致"
                    % (name, step, float(want["step"]))
                )
        if abs(float(values[0]) - float(want["start"])) > 1e-6:
            raise ValueError(
                "%s 起点 %.6f 与模型定义 %.6f 不一致"
                % (name, float(values[0]), float(want["start"]))
            )


def _resolve_var(ds: xr.Dataset, name: str) -> str:
    if name in ds.data_vars:
        return name
    table = {key.lower(): key for key in ds.data_vars}
    try:
        return table[name.lower()]
    except KeyError:
        raise KeyError("文件里没有变量 %s，可用: %s" % (name, sorted(ds.data_vars)))


def _has_var(ds: xr.Dataset, name: str) -> bool:
    return name in ds.data_vars or name.lower() in {
        key.lower() for key in ds.data_vars
    }


# ── 单位换算 ───────────────────────────────────────────────────────────
def _transform_for(spec: Dict, canonical: str) -> Dict:
    return dict(spec.get("transforms", {}).get(canonical, {}))


def _apply_transform(values, transform: Dict) -> np.ndarray:
    """按模型定义把源值换算成规范单位（float64 计算，最后存 float32）。

    expm1 用于源里存 log1p(mm) 的降水；scale/offset 用于 kg/kg→g/kg、英寸→mm 等。
    """
    data = np.asarray(values, dtype="f8")
    if transform.get("expm1"):
        data = np.expm1(data)
    scale = float(transform.get("scale", 1.0))
    offset = float(transform.get("offset", 0.0))
    if scale != 1.0 or offset != 0.0:
        data = data * scale + offset
    return data.astype("f4")


def _transform_value(value: float, transform: Dict) -> float:
    if value is None or not np.isfinite(value):
        return float("nan")
    if transform.get("expm1"):
        value = float(np.expm1(value))
    return float(value) * float(transform.get("scale", 1.0)) + float(
        transform.get("offset", 0.0)
    )


# ── 派生场 ─────────────────────────────────────────────────────────────
def _derive(arrays: Dict[str, np.ndarray], n_leads: int,
            step_hours: int) -> Tuple[Dict[str, np.ndarray], List[str]]:
    """在入库时算好派生场；缺输入的派生场记入 missing，不报错。"""
    derived: Dict[str, np.ndarray] = {}
    missing: List[str] = []

    for name, (u, v) in (
        ("wspd10", ("u10m", "v10m")),
        ("wspd100", ("u100m", "v100m")),
        ("wspd850", ("u850", "v850")),
    ):
        if u in arrays and v in arrays:
            derived[name] = np.hypot(arrays[u], arrays[v]).astype("f4")
        else:
            missing.append(name)

    if "tp" in arrays:
        for hours in (24, 48, 72):
            window = hours // step_hours
            if n_leads < window:
                missing.append("tp%d" % hours)
                continue
            accum = np.full_like(arrays["tp"], np.nan, dtype="f4")
            for index in range(window - 1, n_leads):
                accum[index] = arrays["tp"][index - window + 1:index + 1].sum(
                    axis=0, dtype="f4"
                )
            derived["tp%d" % hours] = accum
    else:
        missing.extend(["tp24", "tp48", "tp72"])

    lag = 24 // step_hours
    for source, name in (("t2m", "tdiff24"), ("msl", "pdiff24")):
        if source in arrays and n_leads > lag:
            diff = np.full_like(arrays[source], np.nan, dtype="f4")
            diff[lag:] = arrays[source][lag:] - arrays[source][:-lag]
            derived[name] = diff
        else:
            missing.append(name)

    return derived, missing


# ── 写 Zarr ────────────────────────────────────────────────────────────
def _write_group(path: Path, arrays: Dict[str, np.ndarray], lat: np.ndarray,
                 lon: np.ndarray, chunks: Tuple[int, int, int]) -> None:
    group = zarr.open_group(str(path), mode="w")
    group.create_dataset("lat", data=np.asarray(lat, dtype="f8"))
    group.create_dataset("lon", data=np.asarray(lon, dtype="f8"))
    for name in sorted(arrays):
        data = arrays[name]
        chunk = tuple(min(int(c), int(s)) for c, s in zip(chunks, data.shape))
        dataset = group.create_dataset(
            name,
            shape=data.shape,
            chunks=chunk,
            dtype="f4",
            compressor=ZARR_COMPRESSOR,
            fill_value=np.nan,
        )
        dataset[...] = data


def _grid_manifest(lat: np.ndarray, lon: np.ndarray) -> Dict:
    def axis(values: np.ndarray) -> Dict:
        step = float(values[1] - values[0]) if values.size > 1 else 0.0
        return {
            "start": round(float(values[0]), 6),
            "step": round(step, 6),
            "size": int(values.size),
        }

    return {"lat": axis(lat), "lon": axis(lon)}


def _source_digest(files: Dict[int, List[Path]]) -> str:
    digest = hashlib.sha256()
    for index in sorted(files):
        for path in files[index]:
            stat = path.stat()
            digest.update(
                ("%d|%s/%s|%d|%d\n" % (
                    index, path.parent.name, path.name,
                    stat.st_size, stat.st_mtime_ns,
                )).encode()
            )
    return digest.hexdigest()


def _tree_size(root: Path) -> int:
    total = 0
    for path in root.rglob("*"):
        if path.is_file():
            total += path.stat().st_size
    return total


# ── 发布 / 清理 ────────────────────────────────────────────────────────
def _publish(tmp: Path, final: Path, force: bool) -> None:
    """临时目录整体 rename 成正式目录；旧目录先挪走，失败时回滚。"""
    trash = None
    if final.exists():
        if not force:
            raise FileExistsError(str(final))
        trash = final.with_name(".old-%s-%s" % (final.name, uuid.uuid4().hex[:6]))
        final.rename(trash)
    try:
        tmp.rename(final)
    except Exception:
        if trash is not None and trash.exists() and not final.exists():
            trash.rename(final)
        raise
    if trash is not None:
        shutil.rmtree(trash, ignore_errors=True)


# ── 主流程 ─────────────────────────────────────────────────────────────
def convert(model: str, init: str, source: str | Path | None = None,
            store_root: str | Path | None = None, force: bool = False,
            delete_source: bool = False,
            max_leads: int | None = None) -> Dict:
    if model not in config.MODELS:
        raise KeyError("未知模型 %r，可用: %s" % (model, sorted(config.MODELS)))
    spec = config.MODELS[model]
    store_root = Path(store_root) if store_root else Path(config.DATA_STORE_ROOT)
    final = store_root / model / init

    if final.exists() and not force:
        try:
            manifest = read_manifest(final)
        except (OSError, ValueError):
            manifest = {}
        if manifest.get("status") == "ready":
            return {
                "status": "skipped",
                "reason": "已转换，需要重转加 --force",
                "run": str(final),
            }
        raise FileExistsError("%s 已存在但没有 ready manifest；确认后加 --force" % final)

    source_path = Path(source) if source else Path(spec["source_root"]) / init
    if not source_path.is_dir():
        raise FileNotFoundError("源目录不存在: %s" % source_path)

    step_hours = int(spec["step_hours"])
    max_index = int(spec["max_lead_index"])
    n_leads = min(int(max_leads), max_index) if max_leads else max_index
    if n_leads < 1:
        raise ValueError("--max-leads 至少为 1")

    ensemble = bool(spec.get("ensemble"))
    files = _source_files(source_path, n_leads, ensemble)
    missing_files = [
        "%s/%s" % (path.parent.name, path.name)
        for paths in files.values() for path in paths if not path.is_file()
    ]
    if missing_files:
        raise FileNotFoundError(
            "缺 %d 个时效文件（%s%s）"
            % (
                len(missing_files),
                ", ".join(missing_files[:8]),
                " ..." if len(missing_files) > 8 else "",
            )
        )

    (store_root / model).mkdir(parents=True, exist_ok=True)
    tmp = store_root / model / (".tmp-%s-%d-%s" % (init, os.getpid(),
                                                   uuid.uuid4().hex[:6]))
    started = time.time()

    try:
        with xr.open_dataset(files[1][0], decode_times=False) as ds:
            lat, lon = _grid_from_dataset(ds)
            _check_grid(lat, lon, spec)
            present = [
                (source_name, meta)
                for source_name, meta in spec["channels"].items()
                if _has_var(ds, source_name)
            ]
            missing_channels = [
                meta["name"]
                for source_name, meta in spec["channels"].items()
                if not _has_var(ds, source_name)
            ]
        if not present:
            raise ValueError("源文件里没有任何配置的产品通道")

        ny, nx = int(lat.size), int(lon.size)
        arrays: Dict[str, np.ndarray] = {
            meta["name"]: np.full((n_leads, ny, nx), np.nan, dtype="f4")
            for _, meta in present
        }
        n_members = len(files[1])
        log.info("读取 %d 个时效、%d 个通道（缺 %s）%s", n_leads, len(present),
                 missing_channels or "无",
                 "，%d 个成员求平均" % n_members if ensemble else "")

        for index, paths in files.items():
            offset = index - 1
            # 集合源逐成员累加后取平均；单预报就是一条路径，均值即原值。
            total = {meta["name"]: np.zeros((ny, nx), dtype="f8")
                     for _, meta in present}
            count = {meta["name"]: np.zeros((ny, nx), dtype="f4")
                     for _, meta in present}
            for path in paths:
                with xr.open_dataset(path, decode_times=False) as ds:
                    for source_name, meta in present:
                        canonical = meta["name"]
                        data = np.asarray(
                            ds[_resolve_var(ds, source_name)].values, dtype="f8"
                        ).squeeze()
                        if data.shape != (ny, nx):
                            raise ValueError(
                                "%s 的 %s 形状 %s 和网格 (%d, %d) 不一致"
                                % (path.name, source_name, data.shape, ny, nx)
                            )
                        ok = np.isfinite(data)
                        total[canonical][ok] += data[ok]
                        count[canonical][ok] += 1
            for _, meta in present:
                canonical = meta["name"]
                with np.errstate(invalid="ignore", divide="ignore"):
                    mean = np.where(
                        count[canonical] > 0,
                        total[canonical] / count[canonical],
                        np.nan,
                    )
                arrays[canonical][offset] = _apply_transform(
                    mean, _transform_for(spec, canonical)
                )
            if index % 10 == 0 or index == n_leads:
                log.info("  已读 %d/%d", index, n_leads)

        derived, missing_derived = _derive(arrays, n_leads, step_hours)
        log.info("原始场 %d 个，派生场 %d 个（缺 %s）", len(arrays), len(derived),
                 missing_derived or "无")

        raw_chunks = (1, min(180, ny), min(360, nx))
        _write_group(tmp / "fields.zarr", arrays, lat, lon, raw_chunks)
        _write_group(tmp / "derived.zarr", derived, lat, lon, raw_chunks)

        stride = max(1, int(spec.get("overview_stride", 1)))
        combined = dict(arrays)
        combined.update(derived)
        overview = {name: values[:, ::stride, ::stride]
                    for name, values in combined.items()}
        overview_chunks = (1, min(181, ny), min(360, nx))
        _write_group(tmp / "overview.zarr", overview, lat[::stride], lon[::stride],
                     overview_chunks)

        manifest = {
            "schema_version": SCHEMA_VERSION,
            "converter_version": CONVERTER_VERSION,
            "status": "ready",
            "id": "%s/%s" % (model, init),
            "model": model,
            "model_label": spec["label"],
            "init": init,
            "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "step_hours": step_hours,
            "leads": [(index + 1) * step_hours for index in range(n_leads)],
            "grid": _grid_manifest(lat, lon),
            "overview_grid": _grid_manifest(lat[::stride], lon[::stride]),
            "channels": [
                {
                    "name": meta["name"],
                    "source": source_name,
                    "unit": config.CANONICAL_UNITS.get(meta["name"], meta.get("unit")),
                    "transform": _transform_for(spec, meta["name"]),
                }
                for source_name, meta in present
            ],
            "missing_channels": missing_channels,
            "derived": sorted(derived),
            "missing_derived": missing_derived,
            "source": {
                "path": str(source_path.resolve()),
                "files": n_leads,
                "digest": _source_digest(files),
            },
            "ensemble": (
                {"members": n_members, "aggregate": "mean"} if ensemble else None
            ),
            "store": {
                "fields": "fields.zarr",
                "derived": "derived.zarr",
                "overview": "overview.zarr",
            },
            "stats": {"bytes": _tree_size(tmp)},
        }
        write_manifest(tmp, manifest)
        _publish(tmp, final, force)
        log.info("已发布 %s", final)

        if delete_source:
            shutil.rmtree(source_path)
            log.info("已删除源目录 %s", source_path)

        return {
            "status": "ready",
            "run": str(final),
            "manifest": str(final / MANIFEST_NAME),
            "channels": [item["name"] for item in manifest["channels"]],
            "derived": manifest["derived"],
            "missing_channels": missing_channels,
            "missing_derived": missing_derived,
            "bytes": manifest["stats"]["bytes"],
            "seconds": round(time.time() - started, 1),
        }
    except Exception:
        if tmp.exists():
            shutil.rmtree(tmp, ignore_errors=True)
        raise
