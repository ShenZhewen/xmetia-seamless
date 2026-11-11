# -*- coding: utf-8 -*-
"""出图接口：按 (模型, 起报, 变量, 时效) 返回 WebP 色块图。"""
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from app.core import config
from app.services import image_service

router = APIRouter(tags=["images"])


@router.get("/image", response_class=FileResponse)
def image(
    model: str = Query("tongyun_c116"),
    init: str = Query(..., pattern=r"^\d{8}(\d{2})?$"),
    var: str = Query("T2M"),
    lead: int = Query(config.STEP_HOURS),
    bbox: str | None = Query(None, description="lon0,lat0,lon1,lat1（数据集经度 0..360）"),
    width: int | None = Query(None, ge=16, le=config.IMAGE_MAX_SIDE),
    height: int | None = Query(None, ge=16, le=config.IMAGE_MAX_SIDE),
    quality: int | None = Query(None, ge=10, le=100),
    projection: str = Query("equirect", pattern=r"^(equirect|mercator)$"),
    mask: str = Query("none", pattern=r"^(none|land|ocean)$"),
):
    parsed = None
    if bbox:
        try:
            parsed = tuple(float(item) for item in bbox.split(","))
        except ValueError:
            raise HTTPException(status_code=400, detail="bbox 需要 4 个逗号分隔的数字")
        if len(parsed) != 4:
            raise HTTPException(
                status_code=400,
                detail="bbox 需要 4 个值：lon0,lat0,lon1,lat1",
            )
    try:
        result = image_service.render(
            model, init, var, lead, parsed, width, height, quality,
            projection, mask,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except KeyError as exc:
        detail = exc.args[0] if exc.args else str(exc)
        raise HTTPException(status_code=400, detail=str(detail))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return FileResponse(
        result["path"],
        media_type="image/webp",
        headers={"Cache-Control": config.IMAGE_CACHE_CONTROL},
    )
