require('dotenv').config();
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { CredentialManager } = require('../utils/credential-manager');

async function uploadShort() {
  console.log(chalk.cyan.bold('\n🚀 ====================================================='));
  console.log(chalk.cyan.bold('   YOUTUBE SHORTS DIRECT UPLOADER'));
  console.log(chalk.cyan.bold('=====================================================\n'));

  const videoPath = process.argv[2] || path.join(__dirname, '..', 'samples', 'agenticflow_ai_vision_50s_short_9x16.mp4');
  const privacyStatus = process.argv[3] || process.env.UPLOAD_PRIVACY_STATUS || 'public'; // 'public' | 'unlisted' | 'private'

  if (!fs.existsSync(videoPath)) {
    console.error(chalk.red(`❌ Video file nahi mili: ${videoPath}`));
    process.exit(1);
  }

  const stat = fs.statSync(videoPath);
  console.log(chalk.gray(`📁 File: ${videoPath}`));
  console.log(chalk.gray(`📦 Size: ${(stat.size / (1024 * 1024)).toFixed(2)} MB`));
  console.log(chalk.gray(`🔒 Privacy Status: ${privacyStatus}\n`));

  const credManager = new CredentialManager();
  const initOk = await credManager.initialize();
  if (!initOk) {
    console.error(chalk.red('❌ CredentialManager initialization failed'));
    process.exit(1);
  }

  let youtube;
  let authClient;
  try {
    authClient = credManager.getYouTubeAuth();
    // Save updated tokens automatically if refreshed
    authClient.on('tokens', async (newTokens) => {
      try {
        const tokensPath = path.join(__dirname, '..', 'config', 'tokens.json');
        const current = JSON.parse(await fs.promises.readFile(tokensPath, 'utf8'));
        current.youtube = { ...current.youtube, ...newTokens };
        await fs.promises.writeFile(tokensPath, JSON.stringify(current, null, 2));
        console.log(chalk.gray('🔄 YouTube access token refreshed and saved'));
      } catch (e) {
        // silent token save fail
      }
    });
    const { google } = require('googleapis');
    youtube = google.youtube({ version: 'v3', auth: authClient });
  } catch (err) {
    console.error(chalk.red(`❌ YouTube Auth Error: ${err.message}`));
    process.exit(1);
  }

  // Metadata for the Short
  const title = 'How AI Sees The World in Real Time 🤖 | Mind-Blowing AI Vision #Shorts';
  const description = `Ever wondered how Artificial Intelligence tracks human faces and sees the world? Watch this fascinating computer vision facial mesh demonstration!

Subscribe to @AgenticFlowAI for daily AI breakdowns, future tech, and intelligent automation tutorials in Hinglish.

#Shorts #ArtificialIntelligence #ComputerVision #AITools #TechShorts #AgenticFlowAI #AI #MachineLearning #Tech`;

  const tags = [
    'Shorts',
    'AI',
    'Artificial Intelligence',
    'Computer Vision',
    'AI Vision',
    'Facial Recognition',
    'AgenticFlowAI',
    'Tech Shorts',
    'Machine Learning',
    'Future Tech'
  ];

  console.log(chalk.yellow('⏳ Uploading to YouTube... please wait...'));

  try {
    const res = await youtube.videos.insert({
      part: 'snippet,status',
      requestBody: {
        snippet: {
          title,
          description,
          tags,
          categoryId: '28', // Science & Technology
          defaultLanguage: 'hi',
          defaultAudioLanguage: 'hi'
        },
        status: {
          privacyStatus,
          selfDeclaredMadeForKids: false
        }
      },
      media: {
        body: fs.createReadStream(videoPath)
      }
    });

    const videoId = res.data.id;
    const shortUrl = `https://www.youtube.com/shorts/${videoId}`;
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

    console.log(chalk.green.bold('\n✅ ====================================================='));
    console.log(chalk.green.bold('   🎉 VIDEO UPLOADED SUCCESSFULLY!'));
    console.log(chalk.green.bold('====================================================='));
    console.log(chalk.cyan(`🆔 Video ID:       ${videoId}`));
    console.log(chalk.cyan(`📱 Shorts URL:      ${shortUrl}`));
    console.log(chalk.cyan(`🌐 Watch URL:       ${watchUrl}`));
    console.log(chalk.cyan(`🔒 Privacy:         ${privacyStatus}`));
    console.log(chalk.green.bold('=====================================================\n'));

    // Output JSON result for callers
    console.log(JSON.stringify({
      success: true,
      videoId,
      shortUrl,
      watchUrl,
      privacyStatus
    }));

  } catch (err) {
    console.error(chalk.red(`\n❌ Upload failed: ${err.message}`));
    if (err.response?.data?.error) {
      console.error(chalk.red(JSON.stringify(err.response.data.error, null, 2)));
    }
    process.exit(1);
  }
}

uploadShort();
