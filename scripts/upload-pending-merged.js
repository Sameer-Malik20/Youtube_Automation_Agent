require('dotenv').config();
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const chalk = require('chalk');
const { CredentialManager } = require('../utils/credential-manager');
const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');
const { Database } = require('../database/db');
const axios = require('axios');

async function sendTelegramAlert(message) {
  try {
    const adminPath = path.join(__dirname, '..', 'data', 'telegram_admin.json');
    if (!fs.existsSync(adminPath)) return;
    const adminData = JSON.parse(fs.readFileSync(adminPath, 'utf8'));
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token || !adminData.adminChatId) return;

    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: adminData.adminChatId,
      text: message,
      parse_mode: 'Markdown'
    });
  } catch (e) {
    console.error('Telegram notification error:', e.message);
  }
}

async function uploadPendingMerged() {
  console.log(chalk.cyan.bold('\n🎬 ====================================================='));
  console.log(chalk.cyan.bold('   UPLOADING LAST MERGED VIDEO TO YOUTUBE'));
  console.log(chalk.cyan.bold('=====================================================\n'));

  const videoPath = path.join(__dirname, '..', 'samples', 'agenticflow_merged_1790957058958.mp4');
  const thumbPath = path.join(__dirname, '..', 'samples', 'agenticflow_thumb_1790957058958.jpg');

  if (!fs.existsSync(videoPath)) {
    console.error(chalk.red(`❌ Video file not found: ${videoPath}`));
    process.exit(1);
  }

  const stat = fs.statSync(videoPath);
  const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);
  console.log(chalk.gray(`📁 Video file: ${videoPath}`));
  console.log(chalk.gray(`📦 Size: ${sizeMB} MB`));

  const creds = new CredentialManager();
  await creds.initialize();
  const db = new Database();
  await db.initialize();

  const publisher = new PublishingSchedulingAgent(db, creds);
  await publisher.initialize();

  const timestamp = Date.now();
  // 1-Hour Schedule Buffer for 1080p transcode and algorithm categorization
  const publishAtDate = new Date(Date.now() + 60 * 60 * 1000);
  const scheduledTimeIST = publishAtDate.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit'
  });

  const metadata = {
    title: 'How 2026 AI Humanoid Robots Are Replacing Manual Work! 🤖 #Shorts',
    description: `Did you know 2026 humanoid robots can coordinate and handle millimeter-precision tasks faster than humans? Watch these autonomous robots assemble vehicle parts in real time!

🔔 Subscribe to Sameer | AgenticFlowAI for daily future tech, AI breakthroughs & automation tutorials in Hinglish!

#Shorts #HumanoidRobots #ArtificialIntelligence #Robotics #AITools #FutureTech #AgenticFlowAI #TechShorts`,
    tags: [
      'HumanoidRobots',
      'AI',
      'Robotics',
      'ArtificialIntelligence',
      'Shorts',
      'FutureTech',
      'AgenticFlowAI',
      'TechShorts',
      'TeslaOptimus',
      'AutonomousRobots'
    ],
    categoryId: '28',
    defaultLanguage: 'hi',
    defaultAudioLanguage: 'hi'
  };

  const scheduleEntry = {
    id: `prod_${timestamp}`,
    productionId: `prod_${timestamp}`,
    title: metadata.title,
    status: 'scheduled',
    publishTime: publishAtDate.toISOString(),
    metadata: {
      seo: metadata,
      video: { path: videoPath },
      thumbnail: { path: fs.existsSync(thumbPath) ? thumbPath : null },
      privacyStatus: 'private', // Scheduled release requires private initially
      containsSyntheticMedia: true
    }
  };

  console.log(chalk.yellow(`⏳ Uploading video to YouTube (Scheduled for ${scheduledTimeIST} IST)...`));

  try {
    const res = await publisher.uploadToYouTube(scheduleEntry);
    const videoId = res?.id || res?.data?.id || scheduleEntry.youtubeId;
    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const shortsUrl = `https://www.youtube.com/shorts/${videoId}`;

    console.log(chalk.green.bold('\n🎉 ====================================================='));
    console.log(chalk.green.bold('   YOUTUBE UPLOAD SUCCESSFUL!'));
    console.log(chalk.green.bold('====================================================='));
    console.log(chalk.cyan(`🆔 Video ID:    ${videoId}`));
    console.log(chalk.cyan(`📱 Shorts URL:   ${shortsUrl}`));
    console.log(chalk.cyan(`🌐 Watch URL:    ${youtubeUrl}`));
    console.log(chalk.cyan(`⏳ Scheduled At: ${scheduledTimeIST} IST`));
    console.log(chalk.green.bold('=====================================================\n'));

    // Send Telegram Notification
    await sendTelegramAlert(`🚀 *YouTube Shorts Upload Successful!*
📌 *Title:* ${metadata.title}
🔗 *Shorts Link:* ${shortsUrl}
🌐 *Watch Link:* ${youtubeUrl}
⏳ *Release Schedule:* 1-Hour Buffer (Auto-Public at ${scheduledTimeIST} IST)
🔒 *Visibility:* Private (Transcoding & SEO Processing)

_Merged video has been uploaded and local disk cleanup triggered!_`);

    // Auto-cleanup: Delete the merged video and thumbnail from disk
    console.log(chalk.yellow('🧹 Auto-cleaning uploaded files from disk...'));
    if (fs.existsSync(videoPath)) {
      await fsp.unlink(videoPath);
      console.log(chalk.green(`✅ Deleted merged video: ${path.basename(videoPath)}`));
    }
    if (fs.existsSync(thumbPath)) {
      await fsp.unlink(thumbPath);
      console.log(chalk.green(`✅ Deleted thumbnail: ${path.basename(thumbPath)}`));
    }

    console.log(chalk.green('✨ Everything complete!'));
    process.exit(0);
  } catch (err) {
    console.error(chalk.red('\n❌ Upload Failed:'), err.message);
    if (err.response?.data?.error) {
      console.error(chalk.red(JSON.stringify(err.response.data.error, null, 2)));
    }
    process.exit(1);
  }
}

uploadPendingMerged();
