const puppeteer = require('puppeteer');
const axios = require('axios');
const moment = require('moment');
const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Server Node.js aktif di Railway!');
});

app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di port ${PORT}`);
});

function convertPixeldrainUrl(url) {
  const regex = /https?:\/\/pixeldrain\.com\/[du]\/([a-zA-Z0-9]+)/;
  const match = url.match(regex);
  if (match) {
    return `https://pixeldrain.com/api/filesystem/${match[1]}?attach`;
  }
  return null;
}

async function getLocalTitles() {
  try {
    const response = await axios.get('https://app.ciptakode.my.id/getData.php');
    if (response.data.success) {
      return response.data.data.map(item => ({
        content_id: item.content_id,
        title: item.title.toLowerCase()
      }));
    }
  } catch (error) {
    console.error('Gagal mengambil data dari server:', error.message);
  }
  return [];
}

async function scrapeKuramanime() {
  const localTitles = await getLocalTitles();
  if (localTitles.length === 0) {
    console.log('❌ Tidak ada data lokal ditemukan.');
    return;
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();

  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36');
  const baseUrl = 'https://v6.kuramanime.run/quick/ongoing?order_by=updated';

  await page.goto(baseUrl, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.product__item');

  const animeList = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.product__item'));
    return items.map(item => {
      const linkElem = item.querySelector('h5 a');
      return {
        title: linkElem ? linkElem.textContent.trim() : 'Tidak ada judul',
        link: linkElem ? linkElem.href : null
      };
    }).filter(a => a.link !== null);
  });

  for (const anime of animeList) {
    const animeTitleLower = anime.title.toLowerCase();
    const matched = localTitles.find(item => item.title === animeTitleLower);
    if (!matched) continue;

    console.log(`\n🎬 Judul: ${anime.title}`);
    console.log(`🆔 content_id: ${matched.content_id}`);

    await page.goto(anime.link, { waitUntil: 'networkidle2' });

    try {
      await page.waitForSelector('#animeEpisodes a.ep-button', { timeout: 10000 });
    } catch {
      console.log('   - Gagal menemukan daftar episode.');
      continue;
    }

    const episode = await page.evaluate(() => {
      const epButtons = Array.from(document.querySelectorAll('#animeEpisodes a.ep-button'));
      const epElement = epButtons[epButtons.length - 1];
      if (!epElement) return null;
      return {
        episode: epElement.innerText.trim().replace(/\s+/g, ' '),
        link: epElement.href
      };
    });

    if (!episode) {
      console.log('   - Tidak ada episode ditemukan.');
      continue;
    }

    console.log(`   📺 Episode Terbaru: ${episode.episode}`);
    await page.goto(episode.link, { waitUntil: 'networkidle2' });

    try {
      await page.waitForSelector('#animeDownloadLink', { timeout: 10000 });
    } catch {
      console.log('     - Gagal menemukan link download');
      continue;
    }

    const pixeldrainLinks = await page.evaluate(() => {
      const container = document.querySelector('#animeDownloadLink');
      if (!container) return null;

      const result = {};
      const headers = Array.from(container.querySelectorAll('h6.font-weight-bold')).filter(h =>
        /mp4 480p/i.test(h.innerText) || /mp4 720p/i.test(h.innerText)
      );

      headers.forEach(header => {
        const qualityText = header.innerText.trim();
        let sib = header.nextElementSibling;
        const urls = [];

        while (sib && sib.tagName.toLowerCase() !== 'h6') {
          if (sib.tagName.toLowerCase() === 'a' && sib.href.includes('pixeldrain.com')) {
            urls.push(sib.href);
          }
          sib = sib.nextElementSibling;
        }

        if (urls.length > 0) {
          result[qualityText] = urls;
        }
      });

      return result;
    });

    let url_480 = '';
    let url_720 = '';
    let url_1080 = '';
    let url_1440 = '';
    let url_2160 = '';

    if (!pixeldrainLinks) {
      console.log('     - Tidak ada link pixeldrain ditemukan');
    } else {
      for (const [quality, links] of Object.entries(pixeldrainLinks)) {
        const convertedLinks = links.map(rawUrl => convertPixeldrainUrl(rawUrl) || rawUrl);
        console.log(`     ▶ ${quality}:`);
        convertedLinks.forEach(link => console.log(`       • ${link}`));

        if (/480p/i.test(quality) && convertedLinks.length > 0) url_480 = convertedLinks[0];
        if (/720p/i.test(quality) && convertedLinks.length > 0) url_720 = convertedLinks[0];
      }

      const fileName = `${anime.title} episode ${episode.episode}`;
      const episodeNumber = parseInt(episode.episode.replace(/[^\d]/g, ''), 10);
      const title = `${anime.title} `;

      try {
        const insertRes = await axios.post('https://app.ciptakode.my.id/insertEpisode.php', {
          content_id: matched.content_id,
          file_name: fileName,
          episode_number: episodeNumber,
          time: moment().format('YYYY-MM-DD HH:mm:ss'),
          view: 0,
          url_480,
          url_720,
          url_1080,
          url_1440,
          url_2160,
          title
        });

        console.log('     ✅ Data berhasil dikirim:', insertRes.data);
      } catch (err) {
        console.log('     ❌ Gagal kirim ke server:', err.message);
      }
    }
  }

  await browser.close();
}

scrapeKuramanime().catch(console.error);
