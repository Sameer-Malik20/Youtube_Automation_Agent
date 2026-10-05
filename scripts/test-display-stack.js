const net = require('net');
const { spawn, execSync } = require('child_process');
const { chromium } = require('playwright');

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

async function test() {
  console.log('Testing Xvfb & Chrome...');
  try {
    execSync('pkill -f "Xvfb :99" || true');
    execSync('rm -f /tmp/.X11-unix/X99 /tmp/.X99-lock');
  } catch (_) {}

  const xvfb = spawn('Xvfb', [':99', '-screen', '0', '1280x800x24', '-ac'], { stdio: 'ignore' });
  for (let i = 0; i < 20; i++) {
    if (checkDisplay(':99')) break;
    await new Promise(r => setTimeout(r, 200));
  }
  console.log('Display :99 ready:', checkDisplay(':99'));

  const x11vnc = spawn('x11vnc', ['-display', ':99', '-nopw', '-listen', '0.0.0.0', '-xkb', '-forever', '-shared'], { stdio: 'ignore' });
  for (let i = 0; i < 20; i++) {
    if (await checkPort(5900)) break;
    await new Promise(r => setTimeout(r, 200));
  }
  console.log('Port 5900 (VNC) ready:', await checkPort(5900));

  const ws = spawn('websockify', ['--web', '/usr/share/novnc', '6080', 'localhost:5900'], { stdio: 'ignore' });
  for (let i = 0; i < 20; i++) {
    if (await checkPort(6080)) break;
    await new Promise(r => setTimeout(r, 200));
  }
  console.log('Port 6080 (noVNC) ready:', await checkPort(6080));

  console.log('Launching Chrome context on :99...');
  const browser = await chromium.launchPersistentContext('/tmp/test_chrome_run', {
    executablePath: '/usr/bin/google-chrome',
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    env: { ...process.env, DISPLAY: ':99' }
  });

  const page = await browser.newPage();
  await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded' });
  console.log('Successfully navigated to Google! Title:', await page.title());
  await browser.close();

  // Cleanup
  ws.kill('SIGTERM');
  x11vnc.kill('SIGTERM');
  xvfb.kill('SIGTERM');
  console.log('All tests passed cleanly!');
}

test().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
