import { join } from 'path';
import { existsSync, mkdirSync, writeFile } from 'fs';
import { createHash } from 'crypto';

// TMDB 配置
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p';

// 封面缓存目录
const postersDir = join(process.cwd(), 'assets/posters');
const backdropsDir = join(process.cwd(), 'assets/backdrops');

if (!existsSync(postersDir)) {
    mkdirSync(postersDir, { recursive: true });
}
if (!existsSync(backdropsDir)) {
    mkdirSync(backdropsDir, { recursive: true });
}

export interface TMDBMetadata {
    tmdb_id: number;
    media_type: 'movie' | 'tv';
    title: string;
    original_title: string;
    overview: string;
    release_date: string;
    rating: number;
    poster_path: string | null;
    backdrop_path: string | null;
    poster_source: 'tmdb' | 'screenshot' | null;
    backdrop_source: 'tmdb' | null;
}

export class TMDBService {
    private apiKey: string;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    /**
     * 清洗文件名，移除标签和特殊字符
     */
    cleanFilename(filename: string): string {
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

    /**
     * 带重试的 HTTP 请求
     */
    private async fetchWithRetry(url: string, retries = 1): Promise<any> {
        for (let i = 0; i < retries; i++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

                const response = await fetch(url, {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
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

    /**
     * 搜索 TMDB
     */
    async search(query: string): Promise<any> {
        try {
            // 先搜索电影
            const movieUrl = `${TMDB_BASE_URL}/search/movie?query=${encodeURIComponent(query)}&language=zh-CN`;
            const movieResult = await this.fetchWithRetry(movieUrl);
            if (movieResult?.results?.length > 0) {
                return { type: 'movie', ...movieResult.results[0] };
            }

            // 再搜索剧集
            const tvUrl = `${TMDB_BASE_URL}/search/tv?query=${encodeURIComponent(query)}&language=zh-CN`;
            const tvResult = await this.fetchWithRetry(tvUrl);
            if (tvResult?.results?.length > 0) {
                return { type: 'tv', ...tvResult.results[0] };
            }

            return null;
        } catch (error) {
            // 网络错误或超时，返回 null
            return null;
        }
    }

    /**
     * 下载 TMDB 图片
     */
    async downloadImage(imagePath: string, type: 'poster' | 'backdrop'): Promise<string | null> {
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

    /**
     * 获取 TMDB 元数据
     */
    async fetchMetadata(filename: string): Promise<TMDBMetadata | null> {
        if (!this.apiKey) return null;

        const cleanedName = this.cleanFilename(filename);
        const result = await this.search(cleanedName);

        if (!result) return null;

        const metadata: TMDBMetadata = {
            tmdb_id: result.id,
            media_type: result.type,
            title: result.title || result.name,
            original_title: result.original_title || result.original_name,
            overview: result.overview,
            release_date: result.release_date || result.first_air_date,
            rating: result.vote_average,
            poster_path: null,
            backdrop_path: null,
            poster_source: null,
            backdrop_source: null,
        };

        // 下载海报
        if (result.poster_path) {
            const poster = await this.downloadImage(result.poster_path, 'poster');
            if (poster) {
                metadata.poster_path = poster;
                metadata.poster_source = 'tmdb';
            }
        }

        // 下载背景图
        if (result.backdrop_path) {
            const backdrop = await this.downloadImage(result.backdrop_path, 'backdrop');
            if (backdrop) {
                metadata.backdrop_path = backdrop;
                metadata.backdrop_source = 'tmdb';
            }
        }

        return metadata;
    }
}
