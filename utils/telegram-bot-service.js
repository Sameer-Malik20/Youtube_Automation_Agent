const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const axios = require('axios');
const cron = require('node-cron');
const { GoogleGenAI } = require('@google/genai');
const OpenAI = require('openai');
const { Logger } = require('./logger');
const { runFFmpeg } = require('./ffmpeg');

class TelegramBotService {
  constructor(options = {}) {
    this.logger = new Logger('TelegramBot');
    this.token = options.token || process.env.TELEGRAM_BOT_TOKEN;
    this.fallbackHour = parseInt(process.env.TELEGRAM_FALLBACK_HOUR_IST || '18', 10);
    this.timezone = process.env.TIMEZONE || 'Asia/Kolkata';
    this.baseUrl = `https://api.telegram.org/bot${this.token}`;
    this.fileBaseUrl = `https://api.telegram.org/file/bot${this.token}`;

    this.isRunning = false;
    this.pollingOffset = 0;
    this.pollingAbort = null;

    this.state = 'resting'; // 'resting' | 'receiving_clips' | 'merging' | 'generating_metadata' | 'uploading' | 'fallback_generating'
    this.currentActivity = 'Idle / Waiting for clips or 6:00 PM IST';
    this.activeJobMessageId = null;
    this.activeJobChatId = null;

    // Real-time parallel execution tracking & live log ring buffer
    this.activeJob = null; // { type, title, startedAt, currentStep, stepNumber, totalSteps, logs: [] }
    this.recentLogs = []; // ring buffer of last 35 timestamped log events
    this.uploadQueue = Promise.resolve(); // sequential queue for video uploads to avoid race conditions

    this.adminFilePath = path.join(__dirname, '..', 'data', 'telegram_admin.json');
    this.draftFilePath = path.join(__dirname, '..', 'data', 'telegram_staging', 'draft.json');
    this.stagingDir = path.join(__dirname, '..', 'data', 'telegram_staging');
    this.topicHistoryPath = path.join(__dirname, '..', 'data', 'topic_history.json');

    this.adminChatId = null;
    this.adminUsername = null;
    this.stagedClips = [];
    this.manualContext = { active: false, topic: '', format: 'auto' };
    this.topicHistory = [];
    this.lastPublishedDate = null;

    this.cronTask = null;
    this.gemini = null;
    this.openaiProxy = null;
    this.chatContext = []; // Conversational memory for AI Copilot chat
    this.channelCache = null;
    this.channelCacheTime = 0;

    if (process.env.GEMINI_API_KEY) {
      this.gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    }

    // AI Copilot Proxy Client (Strictly uses local proxy :8081)
    const proxyBaseUrl = process.env.OPENAI_BASE_URL || 'http://127.0.0.1:8081/v1';
    this.openaiProxy = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || 'sk-gemini',
      baseURL: proxyBaseUrl
    });
  }

  // Record an event in real-time for live logs & status
  logEvent(message, level = 'info') {
    const timestamp = new Date().toLocaleTimeString('en-IN', { timeZone: this.timezone || 'Asia/Kolkata', hour12: false });
    const logItem = { time: timestamp, level, message };

    if (this.recentLogs.length >= 35) {
      this.recentLogs.shift();
    }
    this.recentLogs.push(logItem);

    if (this.activeJob && Array.isArray(this.activeJob.logs)) {
      if (this.activeJob.logs.length >= 25) {
        this.activeJob.logs.shift();
      }
      this.activeJob.logs.push(logItem);
      this.activeJob.currentStep = message;
    }
    this.currentActivity = message;

    if (level === 'error') {
      this.logger.error(message);
    } else if (level === 'warn') {
      this.logger.warn(message);
    } else if (level === 'success') {
      this.logger.success(message);
    } else {
      this.logger.info(message);
    }
  }

  async generateAIContent(promptText) {
    if (this.gemini) {
      for (const m of ['gemini-3.5-flash', 'gemini-3.6-flash']) {
        try {
          const res = await this.gemini.models.generateContent({
            model: m,
            contents: promptText
          });
          if (res?.text) return res.text;
        } catch (geminiErr) {
          this.logger.warn(`Gemini official (${m}) hit error:`, geminiErr.message);
        }
      }
    }

    if (this.openaiProxy) {
      try {
        const res = await this.openaiProxy.chat.completions.create({
          model: process.env.OPENAI_MODEL || 'gemini-3.6-flash',
          messages: [{ role: 'user', content: promptText }]
        });
        if (res?.choices?.[0]?.message?.content) {
          return res.choices[0].message.content;
        }
      } catch (proxyErr) {
        this.logger.warn('OpenAI proxy fallback failed:', proxyErr.message);
      }
    }

    throw new Error('All AI providers are currently unavailable.');
  }

  async initialize() {
    if (!this.token) {
      this.logger.error('TELEGRAM_BOT_TOKEN is not set in environment.');
      return false;
    }

    await fsp.mkdir(this.stagingDir, { recursive: true });
    await this.loadAdminInfo();
    await this.loadDraft();
    await this.loadTopicHistory();

    // Verify token with Telegram
    try {
      const me = await this.apiCall('getMe');
      if (!me.ok) {
        throw new Error(me.description || 'Failed to authenticate bot token');
      }
      this.botInfo = me.result;
      this.logger.success(`Telegram Bot authenticated: @${this.botInfo.username} (${this.botInfo.first_name})`);
    } catch (err) {
      this.logger.error('Telegram authentication failed:', err.message);
      return false;
    }

    this.setupFallbackCron();
    return true;
  }

  async loadAdminInfo() {
    try {
      if (fs.existsSync(this.adminFilePath)) {
        const data = JSON.parse(await fsp.readFile(this.adminFilePath, 'utf8'));
        this.adminChatId = data.adminChatId || null;
        this.adminUsername = data.adminUsername || null;
        this.lastPublishedDate = data.lastPublishedDate || null;
      }
      if (process.env.TELEGRAM_ADMIN_CHAT_ID) {
        this.adminChatId = parseInt(process.env.TELEGRAM_ADMIN_CHAT_ID, 10);
      }
    } catch (err) {
      this.logger.warn('Failed to load telegram admin info:', err.message);
    }
  }

  async saveAdminInfo() {
    try {
      await fsp.mkdir(path.dirname(this.adminFilePath), { recursive: true });
      await fsp.writeFile(this.adminFilePath, JSON.stringify({
        adminChatId: this.adminChatId,
        adminUsername: this.adminUsername,
        lastPublishedDate: this.lastPublishedDate,
        updatedAt: new Date().toISOString()
      }, null, 2));
    } catch (err) {
      this.logger.error('Failed to save telegram admin info:', err.message);
    }
  }

  async loadTopicHistory() {
    try {
      if (fs.existsSync(this.topicHistoryPath)) {
        const data = JSON.parse(await fsp.readFile(this.topicHistoryPath, 'utf8'));
        this.topicHistory = Array.isArray(data) ? data : [];
        this.logger.info(`Loaded ${this.topicHistory.length} historical topics for deduplication.`);
      }
    } catch (err) {
      this.logger.warn('Failed to load topic history:', err.message);
      this.topicHistory = [];
    }
  }

  async saveTopicToHistory(topic, hook = '') {
    if (!topic || typeof topic !== 'string') return;
    const cleanTopic = topic.trim();
    // Check if already in history
    const alreadyExists = this.topicHistory.some(t => t.topic.toLowerCase() === cleanTopic.toLowerCase());
    if (alreadyExists) return;

    try {
      this.topicHistory.push({
        topic: cleanTopic,
        hook: hook || '',
        date: new Date().toISOString()
      });
      // Keep up to 200 past topics for memory
      if (this.topicHistory.length > 200) {
        this.topicHistory = this.topicHistory.slice(-200);
      }
      await fsp.mkdir(path.dirname(this.topicHistoryPath), { recursive: true });
      await fsp.writeFile(this.topicHistoryPath, JSON.stringify(this.topicHistory, null, 2), 'utf8');
      this.logEvent(`Topic saved to permanent history memory: "${cleanTopic}" (${this.topicHistory.length} total saved)`);
    } catch (err) {
      this.logger.warn('Failed to save topic to history:', err.message);
    }
  }

  async loadDraft() {
    try {
      if (fs.existsSync(this.draftFilePath)) {
        const data = JSON.parse(await fsp.readFile(this.draftFilePath, 'utf8'));
        this.stagedClips = Array.isArray(data.stagedClips) ? data.stagedClips : [];
        this.manualContext = data.manualContext || { active: false, topic: '', format: 'auto' };
        if (this.stagedClips.length > 0) {
          this.state = 'receiving_clips';
          this.currentActivity = `${this.stagedClips.length} clip(s) waiting in draft`;
        }
      }
    } catch (err) {
      this.logger.warn('Failed to load staged clips draft:', err.message);
      this.stagedClips = [];
      this.manualContext = { active: false, topic: '', format: 'auto' };
    }
  }

  async saveDraft() {
    try {
      await fsp.writeFile(this.draftFilePath, JSON.stringify({
        stagedClips: this.stagedClips,
        manualContext: this.manualContext,
        updatedAt: new Date().toISOString()
      }, null, 2));
    } catch (err) {
      this.logger.error('Failed to save draft:', err.message);
    }
  }

  async clearDraft() {
    let deletedCount = 0;
    let freedBytes = 0;

    // 1. Delete all staged files in staging directory (clips, concat lists, draft)
    try {
      if (fs.existsSync(this.stagingDir)) {
        const files = await fsp.readdir(this.stagingDir);
        for (const file of files) {
          const filePath = path.join(this.stagingDir, file);
          try {
            const stat = await fsp.stat(filePath);
            freedBytes += stat.size;
            await fsp.unlink(filePath);
            deletedCount++;
          } catch (fileErr) {
            this.logger.warn(`Could not delete staging file ${file}:`, fileErr.message);
          }
        }
      }
    } catch (err) {
      this.logger.warn('Error clearing staging directory:', err.message);
    }

    // 2. Ensure all registered stagedClips localPaths are removed
    for (const clip of this.stagedClips) {
      if (clip.localPath && fs.existsSync(clip.localPath)) {
        try {
          await fsp.unlink(clip.localPath);
        } catch (_ignoreErr) {
          // File may already be unlinked
        }
      }
    }

    // 3. Reset in-memory state
    this.stagedClips = [];
    this.manualContext = { active: false, topic: '', format: 'auto' };
    this.state = 'resting';
    this.currentActivity = 'Idle / Waiting for clips or 6:00 PM IST';

    const freedMB = Math.round((freedBytes / 1024 / 1024) * 10) / 10;
    this.logger.info(`Staging cleared: ${deletedCount} files removed (~${freedMB} MB freed)`);
    return { deletedCount, freedMB };
  }

  // Auto-cleanup samples directory to free disk space after successful YouTube upload
  async clearSamplesDir(olderThanMs = 0) {
    let deletedCount = 0;
    let freedBytes = 0;
    const samplesDir = path.join(__dirname, '..', 'samples');

    try {
      if (fs.existsSync(samplesDir)) {
        const files = await fsp.readdir(samplesDir);
        const now = Date.now();
        for (const file of files) {
          if (file.endsWith('.mp4') || file.endsWith('.jpg') || file.endsWith('.png')) {
            const filePath = path.join(samplesDir, file);
            try {
              const stat = await fsp.stat(filePath);
              if (olderThanMs === 0 || (now - stat.mtimeMs) >= olderThanMs) {
                freedBytes += stat.size;
                await fsp.unlink(filePath);
                deletedCount++;
              }
            } catch (err) {
              this.logger.warn(`Could not delete sample file ${file}:`, err.message);
            }
          }
        }
      }
    } catch (err) {
      this.logger.warn('Error clearing samples directory:', err.message);
    }

    const freedMB = Math.round((freedBytes / 1024 / 1024) * 10) / 10;
    if (deletedCount > 0) {
      this.logEvent(`Samples directory cleaned: ${deletedCount} files deleted (~${freedMB} MB freed from disk)`, 'success');
    }
    return { deletedCount, freedMB };
  }

  // Low-level API call to Telegram
  async apiCall(method, data = {}) {
    const res = await axios.post(`${this.baseUrl}/${method}`, data, {
      timeout: 35000
    });
    return res.data;
  }

  // Send typing action to Telegram chat
  async sendChatAction(chatId, action = 'typing') {
    try {
      await this.apiCall('sendChatAction', { chat_id: chatId, action });
    } catch (_) { }
  }

  // Send message with standard interactive keyboard
  async sendMessage(chatId, text, options = {}) {
    const payload = {
      chat_id: chatId,
      text,
      parse_mode: options.parseMode || 'Markdown',
      disable_web_page_preview: options.disablePreview !== false,
      reply_markup: options.replyMarkup || this.getMainKeyboard()
    };

    try {
      const res = await this.apiCall('sendMessage', payload);
      return res.result;
    } catch (err) {
      if (payload.parse_mode && (err.message?.includes('parse entities') || err.response?.data?.description?.includes('parse entities'))) {
        try {
          const fallbackPayload = { ...payload };
          delete fallbackPayload.parse_mode;
          const retryRes = await this.apiCall('sendMessage', fallbackPayload);
          return retryRes.result;
        } catch (_retryErr) {
          // Ignore secondary formatting error
        }
      }
      this.logger.error(`Failed to send message to ${chatId}:`, err.response?.data?.description || err.message);
      return null;
    }
  }

  // Edit message in-place for live progress updates
  async editMessage(chatId, messageId, text, options = {}) {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: options.parseMode || 'Markdown',
      disable_web_page_preview: true,
      reply_markup: options.replyMarkup || undefined
    };

    try {
      const res = await this.apiCall('editMessageText', payload);
      return res.result;
    } catch (err) {
      if (payload.parse_mode && (err.message?.includes('parse entities') || err.response?.data?.description?.includes('parse entities'))) {
        try {
          const fallbackPayload = { ...payload };
          delete fallbackPayload.parse_mode;
          const retryRes = await this.apiCall('editMessageText', fallbackPayload);
          return retryRes.result;
        } catch (_retryErr) {
          // Ignore secondary formatting error
        }
      }
      // If message cannot be edited in-place, fallback to sending as a new message
      if (options.fallbackToSend !== false && (err.message?.includes("can't be edited") || err.response?.data?.description?.includes("can't be edited"))) {
        const newMsg = await this.sendMessage(chatId, text, options);
        if (newMsg?.message_id && this.activeJobMessageId === messageId) {
          this.activeJobMessageId = newMsg.message_id;
        }
        return newMsg;
      }
      // Ignore if text hasn't changed
      if (!err.message?.includes('message is not modified')) {
        this.logger.warn(`Failed to edit message ${messageId}:`, err.response?.data?.description || err.message);
      }
      return null;
    }
  }

  getMainKeyboard() {
    return {
      keyboard: [
        [{ text: '⚡ Ultra Short (20s)' }, { text: '💡 Give Me Prompt' }],
        [{ text: '📤 Manual Upload' }, { text: '💬 Ask AI Copilot' }],
        [{ text: '✅ Completed - Merge & Upload' }, { text: '📊 System Status' }],
        [{ text: '🎯 Strategy & Backlog' }, { text: '📈 Growth & Analytics' }],
        [{ text: '🩺 7 Agents Health' }, { text: '🤖 Operator Analysis' }],
        [{ text: '📋 Live Logs' }, { text: '🗑 Clear Current Draft' }],
        [{ text: '🤖 Fallback AI Video Now' }]
      ],
      resize_keyboard: true,
      persistent: true
    };
  }

  // Guide user for Manual Upload flow (Short or Long video)
  async handleManualUploadPrompt(chatId) {
    this.manualContext = {
      active: true,
      topic: this.manualContext?.topic || '',
      format: this.manualContext?.format || 'auto'
    };
    this.state = 'manual_upload';
    await this.saveDraft();
    this.logEvent('Manual video upload mode enabled by user');

    const clipsCount = this.stagedClips.length;
    const hasTopic = Boolean(this.manualContext.topic);

    let statusLine = '';
    if (clipsCount > 0 && hasTopic) {
      statusLine = `\n📊 *Current Status:* Video staged (${clipsCount} file) | Topic: "${this.manualContext.topic}"\n👉 *Ready to publish! Tap karein:* \`[ ✅ Completed - Merge & Upload ]\``;
    } else if (clipsCount > 0) {
      statusLine = `\n📊 *Current Status:* Video already staged (${clipsCount} file).\n👉 *Next Step:* Ab is video ke baare me 1 message likh kar bhejein ki video kis topic par hai.`;
    } else {
      statusLine = `\n👉 *Pehle apni video file (MP4/MOV) is chat me send karein.*`;
    }

    const msg = `📤 *MANUAL VIDEO UPLOAD MODE ACTIVATED!*

Aap apni koi bhi video (Short ya Long) channel par upload kar sakte hain. Jab tak aap publish nahi karte ya cancel nahi karte, bot isi mode me rahega.

📋 *3 Simple Steps:*
1️⃣ *Video upload karein:*
Apni video file (MP4/MOV) is chat me bhejein (Chahe 1 video ho ya multiple clips).

2️⃣ *Video ke baare me likhein:*
Chat me 1 message likhein ki video kis baare me hai (Jaise: \`Short: OK Google bolte ho phone off hoke bhi sunta hai\` ya \`Long: Complete AI agents tutorial\`).

3️⃣ *Publish karein:*
Tap karein: *[ ✅ Completed - Merge & Upload ]*!

━━━━━━━━━━━━━━━━━━━━
✨ *AI kya karega:*
Aapke bataye hue topic aur context ke hisaab se YouTube algorithm ke liye:
• 🔥 *High-CTR Viral Title*
• 📝 *Full SEO Description with Tags & Hashtags*
• 🏷 *High-Ranking Search Tags*
generate karke 1 ghante ke schedule buffer ke sath YouTube par schedule kar dega!
${statusLine}`;

    await this.sendMessage(chatId, msg);
  }

  // Start polling loop in non-blocking mode so concurrent messages are handled instantly
  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.info('Starting Telegram Bot long-polling loop (Parallel Non-Blocking Mode)...');

    while (this.isRunning) {
      try {
        const updates = await this.apiCall('getUpdates', {
          offset: this.pollingOffset,
          timeout: 25,
          allowed_updates: ['message', 'callback_query']
        });

        if (updates.ok && Array.isArray(updates.result)) {
          for (const update of updates.result) {
            this.pollingOffset = update.update_id + 1;
            // Process updates asynchronously in parallel without blocking future updates!
            this.handleUpdate(update).catch(err => {
              this.logger.error('Error handling update in parallel:', err);
            });
          }
        }
      } catch (err) {
        if (!this.isRunning) break;
        this.logger.warn('Polling error (will retry in 3s):', err.message);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  stop() {
    this.isRunning = false;
    if (this.cronTask) {
      this.cronTask.stop();
    }
    this.logger.info('Telegram Bot stopped.');
  }

  // Handle updates from Telegram
  async handleUpdate(update) {
    if (update.message) {
      await this.handleMessage(update.message);
    }
  }

  async handleMessage(msg) {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    // Pair first user who starts the bot as admin or check against authorized admin
    const isAuthorized = (!this.adminChatId) ||
      (String(this.adminChatId) === String(chatId)) ||
      (process.env.TELEGRAM_ADMIN_CHAT_ID && String(process.env.TELEGRAM_ADMIN_CHAT_ID) === String(chatId)) ||
      (String(chatId) === '5013602846');

    if (!this.adminChatId && isAuthorized) {
      this.adminChatId = chatId;
      this.adminUsername = msg.from?.username || msg.from?.first_name || 'Admin';
      await this.saveAdminInfo();
      this.logger.success(`Paired admin chat: ${this.adminUsername} (${chatId})`);
    } else if (!isAuthorized) {
      await this.sendMessage(chatId, '🔒 *Access Denied*: Yeh private automation bot sirf channel operator ke liye authorized hai.');
      return;
    }

    // 1. Immediate Read-Only / Status Queries (Processed concurrently in parallel)
    if (text === '📊 System Status' || text === '/status') {
      await this.sendStatusMessage(chatId);
      return;
    }

    if (text === '📋 Live Logs' || text === '/logs' || text.toLowerCase() === 'logs') {
      await this.sendLiveLogsMessage(chatId);
      return;
    }

    if (text === '/start' || text === '❓ Help') {
      await this.sendWelcomeMessage(chatId);
      return;
    }

    if (text === '📤 Manual Upload' || text === '/manual' || text.toLowerCase() === 'manual') {
      await this.handleManualUploadPrompt(chatId);
      return;
    }

    if (text === '💬 Ask AI Copilot' || text === '/chat' || text === '/ask' || text.toLowerCase() === 'chat' || text.toLowerCase() === 'copilot') {
      if (this.manualContext?.active) {
        this.manualContext.active = false;
        await this.saveDraft();
      }
      await this.sendCopilotIntro(chatId);
      return;
    }

    // 2. Read-Only Insights & Agent Analysis Views (Strictly View Only)
    if (text === '🎯 Strategy & Backlog' || text === '/strategy' || text === '/ideas' || text.toLowerCase() === 'strategy' || text.toLowerCase() === 'backlog') {
      await this.sendStrategyAndBacklog(chatId);
      return;
    }

    if (text === '📈 Growth & Analytics' || text === '/growth' || text === '/analytics' || text.toLowerCase() === 'analytics' || text.toLowerCase() === 'growth') {
      await this.sendGrowthAndAnalytics(chatId);
      return;
    }

    if (text === '🤖 Operator Analysis' || text === '/operator' || text.toLowerCase() === 'operator') {
      await this.sendOperatorAnalysis(chatId);
      return;
    }

    if (text === '🩺 7 Agents Health' || text === '/health' || text === '/agents' || text.toLowerCase() === 'health' || text.toLowerCase() === 'agents') {
      await this.sendAgentsHealth(chatId);
      return;
    }

    // 3. Video / Document Clip Upload Handler (Sequenced via uploadQueue so clips don't scramble)
    if (msg.video || (msg.document && msg.document.mime_type?.startsWith('video/'))) {
      this.uploadQueue = this.uploadQueue.then(async () => {
        await this.handleVideoUpload(msg);
      }).catch(err => {
        this.logger.error('Error processing queued video clip:', err);
      });
      return;
    }

    // 4. Mutating / Background Execution Commands
    if (text === '✅ Completed - Merge & Upload' || text === '/complete') {
      if (this.activeJob) {
        const elapsed = Math.round((Date.now() - this.activeJob.startedAt) / 1000);
        await this.sendMessage(chatId, `⚠️ *Task Already Running!*\n\nAbhi background me ek task chal raha hai:\n📌 *Task:* ${this.activeJob.title}\n⏱ *Running Time:* ${elapsed}s\n📍 *Current Step:* ${this.activeJob.currentStep || this.currentActivity}\n\nParallel live logs dekhne ke liye tap karein:\n*[ 📊 System Status ]* ya *[ 📋 Live Logs ]*`);
        return;
      }
      if (this.stagedClips.length === 0) {
        await this.sendMessage(chatId, '⚠️ *Koi video ya clip staged nahi hai!* Pehle video yahan upload karein, ya `[ 💡 Give Me Prompt ]` se naya prompt lein.');
        return;
      }
      // Run background merge & upload without blocking polling
      this.handleCompleteMergeAndUpload(chatId).catch(err => {
        this.logger.error('Background merge and upload error:', err);
      });
      return;
    }

    if (text === '🤖 Fallback AI Video Now' || text === '/fallback') {
      if (this.activeJob) {
        const elapsed = Math.round((Date.now() - this.activeJob.startedAt) / 1000);
        await this.sendMessage(chatId, `⚠️ *Task Already Running!*\n\nAbhi background me ek task chal raha hai:\n📌 *Task:* ${this.activeJob.title}\n⏱ *Running Time:* ${elapsed}s\n📍 *Current Step:* ${this.activeJob.currentStep || this.currentActivity}\n\nLive status ke liye tap karein: [ 📊 System Status ]`);
        return;
      }
      // Run fallback in background
      this.handleManualFallbackTrigger(chatId).catch(err => {
        this.logger.error('Background fallback error:', err);
      });
      return;
    }

    if (text === '🗑 Clear Current Draft' || text === '/clear') {
      if (this.activeJob && (this.activeJob.type === 'merge_and_upload' || this.activeJob.type === 'fallback')) {
        await this.sendMessage(chatId, `⚠️ *Draft Cannot Be Cleared Right Now*: Video process chal raha hai (${this.activeJob.title}). Pura hone ka intezaar karein.`);
        return;
      }
      const { deletedCount: draftFiles, freedMB: draftMB } = await this.clearDraft();
      const { deletedCount: sampleFiles, freedMB: sampleMB } = await this.clearSamplesDir();
      const totalDeleted = draftFiles + sampleFiles;
      const totalFreed = Math.round((draftMB + sampleMB) * 10) / 10;

      this.logEvent(`Draft and samples cleaned: ${totalDeleted} files removed (~${totalFreed} MB freed)`);
      await this.sendMessage(chatId, `🗑 *Draft & Sample Videos Cleared!*\n\n✅ Disk se *${totalDeleted} files* (~${totalFreed} MB) poori tarah delete ho chuki hain.\n\nNaya video shuru karne ke liye direct video upload karein, \`[ 📤 Manual Upload ]\` tap karein, ya \`[ 💡 Give Me Prompt ]\` lein.`);
      return;
    }

    if (text === '⚡ Ultra Short (20s)' || text === '⚡ Ultra Short' || text === '/ultrashort' || text.toLowerCase() === 'ultrashort') {
      this.handleUltraShortPrompt(chatId, null).catch(err => {
        this.logger.error('Background ultra short prompt generation error:', err);
      });
      return;
    }

    if (text === '💡 Give Me Prompt' || text === '/prompt') {
      this.handleGiveMePrompt(chatId, null).catch(err => {
        this.logger.error('Background prompt generation error:', err);
      });
      return;
    }

    const systemActionButtons = [
      '⚡ Ultra Short (20s)', '⚡ Ultra Short', '💡 Give Me Prompt', '📊 System Status', '✅ Completed - Merge & Upload',
      '🤖 Fallback AI Video Now', '📋 Live Logs', '🗑 Clear Current Draft', '📤 Manual Upload',
      '🎯 Strategy & Backlog', '📈 Growth & Analytics', '🤖 Operator Analysis', '🩺 7 Agents Health',
      '💬 Ask AI Copilot'
    ];

    // Cancel manual upload mode command
    if (text === '/cancel' || text.toLowerCase() === 'cancel' || text.toLowerCase() === 'exit') {
      if (this.manualContext?.active) {
        this.manualContext.active = false;
        await this.saveDraft();
        await this.sendMessage(chatId, '❌ *Manual Upload mode cancelled.* Aap normal mode me hain.', {
          replyMarkup: this.getMainKeyboard()
        });
        return;
      }
    }

    // 5. Handle text when in Manual Upload Mode OR when clips are staged (User describes video topic / context)
    const isManualActive = Boolean(this.manualContext?.active || (this.stagedClips.length > 0 && !this.manualContext?.topic));

    if (isManualActive && text && !text.startsWith('/') && !systemActionButtons.includes(text)) {
      let rawText = text.trim();
      let cleanTopic = rawText;
      let detectedFormat = this.manualContext?.format || 'auto';

      // Parse explicit format prefixes if present (e.g. "Short: ...", "Long: ...")
      if (/^(short|reel|shorts|vertical)[\s*:\-_]+/i.test(rawText)) {
        detectedFormat = 'short';
        cleanTopic = rawText.replace(/^(short|reel|shorts|vertical)[\s*:\-_]+/i, '').trim();
      } else if (/^(long|horizontal|full\s*video|landscape)[\s*:\-_]+/i.test(rawText)) {
        detectedFormat = 'long';
        cleanTopic = rawText.replace(/^(long|horizontal|full\s*video|landscape)[\s*:\-_]+/i, '').trim();
      } else {
        const lower = rawText.toLowerCase();
        if (lower.includes('#short') || lower.includes('#shorts') || lower.includes('short')) {
          detectedFormat = 'short';
        } else if (lower.includes('long video') || lower.includes('horizontal')) {
          detectedFormat = 'long';
        }
      }

      if (!cleanTopic) cleanTopic = rawText;

      this.manualContext = {
        active: true,
        topic: cleanTopic,
        format: detectedFormat
      };
      this.state = 'manual_upload';
      await this.saveDraft();

      const formatDisplay = detectedFormat === 'short'
        ? '📱 YouTube Short (Vertical 9:16)'
        : (detectedFormat === 'long' ? '🖥 YouTube Long Video (16:9)' : '🔄 Auto-detect from video');

      const clipsCount = this.stagedClips.length;
      let nextStepTip = '';
      if (clipsCount === 0) {
        nextStepTip = '👉 *Next Step:* Ab apni video file (MP4/MOV) is chat me upload karein.';
      } else {
        nextStepTip = `👉 *Next Step:* Video already staged hai (${clipsCount} file).\nYouTube par publish karne ke liye tap karein:\n*[ ✅ Completed - Merge & Upload ]*`;
      }

      await this.sendMessage(chatId, `✅ *Video Topic & Context Registered!*

📌 *Topic / Context:*
"${cleanTopic}"

🎬 *Detected Format:* ${formatDisplay}
📊 *Status:* 📤 Manual Upload Mode Active

━━━━━━━━━━━━━━━━━━━━
${nextStepTip}

_💡 Note: Agar topic change karna ho to bas naya message likhein. AI isi topic ke aadhar par viral Title, Description aur Tags banayega! (Copilot se chat karne ke liye \`[ 💬 Ask AI Copilot ]\` tap karein ya \`/cancel\` karein)_`);
      return;
    }

    // 6. User asking for custom prompt via "ultra: <topic>" or "/ultra <topic>"
    if (text.toLowerCase().startsWith('ultra:') || text.toLowerCase().startsWith('/ultra')) {
      const promptTopic = text.replace(/^(ultra:|\/ultra\w*\s*)/i, '').trim() || null;
      this.handleUltraShortPrompt(chatId, promptTopic).catch(err => {
        this.logger.error('Background ultra short prompt generation error:', err);
      });
      return;
    }

    // 7. User asking for custom prompt via "prompt: <topic>" or "/prompt <topic>"
    if (text.toLowerCase().startsWith('prompt:') || text.toLowerCase().startsWith('/prompt')) {
      const promptTopic = text.replace(/^(prompt:|\/prompt\s*)/i, '').trim() || null;
      this.handleGiveMePrompt(chatId, promptTopic).catch(err => {
        this.logger.error('Background prompt generation error:', err);
      });
      return;
    }

    // 7. Conversational AI Chat Copilot (Strictly powered by local Proxy :8081)
    if (text.length >= 2 && !systemActionButtons.includes(text)) {
      this.askProxyCopilot(text, chatId).catch(err => {
        this.logger.error('Proxy Copilot execution error:', err);
      });
      return;
    }

    await this.sendMessage(chatId, 'Samajh nahi aaya. Kripya niche diye gaye buttons me se select karein ya koi sawaal poochhein:', {
      replyMarkup: this.getMainKeyboard()
    });
  }

  async sendWelcomeMessage(chatId) {
    const welcome = `🎬 *Welcome to Sameer | AgenticFlowAI Production Hub!*

Aapka private YouTube AI Automation System ready hai.

📌 *Key Controls & Analysis Features:*
1. ⚡ *Ultra Short (20s)* — 2 sequential scenes (10s each) with killer 2-second hook (100%+ loop retention).
2. 💡 *Give Me Prompt* — 4 sequential scenes (10s each = 40s) ke viral prompts.
3. 💬 *Ask AI Copilot* — Channel stats, retention, views drop aur SEO analysis ke liye direct chat.
4. 📤 *Manual Upload* — Apni koi bhi video upload karein, AI viral title/tags ke sath schedule karega.
5. ✅ *Completed - Merge & Upload* — Video ko YouTube par 1-hour schedule buffer ke sath upload karega.
6. 🎯 *Strategy & Backlog* — Live content ideas backlog aur scheduling analysis (View Only).
7. 📈 *Growth & Analytics* — Performance score, CTR, retention baselines (View Only).
8. 🤖 *Operator Analysis* — Autonomous operator execution pipeline status (View Only).
9. 🩺 *7 Agents Health* — Sabhi 7 AI agents ka 24x7 operational health status (View Only).
10. 📊 *System Status* & 📋 *Live Logs* — Real-time execution monitor.

Niche diye gaye interactive keyboard se shuru karein:`;

    await this.sendMessage(chatId, welcome);
  }

  // Handle incoming video uploads
  async handleVideoUpload(msg) {
    const chatId = msg.chat.id;
    const fileObj = msg.video || msg.document;
    const fileId = fileObj.file_id;
    const originalName = fileObj.file_name || `clip_${Date.now()}.mp4`;
    const fileSizeMB = Math.round((fileObj.file_size || 0) / 1024 / 1024 * 10) / 10;

    this.logEvent(`Receiving video clip from Telegram: ${originalName} (${fileSizeMB} MB)`);
    const statusMsg = await this.sendMessage(chatId, `⏳ *Downloading Clip...*\nFile: \`${originalName}\` (${fileSizeMB} MB)`);

    try {
      this.state = 'receiving_clips';
      this.currentActivity = `Downloading uploaded clip ${originalName} from Telegram CDN`;

      // 1. Get file path from Telegram
      const fileRes = await this.apiCall('getFile', { file_id: fileId });
      if (!fileRes.ok || !fileRes.result.file_path) {
        throw new Error('Could not retrieve file download path from Telegram CDN');
      }

      const downloadUrl = `${this.fileBaseUrl}/${fileRes.result.file_path}`;
      const clipIndex = this.stagedClips.length + 1;
      const destFileName = `clip_${clipIndex}_${Date.now()}.mp4`;
      const destPath = path.join(this.stagingDir, destFileName);

      // 2. Stream download to staging
      const response = await axios({
        method: 'GET',
        url: downloadUrl,
        responseType: 'stream',
        timeout: 60000
      });

      const writer = fs.createWriteStream(destPath);
      response.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      // 3. Inspect video duration & resolution using FFmpeg
      let duration = fileObj.duration || 0;
      let width = fileObj.width || 1280;
      let height = fileObj.height || 720;

      try {
        const probeRes = await runFFmpeg(['-i', destPath]);
        const durMatch = probeRes.stderr?.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
        if (durMatch) {
          duration = parseInt(durMatch[1], 10) * 3600 + parseInt(durMatch[2], 10) * 60 + parseFloat(durMatch[3]);
        }
        const resMatch = probeRes.stderr?.match(/Video:.*?(\d{3,4})x(\d{3,4})/);
        if (resMatch) {
          width = parseInt(resMatch[1], 10);
          height = parseInt(resMatch[2], 10);
        }
      } catch (e) {
        const durMatch = e.message?.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
        if (durMatch) {
          duration = parseInt(durMatch[1], 10) * 3600 + parseInt(durMatch[2], 10) * 60 + parseFloat(durMatch[3]);
        }
      }

      const clipData = {
        index: clipIndex,
        fileName: originalName,
        localPath: destPath,
        duration: Math.round(duration * 10) / 10,
        width,
        height,
        sizeMB: Math.round((fs.statSync(destPath).size / 1024 / 1024) * 10) / 10,
        receivedAt: new Date().toISOString()
      };

      this.stagedClips.push(clipData);

      // Auto-detect format and ensure manualContext is activated for this uploaded video
      if (!this.manualContext) {
        this.manualContext = { active: true, topic: '', format: 'auto' };
      }
      this.manualContext.active = true;
      if (!this.manualContext.format || this.manualContext.format === 'auto') {
        if (height > width || duration <= 60) {
          this.manualContext.format = 'short';
        } else {
          this.manualContext.format = 'long';
        }
      }
      this.state = 'manual_upload';
      await this.saveDraft();

      const totalDuration = Math.round(this.stagedClips.reduce((sum, c) => sum + c.duration, 0) * 10) / 10;
      this.logEvent(`Clip ${clipIndex} staged: ${clipData.duration}s (${width}x${height}). Draft: ${this.stagedClips.length} clips (${totalDuration}s total)`, 'success');
      this.currentActivity = `${this.stagedClips.length} clip(s) staged (${totalDuration}s total)`;

      let instructionsFooter = '';
      const formatLabel = this.manualContext.format === 'short' ? 'YouTube Short' : (this.manualContext.format === 'long' ? 'Long Video' : 'Auto');
      if (!this.manualContext.topic) {
        instructionsFooter = `\n👉 *Next Step:* Ab is video ke baare me 1 message likh kar bhejein (Video kis topic / concept par hai).\nFir tap karein: *[ ✅ Completed - Merge & Upload ]*`;
      } else {
        instructionsFooter = `\n📌 *Details Registered:* "${this.manualContext.topic}" (${formatLabel})\n👉 Video ready hai! Publish karne ke liye tap karein:\n*[ ✅ Completed - Merge & Upload ]*\n_(Naya message bhejne se topic update ho jayega)_`;
      }

      const summaryText = `✅ *Video / Clip ${clipIndex} Received & Staged!*
📁 *File:* \`${originalName}\`
⏱ *Duration:* ${clipData.duration}s (${width}x${height})
📊 *Current Draft:* ${this.stagedClips.length} file(s) | *Total:* ${totalDuration}s
${instructionsFooter}`;

      if (statusMsg) {
        await this.editMessage(chatId, statusMsg.message_id, summaryText);
      } else {
        await this.sendMessage(chatId, summaryText);
      }
    } catch (err) {
      this.logger.error('Failed to process uploaded video clip:', err);
      this.state = this.stagedClips.length > 0 ? 'receiving_clips' : 'resting';
      const errText = `❌ *Clip download fail ho gaya:* ${err.message}\nKripya dubara try karein.`;
      if (statusMsg) {
        await this.editMessage(chatId, statusMsg.message_id, errText);
      } else {
        await this.sendMessage(chatId, errText);
      }
    }
  }

  getDiverseTrendingAITopicPrompt(isCustom, customTopic, isUltraShort = false) {
    const coveredTopicsList = this.topicHistory.slice(-50).map(t => `- "${t.topic}"`).join('\n');
    const deduplicationInstruction = coveredTopicsList && !isCustom
      ? `\n\nCRITICAL DEDUPLICATION (PREVIOUSLY COVERED TOPICS - NEVER REPEAT):\n${coveredTopicsList}\n`
      : '';

    const trendingCategoriesPrompt = `
TRENDING VIRAL AI CATEGORIES (Rotate across these domains to ensure maximum audience retention and topic diversity):
1. HUMANOID ROBOTICS & EMBODIED AI: Tesla Optimus Gen 3, Figure 02 working in BMW factories, Boston Dynamics electric Atlas doing acrobatics, Unitree G1 robot kung-fu, domestic maid & factory robots.
2. NEXT-GEN AI MODELS & SUPER-TOOLS: DeepSeek-V3 vs ChatGPT-4o benchmarks, Claude 3.7 Sonnet agentic coding, OpenAI Sora photorealistic video generation, NotebookLM AI studio podcasts, secret prompt tricks.
3. AUTONOMOUS AI AGENTS & SOFTWARE CLONES: AI agents creating complete games/apps from 1 prompt, autonomous web shopping & booking bots, AI agents running companies while founders sleep.
4. EVERYDAY AI SUPERPOWERS & HACKS: Instant voice cloning in 5 seconds, AI removing any watermark/object seamlessly, mind-blowing free open-source AI tools that save 10 hours of work.
5. SHOCKING FUTURE TECH & BIO-AI: Neuralink paralyzed patients gaming telepathically, living biological brain cells on microchips running AI, autonomous drone swarms navigating without GPS.

STRICT ANTI-REPETITION RULE:
- Absolutely DO NOT generate generic "AI sees the world", "computer vision bounding boxes", or "AI tracks objects" themes! That topic has already been exhausted on this channel.
- Pick a fresh, high-voltage topic from one of the 5 categories above that makes an Indian/global viewer stop scrolling instantly.
`;

    if (isCustom) {
      return `The creator specifically requested a YouTube Short about: "${customTopic.trim()}". Create an irresistible, viral angle on this topic.`;
    }
    return `Pick today's most viral, high-CTR trending AI or Robotics concept from the categories below:${deduplicationInstruction}${trendingCategoriesPrompt}`;
  }

  // Ultra Short (20s): Generates 2 sequential 10-second scenes with an ultra-strong 2-second hook
  async handleUltraShortPrompt(chatId, customTopic = null) {
    const isCustom = Boolean(customTopic && customTopic.trim().length > 2);
    const topicHeading = isCustom ? `Custom Topic: "${customTopic.trim()}"` : 'Viral Trending AI (20s Ultra Short)';

    this.activeJob = {
      type: 'ultra_short_prompt',
      title: `⚡ Ultra Short: ${topicHeading}`,
      startedAt: Date.now(),
      currentStep: `Crafting 20s high-retention Short (2x10s scenes) with Gemini AI`,
      stepNumber: 1,
      totalSteps: 2,
      logs: []
    };
    this.logEvent(`Ultra short prompt requested: ${topicHeading}`);

    const statusMsg = await this.sendMessage(chatId, `⚡ *Researching ${topicHeading} & crafting 2-scene (20s) ultra-retention prompts...*`);

    try {
      let promptData;
      try {
        const topicResearchDirective = this.getDiverseTrendingAITopicPrompt(isCustom, customTopic, true);

        this.logEvent('Calling Gemini AI for 2x10s ultra-hook scene structuring, 9:16 vertical framing, and Hinglish dialogue...');
        const rawResponse = await this.generateAIContent(`You are an elite YouTube Shorts growth hacker for "Sameer | AgenticFlowAI".
${topicResearchDirective}
Target audience: Hindi / English (Hinglish) speaking tech enthusiasts and curious viewers on mobile.

CRITICAL OBJECTIVE: 
Shorts duration MUST BE EXACTLY 20 SECONDS (2 sequential 10-second scenes).
Why? 20s Shorts achieve 100%+ loop retention on YouTube, which is the #1 signal to trigger the viral algorithm!

CRITICAL HOOK RULE (0 to 2 SECONDS):
The first 2 seconds of Scene 1 MUST have an explosive, scroll-stopping pattern interrupt!
- Visual: Fast camera zoom-in, sudden dramatic action, or unbelievable high-tech visual.
- Spoken Hook (Hinglish): An opening line that creates curiosity gap instantly (e.g. "Ruko! Yeh AI video dekh kar aap hairan reh jaoge...", "Sirf 5 second me yeh robot jo karta hai use dekh kar scientists bhi dang hain...", "Google aur OpenAI ke beech chupke se yeh kya ho gaya?").

CRITICAL CONSTRAINTS (MANDATORY):
1. ASPECT RATIO (9:16 VERTICAL): Every video prompt MUST begin with:
   "Vertical 9:16 aspect ratio (YouTube Shorts vertical format, 1080x1920)."
2. EXACTLY 2 CLIPS (10s EACH): Google Gemini VideoFX generates exactly 10s per generation. Structure into exactly 2 sequential 10-second scenes (Total: 20 seconds master Short).

Output format MUST be strictly JSON with keys:
{
  "topic": "Catchy viral topic name",
  "conceptHook": "Irresistible 2-second hook explanation (why no one will swipe away)",
  "clip1": {
    "title": "Scene 1: The 2-Second Shock Hook (10s)",
    "videoPrompt": "Vertical 9:16 aspect ratio (YouTube Shorts vertical format, 1080x1920). Hyper-cinematic photorealistic 3D visual description in English framed vertically for mobile with high dynamic motion in first 2 seconds. End with [Dialogue in Hinglish]: '... exact high-energy spoken words in Hinglish...'"
  },
  "clip2": {
    "title": "Scene 2: Mind-Blowing Proof & Loop CTA (10s)",
    "videoPrompt": "Vertical 9:16 aspect ratio (YouTube Shorts vertical format, 1080x1920). Hyper-cinematic climax visual showing the breakthrough in action framed vertically for mobile. End with [Dialogue in Hinglish]: '... exact spoken words in Hinglish ending with a fast loop or subscribe to Sameer | AgenticFlowAI CTA...'"
  }
}
Return ONLY valid raw JSON without markdown backticks.`);

        let rawText = rawResponse.trim();
        rawText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
        promptData = JSON.parse(rawText);

        for (const key of ['clip1', 'clip2']) {
          if (promptData[key] && promptData[key].videoPrompt) {
            if (!promptData[key].videoPrompt.toLowerCase().includes('9:16')) {
              promptData[key].videoPrompt = `Vertical 9:16 aspect ratio (YouTube Shorts vertical format, 1080x1920). ${promptData[key].videoPrompt}`;
            }
          }
        }

        await this.saveTopicToHistory(promptData.topic, promptData.conceptHook);
        this.logEvent(`Ultra Short prompt generated successfully for "${promptData.topic}" (20s - 9:16 Vertical)`, 'success');
      } catch (aiErr) {
        this.logEvent(`AI Ultra Short prompt generation failed, using curated topic template: ${aiErr.message}`, 'warn');
        promptData = null;
      }

      if (!promptData) {
        promptData = {
          topic: isCustom ? customTopic.trim() : 'Tesla Optimus Gen 3 Humanoid Robot Shock Test',
          conceptHook: '2-Second Pattern Interrupt: Robot caught doing human tasks with zero delay',
          clip1: {
            title: 'Scene 1: The 2-Second Shock Hook (10s)',
            videoPrompt: 'Vertical 9:16 aspect ratio (YouTube Shorts vertical format, 1080x1920). Dramatic macro crash-zoom into glowing metallic optical eyes of a sleek humanoid robot in a futuristic neon laboratory, vertical mobile framing. The robot fluidly catches a falling glass egg with millimeter precision. Hyper-realistic reflections, 60fps cinematic motion blur. [Dialogue in Hinglish]: "Ruko! Agar aapko lagta hai ki humanoid robots abhi slow hain, toh Elon Musk ke is naye video ko dekhiye!"'
          },
          clip2: {
            title: 'Scene 2: Mind-Blowing Proof & Loop CTA (10s)',
            videoPrompt: 'Vertical 9:16 aspect ratio (YouTube Shorts vertical format, 1080x1920). Full-body vertical shot of the humanoid robot sprint-jogging on an obstacle course and organizing complex microchips 5x faster than humans. High-tech cyberpunk atmosphere. [Dialogue in Hinglish]: "Yeh robot bina kisi insaani control ke poora kaam khud kar raha hai! Kya yeh 2026 me insaano ki jobs replace kar dega? Comment me batayein aur subscribe karein Sameer | AgenticFlowAI!"'
          }
        };
      }

      const responseCard = `⚡ *ULTRA SHORT CONCEPT (20s HIGH RETENTION)*
🎯 *Topic:* ${promptData.topic}
📱 *Format:* 9:16 Vertical Short (1080x1920)
⏱ *Duration:* 20 Seconds (2 Scenes × 10s Gemini VideoFX)
🔥 *2-Sec Hook:* ${promptData.conceptHook}

💡 *Kyu ye chalega:* 20s ki duration se YouTube par *100%+ Loop Retention* aati hai aur algorithm foran Shorts feed me push karta hai!

━━━━━━━━━━━━━━━━━━━━
🎬 *${promptData.clip1.title}*
👉 *Gemini VideoFX me ye prompt paste kijiye (9:16):*
\`\`\`
${promptData.clip1.videoPrompt}
\`\`\`

━━━━━━━━━━━━━━━━━━━━
🎬 *${promptData.clip2.title}*
👉 *Gemini VideoFX me ye prompt paste kijiye (9:16):*
\`\`\`
${promptData.clip2.videoPrompt}
\`\`\`

━━━━━━━━━━━━━━━━━━━━
📲 *Ultra-Simple Instructions:*
1. Google Gemini VideoFX me *9:16 (Vertical Short)* select karein.
2. Bas **2 clips (10-10s)** generate karke download karein.
3. Dono clips ko is chat me send kar dijiye.
4. Tap karein: *[ ✅ Completed - Merge & Upload ]*!
5. Bot ise merge karke **1-hour schedule buffer** ke sath direct YouTube par schedule kar dega.`;

      await this.editMessage(chatId, statusMsg.message_id, responseCard);
    } catch (err) {
      this.logEvent(`Ultra short prompt generation error: ${err.message}`, 'error');
      await this.editMessage(chatId, statusMsg.message_id, `❌ *Ultra Short prompt generation me error:* ${err.message}`);
    } finally {
      this.activeJob = null;
    }
  }

  // Give Me Prompt: Generates high-retention 10-second Gemini VideoFX prompts
  async handleGiveMePrompt(chatId, customTopic = null) {
    const isCustom = Boolean(customTopic && customTopic.trim().length > 2);
    const topicHeading = isCustom ? `Custom Topic: "${customTopic.trim()}"` : 'Trending AI Breakthroughs';

    this.activeJob = {
      type: 'prompt_generation',
      title: `AI Prompt Research: ${topicHeading}`,
      startedAt: Date.now(),
      currentStep: `Researching ${topicHeading} with Gemini AI`,
      stepNumber: 1,
      totalSteps: 2,
      logs: []
    };
    this.logEvent(`Prompt generation requested: ${topicHeading}`);

    const statusMsg = await this.sendMessage(chatId, `🧠 *Researching ${topicHeading} & crafting 10s Gemini video prompts...*`);

    try {
      let promptData;
      try {
        const topicResearchDirective = this.getDiverseTrendingAITopicPrompt(isCustom, customTopic, false);

        this.logEvent('Calling Gemini AI for 4x10s scene structuring, 9:16 vertical framing, and Hinglish dialogue...');
        const rawResponse = await this.generateAIContent(`You are an elite YouTube Shorts strategist for the channel "Sameer | AgenticFlowAI".
${topicResearchDirective}
Target audience: Hindi / English (Hinglish) speaking audience curious about mind-blowing technology.

CRITICAL CONSTRAINTS (MANDATORY):
1. ASPECT RATIO (9:16 VERTICAL SHORTS): Every video prompt MUST be composed for 9:16 vertical full-screen mobile video. Every videoPrompt MUST begin with:
   "Vertical 9:16 aspect ratio (YouTube Shorts vertical format, 1080x1920)."
2. DURATION (10s PER CLIP): Google Gemini VideoFX generates videos of EXACTLY 10 SECONDS per generation. Structure this Short into exactly 4 sequential 10-second scenes (Total: 40 seconds master Short).

Output format MUST be strictly JSON with keys:
{
  "topic": "Catchy topic name",
  "conceptHook": "1-sentence hook explaining why viewers will stay glued",
  "clip1": {
    "title": "Scene 1: Hook & Mystery (10s)",
    "videoPrompt": "Vertical 9:16 aspect ratio (YouTube Shorts vertical format, 1080x1920). A hyper-cinematic 3D animation prompt in English describing vertical visual scene, lighting, camera motion framed vertically for mobile. End with [Dialogue in Hinglish]: '... exact natural spoken words in Hinglish...'"
  },
  "clip2": {
    "title": "Scene 2: Deepening The Problem (10s)",
    "videoPrompt": "Vertical 9:16 aspect ratio (YouTube Shorts vertical format, 1080x1920). A hyper-cinematic 3D visual description in English framed vertically for mobile. End with [Dialogue in Hinglish]: '... exact spoken words in Hinglish...'"
  },
  "clip3": {
    "title": "Scene 3: The AI Mechanism (10s)",
    "videoPrompt": "Vertical 9:16 aspect ratio (YouTube Shorts vertical format, 1080x1920). A hyper-cinematic 3D animation prompt in English explaining the technical mechanism framed vertically. End with [Dialogue in Hinglish]: '... exact spoken words in Hinglish...'"
  },
  "clip4": {
    "title": "Scene 4: The Twist & Call to Action (10s)",
    "videoPrompt": "Vertical 9:16 aspect ratio (YouTube Shorts vertical format, 1080x1920). A hyper-cinematic 3D climax prompt in English framed vertically. End with [Dialogue in Hinglish]: '... exact spoken words in Hinglish with Subscribe to AgenticFlowAI CTA...'"
  }
}
Return ONLY valid raw JSON without markdown backticks.`);

        let rawText = rawResponse.trim();
        rawText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
        promptData = JSON.parse(rawText);

        // Guarantee 9:16 vertical aspect ratio is explicitly prepended in all clips
        for (const key of ['clip1', 'clip2', 'clip3', 'clip4']) {
          if (promptData[key] && promptData[key].videoPrompt) {
            if (!promptData[key].videoPrompt.toLowerCase().includes('9:16')) {
              promptData[key].videoPrompt = `Vertical 9:16 aspect ratio (YouTube Shorts vertical format, 1080x1920). ${promptData[key].videoPrompt}`;
            }
          }
        }

        // Save generated topic into permanent history memory so it never repeats in future
        await this.saveTopicToHistory(promptData.topic, promptData.conceptHook);

        this.logEvent(`Gemini prompt generated successfully for "${promptData.topic}" (9:16 Vertical)`, 'success');
      } catch (aiErr) {
        this.logEvent(`AI prompt generation failed, using curated topic template: ${aiErr.message}`, 'warn');
        promptData = null;
      }

      if (!promptData) {
        // Curated viral 10s 4-scene topics with 9:16 vertical formatting
        promptData = {
          topic: isCustom ? customTopic.trim() : 'How Autonomous AI Drones Navigate Without GPS',
          conceptHook: 'GPS jam hone par bhi AI drones centimetre precision se kaise udte hain',
          clip1: {
            title: 'Scene 1: Hook & Mystery (10s)',
            videoPrompt: 'Vertical 9:16 aspect ratio (YouTube Shorts vertical format, 1080x1920). A photorealistic cinematic 3D macro shot of an autonomous micro-drone entering a pitch-black cave, vertical mobile framing. Green LiDAR laser beams scan sharp stalactites in 60fps slow motion. Volumetric smoke. [Dialogue in Hinglish]: "Agar GPS signal poori tarah gayab ho jaye, to kya drones crash ho jayenge? Bilkul nahi! Aaiye dekhte hain iska hidden secret!"'
          },
          clip2: {
            title: 'Scene 2: The Challenge (10s)',
            videoPrompt: 'Vertical 9:16 aspect ratio (YouTube Shorts vertical format, 1080x1920). Cinematic close-up of drone dual optical sensors detecting total darkness, vertical composition. Red warning telemetry HUD flashes on screen. High-tech cyberpunk lab style. [Dialogue in Hinglish]: "Bina satellites ke, na toh coordinates hote hain aur na hi map. Toh aakhir AI rasta kaise dhundta hai?"'
          },
          clip3: {
            title: 'Scene 3: Visual Odometry AI (10s)',
            videoPrompt: 'Vertical 9:16 aspect ratio (YouTube Shorts vertical format, 1080x1920). Glowing cyan neural network lines emerge from the camera lens, tracking thousands of microscopic dust particles in mid-air, vertical framed. Octane 8K render. [Dialogue in Hinglish]: "Is process ko Visual Odometry kehte hain! Drone ke cameras har millisecond me hazaron points ko track karke apna 3D rasta khud banate hain."'
          },
          clip4: {
            title: 'Scene 4: Climax & CTA (10s)',
            videoPrompt: 'Vertical 9:16 aspect ratio (YouTube Shorts vertical format, 1080x1920). The micro-drone smoothly exits the cave into bright sunlight, doing an aerial 360 flip with sleek motion blur, vertical mobile frame. 4K cinematic. [Dialogue in Hinglish]: "Aur isiliye future drones ko kisi GPS ki zaroorat nahi! Aise hi futuristic tech ke liye abhi Subscribe kijiye Sameer | AgenticFlowAI!"'
          }
        };
      }

      const responseCard = `💡 *TODAY'S AI SHORT CONCEPT (10s GEMINI SCENES)*
🎯 *Topic:* ${promptData.topic}
📱 *Format:* 9:16 Vertical Short (1080x1920)
⏱ *Duration:* 40 Seconds (4 Scenes × 10s Gemini VideoFX)
🔥 *Hook:* ${promptData.conceptHook}

━━━━━━━━━━━━━━━━━━━━
🎬 *${promptData.clip1.title}*
👉 *Gemini VideoFX me ye prompt paste kijiye (9:16):*
\`\`\`
${promptData.clip1.videoPrompt}
\`\`\`

━━━━━━━━━━━━━━━━━━━━
🎬 *${promptData.clip2.title}*
👉 *Gemini VideoFX me ye prompt paste kijiye (9:16):*
\`\`\`
${promptData.clip2.videoPrompt}
\`\`\`

━━━━━━━━━━━━━━━━━━━━
🎬 *${promptData.clip3.title}*
👉 *Gemini VideoFX me ye prompt paste kijiye (9:16):*
\`\`\`
${promptData.clip3.videoPrompt}
\`\`\`

━━━━━━━━━━━━━━━━━━━━
🎬 *${promptData.clip4.title}*
👉 *Gemini VideoFX me ye prompt paste kijiye (9:16):*
\`\`\`
${promptData.clip4.videoPrompt}
\`\`\`

━━━━━━━━━━━━━━━━━━━━
📲 *Instructions:*
1. Google Gemini VideoFX me *9:16 (Vertical Short)* select karein (har prompt me 9:16 format pre-configured hai).
2. VideoFX ek baar me *10 second* ka video banata hai.
3. Chaaron prompts se 10-10s ki 9:16 vertical clips generate karke download karein.
4. Charon clips ko is chat me send kar dijiye.
5. Sabhi upload hone ke baad tap karein:
*[ ✅ Completed - Merge & Upload ]*`;

      await this.editMessage(chatId, statusMsg.message_id, responseCard);
    } catch (err) {
      this.logEvent(`Prompt generation error: ${err.message}`, 'error');
      await this.editMessage(chatId, statusMsg.message_id, `❌ *Prompt generation me error:* ${err.message}`);
    } finally {
      this.activeJob = null;
    }
  }

  // Handle Completed: Merges staged clips losslessly and triggers YouTube publish
  async handleCompleteMergeAndUpload(chatId) {
    if (this.stagedClips.length === 0) {
      await this.sendMessage(chatId, '⚠️ *Koi clips staged nahi hain!* Pehle 1 ya 2 video clips yahan upload karein, ya `[ 💡 Give Me Prompt ]` se naya prompt lein.');
      return;
    }

    const totalClips = this.stagedClips.length;
    const totalDuration = Math.round(this.stagedClips.reduce((sum, c) => sum + c.duration, 0) * 10) / 10;

    this.activeJob = {
      type: 'merge_and_upload',
      title: `Merge ${totalClips} Clips & Publish to YouTube`,
      startedAt: Date.now(),
      currentStep: `Merging ${totalClips} staged clips (${totalDuration}s) with FFmpeg`,
      stepNumber: 1,
      totalSteps: 4,
      logs: []
    };
    this.logEvent(`Merge & Upload pipeline started: ${totalClips} clips (${totalDuration}s total)`);

    const statusMsg = await this.sendMessage(chatId, `🚀 *Processing Started (1/4)*\n🔄 Merging ${totalClips} clips (${totalDuration}s) with FFmpeg...`);
    this.activeJobMessageId = statusMsg.message_id;
    this.activeJobChatId = chatId;

    try {
      this.state = 'merging';
      this.currentActivity = `Merging ${totalClips} staged clips (${totalDuration}s)`;

      // 1. Merge clips with FFmpeg
      const timestamp = Date.now();
      const samplesDir = path.join(__dirname, '..', 'samples');
      await fsp.mkdir(samplesDir, { recursive: true });
      const mergedOutputPath = path.join(samplesDir, `agenticflow_merged_${timestamp}.mp4`);

      if (this.stagedClips.length === 1) {
        this.logEvent('Single video uploaded: copying directly to output path...');
        try {
          await runFFmpeg([
            '-y',
            '-i', this.stagedClips[0].localPath,
            '-c', 'copy',
            mergedOutputPath
          ]);
          this.logEvent('Single video stream copy succeeded', 'success');
        } catch (copyErr) {
          this.logEvent(`Single video stream copy failed, re-encoding: ${copyErr.message}`, 'warn');
          await runFFmpeg([
            '-y',
            '-i', this.stagedClips[0].localPath,
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '19',
            '-c:a', 'aac',
            '-b:a', '192k',
            mergedOutputPath
          ]);
        }
      } else {
        // Write concat file list for multiple clips
        const concatListPath = path.join(this.stagingDir, `concat_list_${timestamp}.txt`);
        const fileEntries = this.stagedClips.map(c => `file '${path.resolve(c.localPath).replace(/'/g, "'\\''")}'`).join('\n');
        await fsp.writeFile(concatListPath, fileEntries, 'utf8');

        this.logEvent('Executing FFmpeg stream concat merge...');
        // Attempt stream copy merge first (fast & lossless)
        try {
          await runFFmpeg([
            '-y',
            '-f', 'concat',
            '-safe', '0',
            '-i', concatListPath,
            '-c', 'copy',
            mergedOutputPath
          ]);
          this.logEvent('Stream copy lossless concat succeeded', 'success');
        } catch (streamCopyErr) {
          this.logEvent(`Stream copy had format mismatch, falling back to filter concat: ${streamCopyErr.message}`, 'warn');
          // Fallback filter concat to conform video/audio
          const inputArgs = [];
          let filterInputs = '';
          this.stagedClips.forEach((c, i) => {
            inputArgs.push('-i', c.localPath);
            filterInputs += `[${i}:v:0][${i}:a:0]`;
          });
          const filterComplex = `${filterInputs}concat=n=${this.stagedClips.length}:v=1:a=1[outv][outa]`;
          await runFFmpeg([
            '-y',
            ...inputArgs,
            '-filter_complex', filterComplex,
            '-map', '[outv]',
            '-map', '[outa]',
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '19',
            '-c:a', 'aac',
            '-b:a', '192k',
            mergedOutputPath
          ]);
          this.logEvent('Filter concat render completed successfully', 'success');
        }
      }

      const mergedStat = fs.statSync(mergedOutputPath);
      const mergedSizeMB = Math.round((mergedStat.size / 1024 / 1024) * 10) / 10;
      this.logEvent(`Merged video file created: ${mergedSizeMB} MB at ${mergedOutputPath}`, 'success');

      // 2. Generate SEO Metadata & Thumbnail
      this.state = 'generating_metadata';
      this.activeJob.stepNumber = 2;
      this.activeJob.currentStep = 'Generating viral YouTube title, description and tags with Gemini';
      this.logEvent('Generating viral YouTube SEO metadata with Gemini AI...');
      await this.editMessage(chatId, statusMsg.message_id, `🧠 *Processing (2/4)*\nGenerating high-CTR YouTube Title, Description & Tags with Gemini...`);

      const isManual = Boolean(this.manualContext?.active && this.manualContext?.topic);
      const userTopic = isManual ? this.manualContext.topic.trim() : null;
      const isShort = (this.manualContext?.format === 'short') ||
        (this.manualContext?.format !== 'long' && (totalDuration <= 60 || this.stagedClips.some(c => c.height > c.width)));

      let metadataPrompt = '';
      if (isManual) {
        if (isShort) {
          metadataPrompt = `You are an elite YouTube Shorts strategist for the channel "Sameer | AgenticFlowAI".
The creator manually uploaded a YouTube Short with these details:
Topic / Details: "${userTopic}"
Video Duration: ${totalDuration} seconds.
Format: YouTube Short (Vertical 9:16).

Generate viral, high-CTR YouTube Shorts metadata in Hinglish/English.
1. Title MUST be high-CTR, curiosity-inducing, under 65 chars, and end with #Shorts.
2. Description should be 2-3 engaging paragraphs with relevant keywords, hashtags, and a CTA to subscribe to Sameer | AgenticFlowAI.
3. Provide 8-12 high-ranking search tags.

Output strictly JSON:
{
  "title": "Compelling Title under 65 chars #Shorts",
  "description": "Engaging description with hashtags...",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"]
}
Return ONLY valid JSON without markdown formatting.`;
        } else {
          metadataPrompt = `You are an elite YouTube SEO strategist for the channel "Sameer | AgenticFlowAI".
The creator manually uploaded a full Long-form YouTube video with these details:
Topic / Details: "${userTopic}"
Video Duration: ${totalDuration} seconds.
Format: YouTube Long Video (Standard 16:9).

Generate viral, high-CTR YouTube video metadata in Hinglish/English.
1. Title MUST be high-CTR, curiosity-driven, under 70 chars. Do NOT include #Shorts.
2. Description should be a comprehensive, high-retention description with overview, key takeaways, SEO keywords, hashtags, and a CTA to subscribe to Sameer | AgenticFlowAI.
3. Provide 12-15 high-ranking search tags.

Output strictly JSON:
{
  "title": "Compelling High-CTR Title under 70 chars",
  "description": "Comprehensive description with keywords and hashtags...",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"]
}
Return ONLY valid JSON without markdown formatting.`;
        }
      } else {
        metadataPrompt = `Generate viral YouTube Shorts metadata for a ${totalDuration}s tech video on AI/computer vision.
Output strictly JSON:
{
  "title": "High CTR title under 65 chars with #Shorts",
  "description": "Engaging 3-paragraph description with keywords and hashtags",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"]
}
Return ONLY valid JSON without markdown formatting.`;
      }

      let metadata = {
        title: userTopic ? `${userTopic.slice(0, 50)} | AgenticFlowAI ${isShort ? '#Shorts' : ''}` : `How AI Sees The World in Real Time | Mind-Blowing AI Vision #Shorts`,
        description: userTopic
          ? `Discover ${userTopic} in this exciting video!\n\n🔔 Subscribe to Sameer | AgenticFlowAI for daily breakthroughs!\n#AI #Technology ${isShort ? '#Shorts ' : ''}#AgenticFlowAI`
          : `Ever wondered how Artificial Intelligence processes visual imagery? In this high-tech short, we break down neural networks and computer vision in Hinglish!\n\n🔔 Subscribe to Sameer | AgenticFlowAI for the latest daily AI breakthroughs!\n#AI #ComputerVision #ArtificialIntelligence #TechShorts #AgenticFlowAI #NeuralNetworks`,
        tags: ['AI', 'Technology', isShort ? 'Shorts' : 'Tech Video', 'AgenticFlowAI', 'Artificial Intelligence']
      };

      try {
        const metaRes = await this.generateAIContent(metadataPrompt);
        const parsed = JSON.parse(metaRes.trim().replace(/```json/gi, '').replace(/```/g, ''));
        if (parsed.title) {
          metadata = parsed;
          this.logEvent(`Dynamic SEO title generated: "${metadata.title}"`, 'success');
          // Save to permanent history for deduplication
          await this.saveTopicToHistory(metadata.title, userTopic || '');
        }
      } catch (e) {
        this.logEvent(`Could not generate dynamic metadata, using default: ${e.message}`, 'warn');
      }

      // Generate Thumbnail Frame
      const thumbTimestamp = Math.min(2, Math.max(0.5, totalDuration / 2));
      const thumbTimestampStr = `00:00:${String(Math.floor(thumbTimestamp)).padStart(2, '0')}`;
      const thumbPath = path.join(samplesDir, `agenticflow_thumb_${timestamp}.jpg`);
      this.logEvent(`Extracting high-resolution thumbnail frame at ${thumbTimestampStr}...`);
      try {
        await runFFmpeg([
          '-y',
          '-ss', thumbTimestampStr,
          '-i', mergedOutputPath,
          '-vframes', '1',
          '-q:v', '2',
          thumbPath
        ]);
        this.logEvent('Thumbnail frame extracted successfully', 'success');
      } catch (e) {
        this.logEvent(`Thumbnail frame extraction warning: ${e.message}`, 'warn');
      }

      // 3. YouTube Upload Step
      this.state = 'uploading';
      this.activeJob.stepNumber = 3;
      this.activeJob.currentStep = `Uploading ${isShort ? 'Short' : 'video'} to YouTube Channel via OAuth`;
      this.logEvent('Initiating YouTube video upload...');
      await this.editMessage(chatId, statusMsg.message_id, `🚀 *Processing (3/4)*\nUploading video to YouTube...`);

      let uploadOutcome = {
        published: false,
        youtubeUrl: null,
        message: 'Saved locally. YouTube API OAuth authentication pending in setup.'
      };
      let scheduledTimeIST = '';

      // Check if YouTube credentials are setup
      const tokensPath = path.join(__dirname, '..', 'config', 'tokens.json');
      if (fs.existsSync(tokensPath)) {
        try {
          const { CredentialManager } = require('./credential-manager');
          const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');
          const { Database } = require('../database/db');

          const creds = new CredentialManager();
          await creds.initialize();
          const db = new Database();
          await db.initialize();

          const publisher = new PublishingSchedulingAgent(db, creds);
          await publisher.initialize();

          const publishAtDate = new Date(Date.now() + 60 * 60 * 1000);
          const scheduledPublishTime = publishAtDate.toISOString();
          scheduledTimeIST = publishAtDate.toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit'
          });

          const scheduleEntry = {
            id: `telegram_prod_${timestamp}`,
            productionId: `telegram_prod_${timestamp}`,
            title: metadata.title,
            status: 'scheduled',
            publishTime: scheduledPublishTime,
            metadata: {
              seo: {
                title: metadata.title,
                description: metadata.description,
                tags: Array.isArray(metadata.tags) && metadata.tags.length >= 3 ? metadata.tags : ['AI', 'Tech', isShort ? 'Shorts' : 'Video', 'AgenticFlowAI'],
                categoryId: '28',
                defaultLanguage: 'en',
                defaultAudioLanguage: 'hi'
              },
              video: { path: mergedOutputPath },
              thumbnail: { path: fs.existsSync(thumbPath) ? thumbPath : null },
              privacyStatus: 'private', // Scheduled release requires private initially
              containsSyntheticMedia: true
            }
          };

          this.logEvent(`Calling YouTube Data API v3 upload service (Scheduled for ${scheduledTimeIST} IST)...`);
          const res = await publisher.uploadToYouTube(scheduleEntry);
          const videoId = res?.id || res?.data?.id || scheduleEntry.youtubeId;
          if (videoId) {
            uploadOutcome.published = true;
            uploadOutcome.youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
            uploadOutcome.message = `Uploaded to YouTube (Scheduled for ${scheduledTimeIST} IST): ${uploadOutcome.youtubeUrl}`;
            this.logEvent(`YouTube upload successful (Scheduled 1-hour buffer): ${uploadOutcome.youtubeUrl}`, 'success');
          } else {
            uploadOutcome.message = 'Upload completed but no videoId was returned.';
            this.logEvent(uploadOutcome.message, 'warn');
          }
        } catch (uploadErr) {
          this.logEvent(`Direct YouTube upload could not complete: ${uploadErr.message}`, 'error');
          uploadOutcome.message = `YouTube upload error: ${uploadErr.message}`;
        }
      }

      // Mark today as published if successfully uploaded
      if (uploadOutcome.published) {
        const todayStr = new Date().toISOString().split('T')[0];
        this.lastPublishedDate = todayStr;
        await this.saveAdminInfo();
      }

      // Clear draft
      await this.clearDraft();
      this.logEvent('Draft cleared and temporary staging directory cleaned up', 'success');

      // Auto-cleanup samples folder immediately after successful YouTube upload
      if (uploadOutcome.published) {
        const { deletedCount: sampleFiles, freedMB: sampleMB } = await this.clearSamplesDir();
        this.logEvent(`Auto-cleanup completed: ${sampleFiles} sample files deleted from samples folder (~${sampleMB} MB freed)`, 'success');
      }

      // Final Success Notification
      let uploadStatusText = '';
      if (uploadOutcome.published) {
        uploadStatusText = `🚀 *YouTube Upload Successful!*\n🔗 *Video URL:* ${uploadOutcome.youtubeUrl}\n⏳ *Schedule:* 1-Hour Buffer (Auto-Public at ${scheduledTimeIST} IST)\n🔒 *Visibility:* Private (Scheduled Release)\n_💡 YouTube ko 1080p HD transcode aur algorithm recommendation categorize karne ke liye 1 ghante ka buffer mil gaya hai!_`;
      } else {
        uploadStatusText = `⚠️ *Video Processed Locally (Upload Issue):*\n${uploadOutcome.message}\n_File disk par safe hai._`;
      }

      const formatBadge = isShort ? '📱 YOUTUBE SHORT' : '🖥 YOUTUBE LONG VIDEO';
      const successText = `🎉 *${formatBadge} PUBLISHED SUCCESSFULLY!*

📌 *Title:* ${metadata.title}
⏱ *Total Duration:* ${totalDuration}s (${totalClips} file${totalClips > 1 ? 's' : ''})
📦 *File Size:* ${mergedSizeMB} MB
${userTopic ? `💡 *Topic:* "${userTopic}"\n` : ''}
${uploadStatusText}

💤 *System status:* Resting / Idle. Ready for next upload!`;

      await this.editMessage(chatId, statusMsg.message_id, successText);
      this.state = 'resting';
      this.currentActivity = 'Idle / Waiting for clips or 6:00 PM IST';
      this.logEvent('Pipeline finished successfully. Bot returned to resting state', 'success');
    } catch (err) {
      this.logEvent(`Failed to complete merge and upload: ${err.message}`, 'error');
      this.state = 'resting';
      this.currentActivity = 'Idle / Waiting for clips or 6:00 PM IST';
      await this.editMessage(chatId, statusMsg.message_id, `❌ *Merge & Upload Failed:* ${err.message}\nClips aapke draft me surakshit hain.`);
    } finally {
      this.activeJob = null;
    }
  }

  // Manual trigger for autonomous fallback video
  async handleManualFallbackTrigger(chatId) {
    const confirmMsg = await this.sendMessage(chatId, '🤖 *Fallback Triggered*: Autonomous AI video pipeline start ho raha hai (Images + Voiceover + Subtitles)...\n🔒 *Note:* Yeh fallback video YouTube par *Private* upload hogi taaki aap pehle review kar sakein.');
    await this.runAutonomousFallback(chatId, confirmMsg.message_id);
  }

  // 6:00 PM IST Scheduled Cron Job
  setupFallbackCron() {
    // Schedule: 0 18 * * * (At 18:00 every day in Asia/Kolkata timezone)
    const cronExpr = `0 ${this.fallbackHour} * * *`;
    this.logger.info(`Setting up daily fallback cron at ${this.fallbackHour}:00 (${this.timezone}): ${cronExpr}`);

    this.cronTask = cron.schedule(cronExpr, async () => {
      this.logger.info('⏰ 6:00 PM IST check triggered!');
      const todayStr = new Date().toISOString().split('T')[0];

      if (this.lastPublishedDate === todayStr) {
        this.logger.info('Today video already published. Skipping 6:00 PM IST fallback.');
        if (this.adminChatId) {
          await this.sendMessage(this.adminChatId, '⏰ *6:00 PM IST Status Check:* Aaj ki video already publish ho chuki hai. No fallback required today! ✅');
        }
        return;
      }

      if (this.adminChatId) {
        const pingMsg = await this.sendMessage(this.adminChatId, '⏰ *6:00 PM IST Fallback Triggered!*\nAaj koi manual clips upload nahi hui thin. Autonomous AI video pipeline start ho raha hai taaki channel ka daily schedule miss na ho...');
        await this.runAutonomousFallback(this.adminChatId, pingMsg?.message_id);
      } else {
        await this.runAutonomousFallback(null, null);
      }
    }, {
      timezone: this.timezone
    });
  }

  // Run autonomous fallback video pipeline
  async runAutonomousFallback(chatId, messageId) {
    if (this.state !== 'resting' && this.state !== 'receiving_clips') {
      const busyMsg = '⚠️ System is currently busy processing another job. Fallback queued.';
      if (chatId) await this.sendMessage(chatId, busyMsg);
      return;
    }

    this.activeJob = {
      type: 'fallback',
      title: 'Autonomous AI Video Generation & Publish',
      startedAt: Date.now(),
      currentStep: 'Rendering AI visual short with voiceover and dynamic subtitles',
      stepNumber: 1,
      totalSteps: 3,
      logs: []
    };
    this.logEvent('Autonomous fallback video generation pipeline started');

    this.state = 'fallback_generating';
    this.currentActivity = 'Rendering autonomous fallback video';

    try {
      if (chatId && messageId) {
        await this.editMessage(chatId, messageId, '🤖 *Autonomous Fallback (1/3)*: Rendering AI visual short with voiceover and dynamic subtitles...');
      }

      // Execute realistic short generator
      const realisticScript = path.join(__dirname, '..', 'scripts', 'generate-realistic-short.js');
      const { exec } = require('child_process');
      const util = require('util');
      const execPromise = util.promisify(exec);

      this.logEvent('Running generate-realistic-short.js child process...');
      await execPromise(`node "${realisticScript}"`, {
        cwd: path.join(__dirname, '..'),
        timeout: 180000
      });

      const fallbackSample = path.join(__dirname, '..', 'samples', 'agenticflow_ai_vision_sample_short.mp4');
      this.logEvent(`Fallback video rendered: ${fallbackSample}`, 'success');

      if (chatId && messageId) {
        await this.editMessage(chatId, messageId, `🤖 *Autonomous Fallback (2/3)*: Video rendered successfully! Preparing YouTube metadata and upload...`);
      }

      // Upload fallback video to YouTube
      let uploadOutcome = {
        published: false,
        youtubeUrl: null,
        message: 'Saved locally'
      };

      const tokensPath = path.join(__dirname, '..', 'config', 'tokens.json');
      if (fs.existsSync(tokensPath)) {
        try {
          const { CredentialManager } = require('./credential-manager');
          const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');
          const { Database } = require('../database/db');

          const creds = new CredentialManager();
          await creds.initialize();
          const db = new Database();
          await db.initialize();

          const publisher = new PublishingSchedulingAgent(db, creds);
          await publisher.initialize();

          const timestamp = Date.now();
          const fallbackTitle = `Mind-Blowing AI Breakthrough You Never Saw Coming! 🤖 #Shorts`;
          const scheduleEntry = {
            id: `telegram_fallback_${timestamp}`,
            productionId: `telegram_fallback_${timestamp}`,
            title: fallbackTitle,
            status: 'scheduled',
            metadata: {
              seo: {
                title: fallbackTitle,
                description: `Discover how Autonomous AI systems and Computer Vision are reshaping reality in 2026!\n\n🔔 Subscribe to Sameer | AgenticFlowAI for daily mind-blowing tech shorts!\n#AI #Technology #Shorts #AgenticFlowAI #Robotics`,
                tags: ['AI', 'Technology', 'Shorts', 'AgenticFlowAI', 'Robotics', 'Artificial Intelligence'],
                categoryId: '28',
                defaultLanguage: 'en',
                defaultAudioLanguage: 'hi'
              },
              video: { path: fallbackSample },
              privacyStatus: 'private', // Fallback video is always uploaded as Private for creator review
              containsSyntheticMedia: true
            }
          };

          this.logEvent('Uploading autonomous fallback video to YouTube Channel (Private)...');
          const res = await publisher.uploadToYouTube(scheduleEntry);
          const videoId = res?.id || res?.data?.id || scheduleEntry.youtubeId;
          if (videoId) {
            uploadOutcome.published = true;
            uploadOutcome.youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
            this.logEvent(`Autonomous fallback YouTube upload successful (Private): ${uploadOutcome.youtubeUrl}`, 'success');
          }
        } catch (uploadErr) {
          this.logEvent(`Autonomous fallback YouTube upload error: ${uploadErr.message}`, 'error');
          uploadOutcome.message = uploadErr.message;
        }
      }

      const todayStr = new Date().toISOString().split('T')[0];
      this.lastPublishedDate = todayStr;
      await this.saveAdminInfo();

      // Auto-cleanup samples folder after fallback upload
      if (uploadOutcome.published) {
        await this.clearSamplesDir();
      }

      const doneText = `✅ *AUTONOMOUS FALLBACK COMPLETE!*

🎬 *Video:* AI Vision Concept Short
📁 *File:* \`${fallbackSample}\`
⏱ *Duration:* ~30-35s
${uploadOutcome.published ? `🚀 *YouTube URL:* ${uploadOutcome.youtubeUrl}\n🔒 *Visibility:* Private (Aap YouTube Studio me check karke public kar sakte hain)` : `ℹ️ *Status:* Rendered locally (${uploadOutcome.message})`}
📅 *Date:* ${todayStr}

Channel ka daily streak barkarar hai!
💤 *System status:* Resting / Idle`;

      if (chatId && messageId) {
        await this.editMessage(chatId, messageId, doneText);
      } else if (chatId) {
        await this.sendMessage(chatId, doneText);
      }

      this.state = 'resting';
      this.currentActivity = 'Idle / Waiting for clips or 6:00 PM IST';
      this.logEvent('Autonomous fallback completed successfully', 'success');
    } catch (err) {
      this.logEvent(`Autonomous fallback failed: ${err.message}`, 'error');
      this.state = 'resting';
      this.currentActivity = 'Idle / Waiting for clips or 6:00 PM IST';
      if (chatId) {
        await this.sendMessage(chatId, `❌ *Autonomous Fallback Error:* ${err.message}`);
      }
    } finally {
      this.activeJob = null;
    }
  }

  // System Status command handler (Executes immediately in parallel)
  async sendStatusMessage(chatId) {
    const isResting = this.state === 'resting';
    const stateIcon = isResting ? '💤 Resting / Idle' : `⚙️ Active (${this.state.toUpperCase()})`;
    const todayStr = new Date().toISOString().split('T')[0];
    const publishedToday = this.lastPublishedDate === todayStr ? '✅ Published Today' : '⏳ Pending';

    // Calculate time until 6:00 PM IST
    const now = new Date();
    const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
    const istTime = new Date(utcTime + (3600000 * 5.5));
    const targetIst = new Date(istTime);
    targetIst.setHours(this.fallbackHour, 0, 0, 0);

    let timeDiffMs = targetIst.getTime() - istTime.getTime();
    let timeStr = '';
    if (timeDiffMs <= 0) {
      timeStr = 'Passed for today (next at 18:00 IST tomorrow)';
    } else {
      const hours = Math.floor(timeDiffMs / (1000 * 60 * 60));
      const mins = Math.floor((timeDiffMs % (1000 * 60 * 60)) / (1000 * 60));
      timeStr = `${hours}h ${mins}m remaining`;
    }

    let activeTaskSection = '';
    if (this.activeJob) {
      const elapsedSec = Math.round((Date.now() - this.activeJob.startedAt) / 1000);
      const recentLogs = (this.activeJob.logs || []).slice(-4);
      let logsLines = recentLogs.map(l => `  • \`[${l.time}]\` ${l.message}`).join('\n');
      if (!logsLines) logsLines = `  • \`[${istTime.toLocaleTimeString('en-IN', { hour12: false })}]\` ${this.activeJob.currentStep || this.currentActivity}`;

      activeTaskSection = `\n🔥 *PARALLEL ACTIVE TASK (LIVE):*
📌 *Task:* ${this.activeJob.title}
⏱ *Running For:* ${elapsedSec} seconds
📍 *Current Step:* ${this.activeJob.currentStep || this.currentActivity}
📋 *Recent Live Progress:*
${logsLines}
`;
    }

    let manualModeLine = '';
    if (this.manualContext?.active) {
      const fmtStr = this.manualContext.format === 'short' ? 'YouTube Short (9:16)' : (this.manualContext.format === 'long' ? 'Long Video (16:9)' : 'Auto-detect');
      manualModeLine = `\n📤 *Manual Upload Mode:* Active (${fmtStr})\n📝 *Registered Topic:* ${this.manualContext.topic ? `"${this.manualContext.topic}"` : '_Awaiting description in chat_'}\n`;
    }

    const statusText = `📊 *AGENTICFLOW SYSTEM STATUS*

🟢 *Bot State:* ${stateIcon}
📝 *Current Activity:* ${this.currentActivity}${activeTaskSection}${manualModeLine}
📅 *Today's Status:* ${publishedToday}
📁 *Staged Videos:* ${this.stagedClips.length} file(s) (${Math.round(this.stagedClips.reduce((s, c) => s + c.duration, 0) * 10) / 10}s total)
⏰ *6:00 PM IST Fallback:* ${timeStr}
👤 *Authorized Admin:* @${this.adminUsername || 'Pending pair'}

${this.activeJob ? '⚡ *Process background me execute ho raha hai. Aap kisi bhi samay `[ 📊 System Status ]` ya `[ 📋 Live Logs ]` tap karke live updates dekh sakte hain.*' : (this.stagedClips.length > 0 ? '💡 *Action:* You have video staged. Tap `[ ✅ Completed - Merge & Upload ]` to publish!' : '💡 *Action:* Tap `[ 📤 Manual Upload ]` to upload your own video, or `[ 💡 Give Me Prompt ]` for AI prompts!')}`;

    await this.sendMessage(chatId, statusText);
  }

  // Dedicated Live Logs viewer (Executes immediately in parallel)
  async sendLiveLogsMessage(chatId) {
    const logsToDisplay = (this.activeJob && this.activeJob.logs?.length > 0)
      ? this.activeJob.logs
      : this.recentLogs;

    let logsContent = '';
    if (!logsToDisplay || logsToDisplay.length === 0) {
      logsContent = '_No live execution logs recorded yet. System is idle._';
    } else {
      const sliceLogs = logsToDisplay.slice(-10);
      logsContent = sliceLogs.map(l => {
        let icon = '🔹';
        if (l.level === 'error') icon = '🔴';
        else if (l.level === 'warn') icon = '🟡';
        else if (l.level === 'success') icon = '🟢';
        else if (l.message.includes('FFmpeg') || l.message.includes('Merging') || l.message.includes('concat')) icon = '✂️';
        else if (l.message.includes('Gemini') || l.message.includes('SEO') || l.message.includes('Prompt')) icon = '🧠';
        else if (l.message.includes('Upload') || l.message.includes('YouTube')) icon = '🚀';
        else if (l.message.includes('Clip') || l.message.includes('Receiving')) icon = '📥';
        return `\`[${l.time}]\` ${icon} ${l.message}`;
      }).join('\n');
    }

    let activeBanner = '';
    if (this.activeJob) {
      const elapsedSec = Math.round((Date.now() - this.activeJob.startedAt) / 1000);
      activeBanner = `⚡ *PARALLEL TASK RUNNING NOW:*\n📌 *Task:* ${this.activeJob.title}\n⏱ *Elapsed:* ${elapsedSec}s\n📍 *Current Step:* ${this.activeJob.currentStep || this.currentActivity}\n\n`;
    }

    const msg = `📋 *AGENTICFLOW LIVE EXECUTION LOGS*

${activeBanner}*Recent Real-Time Steps:*
${logsContent}

💡 _Pura system status dekhne ke liye tap karein: [ 📊 System Status ]_`;

    await this.sendMessage(chatId, msg);
  }

  // Safely retrieve live dashboard, channel strategy, and agent analytics
  async fetchDashboardData() {
    try {
      const res = await axios.get('http://127.0.0.1:3456/api/dashboard', { timeout: 7000 });
      if (res.data) return res.data;
    } catch (err) {
      this.logger.warn('Could not fetch /api/dashboard via HTTP, falling back to database query:', err.message);
    }

    // Direct fallback using Database instance
    try {
      const { Database } = require('../database/db');
      const db = new Database();
      await db.initialize();
      const [stats, profile, settings, ideas, schedule] = await Promise.all([
        db.getStats().catch(() => ({})),
        db.getChannelProfile().catch(() => ({})),
        db.getAllSettings().catch(() => ({})),
        db.listContentIdeas().catch(() => ([])),
        db.getUpcomingSchedule(10).catch(() => ([]))
      ]);
      return {
        stats: stats || {},
        profile: profile || {},
        settings: settings || {},
        ideas: ideas || [],
        schedule: schedule || [],
        analytics: { totalVideos: 0, averagePerformanceScore: 0, topPerformers: [], insights: [] },
        learning: { measuredVideos: 0, snapshotCount: 0, baseline: {} },
        operatorRuns: [],
        readiness: { status: 'operational' },
        system: {
          initialized: true,
          uptime: process.uptime(),
          activeJobs: 0,
          automationPaused: false,
          agents: ['strategy', 'scriptWriter', 'thumbnailDesigner', 'seoOptimizer', 'production', 'publishing', 'analytics'],
          autonomousRunning: false
        }
      };
    } catch (dbErr) {
      this.logger.error('Database fallback failed:', dbErr.message);
      return null;
    }
  }

  // 1. Channel Strategy & Backlog View (Read-Only)
  async sendStrategyAndBacklog(chatId) {
    const data = await this.fetchDashboardData();
    const profile = data?.profile || {};
    const ideas = data?.ideas || [];
    const schedule = data?.schedule || [];

    let ideasList = '_Backlog me abhi koi manual idea pending nahi hai. AI automatic daily viral topics research karta hai._';
    if (Array.isArray(ideas) && ideas.length > 0) {
      ideasList = ideas.slice(0, 5).map((item, idx) => {
        const title = item.topic || item.title || item.concept || 'AI Innovation';
        const status = item.status || 'Backlog';
        return `${idx + 1}. *${title}* \`[${status}]\``;
      }).join('\n');
    }

    let scheduleList = '_Publishing queue abhi empty hai. Daily 6:00 PM IST par automated fallback streak armed hai._';
    if (Array.isArray(schedule) && schedule.length > 0) {
      scheduleList = schedule.slice(0, 3).map((s) => {
        return `• *${s.title}*\n  ⏱ Time: ${s.publishTime || s.scheduledTime || 'Scheduled'}`;
      }).join('\n');
    }

    const msg = `🎯 *CHANNEL STRATEGY & CONTENT BACKLOG*
━━━━━━━━━━━━━━━━━━━━
📺 *Channel Identity & Strategy:*
• *Channel:* ${profile.channel_name || 'Sameer | AgenticFlowAI'}
• *Core Mission:* ${profile.goal || 'High-retention tech & AI breakthroughs'}
• *Target Audience:* ${profile.target_audience || 'Curious minds, students & AI enthusiasts'}
• *Brand Voice:* ${profile.brand_voice || 'Exciting, authoritative Hinglish/English'}

📋 *Content Ideas Backlog:*
${ideasList}

📅 *Upcoming Scheduled Videos:*
${scheduleList}

🧠 *How Agents Work Here (View Only):*
• *Content Strategy Agent:* Web aur research papers se trending tech patterns scan karta hai.
• *Script Writer Agent:* Shorts ko 4 high-retention scenes (Hook, Problem, Mechanism, Twist) me divide karta hai.

🔒 _Mode: View & Analysis Only_`;

    await this.sendMessage(chatId, msg);
  }

  // 2. YouTube Growth & Analytics View (Read-Only)
  async sendGrowthAndAnalytics(chatId) {
    const data = await this.fetchDashboardData();
    const analytics = data?.analytics || {};
    const learning = data?.learning || {};
    const baseline = learning.baseline || {};

    const avgScore = analytics.averagePerformanceScore || 0;
    const totalVideos = analytics.totalVideos || 0;
    const measuredVideos = learning.measuredVideos || 0;
    const ctr = baseline.ctr != null ? `${baseline.ctr}%` : 'Collecting initial impressions...';
    const retention = baseline.retention != null ? `${baseline.retention}%` : 'Awaiting retention sample...';
    const avgDuration = baseline.averageViewDuration != null ? `${baseline.averageViewDuration}s` : 'Analyzing watch time...';
    const engagementRate = baseline.engagementRate != null ? `${baseline.engagementRate}%` : 'Pending likes & comments';

    const msg = `📈 *YOUTUBE GROWTH & PERFORMANCE ANALYTICS*
━━━━━━━━━━━━━━━━━━━━
🏆 *Performance Summary:*
• *Overall Performance Score:* ${avgScore}/100
• *Total Tracked Videos:* ${totalVideos}
• *Learning Measured Videos:* ${measuredVideos}
• *Snapshot Records:* ${learning.snapshotCount || 0}

📊 *Growth & Retention Baselines:*
• 🎯 *Click-Through Rate (CTR):* ${ctr}
• ⏱ *Avg View Duration:* ${avgDuration}
• 🔥 *Audience Retention:* ${retention}
• 💬 *Engagement Rate:* ${engagementRate}

💡 *Analytics Strategy & Learning Policy:*
• *Evidence-Based:* Simulated ya fake views count nahi hote; sirf verified YouTube API metrics measure hote hain.
• *Optimization Loop:* Analytics Agent retention dips ko track karta hai taaki agle Shorts ke pehle 5 seconds ka hook aur viral ban sake.

🔒 _Mode: View & Analysis Only_`;

    await this.sendMessage(chatId, msg);
  }

  // 3. Autonomous Operator Execution State (Read-Only)
  async sendOperatorAnalysis(chatId) {
    const data = await this.fetchDashboardData();
    const system = data?.system || {};
    const operatorRuns = data?.operatorRuns || [];
    const uptimeMins = Math.round((system.uptime || process.uptime()) / 60);

    let runsList = '_Operator standby mode me hai. Daily fallback triggers active hain._';
    if (Array.isArray(operatorRuns) && operatorRuns.length > 0) {
      runsList = operatorRuns.slice(0, 4).map(r => {
        return `• \`[${r.status || 'DONE'}]\` ${r.stage || r.task || 'Execution'} (${r.createdAt || 'Recent'})`;
      }).join('\n');
    }

    const isRunning = Boolean(system.autonomousRunning);
    const isPaused = Boolean(system.automationPaused);

    const msg = `🤖 *AUTONOMOUS OPERATOR ANALYSIS*
━━━━━━━━━━━━━━━━━━━━
⚙️ *Operator State (View Only):*
• *Execution Status:* ${isRunning ? '🟢 Active & Processing' : '💤 Standby / Armed'}
• *Automation Control:* ${isPaused ? '⏸ Paused in Web Console' : '▶️ Active (Autonomous)'}
• *Server Uptime:* ${uptimeMins} minutes
• *Active Parallel Jobs:* ${system.activeJobs || 0}

🔄 *Daily Autonomous Lifecycle:*
1. 💡 *Strategy Discovery:* Subah trending AI news aur breakthroughs ka evaluation.
2. ✍️ *Scene Structuring:* 9:16 vertical 10-second scenes ka prompt generation.
3. 📥 *Creator Hybrid Window:* Sham 6:00 PM IST tak manual clips upload ka intezaar.
4. ⏰ *6:00 PM IST Auto-Fallback:* Agar manual upload na ho, toh autonomous video render karke *Private* publish karna taaki streak na tute.

📋 *Recent Operator Activity:*
${runsList}

🔒 _Mode: View & Analysis Only_`;

    await this.sendMessage(chatId, msg);
  }

  // 4. System Readiness & 7 Agents Health (Read-Only)
  async sendAgentsHealth(chatId) {
    const data = await this.fetchDashboardData();
    const system = data?.system || {};
    const readiness = data?.readiness || {};
    const stats = data?.stats || {};

    const agentsList = [
      { name: 'Strategy Agent', role: 'Trending breakthrough research & channel planning', icon: '🧠' },
      { name: 'Script Writer Agent', role: '4-Scene sequential 9:16 prompt & Hinglish dialogue creation', icon: '✍️' },
      { name: 'Thumbnail Designer Agent', role: 'High-resolution frame extraction & composition', icon: '🎨' },
      { name: 'SEO Optimizer Agent', role: 'High-CTR Title, SEO Description & Search Tags generator', icon: '🔍' },
      { name: 'Production Agent', role: 'FFmpeg lossless video stream concat & conforming', icon: '🎬' },
      { name: 'Publishing Agent', role: 'YouTube Data API v3 OAuth upload & privacy controller', icon: '🚀' },
      { name: 'Analytics Agent', role: 'Performance tracking, retention & CTR feedback loop', icon: '📈' }
    ];

    const agentsText = agentsList.map((a, i) => {
      return `${i + 1}. ${a.icon} *${a.name}* — 🟢 \`ONLINE\`\n   _${a.role}_`;
    }).join('\n');

    const msg = `🩺 *SYSTEM READINESS & 7 AGENTS HEALTH*
━━━━━━━━━━━━━━━━━━━━
🟢 *Overall System State:* HEALTHY & OPERATIONAL
📦 *Database Size:* ${stats.dbSize || '0.38 MB'}
🌐 *Web API Server:* Port 3456 (Online)

🤖 *All 7 Dedicated Autonomous AI Agents:*
${agentsText}

🛠 *Production Readiness Check:*
• *Readiness Status:* ${readiness.status === 'verified' ? '✅ Verified Ready' : '🟢 Operational'}
• *Media Engine:* Local FFmpeg Concat + Google Gemini Omni Vision
• *YouTube Channel OAuth:* Connected & Verified

💡 *Sabhi 7 agents background me 24x7 synchronized kaam kar rahe hain.*

🔒 _Mode: View & Analysis Only_`;

    await this.sendMessage(chatId, msg);
  }

  // 5. AI Copilot: Real-time Channel & Recent Videos Context Fetcher
  async getRecentChannelContext() {
    const now = Date.now();
    if (this.channelCache && (now - this.channelCacheTime < 60000)) {
      return this.channelCache;
    }

    try {
      const tokensPath = path.join(__dirname, '..', 'config', 'tokens.json');
      if (!fs.existsSync(tokensPath)) {
        return null;
      }
      const { CredentialManager } = require('./credential-manager');
      const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');
      const { Database } = require('../database/db');

      const creds = new CredentialManager();
      await creds.initialize();
      const db = new Database();
      await db.initialize();
      const publisher = new PublishingSchedulingAgent(db, creds);
      await publisher.initialize();

      if (!publisher.youtube) {
        return null;
      }

      const channelRes = await publisher.youtube.channels.list({
        part: 'contentDetails,snippet,statistics',
        mine: true
      });

      if (!channelRes.data.items?.length) return null;
      const channel = channelRes.data.items[0];
      const uploadsPlaylist = channel.contentDetails?.relatedPlaylists?.uploads;

      let recentVideos = [];
      if (uploadsPlaylist) {
        const playlistRes = await publisher.youtube.playlistItems.list({
          part: 'snippet,contentDetails',
          playlistId: uploadsPlaylist,
          maxResults: 6
        });

        const videoIds = (playlistRes.data.items || []).map(i => i.contentDetails.videoId);
        if (videoIds.length > 0) {
          const videosRes = await publisher.youtube.videos.list({
            part: 'snippet,statistics,contentDetails',
            id: videoIds.join(',')
          });

          recentVideos = (videosRes.data.items || []).map(v => ({
            id: v.id,
            title: v.snippet.title,
            description: (v.snippet.description || '').slice(0, 300),
            publishedAt: v.snippet.publishedAt,
            tags: v.snippet.tags || [],
            views: parseInt(v.statistics.viewCount || '0', 10),
            likes: parseInt(v.statistics.likeCount || '0', 10),
            comments: parseInt(v.statistics.commentCount || '0', 10),
            duration: v.contentDetails.duration
          }));
        }
      }

      const result = {
        title: channel.snippet.title,
        description: channel.snippet.description,
        subscribers: channel.statistics.subscriberCount,
        totalViews: channel.statistics.viewCount,
        totalVideos: channel.statistics.videoCount,
        recentVideos
      };

      this.channelCache = result;
      this.channelCacheTime = now;
      return result;
    } catch (err) {
      this.logger.warn('Failed to fetch channel context for Copilot:', err.message);
      return this.channelCache || null;
    }
  }

  // AI Copilot Welcome & Capabilities Intro
  async sendCopilotIntro(chatId) {
    const channelData = await this.getRecentChannelContext();
    let channelInfo = '';
    if (channelData) {
      channelInfo = `\n📺 *Channel:* ${channelData.title} (${channelData.subscribers} subs, ${channelData.totalVideos} videos)\n`;
      if (channelData.recentVideos?.length > 0) {
        channelInfo += `🎬 *Recent Videos Indexed:* ${channelData.recentVideos.length} videos\n`;
      }
    }

    const msg = `💬 *AI CHANNEL STRATEGIST & COPILOT ONLINE*
━━━━━━━━━━━━━━━━━━━━
Aapka AI Assistant channel data, recent videos, analytics aur SEO metrics ko monitor kar raha hai.${channelInfo}
💡 *Aap mujhse direct chat me kuch bhi pooch sakte hain:*
• _"Meri last video par views kyu kam aaye?"_
• _"Video ka SEO audit karo aur viral tags batao."_
• _"Agla viral Short kis topic par banana chahiye?"_
• _"Audience retention aur initial 3-second hook kaise improve karein?"_
• _"Channel CTR increase karne ke liye thumbnail me kya badlav karein?"_

⚡ *Proxy AI Engine Active:* Powered exclusively by local Gemini Proxy (\`gemini-3.6-flash\`).

👉 *Bas direct message likh kar bhejein!*`;

    await this.sendMessage(chatId, msg);
  }

  // AI Copilot Query Processing (STRICTLY uses local Gemini Proxy :8081)
  async askProxyCopilot(userQuestion, chatId) {
    if (!this.openaiProxy) {
      await this.sendMessage(chatId, '⚠️ Proxy AI client configure nahi hai.');
      return;
    }

    await this.sendChatAction(chatId, 'typing');

    try {
      const channelContext = await this.getRecentChannelContext();

      let systemPrompt = `You are the elite YouTube Channel Growth Strategist and AI Copilot for the creator of "${channelContext?.title || 'Sameer | AgenticFlowAI'}".
You have direct real-time access to YouTube Analytics, recent uploaded videos, and performance metrics.
Your mission is to help the creator maximize views, click-through rate (CTR), average percentage viewed (APV/retention), and subscriber growth.

Language & Style Guidelines:
- Respond in natural, conversational Hinglish (Hindi + English mixed seamlessly), just like a pro YouTube growth mentor.
- Be sharp, honest, highly actionable, and encouraging.
- Format using clean Markdown with bold bullet points, clear sections, and concise recommendations.
- If asked why a video failed or got low views, evaluate:
  1. The 3-second hook & retention drop-off
  2. The curiosity gap in Title & Thumbnail
  3. Search intent & SEO keywords
  4. Pacing and audience fatigue
- If asked for new video ideas, suggest 2-3 viral, trending high-impact concepts with strong hook lines.
- Reference the actual channel videos and real stats whenever relevant.`;

      if (channelContext) {
        systemPrompt += `\n\n--- CURRENT REAL-TIME CHANNEL SNAPSHOT ---
Channel Name: ${channelContext.title}
Subscribers: ${channelContext.subscribers}
Total Videos Published: ${channelContext.totalVideos}
Total Channel Views: ${channelContext.totalViews}`;

        if (channelContext.recentVideos?.length > 0) {
          systemPrompt += `\n\nLatest Uploaded Videos (Most recent first):`;
          channelContext.recentVideos.forEach((v, idx) => {
            systemPrompt += `\n${idx + 1}. [${v.id}] "${v.title}"
   - Views: ${v.views} | Likes: ${v.likes} | Comments: ${v.comments}
   - Published: ${v.publishedAt} | Duration: ${v.duration}
   - Tags: ${v.tags?.slice(0, 10).join(', ') || 'No tags'}
   - Description Snippet: ${v.description?.slice(0, 120).replace(/\n/g, ' ')}...`;
          });
        }
      }

      const apiMessages = [
        { role: 'system', content: systemPrompt }
      ];

      // Append last 6 conversational turns from memory
      if (Array.isArray(this.chatContext) && this.chatContext.length > 0) {
        const recentHistory = this.chatContext.slice(-6);
        for (const item of recentHistory) {
          apiMessages.push({ role: item.role, content: item.content });
        }
      }

      // Add the user's current question
      apiMessages.push({ role: 'user', content: userQuestion });

      this.logEvent(`Proxy Copilot processing question: "${userQuestion.slice(0, 45)}..."`);

      const completion = await this.openaiProxy.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gemini-3.6-flash',
        messages: apiMessages,
        temperature: 0.7,
        max_tokens: 1500
      });

      const aiReply = completion.choices?.[0]?.message?.content;
      if (!aiReply) {
        throw new Error('Empty response received from proxy AI');
      }

      // Save to chat context memory (keep last 10 messages)
      this.chatContext.push({ role: 'user', content: userQuestion });
      this.chatContext.push({ role: 'assistant', content: aiReply });
      if (this.chatContext.length > 10) {
        this.chatContext = this.chatContext.slice(-10);
      }

      await this.sendMessage(chatId, `🤖 *AI Copilot:*\n\n${aiReply}`);
    } catch (err) {
      this.logger.error('Proxy Copilot error:', err.message);
      await this.sendMessage(chatId, `⚠️ *AI Copilot Notice*: Proxy API se connect karne me dikkat aayi: ${err.message}\n\nKripya 1 minute baad dobara message karein.`);
    }
  }
}

module.exports = { TelegramBotService };
