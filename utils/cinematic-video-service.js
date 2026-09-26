const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { runFFmpeg, checkFFmpeg, ffmpegInstallHint } = require('./ffmpeg');
const { Logger } = require('./logger');

// Curated pool of high-quality verified royalty-free tech/AI clips from public CDNs
const CURATED_TECH_CLIPS = [
  'https://assets.mixkit.co/videos/46635/46635-720.mp4', // Futuristic holographic lines
  'https://assets.mixkit.co/videos/5728/5728-720.mp4',   // Cyber matrix data stream
  'https://assets.mixkit.co/videos/1781/1781-1080.mp4',  // Computer screen code
  'https://assets.mixkit.co/videos/31771/31771-720.mp4', // Neural network global connections
  'https://assets.mixkit.co/videos/41551/41551-720.mp4', // AI particles & light flow
  'https://assets.mixkit.co/videos/43621/43621-720.mp4', // Digital technology wave
  'https://assets.mixkit.co/videos/4836/4836-720.mp4',   // Futuristic interface HUD
  'https://assets.mixkit.co/videos/23246/23246-720.mp4'  // Server room lights & computing
];

function formatAssTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

class CinematicVideoService {
  constructor(options = {}) {
    this.logger = options.logger || new Logger('CinematicVideoService');
    this.cacheDir = options.cacheDir || path.join(__dirname, '..', 'data', 'assets', 'stock_clips');
  }

  async initialize() {
    await fsp.mkdir(this.cacheDir, { recursive: true });
  }

  async getMediaDuration(filePath) {
    try {
      const res = await runFFmpeg(['-i', filePath]);
      const match = res.stderr?.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (match) {
        return parseInt(match[1], 10) * 3600 + parseInt(match[2], 10) * 60 + parseFloat(match[3]);
      }
    } catch (e) {
      const match = e.message?.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (match) {
        return parseInt(match[1], 10) * 3600 + parseInt(match[2], 10) * 60 + parseFloat(match[3]);
      }
    }
    return 30;
  }

  async downloadClip(url, dest) {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 10000) {
      return dest;
    }
    const res = await axios({
      method: 'get',
      url,
      responseType: 'stream',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 30000
    });
    const writer = fs.createWriteStream(dest);
    res.data.pipe(writer);
    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(dest));
      writer.on('error', reject);
    });
  }

  async fetchDynamicStockClips(category = 'technology', count = 5) {
    try {
      const res = await axios.get(`https://mixkit.co/free-stock-video/${encodeURIComponent(category)}/`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 10000
      });
      const mp4s = [...new Set(res.data.match(/https:\/\/[^"'\s<>]+\.mp4/g) || [])];
      if (mp4s.length >= 3) {
        return mp4s.slice(0, count);
      }
    } catch (_err) {
      this.logger.warn(`Could not scrape category ${category}, using curated library`);
    }
    return CURATED_TECH_CLIPS.slice(0, count);
  }

  extractScriptLines(script) {
    const lines = [];
    if (script?.hook?.text) lines.push(script.hook.text);
    if (script?.introduction) {
      const intro = [script.introduction.greeting, script.introduction.topicIntro, script.introduction.valueProposition].filter(Boolean).join(' ');
      if (intro) lines.push(intro);
    }
    if (script?.mainContent?.sections) {
      for (const sec of script.mainContent.sections) {
        if (Array.isArray(sec.content)) {
          lines.push(...sec.content.filter(c => typeof c === 'string' && !c.startsWith('[')));
        } else if (typeof sec.content === 'string') {
          lines.push(sec.content);
        } else if (sec.title) {
          lines.push(sec.title);
        }
      }
    }
    if (script?.conclusion?.finalThought) lines.push(script.conclusion.finalThought);
    if (script?.callToAction?.subscribe) lines.push(script.callToAction.subscribe);
    
    // Split long lines into clean 5-10 word segments for captions
    const cleanLines = [];
    for (const line of lines) {
      const sentences = String(line).replace(/\n+/g, ' ').split(/(?<=[.!?।])\s+/);
      for (const s of sentences) {
        const trimmed = s.trim();
        if (trimmed.length > 5) cleanLines.push(trimmed);
      }
    }
    return cleanLines.length >= 3 ? cleanLines : [
      script?.title || 'Fascinating AI Technology Explained',
      'Discover how intelligent systems perceive data',
      'Every pixel is converted into neural matrices',
      'Transforming patterns into intelligent reasoning',
      'Subscribe to AgenticFlowAIS for next parts!'
    ];
  }

  async render(script, audioPath, outputPath, options = {}) {
    if (!(await checkFFmpeg())) {
      throw new Error(ffmpegInstallHint());
    }

    await this.initialize();
    const tempDir = path.join(path.dirname(outputPath), `render_${Date.now()}`);
    await fsp.mkdir(tempDir, { recursive: true });

    try {
      this.logger.info('Rendering realistic cinematic video...');
      const duration = await this.getMediaDuration(audioPath);
      this.logger.info(`Voiceover audio duration: ${duration.toFixed(2)}s`);

      const scriptLines = this.extractScriptLines(script);
      const sceneCount = Math.max(3, Math.min(8, scriptLines.length));
      const perSceneDuration = duration / sceneCount;

      // 1. Gather stock clips
      const clipUrls = await this.fetchDynamicStockClips('technology', sceneCount);
      const downloadedClips = [];

      for (let i = 0; i < sceneCount; i++) {
        const clipUrl = clipUrls[i % clipUrls.length] || CURATED_TECH_CLIPS[i % CURATED_TECH_CLIPS.length];
        const dest = path.join(this.cacheDir, `stock_${path.basename(clipUrl)}`);
        await this.downloadClip(clipUrl, dest);
        downloadedClips.push(dest);
      }

      // 2. Determine format (aspect ratio)
      const isVertical = (options.aspectRatio || process.env.VIDEO_ASPECT_RATIO || '9:16') === '9:16';
      const width = isVertical ? 1080 : 1920;
      const height = isVertical ? 1920 : 1080;

      // 3. Process each clip into exact format & scene duration
      const processedClips = [];
      const vf = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=30`;

      for (let i = 0; i < sceneCount; i++) {
        const outClip = path.join(tempDir, `scene_${i}.mp4`);
        await runFFmpeg([
          '-y',
          '-stream_loop', '-1',
          '-i', downloadedClips[i],
          '-t', perSceneDuration.toFixed(2),
          '-vf', vf,
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-pix_fmt', 'yuv420p',
          outClip
        ]);
        processedClips.push(outClip);
      }

      // 4. Merge clips
      const concatList = path.join(tempDir, 'concat_list.txt');
      const fileLines = processedClips.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
      await fsp.writeFile(concatList, fileLines, 'utf8');

      const rawMerged = path.join(tempDir, 'raw_merged.mp4');
      await runFFmpeg([
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatList,
        '-c', 'copy',
        rawMerged
      ]);

      // 5. Generate stylish ASS subtitles
      const assContent = `[Script Info]
Title: Dynamic Realistic Captions
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: HookStyle,Arial,${isVertical ? 66 : 48},&H0000FFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,3,2,60,60,${isVertical ? 420 : 120},1
Style: BodyStyle,Arial,${isVertical ? 60 : 44},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,3,2,60,60,${isVertical ? 420 : 120},1
Style: AccentStyle,Arial,${isVertical ? 62 : 46},&H0000E5FF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,3,2,60,60,${isVertical ? 420 : 120},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
` + scriptLines.slice(0, sceneCount).map((line, idx) => {
        const start = idx * perSceneDuration;
        const end = (idx + 1) * perSceneDuration;
        const style = idx === 0 || idx === sceneCount - 1 ? 'HookStyle' : (idx % 2 === 1 ? 'AccentStyle' : 'BodyStyle');
        return `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},${style},,0,0,0,,{\\fad(120,120)}${line.toUpperCase()}`;
      }).join('\n');

      const assPath = path.join(tempDir, 'subtitles.ass');
      await fsp.writeFile(assPath, assContent, 'utf8');

      // 6. Burn subtitles & mix audio into final MP4
      const escapedAssPath = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
      await fsp.mkdir(path.dirname(outputPath), { recursive: true });

      await runFFmpeg([
        '-y',
        '-i', rawMerged,
        '-i', audioPath,
        '-vf', `subtitles='${escapedAssPath}'`,
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '20',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest',
        outputPath
      ]);

      this.logger.info(`Realistic cinematic video rendered successfully at: ${outputPath}`);
      return outputPath;
    } finally {
      // Clean up temp render files
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports = { CinematicVideoService, CURATED_TECH_CLIPS };
