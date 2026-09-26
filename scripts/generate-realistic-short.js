const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { runFFmpeg } = require('../utils/ffmpeg');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

// Helper to get duration using ffmpeg/ffprobe
async function getMediaDuration(filePath) {
  try {
    const res = await runFFmpeg(['-i', filePath]);
    const match = res.stderr?.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    if (match) {
      return parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]);
    }
  } catch (e) {
    const match = e.message?.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    if (match) {
      return parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]);
    }
  }
  return 30; // fallback
}

// Download clip helper
async function downloadClip(url, dest) {
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

// Format seconds into ASS subtitle timestamp (H:MM:SS.CC)
function formatAssTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

async function main() {
  console.log('=== STARTING REALISTIC SHORTS GENERATION PIPELINE ===');
  const tempDir = path.join(__dirname, '..', 'temp', 'realistic_short');
  await fsp.mkdir(tempDir, { recursive: true });

  // 1. Script definition (Part 1: The Hook & Mystery of AI Vision)
  const scriptScenes = [
    {
      text: "Kya aapne kabhi socha hai, AI images ko kaise dekhta hai?",
      subtitle: "AI IMAGES KO KAISE DEKHTA HAI? 🤔",
      query: "technology"
    },
    {
      text: "Hum insaan to chehre, colours aur sundarta dekhte hain. Par AI ke liye koi bhi photo sirf numbers ka ek gigantesque matrix hota hai!",
      subtitle: "AI KE LIYE PHOTO SIRF NUMBERS HAIN! 🔢",
      query: "cyber"
    },
    {
      text: "Har ek single pixel ki value zero se 255 ke beech hoti hai. Red, Green aur Blue channels me!",
      subtitle: "HAR PIXEL: 0 SE 255 VALUES (RGB) 🎨",
      query: "computer"
    },
    {
      text: "Neural networks in numbers me se pehle edges dhundte hain, phir shapes, aur aakhir me poora chehra pehchante hain!",
      subtitle: "EDGES ➔ SHAPES ➔ FULL OBJECT! ⚡",
      query: "network"
    },
    {
      text: "Is magical process ko Computer Vision kehte hain. Part two me dekhenge AI video kaise samajhta hai, subscribe kijiye AgenticFlowAIS!",
      subtitle: "SUBSCRIBE AGENTICFLOWAIS FOR PART 2! 🚀",
      query: "technology"
    }
  ];

  const fullSpeech = scriptScenes.map(s => s.text).join(' ');
  console.log('Full speech text length:', fullSpeech.length, 'characters');

  // 2. Generate Voiceover via Gemini TTS
  console.log('Generating Gemini TTS Hinglish voiceover...');
  const audioPcm = path.join(tempDir, 'voiceover.pcm');
  const audioWav = path.join(tempDir, 'voiceover.wav');

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: 'gemini-3.1-flash-tts-preview',
    contents: [{ parts: [{ text: fullSpeech }] }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: 'Kore' }
        }
      }
    }
  });

  const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64Audio) throw new Error('No audio returned by Gemini TTS');
  await fsp.writeFile(audioPcm, Buffer.from(base64Audio, 'base64'));

  // Convert raw PCM (24kHz 16-bit mono) to WAV
  await runFFmpeg(['-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', audioPcm, audioWav]);
  console.log('Voiceover audio generated at:', audioWav);

  const totalDuration = await getMediaDuration(audioWav);
  console.log('Total voiceover duration:', totalDuration.toFixed(2), 'seconds');

  // 3. Download curated real cinematic stock clips from Mixkit
  console.log('Fetching real HD cinematic tech clips...');
  const stockClips = [
    'https://assets.mixkit.co/videos/46635/46635-720.mp4', // Tech holographic lines
    'https://assets.mixkit.co/videos/5728/5728-720.mp4',   // Cyber matrix data stream
    'https://assets.mixkit.co/videos/1781/1781-1080.mp4',  // Code and computer screen
    'https://assets.mixkit.co/videos/31771/31771-720.mp4', // Global neural network connections
    'https://assets.mixkit.co/videos/41551/41551-720.mp4'  // Futuristic AI particles
  ];

  const localClips = [];
  for (let i = 0; i < stockClips.length; i++) {
    const dest = path.join(tempDir, `clip_${i}.mp4`);
    console.log(`Downloading clip ${i + 1}/${stockClips.length}...`);
    await downloadClip(stockClips[i], dest);
    localClips.push(dest);
  }

  // 4. Calculate scene timings and create stylish ASS subtitles
  const sceneDuration = totalDuration / scriptScenes.length;
  console.log(`Each scene duration: ${sceneDuration.toFixed(2)}s`);

  let assContent = `[Script Info]
Title: AgenticFlowAIS Dynamic Shorts Captions
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: HookStyle,Arial,68,&H0000FFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,3,2,60,60,420,1
Style: BodyStyle,Arial,62,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,3,2,60,60,420,1
Style: AccentStyle,Arial,64,&H0000E5FF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,3,2,60,60,420,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  for (let i = 0; i < scriptScenes.length; i++) {
    const startSec = i * sceneDuration;
    const endSec = (i + 1) * sceneDuration;
    const style = (i === 0 || i === scriptScenes.length - 1) ? 'HookStyle' : (i % 2 === 1 ? 'AccentStyle' : 'BodyStyle');
    assContent += `Dialogue: 0,${formatAssTime(startSec)},${formatAssTime(endSec)},${style},,0,0,0,,{\\fad(120,120)}${scriptScenes[i].subtitle}\n`;
  }

  const assPath = path.join(tempDir, 'captions.ass');
  await fsp.writeFile(assPath, assContent, 'utf8');
  console.log('Captions created at:', assPath);

  // 5. Build Vertical 9:16 Video Clips using FFmpeg
  // We crop & scale each clip to 1080x1920 with high-quality center crop
  console.log('Processing clips into vertical 9:16 (1080x1920)...');
  const processedClips = [];

  for (let i = 0; i < localClips.length; i++) {
    const outClip = path.join(tempDir, `processed_${i}.mp4`);
    const duration = sceneDuration.toFixed(2);

    // FFmpeg filter: scale to fill 1080x1920 then crop center
    const vf = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30`;
    await runFFmpeg([
      '-y',
      '-stream_loop', '-1',
      '-i', localClips[i],
      '-t', duration,
      '-vf', vf,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-pix_fmt', 'yuv420p',
      outClip
    ]);
    processedClips.push(outClip);
  }

  // 6. Concatenate video clips
  console.log('Concatenating clips into master video stream...');
  const concatList = path.join(tempDir, 'concat_list.txt');
  const fileLines = processedClips.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
  await fsp.writeFile(concatList, fileLines, 'utf8');

  const rawMergedVideo = path.join(tempDir, 'raw_merged.mp4');
  await runFFmpeg([
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatList,
    '-c', 'copy',
    rawMergedVideo
  ]);

  // 7. Add Voiceover Audio & Burn in Subtitles
  console.log('Burning dynamic captions and synchronizing Gemini voiceover...');
  const samplesDir = path.join(__dirname, '..', 'samples');
  await fsp.mkdir(samplesDir, { recursive: true });
  const finalVideoPath = path.join(samplesDir, 'agenticflow_ai_vision_sample_short.mp4');

  // Escape colon and backslashes for FFmpeg subtitles filter on Windows
  const escapedAssPath = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

  await runFFmpeg([
    '-y',
    '-i', rawMergedVideo,
    '-i', audioWav,
    '-vf', `subtitles='${escapedAssPath}'`,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    finalVideoPath
  ]);

  console.log('=== REALISTIC SHORTS VIDEO GENERATED SUCCESSFULLY! ===');
  console.log('Saved to:', finalVideoPath);
  const stats = fs.statSync(finalVideoPath);
  console.log('Final video size:', (stats.size / (1024 * 1024)).toFixed(2), 'MB');
}

main().catch(err => {
  console.error('Pipeline error:', err);
  process.exit(1);
});
