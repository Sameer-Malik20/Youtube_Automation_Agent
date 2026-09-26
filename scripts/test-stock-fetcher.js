const axios = require('axios');

async function testSources() {
  const cats = ['technology', 'computer', 'network', 'cyber'];
  for (const cat of cats) {
    try {
      const res = await axios.get(`https://mixkit.co/free-stock-video/${cat}/`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 10000
      });
      const mp4s = [...new Set(res.data.match(/https:\/\/[^"'\s<>]+\.mp4/g) || [])];
      console.log(`Mixkit ${cat} MP4s found:`, mp4s.length);
      if (mp4s.length) console.log('  sample:', mp4s[0]);
    } catch (e) {
      console.log(`Mixkit ${cat} error:`, e.message);
    }
  }
}

testSources();
