const { chromium } = require('playwright');
const path = require('path');
const fsp = require('fs').promises;
const fs = require('fs');
const axios = require('axios');
const { GeminiProfileManager } = require('./gemini-profile-manager');

class GeminiWebVideoGenerator {
  constructor(options = {}) {
    this.profileManager = new GeminiProfileManager();
    this.outputDir = options.outputDir || path.join(__dirname, '..', 'data', 'telegram_staging');
    this.tempDir = path.join(__dirname, '..', 'temp');
    this.onProgress = options.onProgress || (() => {});
  }

  async ensureDirs() {
    await fsp.mkdir(this.outputDir, { recursive: true });
    await fsp.mkdir(this.tempDir, { recursive: true });
  }

  /**
   * Launch a persistent headless browser context for a specific profile
   */
  async launchBrowser(profileKey) {
    const profileDir = this.profileManager.getProfileDir(profileKey);

    const context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      viewport: { width: 1280, height: 800 },
      executablePath: '/usr/bin/google-chrome',
      acceptDownloads: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--headless=new'
      ],
      ignoreDefaultArgs: ['--enable-automation']
    });

    return context;
  }

  /**
   * Download generated video from the Gemini page reliably
   */
  async downloadVideoFromPage(page, clipIndex) {
    let downloadedPath = null;
    const filename = `clip_${clipIndex}_${Date.now()}.mp4`;
    const targetFile = path.join(this.outputDir, filename);

    // Method 1: Direct authenticated request using context.request from <video> element src
    try {
      const videoSrc = await page.evaluate(() => {
        const videos = Array.from(document.querySelectorAll('video'));
        if (videos.length === 0) return null;
        const last = videos[videos.length - 1];
        return last.src || last.currentSrc || last.querySelector('source')?.src || null;
      });

      if (videoSrc && videoSrc.startsWith('http')) {
        console.log(`🌐 Found direct video stream URL: ${videoSrc.substring(0, 80)}...`);
        const context = page.context();
        const response = await context.request.get(videoSrc, { timeout: 60000 });
        if (response.ok()) {
          const buffer = await response.body();
          if (buffer.length > 50000) {
            await fsp.writeFile(targetFile, buffer);
            console.log(`✅ Saved video via direct stream request: ${targetFile} (${buffer.length} bytes)`);
            downloadedPath = targetFile;
          }
        }
      } else if (videoSrc && videoSrc.startsWith('blob:')) {
        console.log('🌐 Found blob video URL, converting in page context...');
        const base64Data = await page.evaluate(async (blobUrl) => {
          const res = await fetch(blobUrl);
          const blob = await res.blob();
          return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        }, videoSrc);

        if (base64Data && base64Data.includes(',')) {
          const base64Buffer = Buffer.from(base64Data.split(',')[1], 'base64');
          if (base64Buffer.length > 50000) {
            await fsp.writeFile(targetFile, base64Buffer);
            console.log(`✅ Saved video from blob data: ${targetFile} (${base64Buffer.length} bytes)`);
            downloadedPath = targetFile;
          }
        }
      }
    } catch (directErr) {
      console.warn(`   Direct video download attempt note: ${directErr.message}`);
    }

    // Method 2: Click download button with Playwright download event listener (if Method 1 didn't complete)
    if (!downloadedPath || !fs.existsSync(downloadedPath) || fs.statSync(downloadedPath).size < 10000) {
      try {
        const downloadButtons = await page.$$('button[aria-label*="Download"], a[download]');
        if (downloadButtons.length > 0) {
          const targetBtn = downloadButtons[downloadButtons.length - 1];
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 30000 }),
            targetBtn.click()
          ]);
          await download.saveAs(targetFile);
          if (fs.existsSync(targetFile) && fs.statSync(targetFile).size > 10000) {
            console.log(`✅ Saved downloaded clip via button click to: ${targetFile}`);
            downloadedPath = targetFile;
          }
        }
      } catch (btnErr) {
        console.warn(`   Download button click note: ${btnErr.message}`);
      }
    }

    if (downloadedPath && fs.existsSync(downloadedPath) && fs.statSync(downloadedPath).size > 10000) {
      const stats = fs.statSync(downloadedPath);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      console.log(`🎉 Scene ${clipIndex} successfully ready (${sizeMB} MB)!`);
      return { success: true, filePath: downloadedPath, sizeMB };
    }

    return { success: false, error: 'Could not extract valid MP4 from video element' };
  }

  /**
   * Dismiss common Gemini modals / overlays
   */
  async dismissModals(page) {
    try {
      const modalBtn = await page.$('button[aria-label*="Close"], button:has-text("Continue"), button:has-text("Dismiss"), button:has-text("Got it"), button:has-text("Use without content apps")');
      if (modalBtn) {
        await modalBtn.click().catch(() => {});
        await page.waitForTimeout(1000);
      }
    } catch (_) {}
  }

  /**
   * Ensure Video Generation Mode is active and Aspect Ratio is set to Portrait (9:16)
   */
  async ensureVideoAndPortraitMode(page) {
    try {
      console.log('🎬 Ensuring Video Mode & Portrait aspect ratio...');
      await this.dismissModals(page);

      // Check if we are already on /videos or have Videos tool active
      const currentUrl = page.url();
      let hasVideosTool = await page.evaluate(() => {
        const hasDeselectVideos = !!document.querySelector('[aria-label="Deselect Videos"]');
        const hasAspect = !!document.querySelector('button[aria-label*="Aspect ratio"]');
        return hasDeselectVideos || hasAspect;
      });

      if (!hasVideosTool && !currentUrl.includes('/videos')) {
        console.log('Video mode not active, checking Upload and tools...');
        const toolsBtn = await page.$('button[aria-label*="Upload and tools"], button[aria-label*="tools"], button:has-text("+")');
        let selectedViaMenu = false;
        if (toolsBtn) {
          await toolsBtn.click().catch(() => {});
          await page.waitForTimeout(1000);
          const createVideoBtn = await page.$('button:has-text("Create video"), [role="menuitem"]:has-text("Create video"), mat-list-item:has-text("Create video")');
          if (createVideoBtn) {
            await createVideoBtn.click().catch(() => {});
            await page.waitForTimeout(1500);
            selectedViaMenu = true;
          }
        }

        if (!selectedViaMenu) {
          console.log('Navigating directly to https://gemini.google.com/videos for dedicated video mode...');
          await page.goto('https://gemini.google.com/videos', { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(2500);
          await this.dismissModals(page);
        }
      }

      // Ensure Aspect Ratio is Portrait (9:16)
      const aspectBtn = await page.waitForSelector('button[aria-label*="Aspect ratio"], button:has-text("Landscape"), button:has-text("Portrait")', { timeout: 8000 }).catch(() => null);

      if (aspectBtn) {
        const aspectText = await page.evaluate((el) => {
          return ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
        }, aspectBtn);

        console.log(`Current Aspect Ratio: ${aspectText.trim()}`);

        if (!aspectText.includes('portrait')) {
          console.log('Switching Aspect Ratio to Portrait (9:16)...');
          await aspectBtn.click().catch(() => {});
          await page.waitForTimeout(1000);

          const portraitClicked = await page.evaluate(() => {
            const all = Array.from(document.querySelectorAll('*'));
            const target = all.find(el => 
              (el.getAttribute('aria-label') === 'Portrait (9:16)' || 
               el.textContent?.trim() === 'Portrait (9:16)' || 
               el.textContent?.trim() === 'Portrait') && 
              el.offsetParent !== null
            );
            if (target) {
              target.click();
              return true;
            }
            return false;
          });

          if (!portraitClicked) {
            const portraitOption = await page.$('text="Portrait (9:16)", [aria-label="Portrait (9:16)"]');
            if (portraitOption) await portraitOption.click().catch(() => {});
          }

          await page.waitForTimeout(1000);
          console.log('✅ Portrait (9:16) aspect ratio successfully selected.');
        } else {
          console.log('✅ Portrait (9:16) is already active.');
        }
      } else {
        console.warn('⚠️ Aspect ratio selector button not found, proceeding with prompt.');
      }
    } catch (err) {
      console.warn(`Video & Portrait mode configuration note: ${err.message}`);
    }
  }

  /**
   * Start a clean fresh chat session
   */
  async startFreshChat(page) {
    console.log('Initiating fresh chat session...');
    const newChatBtn = await page.$('button:has-text("New chat"), a:has-text("New chat"), [aria-label*="New chat"]');
    if (newChatBtn) {
      await newChatBtn.click().catch(() => {});
      await page.waitForTimeout(2000);
    } else {
      await page.goto('https://gemini.google.com/videos', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
    }
    await this.dismissModals(page);
    await this.ensureVideoAndPortraitMode(page);
  }

  /**
   * Send a single video generation prompt and wait for video output
   */
  async submitPromptAndWaitForVideo(page, promptText, clipIndex = 1, timeoutMs = 240000) {
    try {
      console.log(`\n======================================================`);
      console.log(`🎬 Submitting Prompt for Scene ${clipIndex}:`);
      console.log(`   "${promptText.substring(0, 100)}..."`);
      console.log(`======================================================`);

      await this.dismissModals(page);
      await this.ensureVideoAndPortraitMode(page);

      let finalPrompt = promptText.trim();
      if (!finalPrompt.toLowerCase().includes('generate a video') && !finalPrompt.toLowerCase().includes('generate video') && !finalPrompt.toLowerCase().includes('create a video')) {
        finalPrompt = `Generate a video: ${finalPrompt}`;
      }

      const inputSelector = 'rich-textarea p, rich-textarea, [contenteditable="true"]';
      await page.waitForSelector(inputSelector, { timeout: 20000 });
      await page.click(inputSelector);
      await page.keyboard.type(finalPrompt, { delay: 15 });
      await page.waitForTimeout(500);

      // Click send or press Enter
      const sendBtn = await page.$('button[aria-label*="Send"], button[aria-label*="Submit"]');
      if (sendBtn) {
        await sendBtn.click().catch(async () => {
          await page.keyboard.press('Enter');
        });
      } else {
        await page.keyboard.press('Enter');
      }

      console.log('⏳ Waiting for Gemini video generation (typically 60-150 seconds)...');
      this.onProgress(`⏳ Scene ${clipIndex}: Gemini video generate kar raha hai...`);

      const startTime = Date.now();
      let videoCompleted = false;
      let quotaExceeded = false;
      let errorMessage = null;

      while (!videoCompleted && (Date.now() - startTime < timeoutMs)) {
        await page.waitForTimeout(5000);
        process.stdout.write('.');

        // Check for quota / error messages
        const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
        if (bodyText.includes('reached your limit') || bodyText.includes('daily limit') || bodyText.includes('try again tomorrow') || bodyText.includes('quota exceeded')) {
          console.log('\n⚠️ Quota limit detected on this account!');
          quotaExceeded = true;
          errorMessage = 'Daily video quota exceeded for this account.';
          break;
        }

        // Check if a video element or download button exists in the latest response
        const videoElements = await page.$$('video, video source').catch(() => []);
        const downloadButtons = await page.$$('button[aria-label*="Download"], a[download], [data-test-id*="download"]').catch(() => []);

        if (videoElements.length >= clipIndex || downloadButtons.length >= clipIndex) {
          console.log(`\n🎉 Scene ${clipIndex} video detected in response!`);
          videoCompleted = true;
          break;
        }

        // Dismiss any popups that might have appeared while waiting
        await this.dismissModals(page);
      }

      if (quotaExceeded) {
        return { success: false, quotaExceeded: true, error: errorMessage };
      }

      if (!videoCompleted) {
        const snapPath = path.join(this.tempDir, `scene_${clipIndex}_timeout.png`);
        await page.screenshot({ path: snapPath }).catch(() => {});
        console.log(`\n⚠️ Generation timed out for Scene ${clipIndex}. Snapshot saved: ${snapPath}`);
        return { success: false, quotaExceeded: false, error: 'Video generation timed out' };
      }

      // Download the video
      console.log(`📥 Downloading Scene ${clipIndex} video...`);
      this.onProgress(`📥 Scene ${clipIndex}: Video download ho rahi hai...`);

      await page.waitForTimeout(3000); // Allow video stream to finalize

      return await this.downloadVideoFromPage(page, clipIndex);
    } catch (err) {
      console.error(`\n❌ Error in submitPromptAndWaitForVideo (Scene ${clipIndex}):`, err.message);
      return { success: false, quotaExceeded: false, error: err.message };
    }
  }

  /**
   * Complete multi-scene video generation orchestrator across Account 1 and Account 2
   * @param {Array<string>} prompts - 4 sequential scene prompts
   * @returns {Promise<{ success: boolean, clips: Array<string>, totalGenerated: number }>}
   */
  async generateMultiAccountClips(prompts) {
    await this.ensureDirs();
    const results = [];
    let currentProfile = 'profile_1';
    let context = null;
    let page = null;

    try {
      console.log(`\n🚀 Launching Browser Context for [${currentProfile}]...`);
      this.onProgress(`🚀 Gemini Account 1 (${this.profileManager.profiles.profile_1.email}) connect ho raha hai...`);
      context = await this.launchBrowser(currentProfile);
      page = context.pages()[0] || await context.newPage();
      await page.goto('https://gemini.google.com/videos', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.dismissModals(page);
      await this.startFreshChat(page);

      for (let i = 0; i < prompts.length; i++) {
        const sceneIndex = i + 1;
        const promptText = prompts[i];

        let genResult = await this.submitPromptAndWaitForVideo(page, promptText, sceneIndex);

        // If Account 1 hit quota or failed and we have not switched to Account 2 yet
        if ((!genResult.success && genResult.quotaExceeded) || (sceneIndex === 4 && currentProfile === 'profile_1' && !genResult.success)) {
          console.log(`\n⚠️ Profile 1 reached limit or failed on Scene ${sceneIndex}. Switching to Account 2 (Profile 2)...`);
          this.onProgress(`⚠️ Account 1 limit complete. Ab Account 2 (Profile 2) se Scene ${sceneIndex} generate ho raha hai...`);

          this.profileManager.markQuotaExhausted(currentProfile);

          // Close Account 1
          await context.close().catch(() => {});
          context = null;

          // Switch to Account 2
          currentProfile = 'profile_2';
          context = await this.launchBrowser(currentProfile);
          page = context.pages()[0] || await context.newPage();
          await page.goto('https://gemini.google.com/videos', { waitUntil: 'domcontentloaded', timeout: 30000 });
          await this.dismissModals(page);
          await this.startFreshChat(page);

          // Retry the current scene on Account 2
          genResult = await this.submitPromptAndWaitForVideo(page, promptText, 1);
        }

        if (genResult.success) {
          results.push(genResult.filePath);
          this.profileManager.recordGeneration(currentProfile);
          this.onProgress(`✅ Scene ${sceneIndex} generate & save ho gaya (${genResult.sizeMB} MB)!`);
        } else {
          console.error(`❌ Scene ${sceneIndex} could not be generated: ${genResult.error}`);
          this.onProgress(`⚠️ Scene ${sceneIndex} skip hua: ${genResult.error}`);
        }
      }
    } finally {
      if (context) {
        await context.close().catch(() => {});
      }
    }

    return {
      success: results.length > 0,
      clips: results,
      totalGenerated: results.length
    };
  }
}

module.exports = { GeminiWebVideoGenerator };
