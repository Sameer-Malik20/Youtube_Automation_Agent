const { chromium } = require('playwright');
const path = require('path');

async function launchLoginBrowser() {
  const profileDir = path.join(__dirname, '..', 'data', 'gemini_browser_profile');
  console.log('=====================================================');
  console.log('🌐 LAUNCHING INTERACTIVE GOOGLE PRO BROWSER SESSION');
  console.log('Profile storage directory:', profileDir);
  console.log('=====================================================');

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 850 },
    channel: 'chrome',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--start-maximized'
    ]
  }).catch(async () => {
    return chromium.launchPersistentContext(profileDir, {
      headless: false,
      viewport: { width: 1280, height: 850 },
      args: ['--disable-blink-features=AutomationControlled']
    });
  });

  const page = context.pages()[0] || await context.newPage();
  
  console.log('Opening Google Sign-In directly for your Pro account (sam965309@gmail.com)...');
  const targetUrl = 'https://accounts.google.com/AccountChooser?Email=sam965309@gmail.com&continue=https%3A%2F%2Fgemini.google.com%2Fapp';
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

  console.log('\n👉 ACTION REQUIRED:');
  console.log('1. Jo Chrome window abhi open hui hai, wahan apna password enter kijiye.');
  console.log('2. Phone par 2FA aane par verify kijiye.');
  console.log('3. Jaise hi Gemini dashboard khulega, yeh script automatically detect karke session save kar dega!\n');
  console.log('⏳ Waiting for you to finish sign-in in the opened browser window...');

  // Automatically poll until the user is logged in (Sign in button disappears and user avatar/account appears)
  let loggedIn = false;
  while (!loggedIn) {
    await page.waitForTimeout(3000);
    try {
      // Check if "Sign in" button still exists
      const signInBtn = await page.$('a[href*="accounts.google.com"], button:has-text("Sign in")');
      const avatar = await page.$('img[alt*="Google Account"], [aria-label*="Google Account"], a[href*="SignOutOptions"]');
      const chatArea = await page.$('rich-textarea, [contenteditable="true"]');

      if (!signInBtn && (avatar || chatArea)) {
        loggedIn = true;
        console.log('\n🎉 SUCCESS! Login detect ho gaya hai!');
      } else {
        process.stdout.write('.');
      }
    } catch (_e) {
      // Ignore navigation frame drops during login
    }
  }

  console.log('\nSaving persistent session...');
  await page.waitForTimeout(4000); // Allow cookies to settle
  await context.close();
  console.log('✅ Google Pro session is now permanently saved in data/gemini_browser_profile!');
}

launchLoginBrowser().catch(err => {
  console.error('Browser session launch error:', err);
  process.exit(1);
});
