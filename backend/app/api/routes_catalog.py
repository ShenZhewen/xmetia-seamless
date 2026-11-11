# -*- coding: utf-8 -*-
"""目录类接口：变量表 / 起报列表。"""
from fastapi import APIRouter, HTTPException, Query

from app.services import field_service

router = APIRouter(tags=["catalog"])


@router.get("/catalog")
def catalog():
    return field_service.get_catalog()


@router.get("/runs")
def runs(
    model: str = Query("tongyun_c116"),
    limit: int = Query(100, ge=1, le=2000),
):
    try:
        return field_service.list_runs(model, limit)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
