const express = require('express');
const app = express();
const { scrapeKuramanime } = require('./scraper');

app.get('/run', async (req, res) => {
  if (req.query.token !== process.env.SECRET_TOKEN) {
    return res.status(403).send('Unauthorized');
  }

  
  try {
    await scrapeKuramanime();
    res.send('✅ Scraping berhasil dijalankan');
  } catch (err) {
    console.error(err);
    res.status(500).send('❌ Gagal scraping');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server berjalan di port ${PORT}`));
