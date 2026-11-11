# -*- coding: utf-8 -*-
"""后端配置：全部是字面量默认值，直接改这里，不用环境变量。"""
from pathlib import Path

# 项目根目录下的 data/<模型>/，本机和服务器都是这个相对布局，不用改路径。
_PROJECT_ROOT = Path(__file__).resolve().parents[3]

# 产品由两段拼成：Tongyun 0–15 天（6h、0.25°）+ 风顺 S2S 15–60 天（逐日、1.5°）。
# 两段在 data_store 里仍是两个内部档，前端只显示一个「未来 60 天」产品、按时效自动选源。
STEP_HOURS = 6          # 时间轴最细步长（决定默认时效与最小时效）
DEFAULT_STRIDE = 4      # 默认空间抽稀倍数（0.25° → 1°）
MAX_STRIDE = 16
FIELD_CACHE_SIZE = 64   # 进程内场缓存条数（约 1MB/张，够覆盖一整轮播放）
SERIES_CACHE_SIZE = 64  # 点时序缓存条数（一次 60 个时效）

HOST = "0.0.0.0"
PORT = 8000
CORS_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://tongyun.world:5173",
]

# ── 变量表 ───────────────────────────────────────────────────────────────
# range 是“显示单位”下的配色区间；文件里的物理量用 scale/offset 换算：
#   display = raw * scale + offset
# kind:
#   raw    直接读 nc 里的同名变量
#   wind   sources 两个分量，返回风速，并附带 u/v 给风羽
#   accum  把 source（TP）从 lead-window+step 累加到 lead
#   diff   当前 lead 的值减去 lead-lag_hours 的值
# contour 是等值线间隔（显示单位），null 表示不画。
# adaptive=false 的分级色标不参与“自适应配色”，避免破坏官方分级。
# field 是 data_store 里的规范通道名；kind=wind 时 source_fields 是两个分量。
VARIABLES = [
    # 地面
    {"id": "T2M", "label": "2m 气温", "group": "地面", "unit": "K",
     "field": "t2m", "scale": 1.0, "offset": -273.15, "display_unit": "°C",
     "range": [-40, 50], "palette": "temperature", "contour": 5,
     "legend_note": "气温色标 · 参考 QX/T 180-2013 色域"},
    {"id": "MSL", "label": "海平面气压", "group": "地面", "unit": "Pa",
     "field": "msl", "scale": 0.01, "display_unit": "hPa", "range": [950, 1050],
     "palette": "pressure", "contour": 4,
     "legend_note": "等压线间隔 4 hPa"},
    {"id": "WSPD10", "label": "10m 风速", "group": "地面", "unit": "m/s",
     "field": "wspd10", "display_unit": "m/s", "range": [0, 25],
     "palette": "wind", "contour": 5, "adaptive": False, "kind": "wind",
     "sources": ["U10M", "V10M"], "source_fields": ["u10m", "v10m"],
     "wind_level": "10m", "legend_note": "风速分级 · 风羽按节（kt）绘制"},
    {"id": "WSPD100", "label": "100m 风速", "group": "地面", "unit": "m/s",
     "field": "wspd100", "display_unit": "m/s", "range": [0, 25],
     "palette": "wind", "contour": 5, "adaptive": False, "kind": "wind",
     "sources": ["U100M", "V100M"], "source_fields": ["u100m", "v100m"],
     "wind_level": "100m", "legend_note": "风速分级 · 风羽按节（kt）绘制"},
    # 海洋：当前数据源还没有 SST，先把变量和接口接好，等数据到了自动出图
    {"id": "SST", "label": "海表温度", "group": "海洋", "unit": "K",
     "field": "sst", "scale": 1.0, "offset": -273.15, "display_unit": "°C",
     "range": [-2, 32], "palette": "temperature", "contour": 2,
     "legend_note": "海表温度 · 陆地为缺测"},
    # 降水：6h 用气象部门 6h 分级，24/48/72h 累计用国标 24h 分级（48/72 按倍数换算）
    {"id": "TP", "label": "6h 降水量", "group": "降水", "unit": "mm",
     "field": "tp", "display_unit": "mm", "range": [0, 120], "palette": "tp6",
     "contour": None, "adaptive": False,
     "legend_note": "6h 降水分级 · DB4104/T 124-2023"},
    {"id": "TP24", "label": "24h 累计降水", "group": "降水", "unit": "mm",
     "field": "tp24", "display_unit": "mm", "range": [0, 1000], "palette": "tp24",
     "contour": None, "adaptive": False, "kind": "accum",
     "source": "TP", "window_hours": 24, "min_lead": 24,
     "legend_note": "24h 降水分级 · GB/T 35968-2018"},
    {"id": "TP48", "label": "48h 累计降水", "group": "降水", "unit": "mm",
     "field": "tp48", "display_unit": "mm", "range": [0, 2000], "palette": "tp48",
     "contour": None, "adaptive": False, "kind": "accum",
     "source": "TP", "window_hours": 48, "min_lead": 48,
     "legend_note": "48h 累计 · 按 24h 国标 ×2 分级"},
    {"id": "TP72", "label": "72h 累计降水", "group": "降水", "unit": "mm",
     "field": "tp72", "display_unit": "mm", "range": [0, 3000], "palette": "tp72",
     "contour": None, "adaptive": False, "kind": "accum",
     "source": "TP", "window_hours": 72, "min_lead": 72,
     "legend_note": "72h 累计 · 按 24h 国标 ×3 分级"},
    # 高空
    {"id": "Z500", "label": "500hPa 位势高度", "group": "高空", "unit": "m²/s²",
     "field": "z500", "scale": 0.0101972, "display_unit": "dagpm",
     "range": [480, 600], "palette": "height", "contour": 4,
     "contour_emphasis": 588, "legend_note": "等值线间隔 4 dagpm · 588 线加粗"},
    {"id": "T850", "label": "850hPa 温度", "group": "高空", "unit": "K",
     "field": "t850", "scale": 1.0, "offset": -273.15, "display_unit": "°C",
     "range": [-50, 40], "palette": "temperature", "contour": 5,
     "legend_note": "等温线间隔 5 °C"},
    {"id": "Q850", "label": "850hPa 比湿", "group": "高空", "unit": "g/kg",
     "field": "q850", "display_unit": "g/kg", "range": [0, 20],
     "palette": "moisture", "contour": 2,
     "legend_note": "等值线间隔 2 g/kg"},
    {"id": "WSPD850", "label": "850hPa 风速", "group": "高空", "unit": "m/s",
     "field": "wspd850", "display_unit": "m/s", "range": [0, 50],
     "palette": "wind", "contour": 5, "adaptive": False, "kind": "wind",
     "sources": ["U850", "V850"], "source_fields": ["u850", "v850"],
     "wind_level": "850hPa", "legend_note": "风速分级 · 风羽按节（kt）绘制"},
    # 24h 变化
    {"id": "TDIFF24", "label": "24h 变温", "group": "变化", "unit": "°C",
     "field": "tdiff24", "display_unit": "°C", "range": [-10, 10],
     "palette": "diff", "contour": 2, "kind": "diff", "source": "T2M",
     "lag_hours": 24, "min_lead": 30,
     "legend_note": "当前时效 − 24h 前 · 从 +30h 起 · 蓝色降温 / 红色升温"},
    {"id": "PDIFF24", "label": "24h 变压", "group": "变化", "unit": "Pa",
     "field": "pdiff24", "scale": 0.01, "display_unit": "hPa",
     "range": [-10, 10], "palette": "diff", "contour": 2, "kind": "diff",
     "source": "MSL", "lag_hours": 24, "min_lead": 30,
     "legend_note": "当前时效 − 24h 前 · 从 +30h 起 · 蓝色降压 / 红色升压"},
    # 原始分量：给 API / 高级用户，前端默认收在“原始分量”分组里
    {"id": "U10M", "label": "10m 纬向风", "group": "原始分量", "unit": "m/s",
     "field": "u10m", "display_unit": "m/s", "range": [-25, 25],
     "palette": "component", "contour": 10, "advanced": True},
    {"id": "V10M", "label": "10m 经向风", "group": "原始分量", "unit": "m/s",
     "field": "v10m", "display_unit": "m/s", "range": [-25, 25],
     "palette": "component", "contour": 10, "advanced": True},
    {"id": "U100M", "label": "100m 纬向风", "group": "原始分量", "unit": "m/s",
     "field": "u100m", "display_unit": "m/s", "range": [-25, 25],
     "palette": "component", "contour": 10, "advanced": True},
    {"id": "V100M", "label": "100m 经向风", "group": "原始分量", "unit": "m/s",
     "field": "v100m", "display_unit": "m/s", "range": [-25, 25],
     "palette": "component", "contour": 10, "advanced": True},
    {"id": "U850", "label": "850hPa 纬向风", "group": "原始分量", "unit": "m/s",
     "field": "u850", "display_unit": "m/s", "range": [-40, 40],
     "palette": "component", "contour": 10, "advanced": True},
    {"id": "V850", "label": "850hPa 经向风", "group": "原始分量", "unit": "m/s",
     "field": "v850", "display_unit": "m/s", "range": [-40, 40],
     "palette": "component", "contour": 10, "advanced": True},
]

# ── 数据层：预转换后的线上数据集 ────────────────────────────────────────
# 原始逐时效 nc 不直接对外；转换器把产品要素写成 Zarr，API 只读 data_store。
#   data_incoming/<模型>/<起报>/   拉取落地点（当前步骤先手动给 --source）
#   data_store/<模型>/<起报>/      转换产物，manifest.status=ready 才对外
#   data_archive/<模型>/<起报>/    冷存（后续步骤启用）
DATA_STORE_ROOT = _PROJECT_ROOT / "data_store"
DATA_INCOMING_ROOT = _PROJECT_ROOT / "data_incoming"
DATA_ARCHIVE_ROOT = _PROJECT_ROOT / "data_archive"

# 服务端渲染色块图：全球默认 1440×720（0.25° 格点 1:1），地区块按 bbox 取全分辨率。
# 图片缓存在 data_store/<模型>/<起报>/images/ 下，随起报一起原子发布、一起清理。
IMAGE_DIRNAME = "images"
IMAGE_WIDTH = 1440
IMAGE_HEIGHT = 720
IMAGE_BBOX_WIDTH = 1024
IMAGE_MAX_SIDE = 4096
IMAGE_WEBP_QUALITY = 90
IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable"
# 前端贴图是 Web Mercator：全球图按 ±85.0511° 的方形出图（前端原来是 1152），
# 地区块按 Mercator 宽高比定尺寸（前端原来是最大 1024、最小 96）。
IMAGE_MERCATOR_SIZE = 1152
IMAGE_BBOX_MAX_SIDE = 1024
IMAGE_BBOX_MIN_SIDE = 96
# 陆/海掩膜：和前端 public/land-mask.png 同一张（Natural Earth 1:50m，0.1° 栅格）。
IMAGE_MASK_PATH = Path(__file__).resolve().parent.parent / "data" / "land-mask.png"

# 入库统一的规范单位。源数据单位不一样时，由 MODELS[模型]["transforms"] 换算。
CANONICAL_UNITS = {
    "tp": "mm", "t2m": "K", "u10m": "m/s", "v10m": "m/s",
    "u100m": "m/s", "v100m": "m/s", "msl": "Pa", "z500": "m2/s2",
    "t850": "K", "u850": "m/s", "v850": "m/s", "q850": "g/kg", "sst": "K",
}

# 入库时算好的派生场；读路径因此永远只是"取一张场"。
DERIVED_FIELDS = [
    "wspd10", "wspd100", "wspd850",
    "tp24", "tp48", "tp72", "tdiff24", "pdiff24",
]

# 源通道名 → 规范通道。演示数据只有前 11 个，其余等真实数据接入再出现。
SOURCE_CHANNELS = {
    "TP":   {"name": "tp",    "unit": "mm"},
    "T2M":  {"name": "t2m",   "unit": "K"},
    "U10M": {"name": "u10m",  "unit": "m/s"},
    "V10M": {"name": "v10m",  "unit": "m/s"},
    "U100M": {"name": "u100m", "unit": "m/s"},
    "V100M": {"name": "v100m", "unit": "m/s"},
    "MSL":  {"name": "msl",   "unit": "Pa"},
    "Z500": {"name": "z500",  "unit": "m2/s2"},
    "T850": {"name": "t850",  "unit": "K"},
    "U850": {"name": "u850",  "unit": "m/s"},
    "V850": {"name": "v850",  "unit": "m/s"},
    "Q850": {"name": "q850",  "unit": "g/kg"},
    "SST":  {"name": "sst",   "unit": "K"},
}


GRID_025 = {
    "lat": {"start": 90.0, "step": -0.25, "size": 721},
    "lon": {"start": 0.0, "step": 0.25, "size": 1440},
}
GRID_015 = {
    "lat": {"start": 90.0, "step": -1.5, "size": 121},
    "lon": {"start": 0.0, "step": 1.5, "size": 240},
}


def _model(label: str, source_root: Path, grid: dict, step_hours: int,
           max_lead_index: int, overview_stride: int,
           transforms: dict | None = None, ensemble: bool = False) -> dict:
    """一个内部档的定义。接真实模型时逐条替换 grid / channels / transforms。

    transforms 示例（只对需要换算的通道写）：
        "q850": {"scale": 1000.0},                  # kg/kg → g/kg
        "tp":   {"expm1": True, "scale": 25.4},     # log1p(英寸) → mm
    """
    return {
        "label": label,
        "source_root": str(source_root),
        "grid": grid,
        "step_hours": step_hours,
        "max_lead_index": max_lead_index,
        "overview_stride": overview_stride,
        "channels": dict(SOURCE_CHANNELS),
        "transforms": dict(transforms or {}),
        # 集合预报：源是 member_000/ .. member_051/，入库前先求集合平均。
        "ensemble": ensemble,
    }


MODELS = {
    # 0–15 天：6h 步长、0.25°。实测数值已是规范单位（T K、MSL Pa、Z500 m²/s²、
    # Q700 g/kg、TP mm/6h），transforms 留空；T700/Q700 不在产品通道表里，入库时忽略。
    "tongyun_c116": _model(
        "Tongyun c116", DATA_INCOMING_ROOT / "tongyun_c116",
        GRID_025, step_hours=6, max_lead_index=60, overview_stride=4,
    ),
    # 15–60 天：逐日、1.5°、51 成员的集合预报，入库只保存集合平均。
    # q850 源里是 kg/kg，其余通道已是规范单位。
    "fengshun_ens": _model(
        "风顺 S2S", DATA_INCOMING_ROOT / "fengshun_ens",
        GRID_015, step_hours=24, max_lead_index=60, overview_stride=1,
        transforms={"q850": {"scale": 1000.0}},  # kg/kg → g/kg
        ensemble=True,
    ),
}
