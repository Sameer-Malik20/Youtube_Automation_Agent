const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { runFFmpeg } = require('../utils/ffmpeg');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

async function getMediaDuration(filePath) {
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
  return 45;
}

function formatAssTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

async function main() {
  console.log('=== STARTING 50-SECOND CONCEPT SHORT GENERATION ===');
  const tempDir = path.join(__dirname, '..', 'temp', '50s_short');
  await fsp.mkdir(tempDir, { recursive: true });

  // 1. Master 50-Second Script (Carefully timed for 42-45s spoken speed)
  const scriptParagraphs = [
    {
      start: 0,
      end: 10,
      text: "Kya aapne kabhi socha hai, AI images ko kaise dekhta hai? Hum insaan to chehre, aankhein aur colours dekhte hain. Par AI ke liye koi bhi photo sirf numbers ka ek gigantic grid hota hai!",
      subtitle: "AI KE LIYE PHOTO = NUMBERS KA MATRIX! 🔢"
    },
    {
      start: 10,
      end: 22,
      text: "Screen par har single pixel teen channels me toot-ta hai: Red, Green aur Blue! Aur har channel ki value zero se 255 ke beech hoti hai. Yaani ek 4K photo AI ke liye karodon numbers ki ek list ban jati hai!",
      subtitle: "RGB PIXELS: 0 SE 255 KI VALUES 🎨"
    },
    {
      start: 22,
      end: 34,
      text: "Ab shuru hota hai real magic! Deep Neural Networks in numbers ke patterns ko scan karte hain. Pehli layer edges aur lines dhundti hai, doosri layer shapes pehchanti hai, aur aakhiri layer poora chehra identify kar leti hai!",
      subtitle: "EDGES ➔ SHAPES ➔ FULL FACE DETECT! ⚡"
    },
    {
      start: 34,
      end: 45,
      text: "Is magical process ko kehte hain Computer Vision. Jiske bina na to aapka smartphone face unlock chal sakta hai aur na hi Tesla ki self-driving car! Part two me dekhenge AI videos kaise samajhta hai!",
      subtitle: "COMPUTER VISION: AI KI SUPERPOWER! 🚀"
    }
  ];

  const fullSpeech = scriptParagraphs.map(p => p.text).join(' ');
  console.log('Full speech character count:', fullSpeech.length);

  // 2. Synthesize Master Audio using Gemini TTS
  console.log('Synthesizing continuous master voiceover via Gemini TTS...');
  const audioPcm = path.join(tempDir, 'master_voiceover.pcm');
  const audioWav = path.join(tempDir, 'master_voiceover.wav');

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
  if (!base64Audio) throw new Error('No audio returned from Gemini TTS');
  await fsp.writeFile(audioPcm, Buffer.from(base64Audio, 'base64'));

  // Convert raw PCM to WAV
  await runFFmpeg(['-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', audioPcm, audioWav]);
  const audioDuration = await getMediaDuration(audioWav);
  console.log(`Voiceover audio generated: ${audioDuration.toFixed(2)}s`);

  // 3. Prepare Visual Storyboard Clips
  // We extract and format the 4 main concept scenes into 1080x1920 (9:16)
  console.log('Extracting and preparing 3D concept clips...');
  const whatsappVideo = path.join(__dirname, '..', 'WhatsApp Video 2026-09-22 at 8.42.40 AM.mp4');
  
  // Scene 1: Face Laser Scan (0s to 3.2s from WhatsApp Video looped or slowed)
  const scene1 = path.join(tempDir, 'scene1_face_scan.mp4');
  await runFFmpeg([
    '-y',
    '-ss', '0.0', '-t', '3.3',
    '-i', whatsappVideo,
    '-filter_complex', '[0:v]setpts=3.0*PTS,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30[v]',
    '-map', '[v]',
    '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
    '-t', '10.5',
    scene1
  ]);

  // Scene 2: 3D RGB Matrix Numbers (3.3s to 6.5s from WhatsApp Video)
  const scene2 = path.join(tempDir, 'scene2_rgb_matrix.mp4');
  await runFFmpeg([
    '-y',
    '-ss', '3.3', '-t', '3.2',
    '-i', whatsappVideo,
    '-filter_complex', '[0:v]setpts=3.5*PTS,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30[v]',
    '-map', '[v]',
    '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
    '-t', '11.5',
    scene2
  ]);

  // Scene 3: 3D Neural Network Synapses (6.5s to 10s from WhatsApp Video)
  const scene3 = path.join(tempDir, 'scene3_neural_nodes.mp4');
  await runFFmpeg([
    '-y',
    '-ss', '6.5', '-t', '3.5',
    '-i', whatsappVideo,
    '-filter_complex', '[0:v]setpts=3.5*PTS,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30[v]',
    '-map', '[v]',
    '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
    '-t', '12.0',
    scene3
  ]);

  // Scene 4: Futuristic AI Vision in Action (Stock clip of digital neural HUD)
  const scene4 = path.join(tempDir, 'scene4_computer_vision.mp4');
  const stockClipPath = path.join(__dirname, '..', 'data', 'assets', 'stock_clips', 'stock_31771-720.mp4');
  const stockFallback = fs.existsSync(stockClipPath) ? stockClipPath : path.join(__dirname, '..', 'temp', 'test_stock.mp4');

  await runFFmpeg([
    '-y',
    '-stream_loop', '-1',
    '-i', stockFallback,
    '-filter_complex', '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30[v]',
    '-map', '[v]',
    '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
    '-t', '11.0',
    scene4
  ]);

  // Scene 5: Branded Subscribe Outro
  const outroPath = path.join(__dirname, '..', 'data', 'assets', 'agenticflow_subscribe_outro.mp4');

  // 4. Concatenate All 5 Scenes
  console.log('Concatenating 5 scenes into master 50-second video stream...');
  const concatList = path.join(tempDir, 'concat_list.txt');
  const scenesList = [scene1, scene2, scene3, scene4, outroPath];
  const fileLines = scenesList.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
  await fsp.writeFile(concatList, fileLines, 'utf8');

  const rawMergedVideo = path.join(tempDir, 'raw_50s_merged.mp4');
  await runFFmpeg([
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatList,
    '-c', 'copy',
    rawMergedVideo
  ]);

  // 5. Generate Dynamic ASS Subtitles
  console.log('Generating dynamic pop-up subtitles...');
  const totalScenes = scriptParagraphs.length;
  const perSection = audioDuration / totalScenes;

  let assContent = `[Script Info]
Title: AgenticFlowAIS 50s Shorts
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: HookStyle,Arial,66,&H0000FFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,3,2,60,60,420,1
Style: BodyStyle,Arial,60,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,3,2,60,60,420,1
Style: AccentStyle,Arial,64,&H0000E5FF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,3,2,60,60,420,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  for (let i = 0; i < scriptParagraphs.length; i++) {
    const startSec = i * perSection;
    const endSec = (i + 1) * perSection;
    const style = (i === 0) ? 'HookStyle' : (i % 2 === 1 ? 'AccentStyle' : 'BodyStyle');
    assContent += `Dialogue: 0,${formatAssTime(startSec)},${formatAssTime(endSec)},${style},,0,0,0,,{\\fad(100,100)}${scriptParagraphs[i].subtitle}\n`;
  }

  const assPath = path.join(tempDir, 'captions.ass');
  await fsp.writeFile(assPath, assContent, 'utf8');

  // 6. Final Assembly: Merge Audio + Video + Subtitles + Outro
  console.log('Assembling final 50-second short with audio and subtitles...');
  const samplesDir = path.join(__dirname, '..', 'samples');
  await fsp.mkdir(samplesDir, { recursive: true });
  const finalVideoPath = path.join(samplesDir, 'agenticflow_ai_vision_50s_master_short.mp4');

  const escapedAss = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

  // We combine the voiceover audio for the first 4 scenes and let the outro audio finish the clip
  // Using filter_complex to mix voiceover + outro audio
  const combinedAudio = path.join(tempDir, 'combined_audio.wav');
  await runFFmpeg([
    '-y',
    '-i', audioWav,
    '-i', outroPath,
    '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[aout]',
    '-map', '[aout]',
    combinedAudio
  ]);

  await runFFmpeg([
    '-y',
    '-i', rawMergedVideo,
    '-i', combinedAudio,
    '-vf', `subtitles='${escapedAss}'`,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '19',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    finalVideoPath
  ]);

  console.log('=== 50-SECOND MASTER SHORT GENERATED SUCCESSFULLY! ===');
  console.log('Final Video Location:', finalVideoPath);
  const stats = fs.statSync(finalVideoPath);
  console.log('Final video size:', (stats.size / (1024 * 1024)).toFixed(2), 'MB');
}

main().catch(err => {
  console.error('50s Short Generation Error:', err);
  process.exit(1);
});
