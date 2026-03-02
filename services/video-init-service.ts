import { join } from 'path';
import type { VideoScanner } from './video-scanner.js';
import type { ThumbnailService } from './thumbnail-service.js';
import type { VideoInfoService } from './video-info-service.js';
import { videoOps, episodeOps } from '../db/index.js';

export interface VideoInitServiceOptions {
    videoFolderPath: string;
    scanner: VideoScanner;
    thumbnailService: ThumbnailService;
    videoInfoService: VideoInfoService;
}

export class VideoInitService {
    private videoFolderPath: string;
    private scanner: VideoScanner;
    private thumbnailService: ThumbnailService;
    private videoInfoService: VideoInfoService;

    constructor(options: VideoInitServiceOptions) {
        this.videoFolderPath = options.videoFolderPath;
        this.scanner = options.scanner;
        this.thumbnailService = options.thumbnailService;
        this.videoInfoService = options.videoInfoService;
    }

    /**
     * 启动时扫描视频并更新数据库
     */
    async initializeVideoData(): Promise<void> {
        console.log('initializeVideoData: 正在启动...');

        // 检查 FFmpeg
        const hasFFmpeg = await this.videoInfoService.checkFFmpeg();
        console.log('initializeVideoData: FFmpeg 检查完成，hasFFmpeg =', hasFFmpeg);
        if (!hasFFmpeg) {
            console.log('FFmpeg 不可用');
        }

        try {
            console.log('initializeVideoData: 正在创建扫描器...');

            // 临时存储扫描结果
            const scannedVideos: any[] = [];
            const recommends: any[] = [];

            console.log('initializeVideoData: 正在扫描目录', this.videoFolderPath);
            await this.scanner['traverseDirectory'](this.videoFolderPath, scannedVideos, recommends, this.videoFolderPath);
            console.log('initializeVideoData: 扫描完成，找到', scannedVideos.length, '个视频');

            // 处理每个视频 - 检查数据库，确定需要处理的视频
            let newCount = 0;
            let updatedCount = 0;
            let skippedCount = 0;
            const videosToProcess: any[] = [];

            console.log('initializeVideoData: 正在处理视频...');

            for (let i = 0; i < scannedVideos.length; i++) {
                const scannedVideo = scannedVideos[i];
                console.log(`initializeVideoData: 正在处理视频 ${i + 1}/${scannedVideos.length}:`, scannedVideo.path);
                const existing = await videoOps.findByPath(scannedVideo.path);
                console.log(`initializeVideoData: 视频 ${i + 1} 查询完成，存在:`, !!existing);

                if (existing) {
                    // 视频已存在，检查是否需要处理
                    // 需要处理的情况：
                    // 1. 没有封面 (cover 或 cover_source)
                    // 2. 没有视频元数据 (duration, width, height 等)
                    // 3. 合集的剧集没有封面（episodes 需要封面）
                    // 4. 合集需要重新生成封面（确保使用正确的 collection 后缀）
                    const needsCover = !existing.cover || !existing.cover_source;
                    const needsMetadata = !existing.duration || !existing.width || !existing.height;

                    // 对于合集，检查是否需要生成/重新生成合集封面
                    let needsCollectionCover = false;
                    let needsEpisodeCovers = false;
                    if (existing.type === 'collection') {
                        // 合集始终需要处理封面（确保使用正确的 -collection 后缀）
                        needsCollectionCover = true;

                        // 检查是否有剧集缺少封面
                        if (existing.episodes && existing.episodes.length > 0) {
                            needsEpisodeCovers = existing.episodes.some((ep: any) => !ep.cover || !ep.cover_source);
                        }
                    }

                    if (needsCover || needsMetadata || needsEpisodeCovers || needsCollectionCover) {
                        updatedCount++;
                        // 将现有数据合并到扫描对象
                        scannedVideo.existingId = existing.id;
                        scannedVideo.existingCover = existing.cover;
                        scannedVideo.existingCoverSource = existing.cover_source;
                        scannedVideo.existingBackdrop = existing.backdrop;
                        scannedVideo.existingBackdropSource = existing.backdrop_source;
                        scannedVideo.existingTmdbData = {
                            tmdb_id: existing.tmdb_id,
                            media_type: existing.media_type,
                            original_title: existing.original_title,
                            overview: existing.overview,
                            release_date: existing.release_date,
                            rating: existing.rating,
                        };
                        scannedVideo.needsCover = needsCover || needsCollectionCover;  // 合集需要重新生成封面
                        scannedVideo.needsMetadata = needsMetadata;
                        scannedVideo.needsEpisodeCovers = needsEpisodeCovers;
                        // 保留现有的 episodes 数据（包含已有的封面）
                        scannedVideo.existingEpisodes = existing.episodes;
                        videosToProcess.push(scannedVideo);
                    } else {
                        skippedCount++;
                        // 更新基本信息（title, meta 等可能变化的字段）
                        await videoOps.update(existing.id, {
                            title: scannedVideo.title,
                            meta: scannedVideo.meta,
                            description: scannedVideo.description,
                        });
                    }
                } else {
                    // 新视频
                    newCount++;
                    scannedVideo.needsCover = true;
                    scannedVideo.needsMetadata = true;
                    scannedVideo.needsEpisodeCovers = true; // 新合集的剧集也需要封面
                    videosToProcess.push(scannedVideo);
                }
            }

            // 处理需要获取元数据和/或封面的视频
            if (hasFFmpeg && videosToProcess.length > 0) {
                console.log('initializeVideoData: 正在为', videosToProcess.length, '个视频生成缩略图...');
                await this.thumbnailService.generateThumbnails(videosToProcess);
                console.log('initializeVideoData: 缩略图生成完成');
            }

            // 将处理后的视频保存到数据库
            console.log('initializeVideoData: 正在保存到数据库...');
            for (const video of videosToProcess) {
                const dbVideo: any = {
                    title: video.title,
                    cover: video.cover || video.existingCover || '',
                    cover_source: video.cover_source || video.existingCoverSource,
                    backdrop: video.backdrop || video.existingBackdrop,
                    backdrop_source: video.backdrop_source || video.existingBackdropSource,
                    type: video.type,
                    durationTag: video.durationTag,
                    collectionCount: video.collectionCount,
                    meta: video.meta,
                    description: video.description,
                    path: video.path,
                    // TMDB 元数据（优先使用已有的）
                    tmdb_id: video.tmdb_id || video.existingTmdbData?.tmdb_id,
                    media_type: video.media_type || video.existingTmdbData?.media_type,
                    original_title: video.original_title || video.existingTmdbData?.original_title,
                    overview: video.overview || video.existingTmdbData?.overview,
                    release_date: video.release_date || video.existingTmdbData?.release_date,
                    rating: video.rating ?? video.existingTmdbData?.rating,
                    // 视频技术信息
                    duration: video.duration,
                    width: video.width,
                    height: video.height,
                    codec: video.codec,
                    bitrate: video.bitrate,
                    fps: video.fps,
                    size: video.size,
                };

                const result = await videoOps.upsert(dbVideo);

                // 处理剧集（如果是合集）
                if (video.type === 'collection' && video.episodes && video.episodes.length > 0) {
                    // 先删除现有剧集
                    await episodeOps.deleteByVideoId(result.id);

                    // 插入新剧集（包含封面）
                    const episodesToInsert = video.episodes.map((ep: any) => ({
                        videoId: result.id,
                        title: ep.title,
                        duration: ep.duration,
                        path: ep.path,
                        cover: ep.cover || null,
                        cover_source: ep.cover_source || null,
                    }));
                    await episodeOps.bulkCreate(episodesToInsert);
                }
            }

            console.log('initializeVideoData: 所有视频已保存到数据库');

        } catch (error) {
            console.error('initializeVideoData: Error:', error);
        }
        console.log('initializeVideoData: 完成');
    }
}
