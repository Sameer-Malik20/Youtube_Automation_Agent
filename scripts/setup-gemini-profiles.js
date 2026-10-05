const { chromium } = require('playwright');
const path = require('path');
const net = require('net');
const { spawn, execSync } = require('child_process');
const { GeminiProfileManager } = require('../utils/gemini-profile-manager');

const manager = new GeminiProfileManager();

let xvfbProcess = null;
let openboxProcess = null;
let x11vncProcess = null;
let wsProcess = null;

function checkDisplay(display = ':99') {
  try {
    execSync(`xdpyinfo -display ${display}`, { stdio: 'ignore', timeout: 1000 });
    return true;
  } catch (_e) {
    return false;
  }
}

function checkPort(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const s = net.createConnection(port, host, () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    s.setTimeout(500, () => {
      s.destroy();
      resolve(false);
    });
  });
}

async function startVirtualDisplayAndVNC() {
  console.log('\n🖥️  Setting up Virtual Desktop and Web-VNC environment...');

  // 1. Ensure Xvfb display :99 is active
  if (!checkDisplay(':99')) {
    console.log('   Cleaning locks & starting Xvfb display on :99...');
    try {
      execSync('pkill -f "Xvfb :99" 2>/dev/null || true');
      execSync('rm -f /tmp/.X11-unix/X99 /tmp/.X99-lock');
    } catch (_) {}

    xvfbProcess = spawn('Xvfb', [':99', '-screen', '0', '1280x800x24', '-ac'], { stdio: 'ignore' });
    for (let i = 0; i < 25; i++) {
      if (checkDisplay(':99')) break;
      await new Promise(r => setTimeout(r, 200));
    }
  }

  if (!checkDisplay(':99')) {
    throw new Error('Could not initialize Xvfb on display :99');
  }
  console.log('   ✅ Xvfb virtual display (:99) is ready.');

  // 2. Openbox window manager
  openboxProcess = spawn('openbox', ['--display', ':99'], { stdio: 'ignore' });

  // 3. x11vnc on :99 (port 5900)
  if (!(await checkPort(5900))) {
    console.log('   Starting x11vnc server on port 5900...');
    x11vncProcess = spawn('x11vnc', ['-display', ':99', '-nopw', '-listen', '0.0.0.0', '-xkb', '-forever', '-shared'], { stdio: 'ignore' });
    for (let i = 0; i < 25; i++) {
      if (await checkPort(5900)) break;
      await new Promise(r => setTimeout(r, 200));
    }
  }
  console.log('   ✅ x11vnc server is ready.');

  // 4. websockify (noVNC) on port 6080
  if (!(await checkPort(6080))) {
    console.log('   Starting Web-VNC streaming proxy on port 6080...');
    wsProcess = spawn('websockify', ['--web', '/usr/share/novnc', '6080', 'localhost:5900'], { stdio: 'ignore' });
    for (let i = 0; i < 25; i++) {
      if (await checkPort(6080)) break;
      await new Promise(r => setTimeout(r, 200));
    }
  }
  console.log('   ✅ Web-VNC proxy is ready on port 6080.');
  console.log('✅ Display & Web-VNC bridge fully operational!\n');
}

function cleanupProcesses() {
  try { if (wsProcess) wsProcess.kill('SIGTERM'); } catch (_) {}
  try { if (x11vncProcess) x11vncProcess.kill('SIGTERM'); } catch (_) {}
  try { if (openboxProcess) openboxProcess.kill('SIGTERM'); } catch (_) {}
  try { if (xvfbProcess) xvfbProcess.kill('SIGTERM'); } catch (_) {}
}

process.on('SIGINT', () => {
  console.log('\nStopping setup...');
  cleanupProcesses();
  process.exit(0);
});

async function setupProfile(profileKey) {
  const profile = manager.profiles[profileKey];
  if (!profile) {
    console.error(`❌ Invalid profile: ${profileKey}. Use "profile_1" or "profile_2"`);
    return false;
  }

  console.log('================================================================');
  console.log(`🔑 INITIATING LOGIN SETUP FOR: [ ${profile.name.toUpperCase()} ]`);
  console.log(`📁 Profile directory: ${profile.dir}`);
  console.log('================================================================');

  await startVirtualDisplayAndVNC();

  console.log('🌐 Launching official Google Chrome in virtual desktop (:99)...');
  process.env.DISPLAY = ':99';

  const context = await chromium.launchPersistentContext(profile.dir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    executablePath: '/usr/bin/google-chrome',
    env: { ...process.env, DISPLAY: ':99' },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--display=:99',
      '--start-maximized'
    ],
    ignoreDefaultArgs: ['--enable-automation']
  });

  const page = context.pages()[0] || await context.newPage();

  console.log('Navigating to Google Sign-In / Gemini Web...');
  const targetUrl = 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2Fapp';
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' }).catch(err => {
    console.log('Navigation event notice:', err.message);
  });

  console.log('\n================================================================');
  console.log('👉 ACTION REQUIRED FROM YOU NOW:');
  console.log('1. Apne browser me ye link kholein:');
  console.log('   👉 http://161.97.80.178:6080/vnc.html');
  console.log('2. Web page par "Connect" button dabayein.');
  console.log('3. Screen par Chrome open dikhega:');
  console.log(`   - Apna Google Account (${profileKey === 'profile_1' ? 'Account 1' : 'Account 2'}) ka Email aur Password dalein.`);
  console.log('   - Phone par 2FA verify karein.');
  console.log('4. Jaise hi Gemini Dashboard open hoga, ye script AUTOMATICALLY detect karke session save kar degi!');
  console.log('================================================================\n');
  console.log('⏳ Waiting for you to complete sign-in in the browser window...');

  let loggedIn = false;
  let detectedEmail = null;

  while (!loggedIn) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const allPages = context.pages();
      for (const p of allPages) {
        try {
          const u = p.url();
          let hostname = '';
          try {
            hostname = new URL(u).hostname;
          } catch (_) {}

          // If user completed sign-in and landed on myaccount.google.com, auto-redirect to Gemini
          if (hostname === 'myaccount.google.com') {
            console.log('\nGoogle sign-in detected, redirecting to Gemini dashboard...');
            await p.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' }).catch(() => {});
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }

          if (hostname === 'gemini.google.com') {
            // Dismiss any welcome popups
            try {
              const modalBtn = await p.$('button[aria-label*="Close"], button:has-text("Continue"), button:has-text("Dismiss"), button:has-text("Got it")');
              if (modalBtn) await modalBtn.click().catch(() => {});
            } catch (_) {}

            const signInBtn = await p.$('button:has-text("Sign in"), a:has-text("Sign in"), [aria-label*="Sign in"]');
            const chatArea = await p.$('rich-textarea, [contenteditable="true"], .input-area');
            const newChatBtn = await p.$('button:has-text("New chat"), a:has-text("New chat")');
            const proBadge = await p.$('text="Pro", div:has-text("Pro"), [data-test-id*="user"]');

            if (!signInBtn && (chatArea || newChatBtn || proBadge)) {
              loggedIn = true;
              try {
                const avatar = await p.$('img[alt*="Google Account"], [aria-label*="Google Account"]');
                if (avatar) {
                  const aria = await avatar.getAttribute('aria-label');
                  if (aria) {
                    const match = aria.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
                    if (match) detectedEmail = match[1];
                  }
                }
              } catch (_e) {}

              console.log(`\n🎉 SUCCESS! Login detect ho gaya for ${profile.name}!`);
              if (detectedEmail) {
                console.log(`📧 Detected Account: ${detectedEmail}`);
              }
              break;
            }
          }
        } catch (_tabErr) {}
      }

      if (!loggedIn) {
        process.stdout.write('.');
      }
    } catch (_err) {}
  }

  console.log('💾 Saving persistent cookies and session tokens...');
  await new Promise(r => setTimeout(r, 4000));
  await context.close();

  manager.setLoginStatus(profileKey, true, detectedEmail);
  console.log(`✅ ${profile.name} is now successfully authenticated and stored!\n`);
  return true;
}

async function main() {
  const arg = process.argv[2];
  let target = 'profile_1';

  if (arg === '2' || arg === '--profile=2' || arg === 'profile_2') {
    target = 'profile_2';
  } else if (arg === '1' || arg === '--profile=1' || arg === 'profile_1') {
    target = 'profile_1';
  } else if (arg === 'both' || arg === '--both') {
    target = 'both';
  }

  console.log('\n🤖 ===============================================================');
  console.log('   GEMINI DUAL PROFILE SETUP ASSISTANT (PLAYWRIGHT VPS)');
  console.log('===============================================================');

  if (target === 'both') {
    console.log('\n▶️  STEP 1 of 2: Setting up Account 1 (Profile 1)...');
    await setupProfile('profile_1');
    console.log('\n▶️  STEP 2 of 2: Setting up Account 2 (Profile 2)...');
    await setupProfile('profile_2');
  } else {
    await setupProfile(target);
  }

  console.log('\n📊 Current Profile Status Summary:');
  console.log(JSON.stringify(manager.getStatusSummary(), null, 2));
  console.log('\n🚀 Next step: Ab hum dono accounts se automatic video generation wire kar sakte hain!');
  cleanupProcesses();
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error during profile setup:', err);
  cleanupProcesses();
  process.exit(1);
});
