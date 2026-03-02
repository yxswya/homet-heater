import { spawn } from 'child_process';
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// HLS 码率配置
export const HLS_QUALITIES = [
  { name: '4k', resolution: '3840x2160', videoBitrate: '8000k', audioBitrate: '192k', bandwidth: 8000000 },
  { name: '1080p', resolution: '1920x1080', videoBitrate: '5000k', audioBitrate: '192k', bandwidth: 5000000 },
  { name: '720p', resolution: '1280x720', videoBitrate: '3000k', audioBitrate: '128k', bandwidth: 3000000 },
  { name: '480p', resolution: '854x480', videoBitrate: '1500k', audioBitrate: '128k', bandwidth: 1500000 },
  { name: '360p', resolution: '640x360', videoBitrate: '800k', audioBitrate: '96k', bandwidth: 800000 },
];

// 转码状态接口
export interface TranscodeStatus {
  isComplete: boolean;
  qualities: Record<string, boolean>;
}

// 转码队列类
export class TranscodeQueue {
  private concurrent: number;
  private running: Set<string> = new Set();
  private queue: Array<{ videoId: number; videoPath: string; cachePath: string }> = [];
  private onComplete?: (videoId: number, cachePath: string) => void;

  constructor(options: { concurrent: number; onComplete?: (videoId: number, cachePath: string) => void }) {
    this.concurrent = options.concurrent;
    this.onComplete = options.onComplete;
  }

  // 添加到队列
  async add(videoId: number, videoPath: string, cachePath: string): Promise<void> {
    // 检查是否已在运行或队列中
    const key = `${videoId}`;
    if (this.running.has(key) || this.queue.some(q => q.videoId === videoId)) {
      return;
    }

    this.queue.push({ videoId, videoPath, cachePath });
  }

  // 开始处理队列（启动守护进程 worker）
  start(): void {
    for (let i = 0; i < this.concurrent; i++) {
      // 不等待，让 worker 在后台持续运行
      this.worker(i).catch(() => {});
    }
  }

  // 工作进程 - 持续运行的守护进程
  private async worker(workerId: number): Promise<void> {
    while (true) {
      const task = this.queue.shift();
      if (!task) {
        // 队列为空，等待一段时间再检查
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }

      const key = `${task.videoId}`;
      this.running.add(key);

      try {
        await transcodeToMultiBitrateHls(task.videoPath, task.cachePath);

        // 转码完成回调
        if (this.onComplete) {
          this.onComplete(task.videoId, task.cachePath);
        }
      } catch {
        // 转码失败，静默处理
      } finally {
        this.running.delete(key);
      }
    }
  }

  // 获取队列状态
  getStatus(): { running: number; queued: number } {
    return {
      running: this.running.size,
      queued: this.queue.length,
    };
  }
}

// 检查单个码率的 HLS 是否完整
function isQualityComplete(cachePath: string, quality: string): boolean {
  const m3u8Path = join(cachePath, quality, 'index.m3u8');

  if (!existsSync(m3u8Path)) {
    return false;
  }

  const content = readFileSync(m3u8Path, 'utf-8');
  return content.includes('#EXT-X-ENDLIST');
}

// 转码到多码率 HLS
export async function transcodeToMultiBitrateHls(
  videoPath: string,
  cachePath: string,
  progressCallback?: (quality: string, progress: number) => void
): Promise<void> {
  // 验证文件路径 - 确保 not 是 HLS 文件
  const ext = videoPath.toLowerCase();
  if (ext.endsWith('.m3u8') || ext.endsWith('.ts')) {
    throw new Error(`错误: 尝试转码 HLS 文件而非原始视频: ${videoPath}`);
  }

  // 确保缓存目录存在
  if (!existsSync(cachePath)) {
    mkdirSync(cachePath, { recursive: true });
  }

  // 检查原始视频分辨率，决定要转码哪些码率
  const videoInfo = await getVideoInfo(videoPath);
  const originalWidth = videoInfo.width || 1920;
  const originalHeight = videoInfo.height || 1080;
  const videoFps = videoInfo.fps || 24;  // 获取实际帧率
  const videoDuration = videoInfo.duration || 0;

  // 只转码不超过原始分辨率的码率
  const qualitiesToTranscode = HLS_QUALITIES.filter(q => {
    const [width, height] = q.resolution.split('x').map(Number);
    return width <= originalWidth && height <= originalHeight;
  });

  // 并发转码所有码率
  const transcodePromises = qualitiesToTranscode.map(quality => {
    const qualityDir = join(cachePath, quality.name);
    if (!existsSync(qualityDir)) {
      mkdirSync(qualityDir, { recursive: true });
    }

    // 检查是否已完成
    if (isQualityComplete(cachePath, quality.name)) {
      return Promise.resolve();
    }

    return transcodeQuality(videoPath, qualityDir, quality, videoFps, videoDuration, progressCallback);
  });

  await Promise.all(transcodePromises);

  // 生成 master.m3u8
  await generateMasterM3u8(cachePath, qualitiesToTranscode.map(q => q.name));
}

// 转码单个码率（支持断点续传）
async function transcodeQuality(
  videoPath: string,
  qualityDir: string,
  quality: typeof HLS_QUALITIES[0],
  fps: number,
  duration: number,
  progressCallback?: (quality: string, progress: number) => void
): Promise<void> {
  const outputPath = join(qualityDir, 'index.m3u8');
  const segmentPath = join(qualityDir, 'segment_%03d.ts');

  // 根据 fps 计算 GOP 大小 (2 秒)
  const gopSize = Math.round(fps * 2);

  // 检查是否已有部分转码（断点续传）
  let startTime = 0;
  let startNumber = 0;
  let appendList = false;

  const m3u8Path = join(qualityDir, 'index.m3u8');
  if (existsSync(m3u8Path)) {
    const m3u8Info = parseM3u8File(m3u8Path);

    // 如果 m3u8 文件未完成，说明是中断的转码，可以继续
    if (m3u8Info && !m3u8Info.hasEndList && m3u8Info.totalDuration > 0) {
      startTime = m3u8Info.totalDuration;
      startNumber = m3u8Info.segmentCount;
      appendList = true;

      console.log(`断点续传: ${quality.name} 从 ${startTime.toFixed(2)}秒 开始，已存在 ${startNumber} 个切片`);
    }
  }

  const args = [
    '-i', videoPath,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '22',
    // 关键帧和GOP优化 - 提升切换流畅度
    '-g', gopSize.toString(),           // GOP大小 = 2秒（基于实际fps）
    '-keyint_min', gopSize.toString(),  // 最小关键帧间隔
    '-sc_threshold', '0',               // 禁用场景切换检测
    '-maxrate', quality.videoBitrate,
    '-bufsize', `${parseInt(quality.videoBitrate) * 2}k`,
    '-vf', `scale=${quality.resolution}`,
    '-c:a', 'aac',
    '-b:a', quality.audioBitrate,
    '-ac', '2',
    '-ar', '44100',
    '-f', 'hls',
    '-hls_time', '2',                    // 2秒切片（原6秒）- 更快的切换响应
    '-hls_list_size', '0',
  ];

  // 断点续传：从指定时间点开始
  if (startTime > 0) {
    args.unshift('-ss', startTime.toFixed(2));
    args.push(
      '-hls_flags', 'append_list+independent_segments+program_date_time',
      '-start_number', startNumber.toString()
    );
  } else {
    // 首次转码：使用 epoch 时间作为起始编号，避免重启后文件名冲突
    args.push(
      '-hls_flags', 'independent_segments+program_date_time',
      '-hls_start_number_source', 'epoch'
    );
  }

  args.push(
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', segmentPath,
    outputPath,
  );

  // 首次转码时使用 -y 覆盖已有文件，断点续传时使用 -n 避免覆盖
  if (startTime === 0) {
    args.unshift('-y');
  } else {
    args.unshift('-n');
  }

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', args);
    let started = false;
    let lastProgress = startTime;

    ffmpeg.stderr.on('data', (data) => {
      if (!started) {
        started = true;
      }

      // 解析进度
      const output = data.toString();
      const timeMatch = output.match(/out_time=(\d+):(\d+):(\d+\.\d+)/);
      if (timeMatch && progressCallback && duration > 0) {
        const hours = parseInt(timeMatch[1]);
        const minutes = parseInt(timeMatch[2]);
        const seconds = parseFloat(timeMatch[3]);
        const currentTime = hours * 3600 + minutes * 60 + seconds;

        // 使用实际视频时长计算进度，每 10 秒输出一次
        if (currentTime - lastProgress > 10) {
          lastProgress = currentTime;
          const totalProgress = Math.min((currentTime / duration) * 100, 99);
          progressCallback(quality.name, totalProgress);
        }
      }
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        if (progressCallback) {
          progressCallback(quality.name, 100);
        }
        resolve();
      } else {
        reject(new Error(`FFmpeg ${quality.name} 退出码: ${code}`));
      }
    });

    ffmpeg.on('error', (err) => {
      reject(new Error(`FFmpeg ${quality.name} 启动失败: ${err.message}`));
    });

    // 5 秒超时检测
    setTimeout(() => {
      if (!started) {
        ffmpeg.kill();
        reject(new Error(`FFmpeg ${quality.name} 5 秒内未启动`));
      }
    }, 5000);
  });
}

// 生成 master.m3u8
async function generateMasterM3u8(cachePath: string, qualities: string[]): Promise<void> {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
  ];

  for (const qualityName of qualities) {
    const quality = HLS_QUALITIES.find(q => q.name === qualityName);
    if (!quality) continue;

    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${quality.bandwidth},RESOLUTION=${quality.resolution}`);
    lines.push(`${qualityName}/index.m3u8`);
  }

  writeFileSync(join(cachePath, 'master.m3u8'), lines.join('\n'));
}

// 获取视频信息（包含 fps）
async function getVideoInfo(videoPath: string): Promise<{ width?: number; height?: number; duration?: number; fps?: number }> {
  return new Promise((resolve, reject) => {
    // 验证文件存在
    if (!existsSync(videoPath)) {
      reject(new Error(`视频文件不存在: ${videoPath}`));
      return;
    }

    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate',
      '-show_entries', 'format=duration',
      '-of', 'json',
      videoPath,
    ]);

    let output = '';
    let errorOutput = '';

    ffprobe.stdout.on('data', (data) => {
      output += data.toString();
    });

    ffprobe.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    ffprobe.on('close', (code) => {
      if (code === 0) {
        try {
          const info = JSON.parse(output);
          const stream = info.streams?.[0] || {};

          // 解析帧率: r_frame_rate 格式为 "30000/1001" 或 "25/1"
          let fps = 24; // 默认值
          if (stream.r_frame_rate) {
            const [num, den] = stream.r_frame_rate.split('/').map(Number);
            if (!isNaN(num) && !isNaN(den) && den !== 0) {
              fps = num / den;
            }
          }

          resolve({
            width: stream.width,
            height: stream.height,
            duration: info.format?.duration ? parseFloat(info.format.duration) : undefined,
            fps: fps,
          });
        } catch (e) {
          reject(new Error(`解析视频信息失败: ${e}`));
        }
      } else {
        reject(new Error(`ffprobe 失败 (退出码 ${code}): ${errorOutput || '未知错误'}`));
      }
    });

    ffprobe.on('error', (err) => {
      reject(new Error(`ffprobe 启动失败: ${err.message}`));
    });
  });
}

// 清理不完整的转码
export function cleanupIncompleteTranscode(cachePath: string): void {
  if (!existsSync(cachePath)) {
    return;
  }

  for (const quality of HLS_QUALITIES) {
    const qualityDir = join(cachePath, quality.name);
    const m3u8Path = join(qualityDir, 'index.m3u8');

    if (existsSync(m3u8Path)) {
      const content = readFileSync(m3u8Path, 'utf-8');
      if (!content.includes('#EXT-X-ENDLIST')) {
        // 删除该码率目录下的所有文件
        const files = readdirSync(qualityDir);
        for (const file of files) {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const fs = require('fs');
          fs.unlinkSync(join(qualityDir, file));
        }
      }
    }
  }
}

// 解析 m3u8 文件，获取 TS 切片信息
export interface M3u8SegmentInfo {
  segmentCount: number;      // 切片数量
  totalDuration: number;     // 总时长（秒）
  hasEndList: boolean;       // 是否有 ENDLIST 标记
  segments: string[];        // 切片文件名列表
}

export function parseM3u8File(m3u8Path: string): M3u8SegmentInfo | null {
  if (!existsSync(m3u8Path)) {
    return null;
  }

  try {
    const content = readFileSync(m3u8Path, 'utf-8');
    const lines = content.split('\n');

    const segments: string[] = [];
    let totalDuration = 0;
    let hasEndList = false;

    for (const line of lines) {
      if (line.startsWith('#EXTINF:')) {
        // 解析时长: #EXTINF:10.0,
        const match = line.match(/#EXTINF:([\d.]+)/);
        if (match) {
          totalDuration += parseFloat(match[1]);
        }
      } else if (line.startsWith('#EXT-X-ENDLIST')) {
        hasEndList = true;
      } else if (line.trim().endsWith('.ts') && !line.startsWith('#')) {
        // 切片文件名
        segments.push(line.trim());
      }
    }

    return {
      segmentCount: segments.length,
      totalDuration,
      hasEndList,
      segments,
    };
  } catch (error) {
    return null;
  }
}

// 验证 HLS 缓存完整性 - 检查实际 TS 文件数量与 m3u8 中声明的是否一致
export interface VerificationResult {
  isValid: boolean;
  qualities: Record<string, {
    hasM3u8: boolean;
    segmentCountInM3u8: number;
    actualTsFileCount: number;
    hasEndList: boolean;
    isValid: boolean;
  }>;
  masterM3u8Exists: boolean;
}

export function verifyHlsCache(cachePath: string): VerificationResult {
  const result: VerificationResult = {
    isValid: true,
    qualities: {},
    masterM3u8Exists: existsSync(join(cachePath, 'master.m3u8')),
  };

  if (!existsSync(cachePath)) {
    result.isValid = false;
    return result;
  }

  for (const quality of HLS_QUALITIES) {
    const qualityDir = join(cachePath, quality.name);
    const m3u8Path = join(qualityDir, 'index.m3u8');

    const qualityResult = {
      hasM3u8: existsSync(m3u8Path),
      segmentCountInM3u8: 0,
      actualTsFileCount: 0,
      hasEndList: false,
      isValid: false,
    };

    if (qualityResult.hasM3u8) {
      const m3u8Info = parseM3u8File(m3u8Path);
      if (m3u8Info) {
        qualityResult.segmentCountInM3u8 = m3u8Info.segmentCount;
        qualityResult.hasEndList = m3u8Info.hasEndList;

        // 统计实际 TS 文件数量
        if (existsSync(qualityDir)) {
          const files = readdirSync(qualityDir);
          qualityResult.actualTsFileCount = files.filter(f => f.endsWith('.ts')).length;
        }

        // 验证：m3u8 中的切片数量 = 实际文件数量 && 有 ENDLIST 标记
        qualityResult.isValid = (
          m3u8Info.hasEndList &&
          m3u8Info.segmentCount > 0 &&
          m3u8Info.segmentCount === qualityResult.actualTsFileCount
        );
      }
    }

    result.qualities[quality.name] = qualityResult;

    // 如果有任何码率无效，整体缓存也算有效（部分可用）
    // 但如果所有码率都无效，则整体缓存无效
    if (!qualityResult.isValid && qualityResult.hasM3u8) {
      // 这个码率的 m3u8 存在但无效，标记为需要重新转码
    }
  }

  // 检查是否至少有一个有效的码率
  const hasValidQuality = Object.values(result.qualities).some(q => q.isValid);
  result.isValid = hasValidQuality && result.masterM3u8Exists;

  return result;
}

// 获取视频的转码状态（已存在函数的增强版）
export function getTranscodeStatus(cachePath: string): TranscodeStatus {
  const verification = verifyHlsCache(cachePath);

  const qualities: Record<string, boolean> = {};
  for (const quality of HLS_QUALITIES) {
    const q = verification.qualities[quality.name];
    qualities[quality.name] = q.isValid;
  }

  return {
    isComplete: verification.isValid && Object.values(qualities).some(v => v),
    qualities,
  };
}
