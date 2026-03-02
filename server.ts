import { Hono } from 'hono';
import { serveStatic } from 'hono/bun'
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { config } from 'dotenv';
import { videoOps, initializeDatabase, db } from './db/index.js';
import { eq } from 'drizzle-orm';
import * as schema from './db/schema.js';
import { VideoScanner } from './services/video-scanner.js';
import { TMDBService } from './services/tmdb-service.js';
import { VideoInfoService } from './services/video-info-service.js';
import { ThumbnailService } from './services/thumbnail-service.js';
import { VideoInitService } from './services/video-init-service.js';
import { VideoStreamService } from './services/video-stream-service.js';
import { TranscodeQueue, verifyHlsCache } from './services/transcode-service.js';

// 加载环境变量
config();

// 获取命令行参数 - 视频文件夹路径
const videoFolderPath = process.argv[2] || join(process.cwd(), 'target');
const port = parseInt(process.argv[3]) || 3000;
const tmdbApiKey = process.env.TMDB_API_KEY || '';

// ==================== HLS 转码配置 ====================
// HLS 缓存目录
const hlsDir = join(process.cwd(), 'assets/hls-cache');
if (!existsSync(hlsDir)) {
    mkdirSync(hlsDir, { recursive: true });
}

// 正在转码的视频集合
const transcodingVideos = new Set<string>();

// 初始化转码队列
const transcodeQueue = new TranscodeQueue({
    concurrent: 2,  // 同时转码 2 个视频
    onComplete: async (videoId, cachePath) => {
        // 获取并验证转码状态
        const verification = verifyHlsCache(cachePath);

        // 构建 qualities 对象
        const qualities: Record<string, boolean> = {};
        for (const [name, q] of Object.entries(verification.qualities)) {
            qualities[name] = q.isValid;
        }

        // 获取视频文件信息
        const video = await db.query.videos.findFirst({
            where: eq(schema.videos.id, videoId),
        });

        if (video) {
            const { statSync } = await import('fs');
            const videoPath = join(videoFolderPath, video.path);
            const stats = statSync(videoPath);

            // 标记转码完成，包含 qualities 信息
            const { hlsCacheOps } = await import('./db/index.js');
            await hlsCacheOps.upsert({
                videoId,
                cachePath,
                isComplete: verification.isValid,
                qualities: JSON.stringify(qualities),
                segmentCount: 0,  // 已废弃
                videoMtime: stats.mtimeMs,
                videoSize: stats.size,
            });
        }

        // 从转码集合中移除
        transcodingVideos.delete(cachePath);
    }
});

// 启动转码队列处理
transcodeQueue.start();

// ==================== 初始化服务 ====================
// TMDB 服务
const tmdbService = new TMDBService(tmdbApiKey);

// 视频信息获取服务
const videoInfoService = new VideoInfoService();

// 缩略图生成服务
const thumbnailService = new ThumbnailService({
    videoFolderPath,
    fetchTMDBMetadata: (filename: string) => tmdbService.fetchMetadata(filename),
    getVideoInfo: (path: string) => videoInfoService.getVideoInfo(path)
});

// 视频初始化服务（在 start 函数中初始化）
let videoInitService: VideoInitService;

// 视频流服务
const videoStreamService = new VideoStreamService({
    videoFolderPath,
    hlsDir,
    transcodingVideos,
    transcodeQueue
});

// 创建 Hono 应用
const app = new Hono();

// ==================== 新的流式 API ====================
// API 端点：获取所有视频数据
app.get('/api/videos', async (c) => {
    try {
        const allVideos = await videoOps.getAll();
        return c.json({ videos: allVideos, recommends: [] });
    } catch (error) {
        return c.json({ error: '获取视频数据失败' }, 500);
    }
});

// API 端点：启动视频流（通过路径）
app.get('/api/stream', async (c) => {
    try {
        const { path: encodedPath } = c.req.query();

        if (!encodedPath) {
            return c.json({ error: '缺少 path 参数' }, 400);
        }

        // URL 解码路径参数
        const path = decodeURIComponent(encodedPath);

        const result = await videoStreamService.handleStreamRequest(path);

        if (!result.success) {
            return c.json({ error: result.error }, result.status ?? 500 as any);
        }

        return c.json(result.data);
    } catch (error) {
        return c.json({ error: '启动视频流失败' }, 500 as any);
    }
});

// API 端点：停止视频流
app.post('/api/videos/:id/stop-stream', async (c) => {
    try {
        const videoId = parseInt(c.req.param('id'));
        videoStreamService.stopVideoStream(videoId);
        return c.json({ success: true });
    } catch (error) {
        return c.json({ error: '停止视频流失败' }, 500 as any);
    }
});

// ==================== 直接视频文件服务（支持 Range 请求）====================
// 视频文件服务端点 - 支持 Range 请求以实现 seek 功能
app.get('/videos/:encodedPath', async (c) => {
    const encodedPath = c.req.param('encodedPath');
    const rangeHeader = c.req.header('range');

    const result = videoStreamService.handleVideoFileRequest(encodedPath, rangeHeader);

    if (!result.success) {
        return c.json({ error: result.error }, (result.status ?? 500) as any);
    }

    const { content, headers, status } = result.data!;

    // 设置响应头
    for (const [key, value] of Object.entries(headers)) {
        c.header(key, value);
    }

    return c.body(content as any, status as never);
});

// API 端点：获取视频 HLS 转码状态
app.get('/api/videos/:id/hls-status', async (c) => {
    try {
        const videoId = parseInt(c.req.param('id'));
        const { hlsCacheOps } = await import('./db/index.js');
        const cacheEntry = await hlsCacheOps.findByVideoId(videoId);

        if (!cacheEntry) {
            return c.json({
                isComplete: false,
                hasCache: false,
                qualities: {},
                message: '无 HLS 缓存'
            });
        }

        // 验证缓存文件
        const verification = verifyHlsCache(cacheEntry.cachePath);

        // 解析 qualities JSON
        let qualities: Record<string, boolean> = {};
        try {
            qualities = JSON.parse(cacheEntry.qualities || '{}');
        } catch (e) {
            // 如果解析失败，使用验证结果
            for (const [name, q] of Object.entries(verification.qualities)) {
                qualities[name] = q.isValid;
            }
        }

        return c.json({
            isComplete: verification.isValid && cacheEntry.isComplete,
            hasCache: true,
            cachePath: cacheEntry.cachePath,
            qualities,
            verification,
            message: verification.isValid ? 'HLS 可用' : 'HLS 转码中'
        });
    } catch (error) {
        return c.json({ error: '获取 HLS 状态失败' }, 500 as any);
    }
});

// ==================== HLS 文件服务端点 ====================
// HLS 端点：获取 master.m3u8 文件
// 路径格式: /hls/:encodedPath/master.m3u8
app.get('/hls/:encodedPath/master.m3u8', async (c) => {
    const encodedPath = c.req.param('encodedPath');
    const videoPath = decodeURIComponent(encodedPath);

    const { existsSync } = await import('fs');
    const fullPath = join(videoFolderPath, videoPath);

    if (!existsSync(fullPath)) {
        return c.json({ error: '视频文件不存在' }, 404 as any);
    }

    const cachePath = videoStreamService.getCachePath(videoPath);
    const masterM3u8Path = join(cachePath, 'master.m3u8');

    if (existsSync(masterM3u8Path)) {
        const verification = verifyHlsCache(cachePath);
        const hasCompleteQuality = Object.values(verification.qualities).some(q => q.isValid);

        if (hasCompleteQuality) {
            const content = readFileSync(masterM3u8Path, 'utf-8');
            return c.text(content, 200, {
                'Content-Type': 'application/vnd.apple.mpegurl',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0',
                'Access-Control-Allow-Origin': '*'
            });
        }
    }

    return c.json({ status: 'not_ready', message: 'HLS 转码未完成' }, 202 as any);
});

// HLS 端点：获取指定码率的 m3u8 文件
// 路径格式: /hls/:encodedPath/:quality/index.m3u8
app.get('/hls/:encodedPath/:quality/index.m3u8', async (c) => {
    const encodedPath = c.req.param('encodedPath');
    const quality = c.req.param('quality');
    const videoPath = decodeURIComponent(encodedPath);
    const cachePath = videoStreamService.getCachePath(videoPath);
    const m3u8Path = join(cachePath, quality, 'index.m3u8');

    const { existsSync } = await import('fs');
    if (existsSync(m3u8Path)) {
        const content = readFileSync(m3u8Path, 'utf-8');
        if (content.includes('#EXT-X-ENDLIST')) {
            return c.text(content, 200, {
                'Content-Type': 'application/vnd.apple.mpegurl',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0',
                'Access-Control-Allow-Origin': '*'
            });
        }
    }

    return c.json({ status: 'not_ready', message: quality + ' 转码未完成' }, 202 as any);
});

// HLS 端点：提供 ts 切片文件
// 路径格式: /hls/:encodedPath/:quality/:segment
app.get('/hls/:encodedPath/:quality/:segment', async (c) => {
    const encodedPath = c.req.param('encodedPath');
    const quality = c.req.param('quality');
    const segment = c.req.param('segment');
    const videoPath = decodeURIComponent(encodedPath);
    const cachePath = videoStreamService.getCachePath(videoPath);
    const segmentPath = join(cachePath, quality, segment);

    const { existsSync } = await import('fs');
    if (existsSync(segmentPath)) {
        const content = readFileSync(segmentPath);
        return c.body(content, 200, {
            'Content-Type': 'video/mp2t',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=31536000'
        });
    }

    return c.json({ error: '切片不存在' }, 404 as any);
});

// 流代理端点：代理 FFmpeg 流到前端，添加 CORS 头
app.get('/api/stream-proxy/:port', async (c) => {
    const port = parseInt(c.req.param('port'));
    const streamUrl = `http://127.0.0.1:${port}`;

    try {
        // 使用 fetch 获取 FFmpeg 流
        const response = await fetch(streamUrl);

        if (!response.ok) {
            return c.text('FFmpeg 流错误', response.status as any);
        }

        // 设置 CORS 头和流式传输头
        c.header('Access-Control-Allow-Origin', '*');
        c.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
        c.header('Access-Control-Allow-Headers', 'Range, Content-Type');
        c.header('Content-Type', 'video/mp2t');
        c.header('Transfer-Encoding', 'chunked');
        c.header('Connection', 'keep-alive');
        c.header('Cache-Control', 'no-cache');

        // 创建可读流
        const reader = response.body?.getReader();
        if (!reader) {
            return c.text('无法读取流', 500 as any);
        }

        // 使用 Hono 的流式响应
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            controller.close();
                            break;
                        }
                        controller.enqueue(value);
                    }
                } catch (error) {
                    controller.error(error);
                }
            }
        });

        return c.body(stream);
    } catch (error) {
        return c.text('流代理失败', 502 as never);
    }
});

// OPTIONS 请求处理（CORS 预检）
app.options('/api/stream-proxy/:port', (c) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Range, Content-Type');
    return c.body('', 204 as any);
});

// 静态文件服务 - 提供封面图片
app.use('/assets/covers/*', serveStatic({
    root: process.cwd(),
    rewriteRequestPath: (path) => path
}));

// 静态文件服务 - 提供 TMDB 海报
app.use('/assets/posters/*', serveStatic({
    root: process.cwd(),
    rewriteRequestPath: (path) => path
}));

// 静态文件服务 - 提供公共文件（HTML、CSS、JS）
app.use('/*', serveStatic({
    root: join(process.cwd(), 'public'),
}));

// 静态文件服务 - 提供 TMDB 背景图
app.use('/assets/backdrops/*', serveStatic({
    root: process.cwd(),
    rewriteRequestPath: (path) => path
}));

// 启动服务
async function start() {
    console.log('正在启动服务器初始化...');
    await initializeDatabase();
    console.log('数据库初始化完成');

    // 初始化视频初始化服务
    const scanner = new VideoScanner();
    videoInitService = new VideoInitService({
        videoFolderPath,
        scanner,
        thumbnailService,
        videoInfoService
    });

    await videoInitService.initializeVideoData();
    console.log('视频数据初始化完成');

    Bun.serve({
        fetch: app.fetch,
        port: port,
    });

    console.log(`服务器运行在端口 ${port}`);
}

start();
