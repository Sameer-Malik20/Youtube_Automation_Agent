const { runFFmpeg } = require('../utils/ffmpeg');
const path = require('path');
const fs = require('fs').promises;

async function generateSamples() {
  console.log('🎬 Generating both video style samples...');

  const samplesDir = path.join(__dirname, '..', 'samples');
  await fs.mkdir(samplesDir, { recursive: true });

  const refVideo = path.join(__dirname, '..', 'WhatsApp Video 2026-09-21 at 4.01.04 PM.mp4');
  const audio1 = path.join(samplesDir, 'sample1_narration.mp3');

  // ==========================================
  // SAMPLE 1: Faceless Dynamic B-Roll + Kinetic Captions (Shorts 1080x1920)
  // ==========================================
  console.log('\n--- Building Sample 1: Faceless Dynamic B-Roll + Kinetic Captions ---');
  const sample1Out = path.join(samplesDir, 'Sample1_Dynamic_BRoll_Shorts.mp4');

  const sample1Filter = [
    'testsrc=s=1080x1920:d=3:r=30[ts1]',
    'testsrc2=s=1080x1920:d=3:r=30[ts2]',
    'smptebars=s=1080x1920:d=3:r=30[ts3]',
    'rgbtestsrc=s=1080x1920:d=3:r=30[ts4]',
    '[ts1]format=yuv420p,curves=all=\'0/0 0.5/0.2 1/0.8\',boxblur=2:1[v1]',
    '[ts2]format=yuv420p,curves=all=\'0/0 0.5/0.2 1/0.8\',boxblur=2:1[v2]',
    '[ts3]format=yuv420p,curves=all=\'0/0 0.5/0.2 1/0.8\',boxblur=2:1[v3]',
    '[ts4]format=yuv420p,curves=all=\'0/0 0.5/0.2 1/0.8\',boxblur=2:1[v4]',
    '[v1][v2][v3][v4]concat=n=4:v=1:a=0[raw_scenes]',
    '[raw_scenes]vignette=PI/4,eq=contrast=1.3:brightness=-0.1:saturation=1.4[visual_base]',
    '[visual_base]drawbox=y=900:color=black@0.65:width=iw:height=220:t=fill:enable=\'between(t,0.2,2.8)\',' +
    'drawtext=text=\'KYA AAPKO PATA HAI?\':fontcolor=white:fontsize=72:x=(w-text_w)/2:y=940:enable=\'between(t,0.2,2.8)\':box=1:boxcolor=0x00E5FF@0.3:boxborderw=10,' +
    'drawtext=text=\'AI KAISE DEKHTA HAI?\':fontcolor=0xFFE600:fontsize=78:x=(w-text_w)/2:y=1030:enable=\'between(t,1.2,2.8)\',' +
    'drawbox=y=900:color=black@0.65:width=iw:height=220:t=fill:enable=\'between(t,2.9,5.8)\',' +
    'drawtext=text=\'INSAN KI TARAH\':fontcolor=white:fontsize=72:x=(w-text_w)/2:y=940:enable=\'between(t,2.9,5.8)\',' +
    'drawtext=text=\'BILKUL NAHI!\':fontcolor=0xFF3366:fontsize=84:x=(w-text_w)/2:y=1030:enable=\'between(t,3.8,5.8)\',' +
    'drawbox=y=900:color=black@0.65:width=iw:height=220:t=fill:enable=\'between(t,5.9,8.9)\',' +
    'drawtext=text=\'AI KE LIYE HAR PHOTO\':fontcolor=white:fontsize=72:x=(w-text_w)/2:y=940:enable=\'between(t,5.9,8.9)\',' +
    'drawtext=text=\'LAKHO NUMBERS HAIN\':fontcolor=0x00E5FF:fontsize=78:x=(w-text_w)/2:y=1030:enable=\'between(t,6.9,8.9)\',' +
    'drawbox=y=900:color=black@0.65:width=iw:height=220:t=fill:enable=\'between(t,9.0,12.0)\',' +
    'drawtext=text=\'PIXELS KA EK\':fontcolor=white:fontsize=72:x=(w-text_w)/2:y=940:enable=\'between(t,9.0,12.0)\',' +
    'drawtext=text=\'GIANT MATRIX!\':fontcolor=0xFFE600:fontsize=88:x=(w-text_w)/2:y=1030:enable=\'between(t,9.8,12.0)\'[outv]'
  ].join(';');

  try {
    await runFFmpeg([
      '-y',
      '-i', audio1,
      '-filter_complex', sample1Filter,
      '-map', '[outv]',
      '-map', '0:a',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-shortest',
      sample1Out
    ]);
    console.log('✅ Sample 1 created:', sample1Out);
  } catch (err) {
    console.error('Error creating Sample 1:', err.message);
  }

  // ==========================================
  // SAMPLE 2: AI Avatar Presenter + 3D Holographic B-Roll (Exact WhatsApp Style)
  // ==========================================
  console.log('\n--- Building Sample 2: AI Talking Avatar + 3D Holographic Cutaways ---');
  const sample2Out = path.join(samplesDir, 'Sample2_AI_Avatar_Cinematic.mp4');

  const sample2Filter = [
    '[0:v]trim=start=0:end=4,setpts=PTS-STARTPTS[p1]',
    '[0:v]trim=start=4.5:end=7.5,setpts=PTS-STARTPTS[b1]',
    '[0:v]trim=start=8.5:end=11.5,setpts=PTS-STARTPTS[p2]',
    '[0:v]trim=start=11.5:end=16.0,setpts=PTS-STARTPTS[b2]',
    '[0:v]trim=start=16.5:end=20.5,setpts=PTS-STARTPTS[b3]',
    '[0:v]trim=start=26.0:end=29.0,setpts=PTS-STARTPTS[p3]',

    '[0:a]atrim=start=0:end=4,asetpts=PTS-STARTPTS[a1]',
    '[0:a]atrim=start=4.5:end=7.5,asetpts=PTS-STARTPTS[a2]',
    '[0:a]atrim=start=8.5:end=11.5,asetpts=PTS-STARTPTS[a3]',
    '[0:a]atrim=start=11.5:end=16.0,asetpts=PTS-STARTPTS[a4]',
    '[0:a]atrim=start=16.5:end=20.5,asetpts=PTS-STARTPTS[a5]',
    '[0:a]atrim=start=26.0:end=29.0,asetpts=PTS-STARTPTS[a6]',

    '[p1][b1][p2][b2][b3][p3]concat=n=6:v=1:a=0[v_concat]',
    '[a1][a2][a3][a4][a5][a6]concat=n=6:v=0:a=1[a_concat]',

    '[v_concat]drawbox=x=40:y=40:w=260:h=60:color=0x000000@0.7:t=fill,' +
    'drawtext=text=\'AgenticFlowAIS\':fontcolor=0x00E5FF:fontsize=28:x=60:y=56,' +
    'drawtext=text=\'AI EXPLAINED\':fontcolor=0xFFE600:fontsize=48:x=(w-text_w)/2:y=h-120:enable=\'between(t,1,4)\'[v_final]'
  ].join(';');

  try {
    await runFFmpeg([
      '-y',
      '-i', refVideo,
      '-filter_complex', sample2Filter,
      '-map', '[v_final]',
      '-map', '[a_concat]',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-c:a', 'aac',
      sample2Out
    ]);
    console.log('✅ Sample 2 created:', sample2Out);
  } catch (err) {
    console.error('Error creating Sample 2:', err.message);
  }

  console.log('\n🎉 Both samples generated successfully!');
}

generateSamples().catch(console.error);
