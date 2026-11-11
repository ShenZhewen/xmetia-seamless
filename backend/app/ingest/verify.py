# -*- coding: utf-8 -*-
"""转换产物对拍：从原始 nc 抽点重算，和 Zarr 里的值比较。

    python -m app.ingest verify --model tongyun_c116 --init 20260417 --samples 50

原始场逐点对源文件；派生场按同一定义从源文件重算
（风速 = hypot(u,v)，累计降水 = 窗口求和，24h 变化 = 当前减 lag 前）。
"""
from __future__ import annotations

import math
from functools import lru_cache
from pathlib import Path
from typing import Dict, List

import numpy as np
import xarray as xr
import zarr

from app.core import config
from app.ingest.convert import _resolve_var, _transform_value
from app.ingest.manifest import read_manifest


def _close(expected: float, actual: float) -> bool:
    if math.isnan(expected) and math.isnan(actual):
        return True
    if math.isnan(expected) or math.isnan(actual):
        return False
    return abs(expected - actual) <= 1e-4 + 1e-5 * abs(expected)


def verify(model: str, init: str, samples: int = 20,
           store_root: str | Path | None = None, seed: int = 0) -> Dict:
    store_root = Path(store_root) if store_root else Path(config.DATA_STORE_ROOT)
    run_dir = store_root / model / init
    manifest = read_manifest(run_dir)
    if manifest.get("status") != "ready":
        raise ValueError("%s 状态是 %r，不是 ready" % (run_dir, manifest.get("status")))

    channels = {item["name"]: item for item in manifest["channels"]}
    source_dir = Path(manifest["source"]["path"])
    step_hours = int(manifest["step_hours"])
    n_leads = len(manifest["leads"])
    nlat = int(manifest["grid"]["lat"]["size"])
    nlon = int(manifest["grid"]["lon"]["size"])

    fields = zarr.open_group(str(run_dir / "fields.zarr"), mode="r")
    derived_store = zarr.open_group(str(run_dir / "derived.zarr"), mode="r")
    field_names = set(fields.array_keys())
    derived_names = set(derived_store.array_keys())

    # 集合源是 member_*/NNN.nc，转换时存的是集合平均，对拍也按平均重算。
    member_dirs = (
        sorted(path for path in source_dir.glob("member_*") if path.is_dir())
        if manifest.get("ensemble") else []
    )

    @lru_cache(maxsize=64)
    def source_array(canonical: str, index: int) -> np.ndarray:
        meta = channels[canonical]
        paths = (
            [member / ("%03d.nc" % index) for member in member_dirs]
            if member_dirs else [source_dir / ("%03d.nc" % index)]
        )
        stack = []
        for path in paths:
            with xr.open_dataset(path, decode_times=False) as ds:
                stack.append(np.asarray(
                    ds[_resolve_var(ds, meta["source"])].values, dtype="f8"
                ).squeeze())
        if len(stack) == 1:
            return stack[0]
        with np.errstate(invalid="ignore"):
            return np.nanmean(np.stack(stack), axis=0)

    def source_value(canonical: str, index: int, j: int, k: int) -> float:
        return _transform_value(
            float(source_array(canonical, index)[j, k]),
            channels[canonical].get("transform", {}),
        )

    def expected_derived(name: str, i: int, j: int, k: int) -> float:
        winds = {
            "wspd10": ("u10m", "v10m"),
            "wspd100": ("u100m", "v100m"),
            "wspd850": ("u850", "v850"),
        }
        if name in winds:
            u, v = winds[name]
            return math.hypot(
                source_value(u, i + 1, j, k), source_value(v, i + 1, j, k)
            )

        if name in ("tp24", "tp48", "tp72"):
            window = int(name[2:]) // step_hours
            if i - window + 1 < 0:
                return float("nan")
            return float(sum(
                source_value("tp", index + 1, j, k)
                for index in range(i - window + 1, i + 1)
            ))

        diffs = {"tdiff24": "t2m", "pdiff24": "msl"}
        if name in diffs:
            lag = 24 // step_hours
            if i - lag < 0:
                return float("nan")
            return (
                source_value(diffs[name], i + 1, j, k)
                - source_value(diffs[name], i - lag + 1, j, k)
            )

        raise KeyError("没有派生场 %s 的对拍定义" % name)

    rng = np.random.default_rng(seed)
    checked = 0
    failures: List[Dict] = []

    def record(name: str, i: int, j: int, k: int,
               expected: float, actual: float) -> None:
        nonlocal checked
        checked += 1
        if _close(expected, actual):
            return
        failures.append({
            "field": name,
            "lead_hours": (i + 1) * step_hours,
            "lat_index": j,
            "lon_index": k,
            "expected": expected,
            "actual": actual,
        })

    for name in channels:
        if name not in field_names:
            continue
        array = fields[name]
        for _ in range(samples):
            i = int(rng.integers(0, n_leads))
            j = int(rng.integers(0, nlat))
            k = int(rng.integers(0, nlon))
            record(name, i, j, k,
                   source_value(name, i + 1, j, k), float(array[i, j, k]))

    for name in manifest.get("derived", []):
        if name not in derived_names:
            continue
        array = derived_store[name]
        for _ in range(samples):
            i = int(rng.integers(0, n_leads))
            j = int(rng.integers(0, nlat))
            k = int(rng.integers(0, nlon))
            record(name, i, j, k,
                   expected_derived(name, i, j, k), float(array[i, j, k]))

    return {
        "model": model,
        "init": init,
        "checked": checked,
        "failed": len(failures),
        "ok": not failures,
        "failures": failures[:10],
    }
