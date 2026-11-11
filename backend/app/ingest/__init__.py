# -*- coding: utf-8 -*-
"""入库转换：把逐时效 .nc 转成线上 Zarr 数据集。

入口：
    python -m app.ingest convert --model tongyun_c116 --init 20260417
    python -m app.ingest verify  --model tongyun_c116 --init 20260417 --samples 50
"""
