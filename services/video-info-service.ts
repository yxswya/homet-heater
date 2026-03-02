import { spawn } from 'child_process';

/**
 * 视频信息接口
 */
export interface VideoInfo {
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

export class VideoInfoService {
    /**
     * 检查 FFmpeg 是否可用
     */
    async checkFFmpeg(): Promise<boolean> {
        return new Promise((resolve) => {
            const ffmpeg = spawn('ffmpeg', ['-version']);
            ffmpeg.on('error', () => resolve(false));
            ffmpeg.on('exit', (code) => resolve(code === 0));
        });
    }

    /**
     * 获取视频信息（分辨率、时长、编码格式等）
     */
    async getVideoInfo(videoPath: string): Promise<VideoInfo | null> {
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
                                    size: format.size ? this.formatSizeBytes(format.size) : undefined
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
                    const size = this.formatSizeBytes(sizeBytes);

                    // 格式化比特率
                    const bitrate = format.bit_rate ? this.formatBitrate(format.bit_rate) : undefined;

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

    /**
     * 格式化文件大小
     */
    formatSizeBytes(bytes: string | number): string {
        const size = typeof bytes === 'string' ? parseInt(bytes) : bytes;
        if (size < 1024) return size + ' B';
        if (size < 1024 * 1024) return (size / 1024).toFixed(2) + ' KB';
        if (size < 1024 * 1024 * 1024) return (size / (1024 * 1024)).toFixed(2) + ' MB';
        return (size / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }

    /**
     * 格式化比特率
     */
    formatBitrate(bits: string | number): string {
        const bitrate = typeof bits === 'string' ? parseInt(bits) : bits;
        if (bitrate < 1000) return bitrate + ' bps';
        if (bitrate < 1000000) return (bitrate / 1000).toFixed(0) + ' Kbps';
        return (bitrate / 1000000).toFixed(2) + ' Mbps';
    }

    /**
     * 格式化时长（秒 -> HH:MM:SS 或 MM:SS）
     */
    formatDuration(seconds: number | undefined): string {
        if (!seconds || isNaN(seconds)) return '--:--';
        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        if (hrs > 0) {
            return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        }
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
}
