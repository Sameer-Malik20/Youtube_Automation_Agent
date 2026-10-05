const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { GeminiWebVideoGenerator } = require('../utils/gemini-web-video-generator');
const { runFFmpeg } = require('../utils/ffmpeg');

async function probeMedia(filePath) {
  let duration = 10;
  let width = 1080;
  let height = 1920;

  try {
    const probeRes = await runFFmpeg(['-i', filePath]).catch(err => err);
    const durMatch = (probeRes.stderr || probeRes.message)?.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    if (durMatch) {
      duration = parseInt(durMatch[1], 10) * 3600 + parseInt(durMatch[2], 10) * 60 + parseFloat(durMatch[3]);
    }
    const resMatch = (probeRes.stderr || probeRes.message)?.match(/Video:.*?(\d{3,4})x(\d{3,4})/);
    if (resMatch) {
      width = parseInt(resMatch[1], 10);
      height = parseInt(resMatch[2], 10);
    }
  } catch (_e) {}

  const stat = fs.statSync(filePath);
  const sizeMB = Math.round((stat.size / 1024 / 1024) * 10) / 10;

  return { duration: Math.round(duration * 10) / 10, width, height, sizeMB };
}

/**
 * Execute the 8:00 AM IST Daily Automated Gemini Video Generation & Publishing Pipeline
 * @param {object} botInstance - Active TelegramBotService instance
 * @returns {Promise<boolean>}
 */
async function runDaily8AMPipeline(botInstance = null) {
  let bot = botInstance;
  if (!bot) {
    const { TelegramBotService } = require('../utils/telegram-bot-service');
    bot = new TelegramBotService();
    await bot.initialize();
  }

  const chatId = bot.adminChatId;
  const notify = async (text) => {
    bot.logEvent(text);
    if (chatId) {
      try {
        await bot.sendMessage(chatId, text);
      } catch (err) {
        bot.logger.warn(`Failed to send Telegram notification: ${err.message}`);
      }
    }
  };

  await notify(`🌅 *8:00 AM IST: Daily Automated Shorts Pipeline Triggered!*
Channel: *Sameer | AgenticFlowAI*
Target: 4-Scene AI Video Generation via Gemini (Account 1 & Account 2)
Schedule Buffer: 1 Hour (Publish at ~9:00 - 9:30 AM IST)`);

  // Step 1: Craft 4-Scene Prompts with Gemini
  await notify('🧠 *Step 1/4: Researching today\'s viral AI breakthrough & structuring 4 sequential 10s scenes...*');

  let promptData = null;
  try {
    const topicResearchDirective = bot.getDiverseTrendingAITopicPrompt(false, null, false);
    const rawResponse = await bot.generateAIContent(`You are an elite YouTube Shorts strategist for the channel "Sameer | AgenticFlowAI".
${topicResearchDirective}
Target audience: Curious tech enthusiasts in India (Hindi/English Hinglish).

CRITICAL CONSTRAINTS:
1. ASPECT RATIO (9:16 VERTICAL SHORTS): Every video prompt MUST be composed for 9:16 vertical mobile video.
   Must begin with: "Vertical 9:16 aspect ratio (YouTube Shorts vertical format, 1080x1920)."
2. DURATION (10s PER CLIP): Structure this into exactly 4 sequential 10-second scenes (Total: 40 seconds master Short).

Output strictly valid JSON with keys:
{
  "topic": "Catchy topic name",
  "conceptHook": "1-sentence hook explaining why viewers will stay glued",
  "clip1": {
    "title": "Scene 1: Hook (10s)",
    "videoPrompt": "Vertical 9:16 aspect ratio (YouTube Shorts vertical format, 1080x1920). Cinematic English visual prompt. [Dialogue in Hinglish]: '...spoken words...'"
  },
  "clip2": {
    "title": "Scene 2: Problem / Conflict (10s)",
    "videoPrompt": "Vertical 9:16 aspect ratio (YouTube Shorts vertical format, 1080x1920). Cinematic English visual prompt. [Dialogue in Hinglish]: '...spoken words...'"
  },
  "clip3": {
    "title": "Scene 3: Deep Dive / Breakthrough (10s)",
    "videoPrompt": "Vertical 9:16 aspect ratio (YouTube Shorts vertical format, 1080x1920). Cinematic English visual prompt. [Dialogue in Hinglish]: '...spoken words...'"
  },
  "clip4": {
    "title": "Scene 4: Climax & CTA (10s)",
    "videoPrompt": "Vertical 9:16 aspect ratio (YouTube Shorts vertical format, 1080x1920). Cinematic English visual prompt. [Dialogue in Hinglish]: '...words with subscribe to AgenticFlowAI...'"
  }
}
Return ONLY valid JSON.`);

    let rawText = rawResponse.trim().replace(/```json/gi, '').replace(/```/g, '').trim();
    promptData = JSON.parse(rawText);

    for (const key of ['clip1', 'clip2', 'clip3', 'clip4']) {
      if (promptData[key] && promptData[key].videoPrompt) {
        if (!promptData[key].videoPrompt.toLowerCase().includes('9:16')) {
          promptData[key].videoPrompt = `Vertical 9:16 aspect ratio (YouTube Shorts vertical format, 1080x1920). ${promptData[key].videoPrompt}`;
        }
      }
    }

    await bot.saveTopicToHistory(promptData.topic, promptData.conceptHook);
  } catch (err) {
    bot.logger.warn(`AI topic research fallback used: ${err.message}`);
    promptData = {
      topic: 'Autonomous AI Humanoid Robots Solving Real World Tasks',
      conceptHook: 'Why 2026 humanoid robots are performing dexterous tasks faster than human workers',
      clip1: { videoPrompt: 'Vertical 9:16 aspect ratio (YouTube Shorts vertical format, 1080x1920). Close-up of glowing optical sensor eyes of a sleek humanoid robot booting up in a neon cyber lab. [Dialogue in Hinglish]: "Kya aapko pata hai ki 2026 ke humanoid robots ab insaano se bhi zyada fast kaam kar rahe hain?"' },
      clip2: { videoPrompt: 'Vertical 9:16 aspect ratio (YouTube Shorts vertical format, 1080x1920). Robot hand picking up fragile lightbulb with millimeter pressure sensor feedback. [Dialogue in Hinglish]: "Inke robotic fingers itne sensitive hain ki bina tode egg ya lightbulb utha sakte hain!"' },
      clip3: { videoPrompt: 'Vertical 9:16 aspect ratio (YouTube Shorts vertical format, 1080x1920). Full-body shot of two humanoid robots coordinating in a Tesla gigafactory assembling vehicle parts autonomously. [Dialogue in Hinglish]: "Yeh robots AI neural network se ek dusre se bina bole coordinate karte hain!"' },
      clip4: { videoPrompt: 'Vertical 9:16 aspect ratio (YouTube Shorts vertical format, 1080x1920). Futuristic metallic robot looking forward into camera lens with futuristic HUD graphics. [Dialogue in Hinglish]: "Future yahan aa chuka hai! AI updates ke liye abhi subscribe karein Sameer | AgenticFlowAI!"' }
    };
  }

  await notify(`💡 *Topic Selected:* "${promptData.topic}"
🎯 *Concept Hook:* ${promptData.conceptHook}

🚀 *Step 2/4: Launching Headless Gemini Playwright Generator...*
- Primary: Account 1 (\`susalabs44@gmail.com\`)
- Secondary: Account 2 (\`altechworld675@gmail.com\`)`);

  // Step 2: Generate Clips with Gemini Web Video Generator
  const prompts = [
    promptData.clip1.videoPrompt,
    promptData.clip2.videoPrompt,
    promptData.clip3.videoPrompt,
    promptData.clip4.videoPrompt
  ];

  const generator = new GeminiWebVideoGenerator({
    outputDir: bot.stagingDir,
    onProgress: async (msg) => {
      bot.logEvent(msg);
      if (chatId) {
        try {
          await bot.sendMessage(chatId, msg);
        } catch (_) {}
      }
    }
  });

  const genResult = await generator.generateMultiAccountClips(prompts);

  if (!genResult.success || genResult.clips.length === 0) {
    await notify('⚠️ *Notice:* Gemini web automation could not generate clips. Falling back to autonomous stock/pro generation so schedule is preserved!');
    // Trigger existing autonomous fallback if web generator failed
    await bot.runAutonomousFallback(chatId, null);
    return false;
  }

  await notify(`🎉 *Step 3/4: Generated ${genResult.clips.length} video clips!* Staging clips in \`data/telegram_staging\`...`);

  // Step 3: Populate stagedClips and manualContext in Telegram Bot
  bot.stagedClips = [];
  for (let i = 0; i < genResult.clips.length; i++) {
    const clipPath = genResult.clips[i];
    const meta = await probeMedia(clipPath);

    bot.stagedClips.push({
      index: i + 1,
      fileName: path.basename(clipPath),
      localPath: clipPath,
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      sizeMB: meta.sizeMB,
      receivedAt: new Date().toISOString()
    });
  }

  bot.manualContext = {
    active: true,
    topic: promptData.topic,
    format: 'short'
  };

  await bot.saveDraft();

  const totalDuration = Math.round(bot.stagedClips.reduce((sum, c) => sum + c.duration, 0) * 10) / 10;
  await notify(`📦 *Clips Staged Successfully:*
- Total Clips: ${bot.stagedClips.length}
- Combined Duration: ~${totalDuration}s (YouTube Short 9:16)
- Staging Dir: \`data/telegram_staging/\`

🚀 *Step 4/4: Triggering Autonomous Merge & 1-Hour Scheduled Upload to YouTube...*`);

  // Step 4: Automatically call handleCompleteMergeAndUpload
  await bot.handleCompleteMergeAndUpload(chatId);

  await notify(`✨ *Daily 8:00 AM Automation Complete!*
Video has been merged, SEO optimized, and scheduled for release (~9:00 - 9:30 AM IST).
Your YouTube Shorts streak continues seamlessly! 🚀`);

  return true;
}

module.exports = { runDaily8AMPipeline };
