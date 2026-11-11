# -*- coding: utf-8 -*-
"""入库后预渲染全球色块图，把「第一次看图」的现场计算挪到后台。

    python -m app.ingest prewarm --model tongyun_c116 --init 20260417

出图口径和前端一致：mercator 全球 1152×1152、WebP 质量 90、不套陆海掩膜。
地区块是随视窗变的，不预渲染，仍然按需生成。
"""
from __future__ import annotations

import logging
import time
from typing import Dict

from app.core import config
from app.services import field_service, image_service

log = logging.getLogger(__name__)


def prewarm(model: str, init: str, projection: str = "mercator",
            mask: str = "none") -> Dict:
    store = field_service.require_run(model, init)
    manifest = store.manifest(init)
    available = {item["name"] for item in manifest.get("channels", [])}
    available.update(manifest.get("derived", []))
    leads = [int(value) for value in manifest.get("leads", [])]
    step = int(manifest.get("step_hours", config.STEP_HOURS))
    started = time.time()
    rendered = cached = skipped = 0

    for meta in config.VARIABLES:
        if meta.get("field") not in available:
            skipped += 1
            continue
        min_lead = int(meta.get("min_lead", step))
        for lead in leads:
            if lead < min_lead:
                continue
            try:
                result = image_service.render(
                    model, init, meta["id"], lead,
                    projection=projection, mask=mask,
                )
            except (ValueError, FileNotFoundError):
                skipped += 1
                continue
            if result["cached"]:
                cached += 1
            else:
                rendered += 1

    summary = {
        "model": model,
        "init": init,
        "rendered": rendered,
        "cached": cached,
        "skipped": skipped,
        "seconds": round(time.time() - started, 1),
    }
    log.info("预渲染 %s/%s：新出 %d 张，已缓存 %d 张，跳过 %d 项，%.1fs",
             model, init, rendered, cached, skipped, summary["seconds"])
    return summary
