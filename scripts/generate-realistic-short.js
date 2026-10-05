const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { runFFmpeg } = require('../utils/ffmpeg');
const { GoogleGenAI } = require('@google/genai');
const OpenAI = require('openai');
require('dotenv').config();

// Curated high-res reliable clips per category for fallback resilience
const FALLBACK_CLIPS_BY_CATEGORY = {
  robot: [
    'https://assets.mixkit.co/videos/47257/47257-720.mp4',
    'https://assets.mixkit.co/videos/49042/49042-720.mp4',
    'https://assets.mixkit.co/videos/48821/48821-720.mp4'
  ],
  futuristic: [
    'https://assets.mixkit.co/videos/19630/19630-720.mp4',
    'https://assets.mixkit.co/videos/41551/41551-720.mp4',
    'https://assets.mixkit.co/videos/46635/46635-720.mp4'
  ],
  technology: [
    'https://assets.mixkit.co/videos/46635/46635-720.mp4',
    'https://assets.mixkit.co/videos/31771/31771-720.mp4',
    'https://assets.mixkit.co/videos/5728/5728-720.mp4'
  ],
  computer: [
    'https://assets.mixkit.co/videos/1781/1781-1080.mp4',
    'https://assets.mixkit.co/videos/9757/9757-720.mp4',
    'https://assets.mixkit.co/videos/21053/21053-720.mp4'
  ],
  cyber: [
    'https://assets.mixkit.co/videos/5728/5728-720.mp4',
    'https://assets.mixkit.co/videos/46635/46635-720.mp4',
    'https://assets.mixkit.co/videos/1781/1781-1080.mp4'
  ],
  network: [
    'https://assets.mixkit.co/videos/31771/31771-720.mp4',
    'https://assets.mixkit.co/videos/41551/41551-720.mp4',
    'https://assets.mixkit.co/videos/21053/21053-720.mp4'
  ],
  coding: [
    'https://assets.mixkit.co/videos/9757/9757-720.mp4',
    'https://assets.mixkit.co/videos/1781/1781-1080.mp4',
    'https://assets.mixkit.co/videos/5728/5728-720.mp4'
  ],
  space: [
    'https://assets.mixkit.co/videos/18791/18791-720.mp4',
    'https://assets.mixkit.co/videos/19630/19630-720.mp4',
    'https://assets.mixkit.co/videos/41551/41551-720.mp4'
  ],
  data: [
    'https://assets.mixkit.co/videos/21053/21053-720.mp4',
    'https://assets.mixkit.co/videos/31771/31771-720.mp4',
    'https://assets.mixkit.co/videos/5728/5728-720.mp4'
  ]
};

// Rich rotating fallback pool if all AI providers are offline
const DIVERSE_FALLBACK_POOL = [
  {
    topic: 'Humanoid Robots Running Factories',
    seoTitle: 'Humanoid Robots Are Taking Over Factories! 🤖 #Shorts',
    seoDescription: 'Tesla Optimus and Figure 02 humanoid robots are now assembling cars and operating machinery 24/7 without rest. Subscribe to Sameer | AgenticFlowAI for daily future tech and robotics breakthroughs in Hinglish!\n\n#Robotics #HumanoidRobot #TeslaOptimus #AI #TechNews #FutureTech #SameerAgenticFlowAI #Shorts',
    tags: ['Humanoid Robot', 'Tesla Optimus', 'Figure 02', 'Robotics', 'Artificial Intelligence', 'Tech News', 'AgenticFlowAI', 'Shorts'],
    hook: 'Yeh humanoid robots factories me insaano ki jagah le rahe hain aur bina ruke 24 ghante kaam kar sakte hain!',
    scenes: [
      {
        text: 'Yeh humanoid robots factories me insaano ki jagah le rahe hain aur bina ruke 24 ghante kaam kar sakte hain!',
        subtitle: 'ROBOTS RUNNING FACTORIES! 🤖🏭',
        query: 'robot'
      },
      {
        text: 'BMW aur Tesla ke assembly lines me ab humanoids complex heavy parts ko millimeter accuracy se fit kar rahe hain.',
        subtitle: 'MILLIMETER ACCURACY ⚡🦾',
        query: 'technology'
      },
      {
        text: 'In robots ke hands me 22 degrees of freedom hain, jisse ye delicate objects bhi bina tode handle kar sakte hain.',
        subtitle: 'SUPERHUMAN DEXTERITY 🖐️✨',
        query: 'futuristic'
      },
      {
        text: 'Agla revolution hamare gharon me aane wala hai! Channel ko subscribe karein daily AI updates ke liye!',
        subtitle: 'SUBSCRIBE FOR DAILY AI! 🚀🔔',
        query: 'network'
      }
    ]
  },
  {
    topic: 'Autonomous AI Coding Agents Revolution',
    seoTitle: 'AI Is Writing Full Software Alone Now! 🤯 #Shorts',
    seoDescription: 'Autonomous coding agents like Claude Code and Devin are now writing, testing, and debugging full stack software from a single prompt. Subscribe to Sameer | AgenticFlowAI for daily breakthroughs!\n\n#AI #CodingAgents #SoftwareEngineering #TechNews #AgenticFlowAI #ClaudeCode #Shorts',
    tags: ['AI Coding', 'Autonomous Agents', 'Software Development', 'Claude Code', 'Artificial Intelligence', 'AgenticFlowAI', 'Shorts'],
    hook: 'Ab AI assistants sirf code suggest nahi karte, balki poora software terminal par akele build aur test kar rahe hain!',
    scenes: [
      {
        text: 'Ab AI assistants sirf code suggest nahi karte, balki poora software terminal par akele build aur test kar rahe hain!',
        subtitle: 'AI WRITES CODE ALONE! 💻🤖',
        query: 'coding'
      },
      {
        text: 'Autonomous agents jaise Claude Code poore codebase ko inspect karte hain, bugs pakadte hain aur self-heal karte hain.',
        subtitle: 'SELF-HEALING CODE ⚡🛠️',
        query: 'computer'
      },
      {
        text: 'Developers ab sirf architecture define karte hain, aur baki sara execution AI agents autonomously manage kar lete hain.',
        subtitle: 'ZERO MANUAL WORK 🚀🔥',
        query: 'cyber'
      },
      {
        text: 'Kya future me human programmers ki zaroorat rahegi? Comments me bataiye aur subscribe kijiye Sameer | AgenticFlowAI!',
        subtitle: 'SUBSCRIBE AGENTICFLOWAI! 🔔👀',
        query: 'futuristic'
      }
    ]
  },
  {
    topic: 'Neuralink Telepathic Gaming & BCI',
    seoTitle: 'Playing Games With Pure Brain Thoughts! 🧠🎮 #Shorts',
    seoDescription: 'Brain-Computer Interfaces like Neuralink allow paralyzed patients to control games and computers using pure thoughts. Subscribe to Sameer | AgenticFlowAI for cutting-edge neurotech and AI news!\n\n#Neuralink #BrainComputerInterface #Neurotech #ElonMusk #AI #FutureTech #SameerAgenticFlowAI #Shorts',
    tags: ['Neuralink', 'BCI', 'Brain Computer Interface', 'Neurotech', 'Elon Musk', 'Future Tech', 'Shorts'],
    hook: 'Bina haath lagaye sirf apne dimaag ki soch se computer aur video games control ho rahe hain!',
    scenes: [
      {
        text: 'Bina haath lagaye sirf apne dimaag ki soch se computer aur video games control ho rahe hain!',
        subtitle: 'MIND CONTROL GAMING! 🧠🎮',
        query: 'cyber'
      },
      {
        text: 'Neuralink ke 1024 micro-electrodes brain signals ko real-time digital commands me decode karte hain.',
        subtitle: '1024 BRAIN ELECTRODES ⚡🔬',
        query: 'network'
      },
      {
        text: 'Paralyzed patients ab ultra-fast chess aur shooter games telepathically khel kar record bana rahe hain.',
        subtitle: 'PURE TELEPATHIC SPEED 🏎️💥',
        query: 'futuristic'
      },
      {
        text: 'Yeh technology human evolution ko hamesha ke liye badalne wali hai. Subscribe karein Sameer | AgenticFlowAI ko!',
        subtitle: 'SUBSCRIBE FOR TECH NEWS! 🚀🔔',
        query: 'technology'
      }
    ]
  }
];

// Helper to get media duration via FFmpeg
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
  return 25; // fallback
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

// Normalize category queries to supported Mixkit categories
function normalizeCategory(query) {
  const q = String(query || '').toLowerCase().trim();
  if (q.includes('robot') || q.includes('bot') || q.includes('droid') || q.includes('humanoid')) return 'robot';
  if (q.includes('code') || q.includes('program') || q.includes('developer') || q.includes('terminal')) return 'coding';
  if (q.includes('cyber') || q.includes('matrix') || q.includes('security') || q.includes('hack')) return 'cyber';
  if (q.includes('computer') || q.includes('screen') || q.includes('pc') || q.includes('software')) return 'computer';
  if (q.includes('network') || q.includes('internet') || q.includes('connect') || q.includes('neural')) return 'network';
  if (q.includes('data') || q.includes('server') || q.includes('cloud') || q.includes('analytics')) return 'data';
  if (q.includes('space') || q.includes('cosmos') || q.includes('galaxy') || q.includes('universe')) return 'space';
  if (q.includes('future') || q.includes('scifi') || q.includes('hologram') || q.includes('particle')) return 'futuristic';
  return 'technology';
}

// Dynamic clip fetcher from Mixkit with resilient fallback
async function fetchMixkitClipForQuery(query, usedUrls = new Set()) {
  const cat = normalizeCategory(query);
  try {
    const res = await axios.get(`https://mixkit.co/free-stock-video/${cat}/`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 10000
    });
    const allMp4s = [...new Set(res.data.match(/https:\/\/[^"'\s<>]+\.mp4/g) || [])];
    const hdMp4s = allMp4s.filter(u => u.includes('-720.mp4') || u.includes('-1080.mp4'));
    const candidateList = hdMp4s.length > 0 ? hdMp4s : allMp4s;
    const available = candidateList.filter(u => !usedUrls.has(u));
    const pool = available.length > 0 ? available : candidateList;
    if (pool.length > 0) {
      const pick = pool[Math.floor(Math.random() * pool.length)];
      usedUrls.add(pick);
      return pick;
    }
  } catch (e) {
    console.warn(`[Mixkit] Scraping ${cat} failed (${e.message}), using curated backup`);
  }

  // Curated backup
  const fallbackList = FALLBACK_CLIPS_BY_CATEGORY[cat] || FALLBACK_CLIPS_BY_CATEGORY.technology;
  const availableFallback = fallbackList.filter(u => !usedUrls.has(u));
  const fallbackPool = availableFallback.length > 0 ? availableFallback : fallbackList;
  const pick = fallbackPool[Math.floor(Math.random() * fallbackPool.length)];
  usedUrls.add(pick);
  return pick;
}

// Multi-provider AI text completion helper
async function callAICompletion(promptText) {
  // 1. Try Google Gemini Official
  if (process.env.GEMINI_API_KEY) {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      for (const m of ['gemini-3.5-flash', 'gemini-3.6-flash']) {
        try {
          const res = await ai.models.generateContent({
            model: m,
            contents: promptText
          });
          if (res?.text && res.text.trim()) {
            return res.text.trim();
          }
        } catch (mErr) {
          // continue to next model
        }
      }
    } catch (_gErr) {
      // continue to proxy
    }
  }

  // 2. Try OpenAI / Proxy
  const openAiKey = process.env.OPENAI_API_KEY;
  if (openAiKey) {
    try {
      const baseURL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
      const client = new OpenAI({ apiKey: openAiKey, baseURL });
      const res = await client.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gemini-3.6-flash',
        messages: [{ role: 'user', content: promptText }]
      });
      const content = res?.choices?.[0]?.message?.content;
      if (content && content.trim()) {
        return content.trim();
      }
    } catch (_pErr) {
      // proxy failed
    }
  }

  throw new Error('All AI text completion providers are currently unavailable');
}

// Generate dynamic SEO script based on trending AI concepts and topic history
async function generateDynamicSEOScript(customTopic = null) {
  // Load past topic history for deduplication
  const historyPath = path.join(__dirname, '..', 'data', 'topic_history.json');
  let history = [];
  try {
    if (fs.existsSync(historyPath)) {
      history = JSON.parse(await fsp.readFile(historyPath, 'utf8'));
    }
  } catch (_e) {}

  const pastTopics = history.slice(-40).map(t => `- "${t.topic}"`).join('\n');
  const antiRepeatDirective = pastTopics
    ? `\nPREVIOUSLY COVERED TOPICS (DO NOT REPEAT OR GENERATE SIMILAR THEMES):\n${pastTopics}\n`
    : '';

  const prompt = `You are an elite YouTube Shorts SEO strategist and scriptwriter for the channel "Sameer | AgenticFlowAI".
Channel Niche: Cutting-edge AI, Humanoid Robotics, Autonomous Agents, and Shocking Tech Concepts explained in energetic Hinglish.
Target Audience: Mobile viewers looking for mind-blowing, high-retention tech shorts.

${antiRepeatDirective}

CRITICAL RULES:
1. Select today's most viral, high-CTR, trending AI or Robotics concept (e.g. humanoid robots, AI coding agents, liquid neural nets, brain-computer interfaces, AI supertools).
2. NEVER generate generic "AI sees images" or "computer vision bounding boxes".
3. Script duration: EXACTLY 22-28 seconds total spoken speech (4 scenes).
4. Language: Conversational, energetic Hinglish.
5. Provide 4 distinct scenes:
   - text: Spoken line in Hinglish (fast-paced, high retention, no fluff).
   - subtitle: Punchy, capitalized on-screen caption (under 6 words with emojis).
   - query: Stock video search keyword (must be one of: robot, futuristic, technology, computer, cyber, network, coding, space, data).
6. First 2 seconds of Scene 1 MUST have an explosive curiosity hook!

Return ONLY valid JSON without markdown formatting:
{
  "topic": "Specific viral topic name",
  "seoTitle": "Curiosity High-CTR Title under 65 chars with #Shorts",
  "seoDescription": "Comprehensive 3-paragraph YouTube description with SEO keywords, bullet points, CTA to subscribe to Sameer | AgenticFlowAI, and hashtags",
  "tags": ["AI", "Tech Shorts", "Artificial Intelligence", "Robotics", "Future Tech", "Sameer AgenticFlowAI", "Shorts"],
  "hook": "First 2-second opening spoken line",
  "scenes": [
    { "text": "...", "subtitle": "...", "query": "robot" },
    { "text": "...", "subtitle": "...", "query": "technology" },
    { "text": "...", "subtitle": "...", "query": "futuristic" },
    { "text": "...", "subtitle": "...", "query": "cyber" }
  ]
}`;

  try {
    const raw = await callAICompletion(prompt);
    const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (parsed.scenes && Array.isArray(parsed.scenes) && parsed.scenes.length >= 3 && parsed.seoTitle) {
      console.log(`[SEO Research] Generated dynamic topic: "${parsed.topic}" | Title: "${parsed.seoTitle}"`);
      return parsed;
    }
  } catch (err) {
    console.warn(`[SEO Research] AI generation failed (${err.message}). Using diverse curated pool.`);
  }

  // Fallback to rotating non-repeated topic from curated pool
  const historyTitles = history.map(h => (h.topic || '').toLowerCase());
  const freshCandidate = DIVERSE_FALLBACK_POOL.find(p => !historyTitles.some(t => t.includes(p.topic.toLowerCase())));
  const chosen = freshCandidate || DIVERSE_FALLBACK_POOL[Math.floor(Math.random() * DIVERSE_FALLBACK_POOL.length)];
  console.log(`[SEO Research] Selected curated fresh topic: "${chosen.topic}"`);
  return chosen;
}

async function main() {
  console.log('=== STARTING DYNAMIC SEO-DRIVEN REALISTIC SHORTS GENERATION PIPELINE ===');
  const tempDir = path.join(__dirname, '..', 'temp', 'realistic_short');
  await fsp.mkdir(tempDir, { recursive: true });

  // Parse command line arguments
  const args = process.argv.slice(2);
  let payloadPath = null;
  let customTopic = null;
  let customOutputPath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--payload' && args[i + 1]) {
      payloadPath = args[i + 1];
      i++;
    } else if (args[i] === '--topic' && args[i + 1]) {
      customTopic = args[i + 1];
      i++;
    } else if (args[i] === '--output' && args[i + 1]) {
      customOutputPath = args[i + 1];
      i++;
    }
  }

  // 1. Determine script & SEO metadata payload
  let payload = null;
  if (payloadPath && fs.existsSync(payloadPath)) {
    try {
      payload = JSON.parse(await fsp.readFile(payloadPath, 'utf8'));
      console.log(`Loaded SEO payload from: ${payloadPath}`);
    } catch (e) {
      console.warn(`Could not read payload file (${e.message}), generating dynamically.`);
    }
  }

  if (!payload) {
    payload = await generateDynamicSEOScript(customTopic);
  }

  const scriptScenes = payload.scenes || [];
  if (scriptScenes.length === 0) {
    throw new Error('No script scenes found in payload');
  }

  const fullSpeech = scriptScenes.map(s => s.text).join(' ');
  console.log('Topic:', payload.topic);
  console.log('SEO Title:', payload.seoTitle || payload.title);
  console.log('Full speech text length:', fullSpeech.length, 'characters');

  // 2. Generate Voiceover via Gemini TTS
  console.log('Generating Gemini TTS Hinglish voiceover...');
  const audioPcm = path.join(tempDir, 'voiceover.pcm');
  const audioWav = path.join(tempDir, 'voiceover.wav');

  let audioGenerated = false;
  if (process.env.GEMINI_API_KEY) {
    try {
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
      if (base64Audio) {
        await fsp.writeFile(audioPcm, Buffer.from(base64Audio, 'base64'));
        await runFFmpeg(['-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', audioPcm, audioWav]);
        audioGenerated = true;
        console.log('Voiceover audio generated via Gemini TTS at:', audioWav);
      }
    } catch (ttsErr) {
      console.warn('Gemini TTS failed:', ttsErr.message);
    }
  }

  // Fallback: If TTS generation fails, synthesize silent audio or tone of proportional length
  if (!audioGenerated) {
    const estimatedSeconds = Math.max(18, Math.round(fullSpeech.length / 14));
    console.warn(`Generating ${estimatedSeconds}s fallback audio bed...`);
    await runFFmpeg([
      '-y',
      '-f', 'lavfi',
      '-i', `anullsrc=r=24000:cl=mono`,
      '-t', String(estimatedSeconds),
      audioWav
    ]);
  }

  const totalDuration = await getMediaDuration(audioWav);
  console.log('Total voiceover duration:', totalDuration.toFixed(2), 'seconds');

  // 3. Download dynamically matched HD stock clips from Mixkit
  console.log('Fetching dynamic HD stock video clips for each scene...');
  const localClips = [];
  const usedUrls = new Set();

  for (let i = 0; i < scriptScenes.length; i++) {
    const sceneQuery = scriptScenes[i].query || 'technology';
    const clipUrl = await fetchMixkitClipForQuery(sceneQuery, usedUrls);
    const dest = path.join(tempDir, `clip_${i}.mp4`);
    console.log(`Downloading scene ${i + 1}/${scriptScenes.length} clip (${sceneQuery}): ${clipUrl}`);
    await downloadClip(clipUrl, dest);
    localClips.push(dest);
  }

  // 4. Calculate scene timings and create stylish ASS subtitles
  const sceneDuration = totalDuration / scriptScenes.length;
  console.log(`Each scene duration: ${sceneDuration.toFixed(2)}s`);

  let assContent = `[Script Info]
Title: AgenticFlowAI Dynamic Shorts Captions
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: HookStyle,Arial,68,&H0000FFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,3,2,60,60,500,1
Style: BodyStyle,Arial,62,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,3,2,60,60,500,1
Style: AccentStyle,Arial,64,&H0000E5FF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,3,2,60,60,500,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  for (let i = 0; i < scriptScenes.length; i++) {
    const startSec = i * sceneDuration;
    const endSec = (i + 1) * sceneDuration;
    const style = (i === 0 || i === scriptScenes.length - 1) ? 'HookStyle' : (i % 2 === 1 ? 'AccentStyle' : 'BodyStyle');
    const subtitleText = scriptScenes[i].subtitle || scriptScenes[i].text.slice(0, 30);
    assContent += `Dialogue: 0,${formatAssTime(startSec)},${formatAssTime(endSec)},${style},,0,0,0,,{\\fad(120,120)}${subtitleText}\n`;
  }

  const assPath = path.join(tempDir, 'captions.ass');
  await fsp.writeFile(assPath, assContent, 'utf8');
  console.log('Captions created at:', assPath);

  // 5. Build Vertical 9:16 Video Clips using FFmpeg
  console.log('Processing clips into vertical 9:16 (1080x1920)...');
  const processedClips = [];

  for (let i = 0; i < localClips.length; i++) {
    const outClip = path.join(tempDir, `processed_${i}.mp4`);
    const duration = sceneDuration.toFixed(2);
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
  const finalVideoPath = customOutputPath || path.join(samplesDir, 'agenticflow_ai_vision_sample_short.mp4');

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

  // Save generated metadata for downstream YouTube upload and tracking
  const metadataOutput = {
    topic: payload.topic,
    seoTitle: payload.seoTitle || payload.title,
    seoDescription: payload.seoDescription || payload.description,
    tags: payload.tags || ['AI', 'Tech Shorts', 'AgenticFlowAI'],
    hook: payload.hook || '',
    duration: Math.round(totalDuration),
    videoPath: finalVideoPath
  };

  const metadataPath = path.join(tempDir, 'metadata.json');
  await fsp.writeFile(metadataPath, JSON.stringify(metadataOutput, null, 2), 'utf8');
  console.log('Metadata written to:', metadataPath);

  // Emit machine-readable metadata line for caller
  console.log(`METADATA_JSON: ${JSON.stringify(metadataOutput)}`);
}

main().catch(err => {
  console.error('Pipeline error:', err);
  process.exit(1);
});
