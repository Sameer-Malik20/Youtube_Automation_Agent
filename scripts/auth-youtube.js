require('dotenv').config();
const http = require('http');
const url = require('url');
const fs = require('fs').promises;
const path = require('path');
const { google } = require('googleapis');
const chalk = require('chalk');
const { exec } = require('child_process');

async function main() {
  console.log(chalk.cyan.bold('\n🎬 ====================================================='));
  console.log(chalk.cyan.bold('   YOUTUBE OAUTH ONE-CLICK AUTHENTICATION HELPER'));
  console.log(chalk.cyan.bold('====================================================='));

  const credsPath = path.join(__dirname, '..', 'config', 'credentials.json');
  const tokensPath = path.join(__dirname, '..', 'config', 'tokens.json');

  let creds;
  try {
    const raw = await fs.readFile(credsPath, 'utf8');
    creds = JSON.parse(raw);
  } catch (err) {
    console.error(chalk.red('❌ config/credentials.json nahi mila. Kripya pehle setup karein.'));
    process.exit(1);
  }

  const clientId = creds.youtube?.client_id;
  const clientSecret = creds.youtube?.client_secret;
  const redirectUri = 'http://localhost:8080/oauth2callback';

  if (!clientId || !clientSecret) {
    console.error(chalk.red('❌ YouTube client_id ya client_secret missing hai config/credentials.json me!'));
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const scopes = [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube',
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/yt-analytics.readonly',
    'https://www.googleapis.com/auth/youtube.force-ssl'
  ];

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  });

  // Start local OAuth server
  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = url.parse(req.url, true);
      if (parsedUrl.pathname === '/oauth2callback') {
        const code = parsedUrl.query.code;
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>❌ Error: Authorization code nahi mila.</h1>');
          return;
        }

        console.log(chalk.yellow('\n⏳ Code received from Google! Exchanging for tokens...'));

        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        let existingTokens = {};
        try {
          const rawTokens = await fs.readFile(tokensPath, 'utf8');
          existingTokens = JSON.parse(rawTokens);
        } catch (_ignoreErr) {
          // File may not exist yet
        }

        existingTokens.youtube = tokens;
        await fs.mkdir(path.dirname(tokensPath), { recursive: true });
        await fs.writeFile(tokensPath, JSON.stringify(existingTokens, null, 2), 'utf8');

        // Fetch channel info to confirm
        let channelName = 'YouTube Channel';
        try {
          const yt = google.youtube({ version: 'v3', auth: oauth2Client });
          const chanRes = await yt.channels.list({ part: ['snippet', 'statistics'], mine: true });
          if (chanRes.data.items && chanRes.data.items.length > 0) {
            const ch = chanRes.data.items[0];
            channelName = ch.snippet.title;
            const subs = ch.statistics.subscriberCount;
            console.log(chalk.green.bold(`\n🎉 AUTHENTICATED SUCCESSFULLY!`));
            console.log(chalk.white(`📺 Channel: `) + chalk.cyan.bold(channelName));
            console.log(chalk.white(`👥 Subscribers: `) + chalk.yellow(subs));
          }
        } catch (chanErr) {
          console.log(chalk.green('\n✅ Tokens saved successfully!'));
        }

        const successHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>YouTube Connected</title>
  <style>
    body { font-family: sans-serif; background: #0f172a; color: white; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #1e293b; padding: 40px; border-radius: 16px; text-align: center; box-shadow: 0 10px 25px rgba(0,0,0,0.5); max-width: 480px; }
    h1 { color: #22c55e; margin-bottom: 8px; font-size: 28px; }
    p { color: #94a3b8; font-size: 16px; line-height: 1.5; }
    .channel { color: #38bdf8; font-weight: bold; font-size: 20px; margin: 15px 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>✅ YouTube Connected!</h1>
    <p>Aapka YouTube channel successfully connect ho gaya hai:</p>
    <div class="channel">📺 ${channelName}</div>
    <p>Aap is tab ko close karke terminal/chat par wapas ja sakte hain. Automation server ab ready hai.</p>
  </div>
</body>
</html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(successHtml);

        console.log(chalk.green(`📁 Tokens saved to: ${tokensPath}`));
        console.log(chalk.cyan.bold('\n🚀 YouTube connection complete! You can now run the automation agent.\n'));

        setTimeout(() => {
          server.close();
          process.exit(0);
        }, 2000);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    } catch (err) {
      console.error(chalk.red('\n❌ OAuth Exchange Error:'), err.message);
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>❌ Authentication Failed</h1><p>${err.message}</p>`);
    }
  });

  server.listen(8080, () => {
    console.log(chalk.green('✅ Local OAuth callback server is listening on http://localhost:8080'));
    console.log(chalk.yellow('\n👉 Kripya niche diye gaye URL ko browser me open karke Google sign-in complete karein:'));
    console.log(chalk.blue.underline(authUrl));
    console.log(chalk.gray('\n(Waiting for Google OAuth redirect...)'));

    // Attempt to open browser automatically
    const startCmd = process.platform === 'win32' ? `start "" "${authUrl}"` : `open "${authUrl}"`;
    exec(startCmd, () => {});
  });
}

main().catch(err => {
  console.error(chalk.red('Fatal error:'), err);
  process.exit(1);
});
