const { chromium } = require('playwright');
const path = require('path');
const fsp = require('fs').promises;

async function generateVideoOnGeminiWeb(promptText, outputFilename) {
  const profileDir = path.join(__dirname, '..', 'data', 'gemini_browser_profile');
  const tempDir = path.join(__dirname, '..', 'temp');
  await fsp.mkdir(tempDir, { recursive: true });
  const outputPath = path.join(tempDir, outputFilename || `gemini_fresh_${Date.now()}.mp4`);

  console.log('=====================================================');
  console.log('🤖 GENERATING VIDEO DIRECTLY ON GEMINI WEB');
  console.log('Prompt:', promptText);
  console.log('Output Path:', outputPath);
  console.log('=====================================================');

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false, // Visible so user can see Gemini thinking & generating
    viewport: { width: 1280, height: 850 },
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled']
  }).catch(async () => {
    return chromium.launchPersistentContext(profileDir, {
      headless: false,
      viewport: { width: 1280, height: 850 },
      args: ['--disable-blink-features=AutomationControlled']
    });
  });

  const page = context.pages()[0] || await context.newPage();

  console.log('Navigating to Gemini Web App...');
  await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Check login
  const signInBtn = await page.$('a[href*="accounts.google.com"], button:has-text("Sign in")');
  if (signInBtn) {
    console.error('❌ ERROR: User is not logged in! Please run `node scripts/login-gemini-browser.js` first.');
    await context.close();
    process.exit(1);
  }

  console.log('Locating chat input box...');
  const inputSelector = 'rich-textarea p, rich-textarea, [contenteditable="true"]';
  await page.waitForSelector(inputSelector, { timeout: 15000 });

  console.log('Typing prompt...');
  await page.click(inputSelector);
  await page.keyboard.type(promptText, { delay: 20 });
  await page.waitForTimeout(1000);

  console.log('Sending prompt to Gemini...');
  await page.keyboard.press('Enter');

  console.log('⏳ Waiting for Gemini to generate the video (this typically takes 60-120 seconds)...');

  // Monitor for generated video element or download button
  let videoFound = false;
  const startTime = Date.now();
  const maxWaitMs = 180000; // 3 minutes max

  while (!videoFound && Date.now() - startTime < maxWaitMs) {
    await page.waitForTimeout(5000);
    process.stdout.write('.');

    // Check if video element is present
    const videoElement = await page.$('video, video source, [data-test-id*="video"]');
    if (videoElement) {
      console.log('\n🎉 Video element detected in Gemini response!');
      videoFound = true;
      break;
    }

    // Also check for any download button
    const downloadBtn = await page.$('button[aria-label*="Download"], a[download]');
    if (downloadBtn) {
      console.log('\n🎉 Download button detected!');
      videoFound = true;
      break;
    }
  }

  if (!videoFound) {
    console.log('\nTaking snapshot of Gemini response...');
    await page.screenshot({ path: path.join(tempDir, 'gemini_response_snapshot.png') });
    console.log('Snapshot saved. Gemini may still be generating or returned text.');
  } else {
    // Attempt download
    console.log('Capturing video stream...');
    await page.waitForTimeout(5000);
    const videoSrc = await page.evaluate(() => {
      const v = document.querySelector('video');
      return v ? (v.src || v.querySelector('source')?.src) : null;
    });

    if (videoSrc && videoSrc.startsWith('http')) {
      const axios = require('axios');
      const response = await axios({ method: 'get', url: videoSrc, responseType: 'arraybuffer' });
      await fsp.writeFile(outputPath, Buffer.from(response.data));
      console.log('✅ Video downloaded successfully to:', outputPath);
    } else {
      console.log('Video element present. Taking final snapshot...');
      await page.screenshot({ path: path.join(tempDir, 'gemini_video_ready.png') });
    }
  }

  await context.close();
  return outputPath;
}

const prompt = process.argv[2] || 'Generate a short video: A glowing 3D holographic human brain with neural connections, futuristic, 4k cinematic';
generateVideoOnGeminiWeb(prompt).catch(err => {
  console.error('Error during web video generation:', err);
  process.exit(1);
});
