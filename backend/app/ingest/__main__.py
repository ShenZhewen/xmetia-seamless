# -*- coding: utf-8 -*-
"""入库命令行。

    python -m app.ingest convert --model tongyun_c116 --init 20260417
    python -m app.ingest verify  --model tongyun_c116 --init 20260417 --samples 50
    python -m app.ingest info    --model tongyun_c116
"""
from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from pathlib import Path

from app.core import config
from app.ingest.convert import convert
from app.ingest.manifest import read_manifest, ready_runs
from app.ingest.verify import verify

log = logging.getLogger("app.ingest")
_INIT_RE = re.compile(r"^\d{8}(\d{2})?$")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.ingest", description="逐时效 nc → Zarr 入库转换"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    convert_cmd = sub.add_parser("convert", help="转换一个起报")
    convert_cmd.add_argument("--model", required=True, choices=sorted(config.MODELS))
    convert_cmd.add_argument("--init", required=True)
    convert_cmd.add_argument("--source", default=None,
                             help="源目录（默认 MODELS[模型].source_root/<起报>）")
    convert_cmd.add_argument("--store-root", default=None)
    convert_cmd.add_argument("--force", action="store_true", help="覆盖已存在的起报")
    convert_cmd.add_argument("--delete-source", action="store_true",
                             help="发布后删除源目录（生产拉取用）")
    convert_cmd.add_argument("--max-leads", type=int, default=None,
                             help="只转换前 N 个时效（调试用）")

    verify_cmd = sub.add_parser("verify", help="抽点对拍")
    verify_cmd.add_argument("--model", required=True, choices=sorted(config.MODELS))
    verify_cmd.add_argument("--init", required=True)
    verify_cmd.add_argument("--samples", type=int, default=20,
                            help="每个场抽多少个点")
    verify_cmd.add_argument("--seed", type=int, default=0)
    verify_cmd.add_argument("--store-root", default=None)

    info_cmd = sub.add_parser("info", help="查看已发布的起报")
    info_cmd.add_argument("--model", default=None, choices=sorted(config.MODELS))
    info_cmd.add_argument("--init", default=None)
    info_cmd.add_argument("--store-root", default=None)

    prewarm_cmd = sub.add_parser("prewarm", help="预渲染全球色块图")
    prewarm_cmd.add_argument("--model", required=True, choices=sorted(config.MODELS))
    prewarm_cmd.add_argument("--init", required=True)
    prewarm_cmd.add_argument("--projection", default="mercator",
                             choices=("equirect", "mercator"))
    prewarm_cmd.add_argument("--mask", default="none",
                             choices=("none", "land", "ocean"))

    watch_cmd = sub.add_parser("watch", help="监听超算最新起报并自动入库")
    watch_cmd.add_argument("--once", action="store_true",
                           help="只查一次（cron 用），不带则常驻循环")
    return parser


def _run(args: argparse.Namespace) -> int:
    if args.command == "convert":
        if not _INIT_RE.fullmatch(args.init):
            raise ValueError("起报格式应为 YYYYMMDD 或 YYYYMMDDHH: %r" % args.init)
        result = convert(
            args.model,
            args.init,
            source=args.source,
            store_root=args.store_root,
            force=args.force,
            delete_source=args.delete_source,
            max_leads=args.max_leads,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    if args.command == "verify":
        if not _INIT_RE.fullmatch(args.init):
            raise ValueError("起报格式应为 YYYYMMDD 或 YYYYMMDDHH: %r" % args.init)
        result = verify(args.model, args.init, samples=args.samples,
                        store_root=args.store_root, seed=args.seed)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["ok"] else 1

    if args.command == "prewarm":
        from app.ingest.prewarm import prewarm

        result = prewarm(args.model, args.init, args.projection, args.mask)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    if args.command == "watch":
        from app.ingest.watch import main as watch_main

        result = watch_main(once=args.once)
        if args.once:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    store_root = Path(args.store_root) if args.store_root else Path(
        config.DATA_STORE_ROOT
    )
    if args.init:
        if not args.model:
            raise ValueError("查看单个起报需要同时给 --model 和 --init")
        manifest = read_manifest(store_root / args.model / args.init)
        print(json.dumps(manifest, ensure_ascii=False, indent=2))
        return 0

    runs = ready_runs(store_root, args.model)
    print(json.dumps(
        {
            "store_root": str(store_root),
            "runs": [
                {
                    "id": item.get("id"),
                    "created_at": item.get("created_at"),
                    "leads": len(item.get("leads", [])),
                    "channels": len(item.get("channels", [])),
                    "derived": len(item.get("derived", [])),
                    "bytes": item.get("stats", {}).get("bytes"),
                }
                for item in runs
            ],
        },
        ensure_ascii=False,
        indent=2,
    ))
    return 0


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        return _run(args)
    except Exception as exc:  # noqa: BLE001 - 命令行入口统一报错
        log.error("%s: %s", type(exc).__name__, exc)
        return 2


if __name__ == "__main__":
    sys.exit(main())
