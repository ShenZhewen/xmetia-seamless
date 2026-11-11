# -*- coding: utf-8 -*-
"""监听超算最新起报：发现 → 拉取 → 转换发布 → 清理旧起报 → 预渲染。

跑在业务服务器上（只有它有到超算容器的 SSH 通道）：

    python -m app.ingest watch --once    # cron 每 30 分钟调一次
    python -m app.ingest watch           # 常驻循环

「最新」的判定：inference_result/<批次>/ 下同时存在两个模型的 <起报>/ 目录，
各 60 个时效、head.json 已 succeeded、且 5 分钟内没有文件在写；取起报名最大的一个。
风顺是集合预报，起报目录下是 member_000/.. 各 60 个 nc，入库时求集合平均；
拉下来的成员原始文件在转换发布后删掉，磁盘上只留集合平均。

拉取或转换失败时线上旧起报原样保留；两个模型都发布成功后才清理超出保留数的
旧起报和旧源文件（默认保留最近 KEEP_INITS 个起报）。
状态写在 data_store/.watch_state.json，同一批次的起报、完成时间没变就不重复拉。
"""
from __future__ import annotations

import fcntl
import json
import logging
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Dict, Optional

from app.core import config
from app.ingest.convert import convert
from app.ingest.manifest import read_manifest
from app.ingest.prewarm import prewarm

log = logging.getLogger(__name__)

SSH_HOST = "xay-editor"
REMOTE_ROOT = "/workspace/data/LiuJs/inference_result"
# 站内模型 id → 超算上的目录名
REMOTE_MODELS = {
    "tongyun_c116": "weather_era_0p25_tongyun_c116",
    "fengshun_ens": "s2s_era_1p5_fengshun_ens",
}
EXPECTED_FILES = 60
# 保留最近几个起报（data_store 与 data_incoming 同一口径）
KEEP_INITS = 7
INTERVAL_SECONDS = 30 * 60
ASKPASS = Path.home() / ".ssh" / "askpass-xay.sh"
STATE_NAME = ".watch_state.json"

# 远端只读探测：打印 "批次|起报|风顺完成时间|Tongyun完成时间"，取最新一行。
_DISCOVER = r"""
ROOT=/workspace/data/LiuJs/inference_result
FS=s2s_era_1p5_fengshun_ens
TY=weather_era_0p25_tongyun_c116
for bdir in "$ROOT"/*/; do
  b=${bdir%/}; b=${b##*/}
  [ -f "$ROOT/$b/$FS/head.json" ] || continue
  [ -f "$ROOT/$b/$TY/head.json" ] || continue
  grep -q '"state": "succeeded"' "$ROOT/$b/$FS/head.json" || continue
  grep -q '"state": "succeeded"' "$ROOT/$b/$TY/head.json" || continue
  for idir in "$ROOT/$b/$FS"/*/; do
    init=${idir%/}; init=${init##*/}
    case "$init" in [0-9]*) ;; *) continue ;; esac
    tdir="$ROOT/$b/$TY/$init"
    [ -d "$tdir" ] || continue
    # 风顺是集合预报：member_000/ .. member_NNN/，每个成员各 60 个时效（更早的
    # 单预报布局是起报目录下直接放 001.nc..060.nc，两种都认）。
    if [ -d "$idir/member_000" ]; then
      nm=$(ls -d "$idir"/member_* 2>/dev/null | wc -l)
      [ "$nm" -ge 2 ] || continue
      ok=1
      for mdir in "$idir"/member_*; do
        n=$(ls "$mdir" 2>/dev/null | grep -c '^[0-9][0-9][0-9]\.nc$' || true)
        [ "$n" -eq 60 ] || { ok=0; break; }
      done
      [ "$ok" -eq 1 ] || continue
    else
      n1=$(ls "$idir" 2>/dev/null | grep -c '^[0-9][0-9][0-9]\.nc$' || true)
      [ "$n1" -eq 60 ] || continue
    fi
    n2=$(ls "$tdir" 2>/dev/null | grep -c '^[0-9][0-9][0-9]\.nc$' || true)
    [ "$n2" -eq 60 ] || continue
    [ -z "$(find "$idir" -name '*.nc' -mmin -5 | head -1)" ] || continue
    [ -z "$(find "$tdir" -name '*.nc' -mmin -5 | head -1)" ] || continue
    f1=$(grep -o '"finished_at": "[^"]*"' "$ROOT/$b/$FS/head.json" | head -1 | cut -d'"' -f4)
    f2=$(grep -o '"finished_at": "[^"]*"' "$ROOT/$b/$TY/head.json" | head -1 | cut -d'"' -f4)
    echo "$b|$init|$f1|$f2"
  done
done | sort -t'|' -k2,2 -k1,1 | tail -1
"""


def _env() -> Dict[str, str]:
    env = os.environ.copy()
    env["SSH_ASKPASS"] = str(ASKPASS)
    env["SSH_ASKPASS_REQUIRE"] = "force"
    env["DISPLAY"] = env.get("DISPLAY") or ":0"
    return env


def _ssh(script: str, timeout: int = 120) -> str:
    result = subprocess.run(
        ["setsid", "-w", "ssh", "-o", "StrictHostKeyChecking=no",
         SSH_HOST, "sh -s"],
        input=script, text=True, capture_output=True, env=_env(),
        timeout=timeout,
    )
    if result.returncode != 0:
        raise RuntimeError("ssh 探测失败: %s" % (result.stderr.strip() or result.returncode))
    return result.stdout


def discover() -> Optional[Dict]:
    """返回 {"batch","init","finished"}；没有同时齐两档的起报时返回 None。"""
    line = _ssh(_DISCOVER).strip().splitlines()
    if not line:
        return None
    batch, init, fs_finished, ty_finished = line[-1].split("|")
    return {
        "batch": batch,
        "init": init,
        "finished": {"fengshun_ens": fs_finished, "tongyun_c116": ty_finished},
    }


def pull(model: str, batch: str, init: str) -> Path:
    remote = "%s:%s/%s/%s/%s/" % (
        SSH_HOST, REMOTE_ROOT, batch, REMOTE_MODELS[model], init,
    )
    local = Path(config.DATA_INCOMING_ROOT) / model / init
    local.mkdir(parents=True, exist_ok=True)
    cmd = [
        "setsid", "-w", "rsync", "-rt", "--partial",
        "--chmod=D755,F644", "--info=progress2", remote, str(local) + "/",
    ]
    log.info("拉取 %s/%s ← %s", model, init, remote)
    subprocess.run(cmd, check=True, env=_env(), timeout=4 * 3600)
    return local


def _state_path() -> Path:
    return Path(config.DATA_STORE_ROOT) / STATE_NAME


def _read_state() -> Dict:
    try:
        with open(_state_path(), "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def _write_state(state: Dict) -> None:
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def _cleanup(keep_init: str) -> list:
    """保留最近 KEEP_INITS 个起报；顺手清掉转换中断残留的 .tmp-*/.old-*。"""
    removed = []
    for model in REMOTE_MODELS:
        for root in (Path(config.DATA_STORE_ROOT) / model,
                     Path(config.DATA_INCOMING_ROOT) / model):
            if not root.is_dir():
                continue
            entries = []
            for path in root.iterdir():
                if not path.is_dir():
                    continue
                if path.name.startswith((".tmp-", ".old-")):
                    if time.time() - path.stat().st_mtime > 6 * 3600:
                        shutil.rmtree(path, ignore_errors=True)
                    continue
                entries.append(path)
            # 目录名就是起报串，倒序即新→旧；本轮刚发布的起报一定要留。
            entries.sort(key=lambda path: path.name, reverse=True)
            keep = {path.name for path in entries[:KEEP_INITS]}
            keep.add(keep_init)
            for path in entries:
                if path.name in keep:
                    continue
                shutil.rmtree(path, ignore_errors=True)
                removed.append(str(path))
    return removed


def run_once() -> Dict:
    target = discover()
    if target is None:
        log.info("超算上还没有同时齐两档的起报")
        return {"status": "no_target"}

    state = _read_state()
    if (
        state.get("batch") == target["batch"]
        and state.get("init") == target["init"]
        and state.get("finished") == target["finished"]
    ):
        log.info("没有新起报（%s/%s）", target["batch"], target["init"])
        return {"status": "unchanged", **target}

    init = target["init"]
    force = state.get("batch") == target["batch"] and state.get("init") == init
    log.info("发现新起报 %s/%s（重跑=%s），开始拉取", target["batch"], init, force)

    for model in REMOTE_MODELS:
        pull(model, target["batch"], init)

    results = {}
    for model in REMOTE_MODELS:
        # 集合模型的成员原始文件体积大，发布后只留集合平均。
        results[model] = convert(
            model, init, force=force,
            delete_source=bool(config.MODELS[model].get("ensemble")),
        )
        log.info("转换完成 %s/%s: %s", model, init, results[model].get("status"))

    # 两档都必须是 ready，才允许删旧
    for model in REMOTE_MODELS:
        manifest = read_manifest(Path(config.DATA_STORE_ROOT) / model / init)
        if manifest.get("status") != "ready":
            raise RuntimeError("%s/%s 没有发布成功，保留旧起报" % (model, init))

    removed = _cleanup(init)
    for path in removed:
        log.info("已删除旧数据 %s", path)

    for model in REMOTE_MODELS:
        try:
            prewarm(model, init)
        except Exception as exc:  # noqa: BLE001 - 预渲染失败不影响数据可用
            log.warning("预渲染 %s/%s 失败: %s", model, init, exc)

    state = {
        "batch": target["batch"],
        "init": init,
        "finished": target["finished"],
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "models": {
            model: results[model].get("status") for model in REMOTE_MODELS
        },
    }
    _write_state(state)
    return {"status": "updated", "removed": removed, **state}


def _acquire_lock():
    path = Path(config.DATA_STORE_ROOT) / ".watch.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, "w")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        return None
    return handle


def main(once: bool = False) -> Optional[Dict]:
    lock = _acquire_lock()
    if lock is None:
        log.info("已有一个监听任务在跑，本次跳过")
        return {"status": "locked"}
    try:
        while True:
            try:
                result = run_once()
            except Exception as exc:  # noqa: BLE001 - 常驻循环不能因为一次失败退出
                log.error("本轮失败: %s: %s", type(exc).__name__, exc)
                if once:
                    raise
                result = {"status": "error", "error": str(exc)}
            if once:
                return result
            time.sleep(INTERVAL_SECONDS)
    finally:
        lock.close()
