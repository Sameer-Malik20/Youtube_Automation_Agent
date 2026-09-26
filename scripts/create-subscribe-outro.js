const path = require('path');
const fsp = require('fs').promises;
const { runFFmpeg } = require('../utils/ffmpeg');

async function createSubscribeOutro() {
  console.log('Generating branded AgenticFlowAIS Subscribe Outro...');
  const assetsDir = path.join(__dirname, '..', 'data', 'assets');
  await fsp.mkdir(assetsDir, { recursive: true });
  const outroPath = path.join(assetsDir, 'agenticflow_subscribe_outro.mp4');

  const duration = 5;
  const tempDir = path.join(__dirname, '..', 'temp');
  await fsp.mkdir(tempDir, { recursive: true });

  const assContent = `[Script Info]
Title: Subscribe Outro
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: TitleStyle,Arial,84,&H00FFE500,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,4,2,60,60,1150,1
Style: SubStyle,Arial,44,&H00CCCCCC,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,2,2,60,60,1050,1
Style: BtnStyle,Arial,64,&H00FFFFFF,&H000000FF,&H003300FF,&H80000000,-1,0,0,0,100,100,0,0,1,6,4,2,60,60,820,1
Style: CallStyle,Arial,52,&H0000FFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,4,2,60,60,650,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,TitleStyle,,0,0,0,,{\\fad(200,200)}AgenticFlowAIS
Dialogue: 0,0:00:00.00,0:00:05.00,SubStyle,,0,0,0,,{\\fad(200,200)}AI & TECH EXPLAINED
Dialogue: 0,0:00:00.50,0:00:05.00,BtnStyle,,0,0,0,,{\\fad(200,200)}▶ SUBSCRIBE NOW
Dialogue: 0,0:00:01.00,0:00:05.00,CallStyle,,0,0,0,,{\\fad(200,200)}WATCH PART 2 NEXT! 🚀
`;

  const assPath = path.join(tempDir, 'outro_captions.ass');
  await fsp.writeFile(assPath, assContent, 'utf8');
  const escapedAss = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

  // Simple clean background using cyber stock or solid dark gradient + audio tone
  await runFFmpeg([
    '-y',
    '-f', 'lavfi', '-i', `color=c=0x0a0e17:s=1080x1920:d=${duration}:r=30`,
    '-f', 'lavfi', '-i', `aevalsrc=sin(587*2*PI*t)*exp(-2*t)+sin(880*2*PI*t)*exp(-3*t):s=48000:d=${duration}`,
    '-vf', `subtitles='${escapedAss}'`,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    outroPath
  ]);

  console.log('Outro created successfully at:', outroPath);
  return outroPath;
}

createSubscribeOutro().catch(err => {
  console.error('Failed to create outro:', err);
  process.exit(1);
});
