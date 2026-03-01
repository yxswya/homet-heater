import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { sql, relations } from 'drizzle-orm';

// 视频表 - 存储单个视频和合集的主数据
export const videos = sqliteTable('videos', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  cover: text('cover'), // 封面路径
  cover_source: text('cover_source'), // 'tmdb' | 'screenshot'
  backdrop: text('backdrop'), // 背景图路径
  backdrop_source: text('backdrop_source'), // 'tmdb' | 'screenshot'
  type: text('type').notNull(), // 'collection' | 'video'
  durationTag: text('duration_tag').notNull(),
  collectionCount: text('collection_count'),
  meta: text('meta').notNull(),
  description: text('description'),
  path: text('path').notNull().unique(), // 视频相对路径（唯一）

  // TMDB 元数据
  tmdb_id: integer('tmdb_id'),
  media_type: text('media_type'), // 'movie' | 'tv'
  original_title: text('original_title'),
  overview: text('overview'),
  release_date: text('release_date'),
  rating: real('rating'),

  // 视频技术信息
  duration: integer('duration'), // 时长（秒）
  width: integer('width'),
  height: integer('height'),
  codec: text('codec'),
  bitrate: text('bitrate'),
  fps: text('fps'),
  size: text('size'),

  // 时间戳
  createdAt: integer('created_at').default(sql`(strftime('%s', 'now'))`),
  updatedAt: integer('updated_at').default(sql`(strftime('%s', 'now'))`),
});

// 剧集表 - 存储合集中的剧集数据
export const episodes = sqliteTable('episodes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  videoId: integer('video_id').notNull().references(() => videos.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  duration: text('duration'),
  path: text('path').notNull(),
  cover: text('cover'), // 封面路径
  cover_source: text('cover_source'), // 'tmdb' | 'screenshot'
});

// HLS 缓存表 - 跟踪 HLS 转码状态
export const hlsCache = sqliteTable('hls_cache', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  videoId: integer('video_id').notNull().unique().references(() => videos.id, { onDelete: 'cascade' }),
  cachePath: text('cache_path').notNull(), // HLS 缓存目录路径
  isComplete: integer('is_complete', { mode: 'boolean' }).default(false), // 是否完整转码
  qualities: text('qualities').default('{}'), // 各码率状态 JSON: {"4k": true, "1080p": true, ...}
  segmentCount: integer('segment_count').default(0), // 切片数量（已废弃，保留用于兼容）
  videoMtime: integer('video_mtime'), // 原始视频文件的修改时间（用于检测文件变化）
  videoSize: integer('video_size'), // 原始视频文件的大小（用于检测文件变化）
  lastChecked: integer('last_checked').default(sql`(strftime('%s', 'now'))`),
  createdAt: integer('created_at').default(sql`(strftime('%s', 'now'))`),
});

// 定义关系
export const videosRelations = relations(videos, ({ many }) => ({
  episodes: many(episodes),
  hlsCacheEntries: many(hlsCache),
}));

export const episodesRelations = relations(episodes, ({ one }) => ({
  video: one(videos, {
    fields: [episodes.videoId],
    references: [videos.id],
  }),
}));

export const hlsCacheRelations = relations(hlsCache, ({ one }) => ({
  video: one(videos, {
    fields: [hlsCache.videoId],
    references: [videos.id],
  }),
}));

// 类型导出
export type Video = typeof videos.$inferSelect;
export type NewVideo = typeof videos.$inferInsert;
export type Episode = typeof episodes.$inferSelect;
export type NewEpisode = typeof episodes.$inferInsert;
export type HlsCache = typeof hlsCache.$inferSelect;
export type NewHlsCache = typeof hlsCache.$inferInsert;
