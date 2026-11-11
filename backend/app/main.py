# -*- coding: utf-8 -*-
"""xmetia-seamless 后端入口。

启动（在 backend/ 目录下）：
    uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from app.api import routes_catalog, routes_fields, routes_images
from app.core import config

app = FastAPI(title="xmetia-seamless API", version="0.1.0")

app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(routes_catalog.router, prefix="/api")
app.include_router(routes_fields.router, prefix="/api")
app.include_router(routes_images.router, prefix="/api")


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/")
def index():
    return {
        "name": "xmetia-seamless API",
        "docs": "/docs",
        "endpoints": [
            "/api/catalog", "/api/runs", "/api/field", "/api/series", "/api/image",
        ],
    }
