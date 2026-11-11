# -*- coding: utf-8 -*-
"""场数据接口：按 (模型, 起报, 变量, 时效) 取一张抽稀后的全球场。"""
from fastapi import APIRouter, HTTPException, Query

from app.core import config
from app.services import field_service

router = APIRouter(tags=["fields"])


@router.get("/field")
def field(
    model: str = Query("tongyun_c116"),
    init: str = Query(..., pattern=r"^\d{8}(\d{2})?$"),
    var: str = Query("T2M"),
    lead: int = Query(config.STEP_HOURS),
    stride: int = Query(config.DEFAULT_STRIDE, ge=1, le=config.MAX_STRIDE),
    bbox: str | None = Query(None, description="lon0,lat0,lon1,lat1（数据集经度 0..360）"),
):
    parsed = None
    if bbox:
        try:
            parsed = tuple(float(item) for item in bbox.split(","))
        except ValueError:
            raise HTTPException(status_code=400, detail="bbox 需要 4 个逗号分隔的数字")
        if len(parsed) != 4:
            raise HTTPException(status_code=400, detail="bbox 需要 4 个值：lon0,lat0,lon1,lat1")
    try:
        return field_service.get_field(model, init, var, lead, stride, parsed)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="没有该起报/时效的文件: %s" % exc)
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/series")
def series(
    model: str = Query("tongyun_c116"),
    init: str = Query(..., pattern=r"^\d{8}(\d{2})?$"),
    var: str = Query("T2M"),
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=360),
):
    try:
        return field_service.get_series(model, init, var, lat, lon)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="没有可用文件: %s" % exc)
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
