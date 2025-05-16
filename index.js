const express = require('express');
const app = express();

const { scrapeKuramanime } = require('./scraper'); // Import fungsi dari scraper.js

app.get('/run', async (req, res) => {
  try {
    await scrapeKuramanime();
    res.send('✅ Scraping selesai!');
  } catch (err) {
    res.status(500).send('❌ Gagal menjalankan scraping: ' + err.message);
  }
});


// Gunakan PORT dari environment Railway
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di port ${PORT}`);
});
