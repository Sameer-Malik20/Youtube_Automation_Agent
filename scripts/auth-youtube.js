require('dotenv').config();
const http = require('http');
const url = require('url');
const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');
const { google } = require('googleapis');
const chalk = require('chalk');

async function saveTokens(tokens, tokensPath, oauth2Client) {
  let existingTokens = {};
  try {
    const rawTokens = await fs.readFile(tokensPath, 'utf8');
    existingTokens = JSON.parse(rawTokens);
  } catch (_ignoreErr) {}

  existingTokens.youtube = tokens;
  await fs.mkdir(path.dirname(tokensPath), { recursive: true });
  await fs.writeFile(tokensPath, JSON.stringify(existingTokens, null, 2), 'utf8');

  let channelName = 'YouTube Channel';
  try {
    const yt = google.youtube({ version: 'v3', auth: oauth2Client });
    const chanRes = await yt.channels.list({ part: ['snippet', 'statistics'], mine: true });
    if (chanRes.data.items && chanRes.data.items.length > 0) {
      const ch = chanRes.data.items[0];
      channelName = ch.snippet.title;
      const subs = ch.statistics.subscriberCount;
      console.log(chalk.green.bold('\n🎉 AUTHENTICATED SUCCESSFULLY!'));
      console.log(chalk.white('📺 Channel: ') + chalk.cyan.bold(channelName));
      console.log(chalk.white('👥 Subscribers: ') + chalk.yellow(subs));
    }
  } catch (_chanErr) {
    console.log(chalk.green('\n✅ Tokens saved successfully!'));
  }

  console.log(chalk.green(`📁 Tokens saved to: ${tokensPath}`));
  console.log(chalk.cyan.bold('\n🚀 YouTube connection complete! You can now run the automation agent.\n'));
}

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

  let server = null;
  // Try to bind server on 8080 if free, but do not crash if port is in use
  try {
    server = http.createServer(async (req, res) => {
      try {
        const parsedUrl = url.parse(req.url, true);
        if (parsedUrl.pathname === '/oauth2callback') {
          const code = parsedUrl.query.code;
          if (!code) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h1>❌ Error: Authorization code nahi mila.</h1>');
            return;
          }

          console.log(chalk.yellow('\n⏳ Code received from Google redirect! Exchanging for tokens...'));
          const { tokens } = await oauth2Client.getToken(code);
          oauth2Client.setCredentials(tokens);
          await saveTokens(tokens, tokensPath, oauth2Client);

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>✅ YouTube Connected Successfully!</h1><p>Aap is window ko band kar sakte hain.</p>');

          setTimeout(() => {
            if (server) server.close();
            process.exit(0);
          }, 1500);
        }
      } catch (err) {
        console.error(chalk.red('\n❌ OAuth Exchange Error:'), err.message);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>❌ Authentication Failed</h1><p>${err.message}</p>`);
      }
    });

    server.on('error', () => {
      // Port in use, proceed with manual code paste mode
    });

    server.listen(8080);
  } catch (_) {}

  console.log(chalk.yellow('\n👉 STEP 1: Niche diye gaye link ko apne browser me open karke channel ka permission allow karein:'));
  console.log(chalk.blue.underline('\n' + authUrl + '\n'));

  console.log(chalk.cyan('👉 STEP 2:'));
  console.log(chalk.white('Allow karne ke baad aapka browser redirect hoga. Address bar me aisa URL aayega:'));
  console.log(chalk.gray('http://localhost:8080/oauth2callback?code=4/0A...'));
  console.log(chalk.yellow('\nUs poore URL ko (ya code ko) yahan paste karke Enter dabayein:\n'));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.question('Paste Code / Redirected URL here: ', async (answer) => {
    rl.close();
    if (!answer || answer.trim().length === 0) {
      console.error(chalk.red('❌ Koi code enter nahi kiya gaya.'));
      if (server) server.close();
      process.exit(1);
    }

    let code = answer.trim();
    if (code.includes('code=')) {
      try {
        const u = new URL(code.startsWith('http') ? code : `http://${code}`);
        code = u.searchParams.get('code') || code;
      } catch (_) {
        const m = code.match(/code=([^&]+)/);
        if (m) code = m[1];
      }
    }
    code = decodeURIComponent(code);

    try {
      console.log(chalk.yellow('\n⏳ Exchanging authorization code for fresh tokens...'));
      const { tokens } = await oauth2Client.getToken(code);
      oauth2Client.setCredentials(tokens);
      await saveTokens(tokens, tokensPath, oauth2Client);
      if (server) server.close();
      process.exit(0);
    } catch (err) {
      console.error(chalk.red('\n❌ Token exchange failed:'), err.message);
      if (server) server.close();
      process.exit(1);
    }
  });
}

main().catch(err => {
  console.error(chalk.red('Fatal error:'), err);
  process.exit(1);
});
