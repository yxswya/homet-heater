CREATE TABLE `episodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_id` integer NOT NULL,
	`title` text NOT NULL,
	`duration` text,
	`path` text NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `hls_cache` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_id` integer NOT NULL,
	`cache_path` text NOT NULL,
	`is_complete` integer DEFAULT false,
	`qualities` text DEFAULT '{}',
	`segment_count` integer DEFAULT 0,
	`video_mtime` integer,
	`video_size` integer,
	`last_checked` integer DEFAULT (strftime('%s', 'now')),
	`created_at` integer DEFAULT (strftime('%s', 'now')),
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hls_cache_video_id_unique` ON `hls_cache` (`video_id`);--> statement-breakpoint
CREATE TABLE `videos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`cover` text,
	`cover_source` text,
	`backdrop` text,
	`backdrop_source` text,
	`type` text NOT NULL,
	`duration_tag` text NOT NULL,
	`collection_count` text,
	`meta` text NOT NULL,
	`description` text,
	`path` text NOT NULL,
	`tmdb_id` integer,
	`media_type` text,
	`original_title` text,
	`overview` text,
	`release_date` text,
	`rating` real,
	`duration` integer,
	`width` integer,
	`height` integer,
	`codec` text,
	`bitrate` text,
	`fps` text,
	`size` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')),
	`updated_at` integer DEFAULT (strftime('%s', 'now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `videos_path_unique` ON `videos` (`path`);