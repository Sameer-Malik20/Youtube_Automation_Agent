const fs = require('fs');
const path = require('path');
const { runFFmpeg } = require('../utils/ffmpeg');

async function mergeUserVideos() {
  console.log('Merging user Gemini generated video clips...');
  const tempDir = path.join(__dirname, '..', 'temp');
  const samplesDir = path.join(__dirname, '..', 'samples');
  if (!fs.existsSync(samplesDir)) fs.mkdirSync(samplesDir, { recursive: true });

  const clip1 = path.resolve(__dirname, '..', 'gemini_generated_video_484faf7e.mp4');
  const clip2 = path.resolve(__dirname, '..', 'A_second_cinematic_D_video (1).mp4');

  const concatList = path.join(tempDir, 'concat_user_clips.txt');
  const content = `file '${clip1.replace(/\\/g, '/')}'\nfile '${clip2.replace(/\\/g, '/')}'\n`;
  fs.writeFileSync(concatList, content, 'utf8');

  // Direct lossless stream copy merge (original 1280x720, 24fps)
  const outputPath = path.join(samplesDir, 'agenticflow_ai_vision_50s_final_merged.mp4');
  await runFFmpeg([
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatList,
    '-c', 'copy',
    outputPath
  ]);

  console.log('✅ Final 50s video merged successfully at:', outputPath);
  const stats = fs.statSync(outputPath);
  console.log('Final file size:', (stats.size / (1024 * 1024)).toFixed(2), 'MB');
  return outputPath;
}

mergeUserVideos().catch(err => {
  console.error('Merge failed:', err);
  process.exit(1);
});
