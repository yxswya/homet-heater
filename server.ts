import { Hono } from 'hono';
import { serveStatic } from 'hono/bun'
import { join, basename, relative } from 'path';
import { existsSync, mkdirSync, statSync, writeFile, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { VideoScanner } from './services/video-scanner.js';
import { config } from 'dotenv';
import { videoOps, episodeOps, initializeDatabase, hlsCacheOps, db } from './db/index.js';
import * as schema from './db/schema';
import { TranscodeQueue, HLS_QUALITIES, transcodeToMultiBitrateHls, verifyHlsCache } from './services/transcode-service.js';

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
        const { eq } = await import('drizzle-orm');
        const video = await db.query.videos.findFirst({
            where: eq(schema.videos.id, videoId),
        });

        if (video) {
            const videoPath = join(videoFolderPath, video.path);
            const stats = statSync(videoPath);

            // 标记转码完成，包含 qualities 信息
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

// 创建 Hono 应用
const app = new Hono();

// TMDB 配置
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p';

// ==================== 文件名清洗 ====================
function cleanFilename(filename: string): string {
    // 移除文件扩展名
    let name = filename.replace(/\.[^.]+$/, '');

    // 移除常见标签
    const patterns = [
        /\[.*?\]/g, /\(.*?\)/g, /\{.*?\}/g,
        /\.1080p|\.720p|\.480p|\.4k|\.hd|\.full\.hd/gi,
        /\.blu\.ray|\.bluray|\.bdrip|\.brrip|\.webrip|\.web-dl|\.webdl/gi,
        /\.hdtv|\.pdtv|\.dvdrip|\.camrip|\.ts|\.tc/gi,
        /x264|x265|h\.264|h\.265|hevc/gi,
        /aac[0-9.]*|mp3|\.eng|\.chs|\.cht/gi,
        /s[0-9]{2}e[0-9]{2}|第[0-9]{1,2}集|ep?[0-9]{1,3}|完|未删减/gi,
        /_cd[0-9]|cd[0-9]|part[0-9]/gi,
        /小组|字幕组|官方|论坛|网站|首发/gi,
    ];

    for (const pattern of patterns) {
        name = name.replace(pattern, '');
    }

    // 替换特殊字符为空格
    name = name.replace(/[_\-\.]/g, ' ');
    name = name.replace(/\s+/g, ' ').trim();

    return name;
}

// ==================== TMDB API ====================
async function fetchWithRetry(url: string, retries = 1): Promise<any> {
    for (let i = 0; i < retries; i++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${tmdbApiKey}`,
                    'Content-Type': 'application/json',
                },
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                if (response.status === 404) return null;
                throw new Error(`HTTP ${response.status}`);
            }

            return await response.json();
        } catch (error: any) {
            // 处理超时和网络错误
            if (error.name === 'AbortError' || error.code === 20) {
                console.log('fetchWithRetry: 请求超时');
                return null;
            }
            if (i === retries - 1) {
                console.log('fetchWithRetry: 所有重试失败');
                return null;
            }
            await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }
    }
    return null;
}

async function searchTMDB(query: string): Promise<any> {
    try {
        // 先搜索电影
        const movieUrl = `${TMDB_BASE_URL}/search/movie?query=${encodeURIComponent(query)}&language=zh-CN`;
        const movieResult = await fetchWithRetry(movieUrl);
        if (movieResult?.results?.length > 0) {
            return { type: 'movie', ...movieResult.results[0] };
        }

        // 再搜索剧集
        const tvUrl = `${TMDB_BASE_URL}/search/tv?query=${encodeURIComponent(query)}&language=zh-CN`;
        const tvResult = await fetchWithRetry(tvUrl);
        if (tvResult?.results?.length > 0) {
            return { type: 'tv', ...tvResult.results[0] };
        }

        return null;
    } catch (error) {
        // 网络错误或超时，返回 null
        return null;
    }
}

async function downloadTMDBImage(imagePath: string, type: 'poster' | 'backdrop'): Promise<string | null> {
    const size = type === 'poster' ? 'w500' : 'w1280';
    const url = `${TMDB_IMAGE_BASE_URL}/${size}${imagePath}`;
    const dir = type === 'poster' ? postersDir : backdropsDir;

    try {
        const response = await fetch(url);
        if (!response.ok) return null;

        const buffer = Buffer.from(await response.arrayBuffer());
        const filename = createHash('md5').update(imagePath).digest('hex').substring(0, 12);
        const ext = imagePath.split('.').pop() || 'jpg';
        const outputPath = join(dir, `${filename}.${ext}`);

        if (!existsSync(outputPath)) {
            writeFile(outputPath, buffer, (err) => {
                if (err) {
                    // 静默失败 - 图片下载不是关键操作
                }
            });
        }

        return `assets/${type === 'poster' ? 'posters' : 'backdrops'}/${filename}.${ext}`;
    } catch {
        return null;
    }
}

async function fetchTMDBMetadata(filename: string): Promise<any> {
    if (!tmdbApiKey) return null;

    const cleanedName = cleanFilename(filename);
    const result = await searchTMDB(cleanedName);

    if (!result) return null;

    const metadata: any = {
        tmdb_id: result.id,
        media_type: result.type,
        title: result.title || result.name,
        original_title: result.original_title || result.original_name,
        overview: result.overview,
        release_date: result.release_date || result.first_air_date,
        rating: result.vote_average,
        poster_path: null,
        backdrop_path: null,
        poster_source: null, // 'tmdb' or 'screenshot'
        backdrop_source: null,
    };

    // 下载海报
    if (result.poster_path) {
        const poster = await downloadTMDBImage(result.poster_path, 'poster');
        if (poster) {
            metadata.poster_path = poster;
            metadata.poster_source = 'tmdb';
        }
    }

    // 下载背景图
    if (result.backdrop_path) {
        const backdrop = await downloadTMDBImage(result.backdrop_path, 'backdrop');
        if (backdrop) {
            metadata.backdrop_path = backdrop;
            metadata.backdrop_source = 'tmdb';
        }
    }

    return metadata;
}

// 封面缓存目录
const coversDir = join(process.cwd(), 'assets/covers');
const postersDir = join(process.cwd(), 'assets/posters');
const backdropsDir = join(process.cwd(), 'assets/backdrops');

if (!existsSync(coversDir)) {
    mkdirSync(coversDir, { recursive: true });
}
if (!existsSync(postersDir)) {
    mkdirSync(postersDir, { recursive: true });
}
if (!existsSync(backdropsDir)) {
    mkdirSync(backdropsDir, { recursive: true });
}

// 检查 FFmpeg 是否可用
async function checkFFmpeg(): Promise<boolean> {
    return new Promise((resolve) => {
        const ffmpeg = spawn('ffmpeg', ['-version']);
        ffmpeg.on('error', () => resolve(false));
        ffmpeg.on('exit', (code) => resolve(code === 0));
    });
}

// 获取视频信息（分辨率、时长、编码格式等）
interface VideoInfo {
    duration?: number;       // 时长（秒）
    width?: number;          // 视频宽度
    height?: number;         // 视频高度
    codec?: string;          // 视频编码
    bitrate?: string;        // 比特率
    fps?: string;            // 帧率
    audioCodec?: string;     // 音频编码
    audioSampleRate?: string; // 音频采样率
    size?: string;           // 文件大小（格式化）
}

async function getVideoInfo(videoPath: string): Promise<VideoInfo | null> {
    return new Promise((resolve) => {
        const args = [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height,codec_name,r_frame_rate',
            '-show_entries', 'format=duration,bit_rate,size',
            '-of', 'json',
            videoPath
        ];

        const ffprobe = spawn('ffprobe', args);

        let output = '';
        let errorOutput = '';

        ffprobe.stdout.on('data', (data) => {
            output += data.toString();
        });

        ffprobe.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        ffprobe.on('exit', (code) => {
            if (code !== 0 || !output) {
                // 尝试获取基本信息（备用方案）
                const basicArgs = [
                    '-v', 'error',
                    '-show_entries', 'format=duration,size',
                    '-of', 'json',
                    videoPath
                ];

                const basicProbe = spawn('ffprobe', basicArgs);
                let basicOutput = '';

                basicProbe.stdout.on('data', (data) => {
                    basicOutput += data.toString();
                });

                basicProbe.on('exit', (basicCode) => {
                    if (basicCode === 0 && basicOutput) {
                        try {
                            const data = JSON.parse(basicOutput);
                            const format = data.format || {};
                            resolve({
                                duration: format.duration ? parseFloat(format.duration) : undefined,
                                size: format.size ? formatSizeBytes(format.size) : undefined
                            });
                        } catch {
                            resolve(null);
                        }
                    } else {
                        resolve(null);
                    }
                });

                basicProbe.on('error', () => resolve(null));
                return;
            }

            try {
                const data = JSON.parse(output);
                const streams = data.streams || [];
                const format = data.format || {};
                const videoStream = streams.find((s: any) => s.codec_type === 'video') || streams[0];

                // 解析帧率
                let fps: string | undefined;
                if (videoStream?.r_frame_rate) {
                    const [num, den] = videoStream.r_frame_rate.split('/');
                    fps = den ? (parseInt(num) / parseInt(den)).toFixed(2) : videoStream.r_frame_rate;
                }

                // 格式化文件大小
                const sizeBytes = format.size || '0';
                const size = formatSizeBytes(sizeBytes);

                // 格式化比特率
                const bitrate = format.bit_rate ? formatBitrate(format.bit_rate) : undefined;

                resolve({
                    duration: format.duration ? parseFloat(format.duration) : undefined,
                    width: videoStream?.width,
                    height: videoStream?.height,
                    codec: videoStream?.codec_name,
                    bitrate,
                    fps,
                    size
                });
            } catch (error) {
                resolve(null);
            }
        });

        ffprobe.on('error', () => resolve(null));
    });
}

// 格式化文件大小
function formatSizeBytes(bytes: string | number): string {
    const size = typeof bytes === 'string' ? parseInt(bytes) : bytes;
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(2) + ' KB';
    if (size < 1024 * 1024 * 1024) return (size / (1024 * 1024)).toFixed(2) + ' MB';
    return (size / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// 格式化比特率
function formatBitrate(bits: string | number): string {
    const bitrate = typeof bits === 'string' ? parseInt(bits) : bits;
    if (bitrate < 1000) return bitrate + ' bps';
    if (bitrate < 1000000) return (bitrate / 1000).toFixed(0) + ' Kbps';
    return (bitrate / 1000000).toFixed(2) + ' Mbps';
}

// 格式化时长（秒 -> HH:MM:SS 或 MM:SS）
function formatDuration(seconds: number | undefined): string {
    if (!seconds || isNaN(seconds)) return '--:--';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) {
        return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// 为视频提取封面
async function extractThumbnail(videoPath: string, suffix?: string): Promise<string | null> {
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

// 批量生成视频封面并获取 TMDB 元数据
async function generateThumbnails(videos: any[]): Promise<void> {
    console.log('generateThumbnails: 开始处理', videos.length, '个视频');
    const videoPaths: Array<{ video: any; fullPath: string; isCollection: boolean; isEpisode?: boolean; episode?: any }> = [];

    // 收集所有需要生成封面的视频路径
    for (const video of videos) {
        if (video.type === 'video' && video.path) {
            // 单个视频
            videoPaths.push({
                video,
                fullPath: join(videoFolderPath, video.path),
                isCollection: false
            });
        } else if (video.type === 'collection' && video.episodes && video.episodes.length > 0) {
            // 合集：始终生成合集封面（使用第一个剧集）
            videoPaths.push({
                video,
                fullPath: join(videoFolderPath, video.episodes[0].path),
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
                            fullPath: join(videoFolderPath, episode.path),
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
        if (!isEpisode && tmdbApiKey) {
            console.log(`generateThumbnails: 正在从 TMDB 获取 ${filename}`);
            const metadata = await fetchTMDBMetadata(filename);
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
            const result = await extractThumbnail(fullPath, suffix);
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
        if (!isEpisode) {
            const videoInfo = await getVideoInfo(fullPath);
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

// 启动时扫描视频并更新数据库
async function initializeVideoData() {
    console.log('initializeVideoData: 正在启动...');
    // 检查 FFmpeg
    const hasFFmpeg = await checkFFmpeg();
    console.log('initializeVideoData: FFmpeg 检查完成，hasFFmpeg =', hasFFmpeg);
    if (!hasFFmpeg) {
        console.log('FFmpeg 不可用');
    }

    try {
        console.log('initializeVideoData: 正在创建扫描器...');
        const scanner = new VideoScanner();

        // 临时存储扫描结果
        const scannedVideos: any[] = [];
        const recommends: any[] = [];

        console.log('initializeVideoData: 正在扫描目录', videoFolderPath);
        await scanner['traverseDirectory'](videoFolderPath, scannedVideos, recommends, videoFolderPath);
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
            await generateThumbnails(videosToProcess);
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

// ==================== 视频流服务（直接文件 + Range 支持）====================
// 为视频提供直接文件服务（支持 Range 请求）
const activeStreams = new Map<number, { path: string }>();

async function startVideoStream(videoPath: string, videoId: number): Promise<{ port: number; url: string } | null> {

    activeStreams.set(videoId, { path: videoPath });
    return { port: 0, url: videoPath };
}

function stopVideoStream(videoId: number): void {
    activeStreams.delete(videoId);
}

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

        const fullPath = join(videoFolderPath, path);

        // 检查视频文件是否存在
        if (!existsSync(fullPath)) {
            return c.json({ error: '视频文件不存在' }, 404);
        }

        console.log(`请求启动视频流: ${path}`);
        // 查找数据库中的视频记录，获取真实的数据库 ID
        // 先尝试直接查找（单个视频），再尝试查找合集里的视频
        let videoRecord = await videoOps.findByPath(path);

        if (!videoRecord) {
            console.log(`在 videos 表中未找到，尝试在 episodes 表中查找...`);
            videoRecord = await videoOps.findByEpisodePath(path);
        }

        console.log(`数据库查询结果: ${videoRecord ? '找到视频记录，ID=' + videoRecord.id : '未找到视频记录'}`);
        if (!videoRecord) {
            return c.json({ error: '视频记录不存在' }, 404);
        }
        const realVideoId = videoRecord.id;

        // 使用路径的 hash 作为 streamId（用于流跟踪，区别于数据库 videoId）
        const pathHash = createHash('md5').update(path).digest('hex').substring(0, 12);
        const streamId = parseInt(pathHash, 16) % 1000000;


        // 启动视频流（直接文件服务）
        const streamInfo = await startVideoStream(fullPath, streamId);

        if (!streamInfo) {
            return c.json({ error: '启动流失败' }, 500);
        }


        // 异步启动 HLS 转码，使用真实的数据库 videoId
        triggerHlsTranscode(path, fullPath, realVideoId).catch(err => {
        });

        // 返回视频地址（直接文件 URL）
        return c.json({
            videoId: realVideoId,  // 真实的数据库 ID
            streamId,  // 流跟踪 ID
            videoPath: path,  // 相对路径
            directUrl: `/videos/${encodeURIComponent(path)}`,  // 直接视频文件 URL
        });
    } catch (error) {
        return c.json({ error: '启动视频流失败' }, 500);
    }
});

// ==================== HLS 辅助函数 ====================
// 生成 HLS 缓存路径
function getHlsCachePath(videoPath: string): string {
    const hash = createHash('md5').update(videoPath).digest('hex').substring(0, 12);
    return join(hlsDir, hash);
}

// 触发 HLS 转码
async function triggerHlsTranscode(videoPath: string, fullPath: string, videoId: number) {
    const cachePath = getHlsCachePath(videoPath);

    // 检查是否已在转码中
    if (transcodingVideos.has(cachePath)) {
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
    transcodingVideos.add(cachePath);

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
    await transcodeQueue.add(videoId, fullPath, cachePath);

}

// API 端点：停止视频流
app.post('/api/videos/:id/stop-stream', async (c) => {
    try {
        const videoId = parseInt(c.req.param('id'));
        stopVideoStream(videoId);
        return c.json({ success: true });
    } catch (error) {
        return c.json({ error: '停止视频流失败' }, 500);
    }
});

// ==================== 直接视频文件服务（支持 Range 请求）====================
// 视频文件服务端点 - 支持 Range 请求以实现 seek 功能
app.get('/videos/:encodedPath', async (c) => {
    const encodedPath = c.req.param('encodedPath');
    const videoPath = decodeURIComponent(encodedPath);
    const fullPath = join(videoFolderPath, videoPath);

    if (!existsSync(fullPath)) {
        return c.json({ error: '视频文件不存在' }, 404);
    }

    try {
        const stats = statSync(fullPath);
        const fileSize = stats.size;
        const rangeHeader = c.req.header('range');

        // 设置通用响应头
        c.header('Content-Type', 'video/mp4');
        c.header('Accept-Ranges', 'bytes');
        c.header('Cache-Control', 'public, max-age=3600');

        if (rangeHeader) {
            // 处理 Range 请求（支持 seek）
            const range = parseRangeHeader(rangeHeader, fileSize);

            if (!range) {
                return c.text('请求范围不满足', 416);
            }

            // 读取指定范围的数据
            const { start, end } = range;
            const contentLength = end - start + 1;

            c.header('Content-Length', contentLength.toString());
            c.header('Content-Range', `bytes ${start}-${end}/${fileSize}`);

            const videoBuffer = readFileSync(fullPath, { encoding: null });
            const chunk = videoBuffer.slice(start, end + 1);

            return c.body(chunk, 206);  // 206 Partial Content
        } else {
            // 完整文件请求
            c.header('Content-Length', fileSize.toString());
            const videoBuffer = readFileSync(fullPath);
            return c.body(videoBuffer);
        }
    } catch (error) {
        return c.json({ error: '读取视频文件失败' }, 500);
    }
});

// 解析 Range 头
function parseRangeHeader(rangeHeader: string, fileSize: number): { start: number; end: number } | null {
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

// API 端点：获取视频 HLS 转码状态
app.get('/api/videos/:id/hls-status', async (c) => {
    try {
        const videoId = parseInt(c.req.param('id'));
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
        return c.json({ error: '获取 HLS 状态失败' }, 500);
    }
});

// ==================== HLS 文件服务端点 ====================
// HLS 端点：获取 master.m3u8 文件
// 路径格式: /hls/:encodedPath/master.m3u8
app.get('/hls/:encodedPath/master.m3u8', async (c) => {
    const encodedPath = c.req.param('encodedPath');
    const videoPath = decodeURIComponent(encodedPath);
    const fullPath = join(videoFolderPath, videoPath);

    if (!existsSync(fullPath)) {
        return c.json({ error: '视频文件不存在' }, 404);
    }

    const cachePath = getHlsCachePath(videoPath);
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

    return c.json({ status: 'not_ready', message: 'HLS 转码未完成' }, 202);
});

// HLS 端点：获取指定码率的 m3u8 文件
// 路径格式: /hls/:encodedPath/:quality/index.m3u8
app.get('/hls/:encodedPath/:quality/index.m3u8', async (c) => {
    const encodedPath = c.req.param('encodedPath');
    const quality = c.req.param('quality');
    const videoPath = decodeURIComponent(encodedPath);
    const cachePath = getHlsCachePath(videoPath);
    const m3u8Path = join(cachePath, quality, 'index.m3u8');

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

    return c.json({ status: 'not_ready', message: quality + ' 转码未完成' }, 202);
});

// HLS 端点：提供 ts 切片文件
// 路径格式: /hls/:encodedPath/:quality/:segment
app.get('/hls/:encodedPath/:quality/:segment', async (c) => {
    const encodedPath = c.req.param('encodedPath');
    const quality = c.req.param('quality');
    const segment = c.req.param('segment');
    const videoPath = decodeURIComponent(encodedPath);
    const cachePath = getHlsCachePath(videoPath);
    const segmentPath = join(cachePath, quality, segment);

    if (existsSync(segmentPath)) {
        const content = readFileSync(segmentPath);
        return c.body(content, 200, {
            'Content-Type': 'video/mp2t',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=31536000'
        });
    }

    return c.json({ error: '切片不存在' }, 404);
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
        return c.text('流代理失败', 502 as any);
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
    await initializeVideoData();
    console.log('视频数据初始化完成');

    Bun.serve({
        fetch: app.fetch,
        port: port,
    });

    console.log(`服务器运行在端口 ${port}`);
}

start();
