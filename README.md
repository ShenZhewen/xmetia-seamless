# xmetai-seamless

无缝隙预报业务平台（Seamless Forecast Operations Platform）。

当前版本是**60 天无缝隙预报产品**：前 15 天用 Tongyun C116（0.25°，6h 间隔），
15 天以后用风顺 S2S（1.5°，24h 间隔），前端不暴露模型选择——时间轴超过 +15 天
自动改读风顺档，整条时间轴共 105 个时效。后端按（模型, 起报, 变量, 时效）切全球
预报场，也支持按 bbox 取原始分辨率地区块、单格点逐时效序列，以及服务端着色的
WebP 色块图（等经纬 / Web Mercator，可按陆海掩膜裁切）；前端用 MapLibre + 本地
Natural Earth 底图，提供业务产品预设、官方气象色标、累计量/变化量派生场、
等值线与风羽叠加、离线地名、逐时效播放、十字线读值和 URL 还原。

数据由业务服务器上的监听程序每 30 分钟查一次超算最新批次，保留**最近 7 个
起报日**（`watch.py` 的 `KEEP_INITS`，`data_store/` 与 `data_incoming/` 同一口径）；
新批次转换发布后自动淘汰更早的起报。

## 这一版做了什么

- **降水用官方分级色标**
  - 6h：DB4104/T 124-2023 的 15 个有色区间（0.1–120 mm），无降水透明
  - 24h：GB/T 35968-2018 的 11 级（0.1–1000 mm）
  - 48/72h：沿用国标 24h 色表，阈值分别 ×2 / ×3，图例明确标注“按 24h 国标折算”
- **其它要素也换成气象业务色标**：气温、气压、位势高度、湿度用连续气象色带；
  风速用分级色带；u/v 分量和 24h 变化量用零中心发散色带
- **派生场**：10m/850hPa 风速、6/24/48/72h 累计降水、24h 变温、24h 变压
- **产品预设**（侧栏按 降水 / 地面 / 高空 / 海洋 分组）：降水量图、地面天气图、
  2m 气温图、10m 风场、24h 变温图、24h 变压图、500hPa 高度场、850hPa 温度场、
  850hPa 比湿场、海洋与地面；名称统一成「XX图 / XX场」，一张图只有一个主填色
- **叠加图层**：等值线（Z500 的 588 dagpm 线加粗）、风羽（10m / 850hPa）、
  离线国名/城市名；所有标注画在 canvas 上，不依赖在线 glyph 服务，中文可离线显示
- **无缝时间轴**：顶栏不再选模型，左侧选业务产品；时间轴 6h..360h 读 Tongyun，
  384h..1440h 自动切到风顺；右上角下拉切换起报，当前有效时刻显示在左栏底部
- **保留最近 7 个起报**：监听程序发现新批次后转换发布，只有超过 7 个的起报目录和
  对应原始 nc 才删除；不足 7 个时历史起报会一直留着
- **球面首屏**：第一次打开（URL 里没有 `z`）直接进 3D 地球，正面正好是中国；
  URL 里带 `z` 时按地址栏还原
- **球面/平面缩放**：z<3 显示 3D 地球，放大越过 z3 直接切成平面 Mercator
  （没有中间过渡态），切换瞬间再跳一档 zoom：球面最后一帧看到亚洲，平面第一帧
  直接是中国的尺度（反向缩回去同样退一档）
- **球面背景星空**：星点固定在地球坐标系里，拖动地球时星空跟着一起转；
  平面视图下背景恢复不透明，星空自动隐藏
- **球面视图不画风羽**：风羽只在平面视图显示，球面上过于密集
- **河湖底图**：Natural Earth 1:50m 的河流（线）和湖泊（面），画在填色之上、
  省界之下，全球视角也能看到长江、黄河和青海湖这类主干水系
- **海洋与地面**：左侧产品列表新增一个条目，一张图里海洋铺海温、地面铺海平面
  气压，再叠 10m 风羽和 4hPa 等压线；海温的变量和接口已经接好，等数据源有
  SST 后自动铺到海洋上，没有 SST 时只是不画海面填色，主图照常显示
- **填色图改由后端出图**：色块不再在浏览器里逐像素重投影，后端直接按 Web
  Mercator 采样出 WebP（全球 1152²、视窗块最长边 1024），陆/海掩膜和底图
  海岸线对齐；色标定义放在 `/api/catalog` 的 `palettes` 里，前后端共用一份

## 目录结构

```
xmetai-seamless/
├── backend/                    # FastAPI 后端
│   ├── app/
│   │   ├── main.py             # 入口：CORS / GZip / 路由挂载
│   │   ├── core/config.py      # 数据源、模型名、变量表（字面量，直接改）
│   │   ├── api/                # 路由层：参数校验 + HTTP 错误映射
│   │   ├── services/           # 业务层：目录、缓存、单场/时序查询、WebP 出图
│   │   ├── ingest/             # 入库转换：nc → Zarr + manifest（CLI）
│   │   │   ├── watch.py        # 监听超算最新批次：拉取 / 转换 / 清理 / 预热
│   │   │   └── prewarm.py      # 预渲染全球 WebP 色块图
│   │   └── data/               # 数据层：data_store 的 Zarr 读取适配
│   └── requirements.txt
├── frontend/                   # React + Vite 前端
│   ├── src/
│   │   ├── App.jsx             # 页面状态、产品/叠加、取数、播放、URL 同步
│   │   ├── api.js              # 后端请求
│   │   ├── colormap.js         # 色标（优先用后端 catalog 的 palettes）
│   │   ├── fieldImage.js       # JSON 场取样：读数 / 极冠取色 / 地区块判界
│   │   ├── contours.js         # marching squares 等值线 + 标值点
│   │   ├── windBarbs.js        # 风羽（canvas，按节绘制）
│   │   ├── annotations.js      # 国名/城市名/等值线标值（canvas，避让）
│   │   ├── places.js           # 离线地名表
│   │   ├── products.js         # 业务产品与叠加层预设
│   │   └── components/         # 顶栏、产品栏、地图、图例、时间轴
│   └── package.json
└── README.md
```

分层原则：**路由层只做参数校验和 HTTP 错误映射，业务逻辑在 services，数据格式
细节在 data**。换数据源时只动 `data/`；加接口只动 `api/` + `services/`。

## 数据约定

原始 nc 只给入库转换用；线上 API 只读 `data_store/`。

- 站内模型只有两个，定义在 `backend/app/core/config.py` 的 `MODELS`：
  - `tongyun_c116`：1–15 天，步长 6h，0.25°（lat 721 × lon 1440）
  - `fengshun_ens`：16–60 天，步长 24h，1.5°（lat 121 × lon 240），**51 成员集合**：
    入库时逐时效求集合平均，Zarr 里只有平均场，成员原始文件转换后即删
- 超算落盘：`/workspace/data/LiuJs/inference_result/<批次>/<模型目录>/<起报>/001..060.nc`，
  集合模型是 `.../<起报>/member_000/001..060.nc`；业务服务器拉到 `data_incoming/<id>/<起报>/`
  - `weather_era_0p25_tongyun_c116 → tongyun_c116`
  - `s2s_era_1p5_fengshun_ens → fengshun_ens`
- 时效：第 N 个文件 = N × `step_hours`（Tongyun 6..360h；风顺 24h..1440h）
- 每个 nc 的网格和通道差异由 `MODELS[模型]` 的 `grid / channels / transforms`
  在入库时换算；API 把两段时效拼成一条 6..360h 步 6 + 384..1440h 步 24 的时间轴
- `TP` 是**每个步长**的降水量（mm），24/48/72h 累计在入库时算好存进 Zarr；
  任一 6h 时次缺测时，累计值保持缺测，不拿不完整窗口冒充累计量

## 数据层：逐时效 nc → Zarr

线上服务不直接读原始 nc。转换器把产品要素写成按起报组织的 Zarr 数据集，
转换成功后才原子发布；API 只认 `manifest.status=ready`。

```
data_store/<模型>/<起报>/
    manifest.json   网格、通道、时效、状态、源校验
    fields.zarr     13 个原始场 (lead, lat, lon)，float32 + zstd
    derived.zarr    8 个派生场（风速 / 累计降水 / 24h 变化）
    overview.zarr   1° 缩略层，stride≥4 的全球读数直接读它
    images/         服务端 WebP 出图缓存（按变量/时效/尺寸/bbox 落盘）
```

- 规范单位：K / Pa / m/s / m²/s² / g/kg / mm-per-6h；模型单位差异在
  `config.MODELS[模型]["transforms"]` 里换算（q 的 kg/kg、tp 的 log1p/英寸等）
- 派生场在入库时算好，读路径只取一张场
- 转换在 `<模型>/.tmp-*` 里完成，成功后整体 rename；失败不污染线上

```bash
cd backend
python -m app.ingest convert --model tongyun_c116 --init 20260417
python -m app.ingest verify  --model tongyun_c116 --init 20260417 --samples 50
python -m app.ingest info    --model tongyun_c116
```

`--max-leads N` 只转前 N 个时效（调试）；`--force` 覆盖已存在的起报；
`--delete-source` 在发布后删除源目录。

**自动拉取（生产路径）**：业务服务器 `cron` 每 30 分钟跑一次

```bash
cd /home/xmetai/shenzw/xmetai-seamless/backend
python -m app.ingest watch --once
```

它 ssh 到超算，找**两个模型都齐全、`head.json` 已 `succeeded`、5 分钟内没有新写入**
的最新批次，rsync 拉到 `data_incoming/`，分别转换两个模型；两个 manifest 都 ready
后只保留最近 `KEEP_INITS`（默认 7）个起报、更早的删除（`data_store/` 与 `data_incoming/` 都清），
再预渲染全球色块图，最后把批次/起报写进 `data_store/.watch_state.json`。
状态没变就直接退出；增量拉取靠 rsync `-t`（mtime 相同即跳过）。手动预渲染：

```bash
python -m app.ingest prewarm --model tongyun_c116 --init 20260417
python -m app.ingest prewarm --model fengshun_ens --init 20260417
```

## 变量与派生场

变量定义在 `backend/app/core/config.py`：

- `kind: raw`：直接读 `field` 指向的规范通道
- `kind: wind`：读 `source_fields` 里的两个分量，返回 `hypot(u, v)`，并附带 `u/v` 给风羽
- `kind: accum`：读入库时算好的 `${field}`（`min_lead = window_hours`）
- `kind: diff`：读入库时算好的 `${field}`（`min_lead = lag_hours + 6h`）

| 变量 | 说明 | 显示单位 | 起算时效 |
|---|---|---|---|
| `T2M MSL Z500 T850 Q850` | 原始场 | °C / hPa / dagpm / °C / g/kg | +6h |
| `WSPD10 WSPD100 WSPD850` | 风速 = √(u²+v²)，附带 u/v | m/s | +6h |
| `SST` | 海表温度（待数据） | °C | +6h |
| `TP` | 6h 降水 | mm | +6h |
| `TP24 TP48 TP72` | 累计降水（入库预计算） | mm | +24 / +48 / +72h |
| `TDIFF24 PDIFF24` | 当前场减 24h 前（入库预计算） | °C / hPa | **+30h** |
| `U10M V10M U100M V100M U850 V850` | 原始分量（高级） | m/s | +6h |

变化量从 **+30h** 起算，是因为数据集没有 0h 分析场；+30h 减 +6h 才是完整的 24h 变化。

## 启动

后端（需要能读到上面的数据目录）：

```bash
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate
# Linux:   source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

前端：

```bash
cd frontend
npm install
npm run dev
```

打开 http://localhost:5173 。开发服务器会把 `/api` 代理到 `127.0.0.1:8000`；
如果后端跑在服务器上，改 `frontend/vite.config.js` 里的 proxy 目标即可。

## 交互

- 起报可在顶栏右侧下拉切换，顶栏不选模型；左侧先选业务产品，再决定叠加图层
- 时间轴跨过 +15 天自动换数据源（Tongyun → 风顺），点选曲线也把两段拼在一起；
  风顺还没有的变量只在 1–15 天段可用，时间轴会截到该来源的最后一小时效
- 降水产品有 6h / 24h / 48h / 72h 切换；累计产品的时间轴自动从对应起算时效开始
- 叠加层：
  - **等值线**：按变量元数据里的 `contour` 间隔生成；Z500 的 588 dagpm 用暖色加粗
  - **风羽**：10m 或 850hPa，传统风羽符号按节（kt）绘制，短划 5、长划 10、三角 50；
    数字读值仍用 m/s
  - **地名**：离线国名/城市名，随缩放逐级出现
- 地图缩放：z<3 为球面，越过 z3 直接切换为平面（无过渡中间态），并且切换时
  带一档视野落差（球面看到亚洲 → 平面直接到中国尺度，反向同理）；
  球面段横向拖拽可以一直转满 360°（纵向纬度夹在 ±85°，拖动全程不改变缩放）
- 底部时间轴拖动/播放（`←` `→` 调时效，空格播放；播到最后一个时效自动停，不循环）
- 填色图由后端 `/api/image?projection=mercator` 出 WebP 贴到地图上（全球一张，
  放大到 z≥5 后换成视窗的原始分辨率块）；等值线、风羽、读值和极冠取色仍用
  `/api/field` 的 JSON，配色从 catalog 的 `palettes` 来
- 鼠标在地图上是十字线 + 最近格点读值；放大到 z≥5 后按视窗向后端取原始分辨率块，
  读数也切到这块的 0.25° 格点
- 海洋与地面产品的海面只铺 SST、地面只铺 MSL：贴图由后端 `mask=land|ocean` 裁切，
  边界与底图海岸线完全对齐
- 点击地图落一个点，右下角弹出该格点的逐时效曲线，并与当前时效联动；
  再点别处换位置，`×` 或 `Esc` 关闭
- 左下角图例只显示一条色卡和对应的数值刻度
- 文件单位与显示单位：MSL 用 hPa、Z500 用 dagpm、气温用 °C（文件里仍是 Pa / m²/s² / K）
- 地址栏同步 `model / init / product / var / lead / lon / lat / z`，复制 URL 即可还原
- 底图、省界、河湖和地名都随前端一起构建，离线可用（Natural Earth 1:50m；
  河湖是 `frontend/public/water-50m.geojson`，省界在 z≥4 显示）

## API

| 接口 | 说明 |
|---|---|
| `GET /api/catalog` | 模型、变量表（配色区间、分组、`min_lead`、派生类型）、时效网格、色标定义 |
| `GET /api/runs?model=tongyun_c116&limit=500` | 起报列表（只列 `status=ready`，新的在前）+ `latest` 清单 |
| `GET /api/field?model=tongyun_c116&init=20260417&var=TP24&lead=72&stride=4` | 单场：抽稀后的 lat/lon/values + min/max/mean |
| `GET /api/field?...&stride=1&bbox=100,20,120,40` | 同上，只返回 bbox 内的块（lon 0..360，lat -90..90） |
| `GET /api/series?model=tongyun_c116&init=20260417&var=WSPD10&lat=31.2&lon=121.5` | 单格点 6h..360h 逐时效值（最近格点，不插值） |
| `GET /api/image?model=tongyun_c116&init=20260417&var=TP24&lead=72` | 全球色块图（WebP，默认等经纬 1440×720） |
| `GET /api/image?...&bbox=100,20,120,40&width=1024` | 地区块（全分辨率取 bbox，缺测透明），返回 `image/webp` |
| `GET /api/image?...&projection=mercator&mask=land` | 前端贴图用：Web Mercator 全球 1152×1152 / 地区块按 Mercator 宽高比，可按陆/海掩膜裁切 |
| `GET /api/health` | 健康检查 |

`/api/image` 支持 `width / height / quality / projection / mask`：

- `projection=equirect`（默认）按等经纬网格出图；`mercator` 按 Web Mercator 逐像素
  反算经纬度后在全分辨率场上双线性采样，可直接交给 MapLibre 的 image source；
- `mask=none|land|ocean` 用与前端同一张 `backend/app/data/land-mask.png`
  （Natural Earth 1:50m，0.1° 栅格）裁掉另一侧，透明像素即被排除的区域；
- 缺省尺寸：等经纬全球 1440×720、地区块宽 1024；Mercator 全球 1152×1152、
  地区块最长边 1024（按 Mercator 宽高比）。产物按（起报, 变量, 时效, 尺寸,
  bbox, 投影, 掩膜）缓存在 `data_store/<模型>/<起报>/images/`，响应带
  `Cache-Control: public, max-age=31536000, immutable` 和 ETag。

派生变量在返回体里带额外字段：

- 风速：`u`、`v` 两个与 `values` 同形状的数组（风羽用）
- 累计降水：`window_hours`
- 变化量：`lag_hours`

`/api/field` 返回示例：

```json
{
  "model": "tongyun_c116",
  "init": "20260417",
  "var": "WSPD10",
  "lead_hours": 72,
  "valid_time": "2023-01-03 00:00",
  "shape": [181, 360],
  "lat": [90.0, 89.0, "..."],
  "lon": [0.0, 1.0, "..."],
  "values": [[3.2, 4.1, "..."], "..."],
  "u": [[1.2, 2.0, "..."], "..."],
  "v": [[2.9, 3.6, "..."], "..."],
  "stats": {"min": 0.0, "max": 31.4, "mean": 7.8}
}
```

- `stride` 是空间抽稀倍数，默认 4（0.25° → 1°）；缺测值返回 `null`。
- `bbox` 是数据集坐标（lon 0..360），省略就是全球场；前端放大到 z≥5 时
  z≥6 用 stride=1、否则 stride=2 取块。
- `min_lead` 不满足时返回 400，例如 `TP24` 在 `lead=12` 时会被拒绝。
- 场和点序列都在进程内做 LRU 缓存（`FIELD_CACHE_SIZE` / `SERIES_CACHE_SIZE`）。

## 部署（业务服务器）

- 入口：`http://tongyun.world/`（80 由 nginx 反代到 5173；`http://tongyun.world:5173/` 也仍可用），内网 `10.49.71.196`
- nginx：Ubuntu 24.04 系统包（1.24），站点配置在
  `/etc/nginx/sites-available/xmetai-seamless`（`listen 80` → `proxy_pass http://127.0.0.1:5173`，
  带 WebSocket 升级头给 Vite HMR），已 `systemctl enable`，默认站点已移除
- 账号 `xmetai`，项目目录 **`/home/xmetai/shenzw/xmetai-seamless`**
  （本机目录名仍是 `D:\xmetia-seamless`，历史拼写；产品名统一写 `xmetai-`）
- 前端：Vite dev server，`0.0.0.0:5173`；后端：uvicorn，`127.0.0.1:8000`，由 Vite 代理 `/api`
- 运行环境：conda `xmetia-seamless`（Python 3.11）、Node 18
- 密码不进仓库：本机 WSL 的 `~/.ssh/askpass-business.sh`（chmod 700）里保存；
  密码变了就改这个文件，README 不记录密码

### 传文件（在 WSL 里执行）

本地改动不会自动同步。rsync 只传源码，不传 `node_modules` / `data` / 日志：

```bash
export SSH_ASKPASS=$HOME/.ssh/askpass-business.sh SSH_ASKPASS_REQUIRE=force
APP=/home/xmetai/shenzw/xmetai-seamless
RS="ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no"

cd /mnt/d/xmetia-seamless
setsid -w rsync -az --delete --exclude=__pycache__ --exclude=.venv \
  -e "$RS" backend/ xmetai@10.49.71.196:$APP/backend/
setsid -w rsync -az --delete --exclude=node_modules --exclude=dev.log \
  --exclude=dist --exclude=package-lock.json \
  -e "$RS" frontend/ xmetai@10.49.71.196:$APP/frontend/
setsid -w rsync -az -e "$RS" README.md .gitignore xmetai@10.49.71.196:$APP/
```

前端依赖有变化时，再在服务器上执行 `cd $APP/frontend && npm install`。

### 重启

```bash
pkill -f "node ./node_modules/.bin/vite"   # 进程名是相对路径，别按绝对路径匹配
pkill -f "uvicorn app.main:app"

cd /home/xmetai/shenzw/xmetai-seamless/backend
setsid nohup /home/xmetai/anaconda3/envs/xmetia-seamless/bin/python -m uvicorn \
  app.main:app --host 127.0.0.1 --port 8000 > server.log 2>&1 < /dev/null &

cd ../frontend
setsid nohup ./node_modules/.bin/vite --host 0.0.0.0 --port 5173 > dev.log 2>&1 < /dev/null &
```

验证：服务器本机 `curl http://127.0.0.1:8000/api/catalog`，或浏览器打开
`http://tongyun.world/`。5173 被占用时 Vite 会静默改用 5174，重启后
用 `ss -lntp | grep 5173` 确认端口对；改了 nginx 配置则 `sudo nginx -t && sudo systemctl reload nginx`。

### 服务器数据

线上读的是 `data_store/<模型>/<起报>/`（Zarr + manifest），由 `data_incoming/`
里的原始 nc 转换而来。磁盘上保留最近 `KEEP_INITS`（默认 7）个起报，超出才删：

```
data_store/tongyun_c116/20260417/     2.7G
data_store/fengshun_ens/20260417/     173M（集合平均）
data_incoming/tongyun_c116/20260417/  2.6G（原始 nc，转换后保留一份备查）
data_incoming/fengshun_ens/           空（51 成员约 3.7G，转完即删）
```

本地开发机不再保留数据副本，`D:\xmetia-seamless` 下只有源码；数据只在业务服务器上。
监听程序每 30 分钟自动处理新批次（见下节），不需要人工 `convert`。

## 业务服务器 ← 超算服务器：拉数入库

### 通道

超算上跑推理的是容器 `tongyun-backend-run-*`，平台外部映射：

| 平台映射 | 容器端口 | 用途 |
|---|---|---|
| `172.16.100.2:32091` | 8888 | SSH（root，密码认证） |
| `172.16.100.2:31091` | 8080 | vscode / Web 入口（HTTP，不是 SSH） |
| `172.16.100.2:30091` | 8080 | filebrowser |

注意 `172.16.100.2:32049` **不是**这台超算容器，是另一台（用户自己的服务器），
`xay-editor` 在两个地方指向不同的机器，别混。

业务服务器 `~/.ssh/config`（`xmetai@10.49.71.196`）：

```
Host xay-editor
    HostName 172.16.100.2
    Port 32091
    User root
    PreferredAuthentications password
    PubkeyAuthentication no
    ServerAliveInterval 30
    ServerAliveCountMax 3
```

密码放在业务服务器 `~/.ssh/askpass-xay.sh`（chmod 700），不进仓库。手动
`ssh xay-editor` 会正常提示输密码；脚本里免交互先 export：

```bash
export SSH_ASKPASS=~/.ssh/askpass-xay.sh SSH_ASKPASS_REQUIRE=force DISPLAY=:0
```

### 自动监听（生产）

业务服务器 crontab（已装）：

```cron
*/30 * * * * cd /home/xmetai/shenzw/xmetai-seamless/backend && \
  /home/xmetai/anaconda3/envs/xmetia-seamless/bin/python -m app.ingest watch --once \
  >> /home/xmetai/shenzw/xmetai-seamless/logs/watch.log 2>&1
```

`watch.py` 做的事情：

1. ssh 到超算列批次，挑**两个模型目录都齐、各有 60 个 `001..060.nc`、
   `head.json` 为 `succeeded`、且 5 分钟内没有文件写入**的最新批次/起报；
2. 用 `rsync -rt --partial --chmod=D755,F644` 拉到 `data_incoming/<id>/<起报>/`
   （`--chmod` 不能省：超算上 nc 权限是 `---x-----T`，`-a` 会把不可读权限带过来；
   `-t` 保留 mtime，下一轮没变化就整批跳过）；
3. 两个模型各跑一次 `convert`，都确认 `manifest.status=ready`；
4. 删除 `data_store/` 和 `data_incoming/` 里除最新起报以外的旧目录，顺带清 6h
   以上的 `.tmp-*` / `.old-*` 残留；
5. 预渲染两个模型所有变量 × 时效的全球 WebP（Tongyun 约 1050 张，145s），
   写 `data_store/.watch_state.json`。

同一时刻只允许一个 watcher：`data_store/.watch.lock` 上的 `flock` 是阻塞式独占，
cron 撞上了就等下一轮。启动/手动跑一次：

```bash
cd /home/xmetai/shenzw/xmetai-seamless/backend
PY=/home/xmetai/anaconda3/envs/xmetia-seamless/bin/python
$PY -m app.ingest watch --once
```

```bash
cd /home/xmetai/shenzw/xmetai-seamless/backend
PY=/home/xmetai/anaconda3/envs/xmetia-seamless/bin/python
$PY -m app.ingest verify --model tongyun_c116 --init 20260417 --samples 20
```

转换全程写 `.tmp-*`，成功后才原子 rename 成 `data_store/<模型>/<起报>/`，API 只认
`manifest.status=ready`；新起报不用重启，`/api/runs` 和 `/api/catalog` 会自己更新
（新增**模型**才需要重启后端）。

2026-11-10 实测：`20260417/2026041700` 一轮跑通，Tongyun 拉 2.7G / 60 个时效、
风顺 51 成员 × 60 时效共 3.7G，集合平均后转换 ready（11 个原始场 + 7 个派生场），
成员原始文件发布后即删；预渲染 1075 + 931 张图，旧起报已自动删除。

## 缓存与性能

前端慢主要慢在“每次换时效重新取数 + 后端现渲染 WebP”。现在有四层：

1. **入库即派生**：风速/累计降水/变化量在转换时算好，读路径只读一张场，
   不在请求里重复算。
2. **Zarr 分块 + zstd/bitshuffle**：`fields.zarr` 按 (lead, lat, lon) 分块，
   取一个时效只读对应块的压缩数据；1° 缩略层 `overview.zarr` 给 stride≥4 的
   全球读数兜底。
3. **进程内 LRU**：`FIELD_CACHE_SIZE=64` 个场、`SERIES_CACHE_SIZE=64` 条曲线
   （`config.py` 里字面量，直接改），同一时效反复拖动/播放时命中。
4. **磁盘 WebP 缓存 + 预热**：出图结果按（起报, 变量, 时效, 尺寸, bbox, 投影,
   掩膜）落在 `data_store/<模型>/<起报>/images/`，响应带
   `Cache-Control: public, max-age=31536000, immutable` 和 ETag；新起报入库后
   watcher 会把所有变量 × 时效预先出好，用户第一帧也是缓存命中。

再加一层 `GZip`（`main.py` 中间件）压 JSON：0.25° 全球场 JSON 单张 5–10 MB，
压缩后约 1/8，内网到浏览器明显更快。图片本身是 WebP，不再二次压缩。

## 当前限制

- 风顺是 1.5°、24h 步长，15 天以后的空间细节和逐 6h 变化都明显粗于前 15 天；
  这是数据源本身的粒度，不是渲染或抽稀造成的
- 两个模型都没有 U100M / V100M，`WSPD100` 取不到；850hPa 比湿、SST 都有
- 风顺是否已输出全部要素取决于超算侧批次；缺的变量在时间轴上只到 Tongyun 的
  +360h，前端会自动隐藏该变量在风顺段的时效
- 没有 500hPa 风场（数据里没有 U500/V500），所以 500hPa 产品只画高度和等值线
- 风羽用 1° 全球风场绘制；放大后的高分辨率填色块不会单独再取一套风场
- 等值线在 1° 全球场上计算；48/72h 降水色表是按 24h 国标倍数换算，不是独立国标
- 放大后的地区块跨 0°/360° 经度接缝时只能取一半，另一半保持全球抽稀分辨率
- 球面模式下图片源只铺到 ±85.05°，极区那条空白按经度切成 1° 一条的
  GeoJSON 填色补到极点，每条的颜色取极冠内缘（84.55°）的双线性插值场值，
  和底图接缝同色；85° 以上仍是近似延伸，不是独立格点
- 风羽/地名/等值线标值会剔除地球背面（球心夹角 + MapLibre 遮挡判断双保险），
  球面低缩放时密度会主动抽稀
- `SST` 场在陆地上也有值（不是缺测），海洋与地面按 `land-mask.png` 判定陆海：
  海洋铺海温、陆地铺海平面气压；风顺的 `q850` 源单位是 kg/kg，入库时乘 1000
- 图片按请求串行渲染（单张 0.1–0.4s），第一张落盘后走缓存；瓦片还没做
- 无站点观测、无 ERA5 实况叠加、无集合成员
- 服务用 `setsid nohup` 手动拉起，机器重启后需要按上面「重启」再起一次
