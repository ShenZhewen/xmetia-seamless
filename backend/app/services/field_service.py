# -*- coding: utf-8 -*-
"""业务层：目录信息、起报列表、单场查询（带进程内缓存）。

变量分四类（见 config.VARIABLES 的 kind）：
  raw    直接读文件
  wind   两个分量合成风速，并附带 u/v 给前端画风羽
  accum  把 6h 降水累加成 24/48/72h
  diff   当前时效减去 24h 前的值（变温 / 变压）
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta
from functools import lru_cache
from typing import Dict

import numpy as np

from app.core import config
from app.data.forecast_store import ForecastStore

_STORES = {
    name: ForecastStore(root, config.STEP_HOURS, config.MAX_LEAD_INDEX)
    for name, root in config.FORECAST_SOURCES.items()
}

_VAR_BY_ID = {item["id"].upper(): item for item in config.VARIABLES}


def _get_store(model: str) -> ForecastStore:
    try:
        return _STORES[model]
    except KeyError:
        raise KeyError("未知模型 %r，可用: %s" % (model, sorted(_STORES)))


def get_catalog() -> Dict:
    variables = []
    for item in config.VARIABLES:
        row = dict(item)
        row.setdefault("min_lead", config.STEP_HOURS)
        # 分级色标默认不参与自适应；没写 adaptive 的连续色标可以自适应
        row.setdefault("adaptive", True)
        variables.append(row)
    return {
        "models": [
            {"id": name, "label": config.MODEL_LABELS.get(name, name)}
            for name in _STORES
        ],
        "variables": variables,
        "leads": [
            index * config.STEP_HOURS
            for index in range(1, config.MAX_LEAD_INDEX + 1)
        ],
        "step_hours": config.STEP_HOURS,
    }


def list_runs(model: str, limit: int) -> Dict:
    store = _get_store(model)
    inits = store.list_inits()
    return {"model": model, "total": len(inits), "inits": inits[:limit]}


def get_field(
    model: str,
    init: str,
    var: str,
    lead_hours: int,
    stride: int,
    bbox: tuple | None = None,
) -> Dict:
    """单场查询。参数不合法抛 ValueError，文件缺失抛 FileNotFoundError。"""
    _get_store(model)
    var_id = _validate_var(var)
    _validate_lead(lead_hours, _VAR_BY_ID[var_id])
    if not (1 <= stride <= config.MAX_STRIDE):
        raise ValueError("stride 必须在 1..%d 之间" % config.MAX_STRIDE)
    if bbox is not None:
        lon0, lat0, lon1, lat1 = [float(item) for item in bbox]
        if not (-0.001 <= lon0 < lon1 <= 360.001):
            raise ValueError("bbox 经度需在 0..360 且 lon0 < lon1")
        if not (-90.001 <= lat0 < lat1 <= 90.001):
            raise ValueError("bbox 纬度需在 -90..90 且 lat0 < lat1")
        bbox = (lon0, lat0, lon1, lat1)
    return _cached_field(model, init, var_id, lead_hours, stride, bbox)


def _validate_var(var: str) -> str:
    var_id = var.upper()
    if var_id not in _VAR_BY_ID:
        raise ValueError("未知变量 %r，可用: %s" % (var, sorted(_VAR_BY_ID)))
    return var_id


def _validate_lead(lead_hours: int, meta: Dict | None = None) -> None:
    if lead_hours % config.STEP_HOURS != 0 or not (
        config.STEP_HOURS <= lead_hours <= config.MAX_LEAD_INDEX * config.STEP_HOURS
    ):
        raise ValueError(
            "时效必须是 %d 的倍数，且在 %d..%d 之间"
            % (config.STEP_HOURS, config.STEP_HOURS,
               config.MAX_LEAD_INDEX * config.STEP_HOURS)
        )
    min_lead = int((meta or {}).get("min_lead", config.STEP_HOURS))
    if lead_hours < min_lead:
        raise ValueError(
            "%s 需要时效 ≥ %dh（当前 %dh）"
            % ((meta or {}).get("label", "该产品"), min_lead, lead_hours)
        )


def _derived_values(
    store: ForecastStore,
    init: str,
    meta: Dict,
    lead_hours: int,
    stride: int,
    bbox: tuple | None,
) -> Dict:
    """返回 values/lat/lon 以及 wind 的 u/v、累加窗口等附加信息。"""
    kind = meta.get("kind", "raw")

    if kind == "wind":
        u = store.read_field(init, meta["sources"][0], lead_hours, stride, bbox)
        v = store.read_field(init, meta["sources"][1], lead_hours, stride, bbox)
        values = np.hypot(u["values"], v["values"]).astype("f4")
        return {
            "lat": u["lat"],
            "lon": u["lon"],
            "values": values,
            "u": u["values"],
            "v": v["values"],
            "source_vars": list(meta["sources"]),
        }

    if kind == "accum":
        window = int(meta["window_hours"])
        parts = []
        first = None
        for offset in range(window - config.STEP_HOURS, -1, -config.STEP_HOURS):
            part = store.read_field(
                init, meta["source"], lead_hours - offset, stride, bbox
            )
            if first is None:
                first = part
            parts.append(part["values"])
        # 任何一个时次缺测都保持 NaN，避免把不完整的窗口当成累计值
        values = np.sum(np.stack(parts, axis=0), axis=0, dtype="f4")
        return {
            "lat": first["lat"],
            "lon": first["lon"],
            "values": values,
            "source_vars": [meta["source"]],
            "window_hours": window,
        }

    if kind == "diff":
        lag = int(meta["lag_hours"])
        current = store.read_field(init, meta["source"], lead_hours, stride, bbox)
        earlier = store.read_field(init, meta["source"], lead_hours - lag, stride, bbox)
        values = (current["values"] - earlier["values"]).astype("f4")
        return {
            "lat": current["lat"],
            "lon": current["lon"],
            "values": values,
            "source_vars": [meta["source"]],
            "lag_hours": lag,
        }

    try:
        raw = store.read_field(init, meta["id"], lead_hours, stride, bbox)
    except KeyError as exc:
        raise ValueError(_missing_var_message(meta["id"], meta)) from exc
    return {
        "lat": raw["lat"],
        "lon": raw["lon"],
        "values": raw["values"],
        "source_vars": [meta["id"]],
    }


def _missing_var_message(var: str, meta: Dict | None = None) -> str:
    label = (meta or {}).get("label", var)
    return "当前数据没有 %s（%s）变量，等数据接入后再看" % (var, label)


@lru_cache(maxsize=config.FIELD_CACHE_SIZE)
def _cached_field(
    model: str,
    init: str,
    var: str,
    lead_hours: int,
    stride: int,
    bbox: tuple | None,
) -> Dict:
    meta = _VAR_BY_ID[var]
    raw = _derived_values(_get_store(model), init, meta, lead_hours, stride, bbox)
    finite = raw["values"][np.isfinite(raw["values"])]
    result = {
        "model": model,
        "init": init,
        "var": var,
        "label": meta.get("label", var),
        "lead_hours": lead_hours,
        "valid_time": _valid_time(init, lead_hours),
        "shape": list(raw["values"].shape),
        "lat": [round(float(x), 4) for x in raw["lat"]],
        "lon": [round(float(x), 4) for x in raw["lon"]],
        "values": _to_json_rows(raw["values"]),
        "stats": {
            "min": float(finite.min()) if finite.size else None,
            "max": float(finite.max()) if finite.size else None,
            "mean": float(finite.mean()) if finite.size else None,
        },
        "source_vars": raw.get("source_vars", [var]),
    }
    if "window_hours" in raw:
        result["window_hours"] = raw["window_hours"]
    if "lag_hours" in raw:
        result["lag_hours"] = raw["lag_hours"]
    # 风羽需要原始 u/v 分量；只在风速变量上附带，其他场不额外传输
    if "u" in raw:
        result["u"] = _to_json_rows(raw["u"])
        result["v"] = _to_json_rows(raw["v"])
    return result


def get_series(model: str, init: str, var: str, lat: float, lon: float) -> Dict:
    """一个格点、一个变量的逐时效序列（最近格点，不插值）。"""
    _get_store(model)
    var_id = _validate_var(var)
    if not (-90.0 <= lat <= 90.0):
        raise ValueError("纬度需在 -90..90")
    if not (-180.0 <= lon <= 360.0):
        raise ValueError("经度需在 -180..360")
    try:
        return _cached_series(
            model, init, var_id, round(float(lat), 2), round(float(lon), 2)
        )
    except KeyError as exc:
        raise ValueError(_missing_var_message(var_id, _VAR_BY_ID.get(var_id))) from exc


def _read_point_pair(
    store: ForecastStore, init: str, var: str, lead: int, lat: float, lon: float
) -> tuple:
    hit = store.read_point(init, var, lead, lat, lon)
    return hit["value"], (hit["lat"], hit["lon"])


@lru_cache(maxsize=config.SERIES_CACHE_SIZE)
def _cached_series(model: str, init: str, var: str, lat: float, lon: float) -> Dict:
    store = _get_store(model)
    meta = _VAR_BY_ID[var]
    kind = meta.get("kind", "raw")
    leads = [index * config.STEP_HOURS
             for index in range(1, config.MAX_LEAD_INDEX + 1)]
    grid = {"lat": None, "lon": None}

    def remember_grid(pair):
        if grid["lat"] is None and pair:
            grid["lat"] = round(float(pair[0]), 4)
            grid["lon"] = round(float(pair[1]), 4)

    # 先按基础变量把 60 个时次读一遍，派生量在内存里算，避免重复开文件
    if kind == "wind":
        source_u, source_v = meta["sources"]
        values = []
        for lead in leads:
            hit = store.read_points(init, meta["sources"], lead, lat, lon)
            remember_grid((hit["lat"], hit["lon"]))
            u = hit["values"][source_u]
            v = hit["values"][source_v]
            values.append(None if (u is None or v is None) else math.hypot(u, v))
    elif kind in ("accum", "diff"):
        base = []
        for lead in leads:
            value, pair = _read_point_pair(store, init, meta["source"], lead, lat, lon)
            remember_grid(pair)
            base.append(value)
        if kind == "accum":
            steps = int(meta["window_hours"]) // config.STEP_HOURS
            values = []
            for index in range(len(base)):
                if index < steps - 1 or any(v is None for v in base[index - steps + 1:index + 1]):
                    values.append(None)
                else:
                    values.append(sum(base[index - steps + 1:index + 1]))
        else:
            lag_steps = int(meta["lag_hours"]) // config.STEP_HOURS
            values = []
            for index in range(len(base)):
                if index < lag_steps or base[index] is None or base[index - lag_steps] is None:
                    values.append(None)
                else:
                    values.append(base[index] - base[index - lag_steps])
    else:
        values = []
        for lead in leads:
            value, pair = _read_point_pair(store, init, meta["id"], lead, lat, lon)
            remember_grid(pair)
            values.append(value)

    points = [
        {
            "lead_hours": lead,
            "valid_time": _valid_time(init, lead),
            "value": None if value is None else round(float(value), 2),
        }
        for lead, value in zip(leads, values)
    ]
    result = {
        "model": model,
        "init": init,
        "var": var,
        "label": meta.get("label", var),
        "lat": lat,
        "lon": lon,
        "grid": grid,
        "points": points,
    }
    if "window_hours" in meta:
        result["window_hours"] = meta["window_hours"]
    if "lag_hours" in meta:
        result["lag_hours"] = meta["lag_hours"]
    return result


def _to_json_rows(values: np.ndarray) -> list:
    """NaN -> None，其余保留 2 位小数（显示足够，体积小很多）。"""
    return [
        [None if not math.isfinite(value) else round(float(value), 2) for value in row]
        for row in values
    ]


def _valid_time(init: str, lead_hours: int) -> str:
    fmt = "%Y%m%d%H" if len(init) == 10 else "%Y%m%d"
    start = datetime.strptime(init, fmt)
    return (start + timedelta(hours=lead_hours)).strftime("%Y-%m-%d %H:%M")
