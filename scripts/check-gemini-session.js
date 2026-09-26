const { chromium } = require('playwright');
const path = require('path');
const fsp = require('fs').promises;

async function checkSession() {
  const profileDir = path.join(__dirname, '..', 'data', 'gemini_browser_profile');
  const tempDir = path.join(__dirname, '..', 'temp');
  await fsp.mkdir(tempDir, { recursive: true });

  console.log('Testing session in:', profileDir);

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [
      '--profile-directory=Profile 1',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const page = context.pages()[0] || await context.newPage();

  console.log('Navigating to gemini.google.com...');
  await page.goto('https://gemini.google.com/app', { waitUntil: 'networkidle', timeout: 30000 }).catch(async () => {
    console.log('Networkidle timed out, proceeding with current state...');
  });

  const title = await page.title();
  const url = page.url();
  console.log('Page Title:', title);
  console.log('Current URL:', url);

  const screenshotPath = path.join(tempDir, 'gemini_session_check.png');
  await page.screenshot({ path: screenshotPath });
  console.log('Screenshot saved to:', screenshotPath);

  // Check for chat input or sign-in button
  const hasInput = await page.$('rich-textarea, [contenteditable="true"], textarea, .input-area');
  const hasSignIn = await page.$('a[href*="accounts.google.com"], button:has-text("Sign in")');

  console.log('Has Chat Input Area:', Boolean(hasInput));
  console.log('Has Sign In Button:', Boolean(hasSignIn));

  await context.close();
}

checkSession().catch(err => {
  console.error('Session check failed:', err);
  process.exit(1);
});
