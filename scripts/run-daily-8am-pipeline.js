require('dotenv').config();
const { TelegramBotService } = require('../utils/telegram-bot-service');
const { runDaily8AMPipeline } = require('../services/daily-gemini-pipeline');

async function main() {
  console.log('================================================================');
  console.log('🌅 RUNNING 8:00 AM IST DAILY GEMINI AUTOMATED PIPELINE');
  console.log('================================================================');

  const bot = new TelegramBotService();
  await bot.initialize();

  const success = await runDaily8AMPipeline(bot);
  console.log(`\nPipeline execution finished with result: ${success ? 'SUCCESS' : 'FAILED'}`);
  process.exit(success ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal pipeline error:', err);
  process.exit(1);
});
