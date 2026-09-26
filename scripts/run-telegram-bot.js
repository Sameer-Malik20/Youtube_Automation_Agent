require('dotenv').config();
const { TelegramBotService } = require('../utils/telegram-bot-service');
const chalk = require('chalk');

async function main() {
  console.log(chalk.cyan.bold('\n🤖 ====================================================='));
  console.log(chalk.cyan.bold('   AGENTICFLOW TELEGRAM BOT & HYBRID AUTOMATION HUB'));
  console.log(chalk.cyan.bold('====================================================='));

  const bot = new TelegramBotService();
  const ok = await bot.initialize();

  if (!ok) {
    console.error(chalk.red('\n❌ Telegram Bot could not be initialized. Check .env TELEGRAM_BOT_TOKEN.'));
    process.exit(1);
  }

  console.log(chalk.green('\n✅ Telegram Bot is running in long-polling mode.'));
  console.log(chalk.yellow(`👉 Open Telegram, search @${bot.botInfo.username} and send /start`));
  console.log(chalk.gray('Press Ctrl+C to stop the bot daemon gracefully.\n'));

  // Handle termination signals
  const cleanup = () => {
    console.log(chalk.yellow('\nStopping Telegram bot service...'));
    bot.stop();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  await bot.start();
}

main().catch(err => {
  console.error(chalk.red('Fatal error running telegram bot:'), err);
  process.exit(1);
});
