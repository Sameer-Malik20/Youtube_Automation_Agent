const { chromium } = require('playwright');
const path = require('path');
const fsp = require('fs').promises;
const fs = require('fs');
const { GeminiProfileManager } = require('../utils/gemini-profile-manager');

const manager = new GeminiProfileManager();

async function importSession(profileKey, cookieOrStateFilePath) {
  const profile = manager.profiles[profileKey];
  if (!profile) {
    console.error(`❌ Invalid profile: ${profileKey}. Use "profile_1" or "profile_2"`);
    return false;
  }

  if (!fs.existsSync(cookieOrStateFilePath)) {
    console.error(`❌ File not found: ${cookieOrStateFilePath}`);
    return false;
  }

  console.log(`📥 Importing session into ${profile.name} from ${cookieOrStateFilePath}...`);
  const rawData = await fsp.readFile(cookieOrStateFilePath, 'utf8');
  let data;
  try {
    data = JSON.parse(rawData);
  } catch (e) {
    console.error('❌ Invalid JSON in file:', e.message);
    return false;
  }

  const context = await chromium.launchPersistentContext(profile.dir, {
    headless: true,
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    if (Array.isArray(data)) {
      // Standard Cookie-Editor exported array of cookies
      const cookiesToSet = data.map(c => {
        const item = {
          name: c.name,
          value: c.value,
          domain: c.domain.startsWith('.') ? c.domain : `.${c.domain}`,
          path: c.path || '/'
        };
        if (c.sameSite) {
          const s = c.sameSite.toLowerCase();
          if (s === 'no_restriction' || s === 'none') item.sameSite = 'None';
          else if (s === 'lax') item.sameSite = 'Lax';
          else if (s === 'strict') item.sameSite = 'Strict';
        }
        if (c.secure !== undefined) item.secure = Boolean(c.secure);
        if (c.httpOnly !== undefined) item.httpOnly = Boolean(c.httpOnly);
        return item;
      });
      await context.addCookies(cookiesToSet);
      console.log(`✅ Loaded ${cookiesToSet.length} cookies into browser context.`);
    } else if (data.cookies) {
      // Playwright storageState JSON
      await context.addCookies(data.cookies);
      console.log(`✅ Loaded ${data.cookies.length} cookies from Playwright storage state.`);
    }

    const page = await context.newPage();
    console.log('Navigating to Gemini to verify imported session...');
    await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    const hasSignIn = await page.$('a[href*="accounts.google.com"], button:has-text("Sign in")');
    const hasInput = await page.$('rich-textarea, [contenteditable="true"], .input-area');

    if (!hasSignIn && hasInput) {
      console.log(`🎉 SUCCESS: ${profile.name} is successfully authenticated via imported session!`);
      manager.setLoginStatus(profileKey, true);
    } else {
      console.log('⚠️ Could not verify login. The cookies might be expired or incomplete.');
    }
  } finally {
    await context.close();
  }
}

const profileArg = process.argv[2] || 'profile_1';
const fileArg = process.argv[3];

if (!fileArg) {
  console.log('Usage: node scripts/import-gemini-session.js <profile_1|profile_2> <path_to_cookies.json>');
  process.exit(1);
}

importSession(profileArg, fileArg).catch(err => {
  console.error('Import error:', err);
  process.exit(1);
});
