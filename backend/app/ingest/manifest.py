# -*- coding: utf-8 -*-
"""manifest.json 读写。

一份起报一个 manifest，记录网格、通道、时效、状态和校验信息。
API 只认 status=ready 的目录；转换过程写在临时目录里，最后整体 rename 发布。
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Dict, List

MANIFEST_NAME = "manifest.json"
SCHEMA_VERSION = 1


def manifest_path(run_dir: str | Path) -> Path:
    return Path(run_dir) / MANIFEST_NAME


def read_manifest(run_dir: str | Path) -> Dict:
    with open(manifest_path(run_dir), "r", encoding="utf-8") as handle:
        return json.load(handle)


def write_manifest(run_dir: str | Path, manifest: Dict) -> Path:
    path = manifest_path(run_dir)
    tmp = path.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(tmp, path)
    return path


def ready_runs(store_root: str | Path, model: str | None = None) -> List[Dict]:
    """列出已发布的起报（status=ready），新的在前。"""
    store_root = Path(store_root)
    models = [model] if model else sorted(
        p.name for p in store_root.iterdir() if p.is_dir()
    ) if store_root.is_dir() else []
    rows: List[Dict] = []
    for model_id in models:
        model_dir = store_root / model_id
        if not model_dir.is_dir():
            continue
        for run_dir in sorted(model_dir.iterdir(), reverse=True):
            if not run_dir.is_dir() or run_dir.name.startswith("."):
                continue
            try:
                manifest = read_manifest(run_dir)
            except (OSError, ValueError):
                continue
            if manifest.get("status") == "ready":
                rows.append(manifest)
    return rows
