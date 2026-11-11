# -*- coding: utf-8 -*-
"""业务层：目录信息、起报列表、单场/点时序查询（读 data_store 的 Zarr）。

变量分四类（见 config.VARIABLES 的 kind）：
  raw    直接读一个规范通道
  wind   两个分量合成风速并附带 u/v 给前端画风羽
  accum  读入库时算好的 24/48/72h 累计降水
  diff   读入库时算好的 24h 变温 / 变压
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta
from functools import lru_cache
from typing import Dict

import numpy as np

from app.core import config, palettes
from app.data.zarr_store import ZarrStore

_STORES = {
    name: ZarrStore(name, step_hours=spec["step_hours"],
                    max_lead_index=spec["max_lead_index"])
    for name, spec in config.MODELS.items()
}

_VAR_BY_ID = {item["id"].upper(): item for item in config.VARIABLES}


def _get_store(model: str) -> ZarrStore:
    try:
        return _STORES[model]
    except KeyError:
        raise KeyError("未知模型 %r，可用: %s" % (model, sorted(_STORES)))


def require_run(model: str, init: str) -> ZarrStore:
    """确认模型已配置、起报已发布；给其它服务（出图）复用。"""
    store = _get_store(model)
    store.manifest(init)
    return store


def variable_meta(var: str) -> tuple:
    var_id = _validate_var(var)
    return var_id, _VAR_BY_ID[var_id]


def validate_lead(store: ZarrStore, init: str, lead_hours: int,
                  meta: Dict | None = None) -> None:
    """按该起报 manifest 里实际写出的时效校验；两段步长不同（6h / 24h）。"""
    manifest = store.manifest(init)
    leads = manifest.get("leads", [])
    if int(lead_hours) not in leads:
        step = manifest.get("step_hours", config.STEP_HOURS)
        if leads:
            raise ValueError(
                "该起报没有 %dh 时效，可用 %dh..%dh（步长 %dh）"
                % (lead_hours, leads[0], leads[-1], step)
            )
        raise ValueError("该起报没有可用时效")
    min_lead = int((meta or {}).get("min_lead", manifest.get("step_hours", config.STEP_HOURS)))
    if lead_hours < min_lead:
        raise ValueError(
            "%s 需要时效 ≥%dh（当前 %dh）"
            % ((meta or {}).get("label", "该产品"), min_lead, lead_hours)
        )


def _model_leads(spec: Dict) -> list:
    return [index * int(spec["step_hours"])
            for index in range(1, int(spec["max_lead_index"]) + 1)]


def get_catalog() -> Dict:
    variables = []
    for item in config.VARIABLES:
        row = dict(item)
        row.setdefault("min_lead", config.STEP_HOURS)
        # 分级色标默认不参与自适应；没写 adaptive 的连续色标可以自适应
        row.setdefault("adaptive", True)
        variables.append(row)
    models = []
    for name, spec in config.MODELS.items():
        leads = _model_leads(spec)
        models.append({
            "id": name,
            "label": spec["label"],
            "step_hours": int(spec["step_hours"]),
            "lead_min": leads[0],
            "lead_max": leads[-1],
            "leads": leads,
        })
    # 两段时效取并集：24..360h 同时属于两档，但 6h 细档已经把这段覆盖了
    leads = sorted({lead for item in models for lead in item["leads"]})
    return {
        "models": models,
        "variables": variables,
        "leads": leads,
        "step_hours": config.STEP_HOURS,
        **palettes.catalog_palettes(),
    }


def list_runs(model: str, limit: int) -> Dict:
    store = _get_store(model)
    inits = store.list_inits()
    result = {"model": model, "total": len(inits), "inits": inits[:limit]}
    if inits:
        manifest = store.manifest(inits[0])
        result["latest"] = {
            "init": inits[0],
            "step_hours": manifest.get("step_hours"),
            "leads": manifest.get("leads", []),
            "channels": [item["name"] for item in manifest.get("channels", [])],
            "derived": manifest.get("derived", []),
            "grid": manifest.get("grid"),
        }
    return result


def get_field(
    model: str,
    init: str,
    var: str,
    lead_hours: int,
    stride: int,
    bbox: tuple | None = None,
) -> Dict:
    """单场查询。参数不合法抛 ValueError，起报/变量缺失抛 FileNotFoundError/KeyError。"""
    store = _get_store(model)
    var_id = _validate_var(var)
    validate_lead(store, init, lead_hours, _VAR_BY_ID[var_id])
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


def _missing_var_message(var: str, meta: Dict | None = None) -> str:
    label = (meta or {}).get("label", var)
    return "当前数据没有 %s（%s）变量，等数据接入后再看" % (var, label)


def _derived_values(
    store: ZarrStore,
    init: str,
    meta: Dict,
    lead_hours: int,
    stride: int,
    bbox: tuple | None,
) -> Dict:
    """返回 values/lat/lon 以及 wind 的 u/v、累加窗口等附加信息。"""
    kind = meta.get("kind", "raw")
    try:
        if kind == "wind":
            u = store.read_field(init, meta["source_fields"][0], lead_hours,
                                 stride, bbox)
            v = store.read_field(init, meta["source_fields"][1], lead_hours,
                                 stride, bbox)
            values = np.hypot(u["values"], v["values"]).astype("f4")
            return {
                "lat": u["lat"],
                "lon": u["lon"],
                "values": values,
                "u": u["values"],
                "v": v["values"],
                "source_vars": list(meta["sources"]),
            }

        raw = store.read_field(init, meta["field"], lead_hours, stride, bbox)
    except KeyError as exc:
        raise ValueError(_missing_var_message(meta["id"], meta)) from exc

    result = {
        "lat": raw["lat"],
        "lon": raw["lon"],
        "values": raw["values"],
        "source_vars": [meta.get("source", meta["id"])],
    }
    if kind == "accum":
        result["window_hours"] = int(meta["window_hours"])
    if kind == "diff":
        result["lag_hours"] = int(meta["lag_hours"])
    return result


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


@lru_cache(maxsize=config.SERIES_CACHE_SIZE)
def _cached_series(model: str, init: str, var: str, lat: float, lon: float) -> Dict:
    store = _get_store(model)
    meta = _VAR_BY_ID[var]
    manifest = store.manifest(init)
    kind = meta.get("kind", "raw")
    leads = list(manifest["leads"])
    grid = {"lat": None, "lon": None}

    def remember_grid(hit):
        if grid["lat"] is None:
            grid["lat"] = round(float(hit["lat"]), 4)
            grid["lon"] = round(float(hit["lon"]), 4)

    if kind == "wind":
        u = store.read_point_series(init, meta["source_fields"][0], lat, lon)
        v = store.read_point_series(init, meta["source_fields"][1], lat, lon)
        remember_grid(u)
        values = np.hypot(u["values"], v["values"])
    else:
        hit = store.read_point_series(init, meta["field"], lat, lon)
        remember_grid(hit)
        values = hit["values"]

    points = [
        {
            "lead_hours": lead,
            "valid_time": _valid_time(init, lead),
            "value": None if not math.isfinite(value) else round(float(value), 2),
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
