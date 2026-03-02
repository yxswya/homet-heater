import { join, basename, relative } from 'path';
import { existsSync, mkdirSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import type { TMDBMetadata } from './tmdb-service.js';
import type { VideoInfo } from './video-info-service.js';

// 封面缓存目录
const coversDir = join(process.cwd(), 'assets/covers');
if (!existsSync(coversDir)) {
    mkdirSync(coversDir, { recursive: true });
}

/**
 * 视频处理目标对象
 */
interface VideoProcessTarget {
    path?: string;
    cover?: string;
    cover_source?: 'tmdb' | 'screenshot' | null;
}

/**
 * 缩略图生成选项
 */
export interface ThumbnailGenerationOptions {
    videoFolderPath: string;
    fetchTMDBMetadata?: (filename: string) => Promise<TMDBMetadata | null>;
    getVideoInfo?: (path: string) => Promise<VideoInfo | null>;
}

/**
 * 视频路径信息
 */
interface VideoPathInfo {
    video: any;
    fullPath: string;
    isCollection: boolean;
    isEpisode?: boolean;
    episode?: any;
}

export class ThumbnailService {
    private videoFolderPath: string;
    private fetchTMDBMetadata?: (filename: string) => Promise<TMDBMetadata | null>;
    private getVideoInfo?: (path: string) => Promise<VideoInfo | null>;

    constructor(options: ThumbnailGenerationOptions) {
        this.videoFolderPath = options.videoFolderPath;
        this.fetchTMDBMetadata = options.fetchTMDBMetadata;
        this.getVideoInfo = options.getVideoInfo;
    }

    /**
     * 为视频提取封面
     */
    async extractThumbnail(videoPath: string, suffix?: string): Promise<string | null> {
        const stats = statSync(videoPath);
        const hashInput = suffix ? `${videoPath}-${suffix}-${stats.size}-${stats.mtime.getTime()}` : `${videoPath}-${stats.size}-${stats.mtime.getTime()}`;
        const hash = createHash('md5').update(hashInput).digest('hex').substring(0, 12);
        const coverPath = join(coversDir, `${hash}.jpg`);

        // 检查封面是否已存在
        if (existsSync(coverPath)) {
            return coverPath;
        }

        return new Promise((resolve) => {
            const args = [
                '-ss', '5',
                '-i', videoPath,
                '-vframes', '1',
                '-vf', 'scale=400:225',
                '-q:v', '2',
                '-y',
                coverPath
            ];

            const ffmpeg = spawn('ffmpeg', args);

            ffmpeg.on('exit', (code) => {
                if (code === 0 && existsSync(coverPath)) {
                    resolve(coverPath);
                } else {
                    resolve(null);
                }
            });

            ffmpeg.on('error', () => {
                resolve(null);
            });
        });
    }

    /**
     * 批量生成视频封面并获取元数据
     */
    async generateThumbnails(videos: any[]): Promise<void> {
        console.log('generateThumbnails: 开始处理', videos.length, '个视频');
        const videoPaths: VideoPathInfo[] = [];

        // 收集所有需要生成封面的视频路径
        for (const video of videos) {
            if (video.type === 'video' && video.path) {
                // 单个视频
                videoPaths.push({
                    video,
                    fullPath: join(this.videoFolderPath, video.path),
                    isCollection: false
                });
            } else if (video.type === 'collection' && video.episodes && video.episodes.length > 0) {
                // 合集：始终生成合集封面（使用第一个剧集）
                videoPaths.push({
                    video,
                    fullPath: join(this.videoFolderPath, video.episodes[0].path),
                    isCollection: true
                });

                // 为需要封面的剧集生成独立的封面
                const needsEpisodeCovers = video.needsEpisodeCovers;
                if (needsEpisodeCovers) {
                    for (const episode of video.episodes) {
                        // 检查剧集是否已有封面
                        const existingEpisode = video.existingEpisodes?.find((e: any) => e.path === episode.path);
                        if (!existingEpisode || !existingEpisode.cover) {
                            videoPaths.push({
                                video,
                                fullPath: join(this.videoFolderPath, episode.path),
                                isCollection: false,
                                isEpisode: true,
                                episode
                            });
                        } else {
                            // 保留现有封面
                            episode.cover = existingEpisode.cover;
                            episode.cover_source = existingEpisode.cover_source;
                        }
                    }
                }
            }
        }

        if (videoPaths.length === 0) {
            console.log('generateThumbnails: 没有视频需要处理');
            return;
        }

        console.log('generateThumbnails: 正在处理', videoPaths.length, '个视频路径');

        let tmdbCount = 0;
        let screenshotCount = 0;

        for (let i = 0; i < videoPaths.length; i++) {
            const { video, fullPath, isCollection, isEpisode, episode } = videoPaths[i];
            console.log(`generateThumbnails: 正在处理 ${i + 1}/${videoPaths.length}:`, fullPath);

            // 确定目标对象（合集本身 或 单个剧集）
            const targetObject = isEpisode ? episode : video;
            const filename = basename(targetObject.path || fullPath);

            // 1. 尝试从 TMDB 获取元数据和海报（仅对主视频和合集，不对单个剧集）
            let coverSet = false;
            if (!isEpisode && this.fetchTMDBMetadata) {
                console.log(`generateThumbnails: 正在从 TMDB 获取 ${filename}`);
                const metadata = await this.fetchTMDBMetadata(filename);
                console.log(`generateThumbnails: TMDB 结果:`, !!metadata);
                if (metadata) {
                    // 添加元数据到视频对象
                    Object.assign(video, {
                        tmdb_id: metadata.tmdb_id,
                        media_type: metadata.media_type,
                        original_title: metadata.original_title,
                        overview: metadata.overview,
                        release_date: metadata.release_date,
                        rating: metadata.rating,
                    });

                    // 使用 TMDB 海报
                    if (metadata.poster_path) {
                        video.cover = metadata.poster_path;
                        video.cover_source = 'tmdb';
                        coverSet = true;
                        tmdbCount++;
                    }

                    // 背景图
                    if (metadata.backdrop_path) {
                        video.backdrop = metadata.backdrop_path;
                        video.backdrop_source = 'tmdb';
                    }
                }
            }

            // 2. 如果没有 TMDB 海报，使用视频截图
            if (!coverSet) {
                // 为合集生成独立的封面（使用 'collection' 后缀）
                const suffix = isCollection ? 'collection' : undefined;
                console.log(`generateThumbnails: 正在从 ${fullPath} 提取缩略图，后缀:`, suffix);
                const result = await this.extractThumbnail(fullPath, suffix);
                console.log(`generateThumbnails: 缩略图结果:`, !!result);

                if (result) {
                    // 使用 path.relative 获取相对路径，确保跨平台兼容
                    const relativePath = relative(process.cwd(), result);
                    // 统一使用正斜杠作为路径分隔符（URL 标准）
                    targetObject.cover = '/' + relativePath.split(/[/\\]/).join('/');
                    targetObject.cover_source = 'screenshot';
                    screenshotCount++;
                }
            }

            // 3. 获取视频技术信息（分辨率、时长等）- 仅对主视频获取
            if (!isEpisode && this.getVideoInfo) {
                const videoInfo = await this.getVideoInfo(fullPath);
                if (videoInfo) {
                    // 计算时长的 durationTag 格式
                    let durationTag = '视频';
                    if (videoInfo.duration) {
                        const mins = Math.floor(videoInfo.duration / 60);
                        const secs = Math.floor(videoInfo.duration % 60);
                        const hrs = Math.floor(mins / 60);
                        const minsPart = mins % 60;
                        if (hrs > 0) {
                            durationTag = `${hrs}:${minsPart.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
                        } else {
                            durationTag = `${mins}:${secs.toString().padStart(2, '0')}`;
                        }
                    }

                    Object.assign(video, {
                        duration: videoInfo.duration,
                        width: videoInfo.width,
                        height: videoInfo.height,
                        codec: videoInfo.codec,
                        bitrate: videoInfo.bitrate,
                        fps: videoInfo.fps,
                        size: videoInfo.size,
                        durationTag: durationTag // 更新 durationTag 为实际时长
                    });

                    // 同时更新合集的 episodes 时长
                    if (video.episodes && video.episodes.length > 0) {
                        // 使用主视频的时长作为合集 durationTag
                        video.collectionCount = `全 ${video.episodes.length} 个视频 · ${durationTag}`;
                    }
                }
            }
        }

        console.log('generateThumbnails: 完成，TMDB:', tmdbCount, '截图:', screenshotCount);
    }
}
