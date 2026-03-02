import { join } from 'path';
import { existsSync, statSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import type { TranscodeQueue } from './transcode-service.js';
import { hlsCacheOps } from '../db/index.js';

/**
 * 视频流信息
 */
export interface StreamInfo {
    videoId: number;
    streamId: number;
    videoPath: string;
    directUrl: string;
}

/**
 * 视频流服务选项
 */
export interface VideoStreamServiceOptions {
    videoFolderPath: string;
    hlsDir: string;
    transcodingVideos: Set<string>;
    transcodeQueue: TranscodeQueue;
}

export class VideoStreamService {
    private videoFolderPath: string;
    private hlsDir: string;
    private transcodingVideos: Set<string>;
    private transcodeQueue: TranscodeQueue;
    private activeStreams = new Map<number, { path: string }>();

    constructor(options: VideoStreamServiceOptions) {
        this.videoFolderPath = options.videoFolderPath;
        this.hlsDir = options.hlsDir;
        this.transcodingVideos = options.transcodingVideos;
        this.transcodeQueue = options.transcodeQueue;
    }

    /**
     * 解析 Range 头
     */
    private parseRangeHeader(rangeHeader: string, fileSize: number): { start: number; end: number } | null {
        const matches = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
        if (!matches) return null;

        const start = parseInt(matches[1]);
        let end = matches[2] ? parseInt(matches[2]) : fileSize - 1;

        // 验证范围
        if (start >= fileSize || end >= fileSize || start > end) {
            return null;
        }

        return { start, end };
    }

    /**
     * 生成 HLS 缓存路径
     */
    private getHlsCachePath(videoPath: string): string {
        const hash = createHash('md5').update(videoPath).digest('hex').substring(0, 12);
        return join(this.hlsDir, hash);
    }

    /**
     * 触发 HLS 转码
     */
    private async triggerHlsTranscode(videoPath: string, fullPath: string, videoId: number): Promise<void> {
        const cachePath = this.getHlsCachePath(videoPath);

        // 检查是否已在转码中
        if (this.transcodingVideos.has(cachePath)) {
            return;
        }

        // 检查缓存是否有效
        const stats = statSync(fullPath);
        const existingCache = await hlsCacheOps.findByVideoId(videoId);

        if (existingCache) {
            // 检查文件是否变化
            if (existingCache.videoMtime === stats.mtimeMs &&
                existingCache.videoSize === stats.size &&
                existingCache.isComplete) {
                return;
            }
        }

        // 标记为正在转码
        this.transcodingVideos.add(cachePath);

        // 创建/更新缓存记录（支持断点续传，不删除未完成的转码）
        await hlsCacheOps.upsert({
            videoId,
            cachePath,
            isComplete: false,
            qualities: '{}',
            videoMtime: stats.mtimeMs,
            videoSize: stats.size,
        });

        // 添加到转码队列
        await this.transcodeQueue.add(videoId, fullPath, cachePath);
    }

    /**
     * 启动视频流
     */
    async startVideoStream(videoPath: string, videoId: number): Promise<StreamInfo | null> {
        this.activeStreams.set(videoId, { path: videoPath });

        // 使用路径的 hash 作为 streamId（用于流跟踪，区别于数据库 videoId）
        const pathHash = createHash('md5').update(videoPath).digest('hex').substring(0, 12);
        const streamId = parseInt(pathHash, 16) % 1000000;

        return {
            videoId,
            streamId,
            videoPath,
            directUrl: `/videos/${encodeURIComponent(videoPath)}`
        };
    }

    /**
     * 停止视频流
     */
    stopVideoStream(videoId: number): void {
        this.activeStreams.delete(videoId);
    }

    /**
     * 处理视频流请求
     */
    async handleStreamRequest(path: string): Promise<{ success: boolean; data?: StreamInfo; error?: string; status?: number }> {
        const fullPath = join(this.videoFolderPath, path);

        // 检查视频文件是否存在
        if (!existsSync(fullPath)) {
            return { success: false, error: '视频文件不存在', status: 404 };
        }

        console.log(`请求启动视频流: ${path}`);

        // 查找数据库中的视频记录，获取真实的数据库 ID
        // 先尝试直接查找（单个视频），再尝试查找合集里的视频
        let videoRecord = await hlsCacheOps.findByPath?.(path);

        if (!videoRecord) {
            console.log(`在 videos 表中未找到，尝试在 episodes 表中查找...`);
            videoRecord = await hlsCacheOps.findByEpisodePath?.(path);
        }

        // 如果 hlsCacheOps 没有提供查找方法，使用 videoOps
        if (!videoRecord) {
            const { videoOps } = await import('../db/index.js');
            videoRecord = await videoOps.findByPath(path);

            if (!videoRecord) {
                videoRecord = await videoOps.findByEpisodePath(path);
            }
        }

        console.log(`数据库查询结果: ${videoRecord ? '找到视频记录，ID=' + videoRecord.id : '未找到视频记录'}`);
        if (!videoRecord) {
            return { success: false, error: '视频记录不存在', status: 404 };
        }
        const realVideoId = videoRecord.id;

        // 启动视频流（直接文件服务）
        const streamInfo = await this.startVideoStream(path, realVideoId);

        if (!streamInfo) {
            return { success: false, error: '启动流失败', status: 500 };
        }

        // 异步启动 HLS 转码，使用真实的数据库 videoId
        this.triggerHlsTranscode(path, fullPath, realVideoId).catch(err => {
            console.error('HLS 转码触发失败:', err);
        });

        return { success: true, data: { ...streamInfo, videoId: realVideoId } };
    }

    /**
     * 处理直接视频文件请求（支持 Range 请求）
     */
    handleVideoFileRequest(encodedPath: string, rangeHeader: string | undefined): {
        success: boolean;
        data?: { content: Buffer | Uint8Array; headers: Record<string, string>; status: number };
        error?: string;
        status?: number;
    } {
        const videoPath = decodeURIComponent(encodedPath);
        const fullPath = join(this.videoFolderPath, videoPath);

        if (!existsSync(fullPath)) {
            return { success: false, error: '视频文件不存在', status: 404 };
        }

        try {
            const stats = statSync(fullPath);
            const fileSize = stats.size;

            // 设置通用响应头
            const headers: Record<string, string> = {
                'Content-Type': 'video/mp4',
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'public, max-age=3600'
            };

            if (rangeHeader) {
                // 处理 Range 请求（支持 seek）
                const range = this.parseRangeHeader(rangeHeader, fileSize);

                if (!range) {
                    return { success: false, error: '请求范围不满足', status: 416 };
                }

                // 读取指定范围的数据
                const { start, end } = range;
                const contentLength = end - start + 1;

                headers['Content-Length'] = contentLength.toString();
                headers['Content-Range'] = `bytes ${start}-${end}/${fileSize}`;

                const videoBuffer = readFileSync(fullPath, { encoding: null });
                const chunk = videoBuffer.slice(start, end + 1);

                return {
                    success: true,
                    data: { content: chunk, headers, status: 206 }  // 206 Partial Content
                };
            } else {
                // 完整文件请求
                headers['Content-Length'] = fileSize.toString();
                const videoBuffer = readFileSync(fullPath);
                return {
                    success: true,
                    data: { content: videoBuffer, headers, status: 200 }
                };
            }
        } catch (error) {
            return { success: false, error: '读取视频文件失败', status: 500 };
        }
    }

    /**
     * 获取 HLS 缓存路径
     */
    getCachePath(videoPath: string): string {
        return this.getHlsCachePath(videoPath);
    }
}
