# -*- coding: utf-8 -*-
"""后端配置：全部是字面量默认值，直接改这里，不用环境变量。"""
from pathlib import Path

# 项目根目录下的 data/<模型>/，本机和服务器都是这个相对布局，不用改路径。
_PROJECT_ROOT = Path(__file__).resolve().parents[3]
_DATA_ROOT = _PROJECT_ROOT / "data"

# 预报数据源。目录约定：{root}/{init:YYYYMMDDHH}/{lead_index:03d}.nc
# 本地演示：一个起报（20221231）复制成五份，除 fuxi 外都是副本，
# 只用于把多模型界面跑起来；接真实模型时逐条替换成实际目录。
FORECAST_SOURCES = {
    "fuxi":     str(_DATA_ROOT / "fuxi"),
    "fgvp":     str(_DATA_ROOT / "fgvp"),
    "aifs":     str(_DATA_ROOT / "aifs"),
    "fengqing": str(_DATA_ROOT / "fengqing"),
    "tongyun":  str(_DATA_ROOT / "tongyun"),
}

# 界面展示名（catalog 里返回）。没写到的模型直接用 id。
MODEL_LABELS = {
    "fuxi": "FuXi 2.1",
    "fgvp": "FGVP",
    "aifs": "AIFS",
    "fengqing": "FengQing",
    "tongyun": "Tongyun",
}

STEP_HOURS = 6          # 每个 .nc 文件代表的时效步长（001.nc = 6h）
MAX_LEAD_INDEX = 60     # 目录里最大文件序号（001..060 → 6h..360h）
DEFAULT_STRIDE = 4      # 默认空间抽稀倍数（0.25° → 1°）
MAX_STRIDE = 16
FIELD_CACHE_SIZE = 16   # 进程内场缓存条数（全球场约 5MB，放大后的地区块更小）
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
VARIABLES = [
    # 地面
    {"id": "T2M", "label": "2m 气温", "group": "地面", "unit": "K",
     "scale": 1.0, "offset": -273.15, "display_unit": "°C",
     "range": [-40, 50], "palette": "temperature", "contour": 5,
     "legend_note": "气温色标 · 参考 QX/T 180-2013 色域"},
    {"id": "MSL", "label": "海平面气压", "group": "地面", "unit": "Pa",
     "scale": 0.01, "display_unit": "hPa", "range": [950, 1050],
     "palette": "pressure", "contour": 4,
     "legend_note": "等压线间隔 4 hPa"},
    {"id": "WSPD10", "label": "10m 风速", "group": "地面", "unit": "m/s",
     "display_unit": "m/s", "range": [0, 25], "palette": "wind",
     "contour": 5, "adaptive": False, "kind": "wind",
     "sources": ["U10M", "V10M"], "wind_level": "10m",
     "legend_note": "风速分级 · 风羽按节（kt）绘制"},
    # 海洋：当前数据源还没有 SST，先把变量和接口接好，等数据到了自动出图
    {"id": "SST", "label": "海表温度", "group": "海洋", "unit": "K",
     "scale": 1.0, "offset": -273.15, "display_unit": "°C",
     "range": [-2, 32], "palette": "temperature", "contour": 2,
     "legend_note": "海表温度 · 陆地为缺测"},
    # 降水：6h 用气象部门 6h 分级，24/48/72h 累计用国标 24h 分级（48/72 按倍数换算）
    {"id": "TP", "label": "6h 降水量", "group": "降水", "unit": "mm",
     "display_unit": "mm", "range": [0, 120], "palette": "tp6",
     "contour": None, "adaptive": False,
     "legend_note": "6h 降水分级 · DB4104/T 124-2023"},
    {"id": "TP24", "label": "24h 累计降水", "group": "降水", "unit": "mm",
     "display_unit": "mm", "range": [0, 1000], "palette": "tp24",
     "contour": None, "adaptive": False, "kind": "accum",
     "source": "TP", "window_hours": 24, "min_lead": 24,
     "legend_note": "24h 降水分级 · GB/T 35968-2018"},
    {"id": "TP48", "label": "48h 累计降水", "group": "降水", "unit": "mm",
     "display_unit": "mm", "range": [0, 2000], "palette": "tp48",
     "contour": None, "adaptive": False, "kind": "accum",
     "source": "TP", "window_hours": 48, "min_lead": 48,
     "legend_note": "48h 累计 · 按 24h 国标 ×2 分级"},
    {"id": "TP72", "label": "72h 累计降水", "group": "降水", "unit": "mm",
     "display_unit": "mm", "range": [0, 3000], "palette": "tp72",
     "contour": None, "adaptive": False, "kind": "accum",
     "source": "TP", "window_hours": 72, "min_lead": 72,
     "legend_note": "72h 累计 · 按 24h 国标 ×3 分级"},
    # 高空
    {"id": "Z500", "label": "500hPa 位势高度", "group": "高空", "unit": "m²/s²",
     "scale": 0.0101972, "display_unit": "dagpm", "range": [480, 600],
     "palette": "height", "contour": 4, "contour_emphasis": 588,
     "legend_note": "等值线间隔 4 dagpm · 588 线加粗"},
    {"id": "T850", "label": "850hPa 温度", "group": "高空", "unit": "K",
     "scale": 1.0, "offset": -273.15, "display_unit": "°C",
     "range": [-50, 40], "palette": "temperature", "contour": 5,
     "legend_note": "等温线间隔 5 °C"},
    {"id": "WSPD850", "label": "850hPa 风速", "group": "高空", "unit": "m/s",
     "display_unit": "m/s", "range": [0, 50], "palette": "wind",
     "contour": 5, "adaptive": False, "kind": "wind",
     "sources": ["U850", "V850"], "wind_level": "850hPa",
     "legend_note": "风速分级 · 风羽按节（kt）绘制"},
    {"id": "T700", "label": "700hPa 温度", "group": "高空", "unit": "K",
     "scale": 1.0, "offset": -273.15, "display_unit": "°C",
     "range": [-60, 30], "palette": "temperature", "contour": 5,
     "legend_note": "等温线间隔 5 °C"},
    {"id": "Q700", "label": "700hPa 比湿", "group": "高空", "unit": "g/kg",
     "display_unit": "g/kg", "range": [0, 20], "palette": "moisture",
     "contour": 2, "legend_note": "等值线间隔 2 g/kg"},
    # 24h 变化
    {"id": "TDIFF24", "label": "24h 变温", "group": "变化", "unit": "°C",
     "display_unit": "°C", "range": [-10, 10], "palette": "diff",
     "contour": 2, "kind": "diff", "source": "T2M", "lag_hours": 24,
     "min_lead": 30, "legend_note": "当前时效 − 24h 前 · 从 +30h 起 · 蓝色降温 / 红色升温"},
    {"id": "PDIFF24", "label": "24h 变压", "group": "变化", "unit": "Pa",
     "scale": 0.01, "display_unit": "hPa", "range": [-10, 10],
     "palette": "diff", "contour": 2, "kind": "diff", "source": "MSL",
     "lag_hours": 24, "min_lead": 30,
     "legend_note": "当前时效 − 24h 前 · 从 +30h 起 · 蓝色降压 / 红色升压"},
    # 原始分量：给 API / 高级用户，前端默认收在“原始分量”分组里
    {"id": "U10M", "label": "10m 纬向风", "group": "原始分量", "unit": "m/s",
     "display_unit": "m/s", "range": [-25, 25], "palette": "component",
     "contour": 10, "advanced": True},
    {"id": "V10M", "label": "10m 经向风", "group": "原始分量", "unit": "m/s",
     "display_unit": "m/s", "range": [-25, 25], "palette": "component",
     "contour": 10, "advanced": True},
    {"id": "U850", "label": "850hPa 纬向风", "group": "原始分量", "unit": "m/s",
     "display_unit": "m/s", "range": [-40, 40], "palette": "component",
     "contour": 10, "advanced": True},
    {"id": "V850", "label": "850hPa 经向风", "group": "原始分量", "unit": "m/s",
     "display_unit": "m/s", "range": [-40, 40], "palette": "component",
     "contour": 10, "advanced": True},
]
