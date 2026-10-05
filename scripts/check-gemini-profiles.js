const { GeminiProfileManager } = require('../utils/gemini-profile-manager');

async function checkAllProfiles() {
  const manager = new GeminiProfileManager();
  console.log('\n======================================================');
  console.log('🔍 TESTING SAVED GEMINI PROFILES STATUS (HEADLESS)');
  console.log('======================================================\n');

  console.log('1️⃣ Checking Profile 1...');
  const res1 = await manager.checkProfileHealth('profile_1');

  console.log('\n2️⃣ Checking Profile 2...');
  const res2 = await manager.checkProfileHealth('profile_2');

  console.log('\n======================================================');
  console.log('📊 OVERALL STATUS SUMMARY:');
  console.log('======================================================');
  console.log(JSON.stringify(manager.getStatusSummary(), null, 2));

  console.log('\n📌 Profile 1 Screenshot:', res1.screenshotFile || 'None');
  console.log('📌 Profile 2 Screenshot:', res2.screenshotFile || 'None');
}

checkAllProfiles().catch(err => {
  console.error('Error during profile status check:', err);
  process.exit(1);
});
