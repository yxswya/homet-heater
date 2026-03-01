import { drizzle } from 'drizzle-orm/bun-sqlite';
import { eq } from 'drizzle-orm';
import { Database } from 'bun:sqlite';
import * as schema from './schema';
import type { NewVideo, NewEpisode, NewHlsCache } from './schema';

// 创建数据库连接
const dbPath = process.env.DATABASE_URL || './video-library.db';
const sqlite = new Database(dbPath);
const db = drizzle(sqlite, { schema });

// 导出数据库实例和 schema
export { db, schema };

// 导出表以便在其他文件中使用
export const { videos, episodes, hlsCache } = schema;

// 导出类型
export type { NewVideo, NewEpisode, NewHlsCache };

// 数据库初始化函数 - 运行迁移
export async function initializeDatabase() {
  

  try {
    // 检查数据库文件是否存在
    const { existsSync } = await import('fs');

    const dbExists = existsSync(dbPath);

    if (!dbExists) {
      
    } else {
      
    }

    // 检查表是否存在
    const tableExists = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='videos'"
    ).get();

    if (!tableExists) {
      

      // 逐个创建表
      const tables = [
        `CREATE TABLE IF NOT EXISTS videos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          cover TEXT,
          cover_source TEXT,
          backdrop TEXT,
          backdrop_source TEXT,
          type TEXT NOT NULL,
          duration_tag TEXT NOT NULL,
          collection_count TEXT,
          meta TEXT NOT NULL,
          description TEXT,
          path TEXT NOT NULL UNIQUE,
          tmdb_id INTEGER,
          media_type TEXT,
          original_title TEXT,
          overview TEXT,
          release_date TEXT,
          rating REAL,
          duration INTEGER,
          width INTEGER,
          height INTEGER,
          codec TEXT,
          bitrate TEXT,
          fps TEXT,
          size TEXT,
          created_at INTEGER DEFAULT (strftime('%s', 'now')),
          updated_at INTEGER DEFAULT (strftime('%s', 'now'))
        )`,
        `CREATE TABLE IF NOT EXISTS episodes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          duration TEXT,
          path TEXT NOT NULL,
          cover TEXT,
          cover_source TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS hls_cache (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          video_id INTEGER NOT NULL UNIQUE REFERENCES videos(id) ON DELETE CASCADE,
          cache_path TEXT NOT NULL,
          is_complete INTEGER DEFAULT 0,
          qualities TEXT DEFAULT '{}',
          segment_count INTEGER DEFAULT 0,
          video_mtime INTEGER,
          video_size INTEGER,
          last_checked INTEGER DEFAULT (strftime('%s', 'now')),
          created_at INTEGER DEFAULT (strftime('%s', 'now'))
        )`,
        `CREATE INDEX IF NOT EXISTS idx_videos_path ON videos(path)`,
        `CREATE INDEX IF NOT EXISTS idx_videos_type ON videos(type)`,
        `CREATE INDEX IF NOT EXISTS idx_videos_tmdb_id ON videos(tmdb_id)`,
        `CREATE INDEX IF NOT EXISTS idx_videos_created_at ON videos(created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_episodes_video_id ON episodes(video_id)`,
        `CREATE INDEX IF NOT EXISTS idx_hls_cache_video_id ON hls_cache(video_id)`,
        `CREATE INDEX IF NOT EXISTS idx_hls_cache_is_complete ON hls_cache(is_complete)`,
      ];

      for (const sql of tables) {
        sqlite.run(sql);
      }
      
    } else {

      // 检查并迁移：添加 qualities 列到 hls_cache 表
      const columnExists = sqlite.prepare(
        "PRAGMA table_info(hls_cache)"
      ).all() as { name: string }[];
      const hasQualitiesColumn = columnExists.some((col: { name: string }) => col.name === 'qualities');

      if (!hasQualitiesColumn) {

        sqlite.run('ALTER TABLE hls_cache ADD COLUMN qualities TEXT DEFAULT "{}"');

      }

      // 检查并迁移：添加 cover 和 cover_source 列到 episodes 表
      const episodeColumns = sqlite.prepare(
        "PRAGMA table_info(episodes)"
      ).all() as { name: string }[];
      const hasCoverColumn = episodeColumns.some((col: { name: string }) => col.name === 'cover');

      if (!hasCoverColumn) {

        sqlite.run('ALTER TABLE episodes ADD COLUMN cover TEXT');
        sqlite.run('ALTER TABLE episodes ADD COLUMN cover_source TEXT');

      }
    }

    
  } catch (error) {
    
    throw error;
  }
}
// initializeDatabase();
// 重置数据库（仅用于开发/测试）
export async function resetDatabase() {
  
  const { existsSync, unlinkSync } = await import('fs');
  const { existsSync: existsSyncDir, rmSync } = await import('fs');

  if (existsSync(dbPath)) {
    unlinkSync(dbPath);
  }

  // 删除 WAL 文件
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  if (existsSync(walPath)) unlinkSync(walPath);
  if (existsSync(shmPath)) unlinkSync(shmPath);

  
}

// 便捷的视频操作函数
export const videoOps = {
  // 根据 path 查找视频（包含剧集）
  findByPath: async (path: string) => {
    const video = await db.query.videos.findFirst({
      where: eq(schema.videos.path, path),
    });

    if (!video) return null;

    // 手动获取剧集
    const videoEpisodes = await db.query.episodes.findMany({
      where: eq(schema.episodes.videoId, video.id),
    });

    return {
      ...video,
      episodes: videoEpisodes,
    };
  },

  // 根据 path 查找合集里的视频（episode）
  findByEpisodePath: async (path: string) => {
    // 先在 episodes 表中查找匹配的视频
    const episode = await db.query.episodes.findFirst({
      where: eq(schema.episodes.path, path),
    });

    if (!episode) return null;

    // 获取所属的合集（video）
    const collection = await db.query.videos.findFirst({
      where: eq(schema.videos.id, episode.videoId),
    });

    if (!collection) return null;

    // 获取合集的所有剧集
    const allEpisodes = await db.query.episodes.findMany({
      where: eq(schema.episodes.videoId, collection.id),
    });

    return {
      ...collection,
      episodes: allEpisodes,
      currentEpisode: episode,  // 当前要播放的剧集
    };
  },

  // 获取所有视频（包含剧集）
  getAll: async () => {
    const allVideos = await db.query.videos.findMany();
    const result = [];

    for (const video of allVideos) {
      const videoEpisodes = await db.query.episodes.findMany({
        where: eq(schema.episodes.videoId, video.id),
      });

      result.push({
        ...video,
        episodes: videoEpisodes,
      });
    }

    return result;
  },

  // 创建视频
  create: async (video: NewVideo) => {
    const [result] = await db.insert(schema.videos).values(video).returning();
    return result;
  },

  // 更新视频
  update: async (id: number, data: Partial<NewVideo>) => {
    const [result] = await db
      .update(schema.videos)
      .set({ ...data, updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(schema.videos.id, id))
      .returning();
    return result;
  },

  // 根据 path 更新或创建视频
  upsert: async (video: NewVideo) => {
    const existing = await videoOps.findByPath(video.path!);

    if (existing) {
      return await videoOps.update(existing.id, video);
    } else {
      return await videoOps.create(video);
    }
  },

  // 删除视频
  delete: async (id: number) => {
    await db.delete(schema.videos).where(eq(schema.videos.id, id));
  },

  // 批量创建或更新视频
  bulkUpsert: async (videos: Array<NewVideo>) => {
    const results = [];
    for (const video of videos) {
      const result = await videoOps.upsert(video);
      if (result) results.push(result);
    }
    return results;
  },
};

// 便捷的 episode 操作函数
export const episodeOps = {
  // 创建剧集
  create: async (episode: NewEpisode) => {
    const [result] = await db.insert(schema.episodes).values(episode).returning();
    return result;
  },

  // 批量创建剧集
  bulkCreate: async (episodes: Array<NewEpisode>) => {
    if (episodes.length === 0) return [];
    return await db.insert(schema.episodes).values(episodes).returning();
  },

  // 根据 videoId 删除所有剧集
  deleteByVideoId: async (videoId: number) => {
    await db.delete(schema.episodes).where(eq(schema.episodes.videoId, videoId));
  },
};

// 便捷的 HLS 缓存操作函数
export const hlsCacheOps = {
  // 根据 videoId 获取缓存状态
  findByVideoId: async (videoId: number) => {
    return db.query.hlsCache.findFirst({
      where: eq(schema.hlsCache.videoId, videoId),
    });
  },

  // 根据 path 查找视频的缓存状态
  findByPath: async (path: string) => {
    const video = await videoOps.findByPath(path);
    if (!video) return null;
    return await hlsCacheOps.findByVideoId(video.id);
  },

  // 创建或更新缓存状态
  upsert: async (cache: NewHlsCache & { videoId: number }) => {
    const existing = await hlsCacheOps.findByVideoId(cache.videoId);

    if (existing) {
      const [result] = await db
        .update(schema.hlsCache)
        .set({ ...cache, lastChecked: Math.floor(Date.now() / 1000) })
        .where(eq(schema.hlsCache.videoId, cache.videoId))
        .returning();
      return result;
    } else {
      const [result] = await db.insert(schema.hlsCache).values(cache).returning();
      return result;
    }
  },

  // 标记缓存为完整
  markComplete: async (videoId: number, segmentCount: number, videoMtime: number, videoSize: number, cachePath: string) => {
    return await hlsCacheOps.upsert({
      videoId,
      isComplete: true,
      segmentCount,
      videoMtime,
      videoSize,
      cachePath,
    });
  },

  // 标记缓存为不完整
  markIncomplete: async (videoId: number) => {
    const existing = await hlsCacheOps.findByVideoId(videoId);
    if (existing) {
      await db
        .update(schema.hlsCache)
        .set({ isComplete: false, lastChecked: Math.floor(Date.now() / 1000) })
        .where(eq(schema.hlsCache.videoId, videoId));
    }
  },

  // 删除缓存记录
  delete: async (videoId: number) => {
    await db.delete(schema.hlsCache).where(eq(schema.hlsCache.videoId, videoId));
  },
};
