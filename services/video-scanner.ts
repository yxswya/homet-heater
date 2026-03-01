import * as fs from 'fs';
import * as path from 'path';

// 视频文件扩展名（不包含 ts，ts 文件只有在有 m3u8 时才有意义）
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.avi', '.mov', '.mkv', '.flv', '.wmv', '.m4v', '.m3u8'];

// 接口定义
interface Episode {
    id: number;
    title: string;
    duration: string;
    path: string;
}

interface Video {
    id: number;
    title: string;
    cover: string;
    cover_source?: 'tmdb' | 'screenshot'; // 海报来源
    backdrop?: string; // 背景图
    backdrop_source?: 'tmdb' | 'screenshot';
    type: 'collection' | 'video';
    durationTag: string;
    collectionCount?: string;
    meta: string;
    description?: string;
    path: string;
    episodes?: Episode[];
    // TMDB 元数据
    tmdb_id?: number;
    media_type?: 'movie' | 'tv';
    original_title?: string;
    overview?: string;
    release_date?: string;
    rating?: number;
}

interface Recommend {
    id: number;
    title: string;
    cover: string;
}

interface MockData {
    videos: Video[];
    recommends: Recommend[];
}

class VideoScanner {
    private videoIdCounter = 1;
    private episodeIdCounter = 100;
    private recommendIdCounter = 101;

    // 扫描指定文件夹
    async scanFolder(rootPath: string, outputFileName: string = 'video-data.json'): Promise<void> {
        // 检查文件夹是否存在
        if (!fs.existsSync(rootPath)) {
            return;
        }

        const videos: Video[] = [];
        const recommends: Recommend[] = [];

        try {
            await this.traverseDirectory(rootPath, videos, recommends, rootPath);
            await this.generateMockData(videos, recommends, outputFileName);
        } catch (error) {
        }
    }

    // 遍历目录（改为 public 以供服务调用）
    async traverseDirectory(
        dirPath: string,
        videos: Video[],
        recommends: Recommend[],
        rootPath: string
    ): Promise<void> {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });

        // 分离文件和文件夹
        const files: string[] = [];
        const dirs: string[] = [];

        for (const entry of entries) {
            if (entry.isDirectory()) {
                // 跳过隐藏文件夹和 node_modules/.cache 等特殊文件夹
                if (!entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'cache') {
                    dirs.push(entry.name);
                }
            } else if (entry.isFile()) {
                files.push(entry.name);
            }
        }

        // 检查当前文件夹中的视频文件
        const videoFiles = files.filter(f => {
            const ext = path.extname(f).toLowerCase();
            return VIDEO_EXTENSIONS.includes(ext);
        });

        // 检查是否有 m3u8 文件
        const m3u8Files = videoFiles.filter(f => path.extname(f).toLowerCase() === '.m3u8');
        const otherVideoFiles = videoFiles.filter(f => path.extname(f).toLowerCase() !== '.m3u8');

        // 检查是否是根目录（相对路径为空）
        const relativePath = path.relative(rootPath, dirPath);
        const isRootDir = relativePath === '';

        // 如果有视频文件，添加到列表
        if (videoFiles.length > 0) {
            const folderName = path.basename(dirPath);

            // 处理 m3u8 视频（m3u8 总是单个视频，不管在哪个目录）
            for (const m3u8File of m3u8Files) {
                const videoTitle = path.basename(m3u8File, path.extname(m3u8File));
                const m3u8Path = path.join(relativePath, m3u8File).replace(/\\/g, '/');

                videos.push({
                    id: this.videoIdCounter++,
                    title: videoTitle,
                    cover: `https://picsum.photos/seed/${this.videoIdCounter}/400/225`,
                    type: 'video',
                    durationTag: 'M3U8',
                    meta: '刚刚',
                    description: `M3U8 视频流 - ${videoTitle}`,
                    path: m3u8Path
                });

                // 添加到推荐
                recommends.push({
                    id: this.recommendIdCounter++,
                    title: videoTitle,
                    cover: `https://picsum.photos/seed/${this.recommendIdCounter}/300/170`
                });
            }

            // 处理其他视频文件
            if (otherVideoFiles.length > 0) {
                // 判断是否应该创建合集
                // 条件：不是根目录 且 有多个视频
                const shouldCreateCollection = !isRootDir && otherVideoFiles.length > 1;

                if (shouldCreateCollection) {
                    // 子文件夹有多个视频 = 合集
                    const episodes: Episode[] = otherVideoFiles.map((file) => {
                        const videoTitle = path.basename(file, path.extname(file));
                        const videoPath = path.join(relativePath, file).replace(/\\/g, '/');

                        return {
                            id: this.episodeIdCounter++,
                            title: videoTitle,
                            duration: '--:--',
                            path: videoPath
                        };
                    });

                    videos.push({
                        id: this.videoIdCounter++,
                        title: folderName,
                        cover: `https://picsum.photos/seed/${this.videoIdCounter}/400/225`,
                        type: 'collection',
                        durationTag: '合集',
                        collectionCount: `全 ${episodes.length} 个视频`,
                        meta: `合集 · ${episodes.length} 个视频`,
                        description: `位于 ${relativePath} 的视频合集`,
                        path: relativePath.replace(/\\/g, '/'),
                        episodes: episodes
                    });

                    // 添加到推荐
                    recommends.push({
                        id: this.recommendIdCounter++,
                        title: folderName,
                        cover: `https://picsum.photos/seed/${this.recommendIdCounter}/300/170`
                    });
                } else {
                    // 根目录的视频 或 单个视频 = 独立视频
                    for (const videoFile of otherVideoFiles) {
                        const videoTitle = path.basename(videoFile, path.extname(videoFile));
                        const videoPath = path.join(relativePath, videoFile).replace(/\\/g, '/');

                        videos.push({
                            id: this.videoIdCounter++,
                            title: videoTitle,
                            cover: `https://picsum.photos/seed/${this.videoIdCounter}/400/225`,
                            type: 'video',
                            durationTag: '视频',
                            meta: '刚刚',
                            description: `视频文件 - ${videoTitle}`,
                            path: videoPath
                        });

                        // 添加到推荐
                        recommends.push({
                            id: this.recommendIdCounter++,
                            title: videoTitle,
                            cover: `https://picsum.photos/seed/${this.recommendIdCounter}/300/170`
                        });
                    }
                }
            }
        }

        // 递归扫描子文件夹
        for (const dir of dirs) {
            const fullPath = path.join(dirPath, dir);
            await this.traverseDirectory(fullPath, videos, recommends, rootPath);
        }
    }

    // 生成 mock-data.json 格式的文件
    private async generateMockData(videos: Video[], recommends: Recommend[], outputFileName: string): Promise<void> {
        const mockData: MockData = {
            videos: videos,
            recommends: recommends.slice(0, 10) // 只取前10个推荐
        };

        const outputPath = path.join(process.cwd(), outputFileName);
        fs.writeFileSync(outputPath, JSON.stringify(mockData, null, 2), 'utf-8');
    }
}

// 使用示例
async function main() {
    const scanner = new VideoScanner();

    // 从命令行参数获取要扫描的文件夹路径
    const targetFolder = process.argv[2] || './videos';
    const outputFile = process.argv[3] || 'video-data.json';


    await scanner.scanFolder(targetFolder, outputFile);
}

// 运行
if (require.main === module) {
    main().catch(() => {});
}

export { VideoScanner, MockData, Video, Episode, Recommend };
