# 本地视频流媒体服务器 - 架构文档

## 项目概述

这是一个基于 Bun + Hono 的本地视频流媒体服务器，支持 HLS 多画质转码和自适应播放。

**项目地址**: `/Users/mac/Documents/yxswy-test/homet-heater/sha1920/app/`

---

## 目录结构

```
app/
├── 📁 db/                          # 数据库模块
│   ├── schema.ts                    # 数据库模型定义
│   ├── index.ts                     # 数据库连接和操作封装
│   └── migrations/                  # Drizzle 迁移文件
│
├── 📁 services/                    # 核心服务模块 ⭐ 已整理
│   ├── transcode-service.ts         # HLS 转码服务（队列、转码、验证）
│   └── video-scanner.ts             # 视频扫描器
│
├── 📁 assets/                      # 缓存文件目录 ⭐ 已整理
│   ├── hls-cache/                   # HLS 转码缓存
│   │   └── {hash}/                  # 视频哈希命名的缓存目录
│   ├── posters/                     # TMDB 海报缓存
│   ├── covers/                      # 视频封面缓存
│   └── backdrops/                   # TMDB 背景图缓存
│
├── 📁 public/                      # 静态前端文件
│   ├── index.html                   # 首页（视频列表）
│   └── play.html                    # 播放页面
│
├── 📁 target/                      # 原始视频文件目录
│   └── *.mp4                        # 用户存放视频文件的位置
│
├── server.ts                        # 主服务器（路由、API、TMDB）
├── drizzle.config.ts                # Drizzle ORM 配置
├── package.json                     # 项目依赖
├── .env                             # 环境变量
├── video-library.db                 # SQLite 数据库
└── tsconfig.json                    # TypeScript 配置
```

---

## 功能模块架构

### 1. 服务层 (`services/`)

所有业务逻辑功能模块集中在此目录：

| 文件 | 职责 |
|------|------|
| `transcode-service.ts` | HLS 转码队列、转码执行、缓存验证 |
| `video-scanner.ts` | 视频扫描、元数据提取、封面生成 |

### 2. 缓存层 (`assets/`)

所有缓存文件集中在此目录：

| 目录 | 说明 |
|------|------|
| `hls-cache/` | HLS 多画质转码缓存 |
| `posters/` | TMDB 海报图片 |
| `covers/` | 视频封面截图 |
| `backdrops/` | TMDB 背景图 |

---

## 服务层详细说明

### transcode-service.ts

**职责**: HLS 转码、队列管理、缓存验证

**核心类和函数**:

| 名称 | 类型 | 说明 |
|------|------|------|
| `HLS_QUALITIES` | 常量 | 画质配置（4K/1080p/720p/480p/360p） |
| `TranscodeQueue` | 类 | 转码队列管理器 |
| `transcodeToMultiBitrateHls()` | 函数 | 执行多画质转码 |
| `verifyHlsCache()` | 函数 | 验证缓存完整性 |
| `cleanupIncompleteTranscode()` | 函数 | 清理不完整的转码 |
| `getTranscodeStatus()` | 函数 | 获取转码状态 |
| `parseM3u8File()` | 函数 | 解析 m3u8 文件 |

### video-scanner.ts

**职责**: 扫描视频目录、提取元数据、更新数据库

**工作流程**:
```
1. 递归扫描视频文件夹
2. 识别单个视频 vs 视频合集
3. 提取视频元数据（ffprobe）
4. 生成视频封面（首帧截图）
5. 获取 TMDB 元数据（可选）
6. 写入/更新数据库
```

---

## 缓存层详细说明

### HLS 转码缓存 (`assets/hls-cache/`)

**目录结构**:
```
hls-cache/
└── {md5_hash}/              # 视频路径的 MD5 哈希（前12位）
    ├── master.m3u8          # 主播放列表（包含所有画质）
    ├── 4k/
    │   ├── index.m3u8       # 4K 子播放列表
    │   └── segment_*.ts     # 4K 分片文件
    ├── 1080p/
    │   ├── index.m3u8
    │   └── segment_*.ts
    ├── 720p/
    │   ├── index.m3u8
    │   └── segment_*.ts
    ├── 480p/
    │   ├── index.m3u8
    │   └── segment_*.ts
    └── 360p/
        ├── index.m3u8
        └── segment_*.ts
```

**缓存验证规则**:
- 检查 `master.m3u8` 是否存在
- 检查各画质的 `index.m3u8` 是否包含 `#EXT-X-ENDLIST`
- 检查分片文件数量是否与 m3u8 中声明的一致
- 检查视频文件是否变化（mtime + size）

### 图片缓存

| 目录 | 说明 | 来源 |
|------|------|------|
| `assets/covers/` | 视频封面截图 | 本地生成（ffprobe） |
| `assets/posters/` | TMDB 海报 | TMDB API |
| `assets/backdrops/` | TMDB 背景图 | TMDB API |

---

## API 路由变更

由于目录结构调整，以下路由已更新：

| 旧路由 | 新路由 |
|--------|--------|
| `/covers/*` | `/assets/covers/*` |
| `/posters/*` | `/assets/posters/*` |
| `/backdrops/*` | `/assets/backdrops/*` |
| `hls-cache/` | `assets/hls-cache/` |

---

## 导入路径变更

### server.ts 中的导入更新

```typescript
// 旧路径
import { VideoScanner } from './video-scanner';
import { TranscodeQueue, ... } from './lib/transcode-service.js';

// 新路径
import { VideoScanner } from './services/video-scanner.js';
import { TranscodeQueue, ... } from './services/transcode-service.js';
```

### 目录路径更新

```typescript
// HLS 缓存目录
const hlsDir = join(process.cwd(), 'assets/hls-cache');

// 图片缓存目录
const coversDir = join(process.cwd(), 'assets/covers');
const postersDir = join(process.cwd(), 'assets/posters');
const backdropsDir = join(process.cwd(), 'assets/backdrops');
```

---

## 数据库结构

### videos 表
```sql
id              INTEGER PRIMARY KEY
title           TEXT NOT NULL
cover           TEXT
backdrop        TEXT
type            TEXT NOT NULL          -- 'video' 或 'collection'
path            TEXT NOT NULL UNIQUE
tmdb_id         INTEGER
duration        INTEGER               -- 秒
width           INTEGER
height          INTEGER
codec           TEXT
fps             TEXT
size            TEXT
created_at      INTEGER
updated_at      INTEGER
```

### episodes 表
```sql
id              INTEGER PRIMARY KEY
video_id        INTEGER REFERENCES videos(id)
title           TEXT NOT NULL
duration        TEXT
path            TEXT NOT NULL
```

### hls_cache 表
```sql
id              INTEGER PRIMARY KEY
video_id        INTEGER UNIQUE REFERENCES videos(id)
cache_path      TEXT NOT NULL
is_complete     BOOLEAN DEFAULT 0
qualities       TEXT DEFAULT '{}'
video_mtime     INTEGER
video_size      INTEGER
last_checked    INTEGER
created_at      INTEGER
```

---

## 开发注意事项

### 启动服务器
```bash
bun run start
```

### 扫描视频
```bash
bun run scan
```

### 清除 HLS 缓存
```bash
rm -rf assets/hls-cache/*
```

### 查看数据库
```bash
sqlite3 video-library.db
SELECT * FROM videos;
SELECT * FROM hls_cache;
```

---

## 整理完成记录

### 2026-03-02 目录结构整理

**变更内容**:
1. ✅ 创建 `services/` 目录，集中所有功能模块
   - 移动 `lib/transcode-service.ts` → `services/transcode-service.ts`
   - 移动 `video-scanner.ts` → `services/video-scanner.ts`
   - 删除空的 `lib/` 目录

2. ✅ 创建 `assets/` 目录，集中所有缓存文件
   - 移动 `hls-cache/` → `assets/hls-cache/`
   - 移动 `posters/` → `assets/posters/`
   - 移动 `covers/` → `assets/covers/`
   - 移动 `backdrops/` → `assets/backdrops/`

3. ✅ 更新 `server.ts` 中的所有路径引用
   - 导入路径更新
   - 目录路径更新
   - 静态文件路由更新

4. ✅ 更新项目文档
   - ARCHITECTURE.md
   - PROJECT_DOCS.md
