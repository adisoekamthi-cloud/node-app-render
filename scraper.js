const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const moment = require('moment');
const fs = require('fs');

puppeteer.use(StealthPlugin());

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

const dayMap = {
  monday: 'monday',
  tuesday: 'tuesday',
  wednesday: 'wednesday',
  thursday: 'thursday',
  friday: 'friday',
  saturday: 'saturday',
  sunday: 'sunday'
};

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let totalHeight = 0;
      const distance = 100;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
  });
}

async function scrapeKuramanime() {
  const localTitles = await getLocalTitles();
  if (localTitles.length === 0) {
    console.log('❌ Tidak ada data lokal ditemukan.');
    return;
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
    ],
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36');

  const hariIni = moment().format('dddd').toLowerCase();
  const scheduledDay = dayMap[hariIni];

  for (let i = 1; i <= 3; i++) {
    const targetUrl = `https://v6.kuramanime.run/schedule?scheduled_day=${scheduledDay}&page=${i}`;
    console.log(`🔎 Mengakses: ${targetUrl}`);

    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await autoScroll(page);
      await new Promise(resolve => setTimeout(resolve, 3000));
    } catch (e) {
      console.error(`❌ Gagal akses halaman ${i}:`, e.message);
      continue;
    }

    const animeList = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.product__item'));
      const list = [];

      items.forEach(item => {
        const linkElem = item.querySelector('h5 a');
        if (!linkElem) return;

        const link = linkElem.href;
        const title = linkElem.textContent.trim();

        const match = link.match(/\/anime\/(\d+)\//);
        const id = match ? match[1] : null;
        if (!id) return;

        const epInput = document.querySelector(`input.actual-schedule-ep-${id}-real`);
        const latestEp = epInput ? epInput.value : 'Tidak Diketahui';

        list.push({ id, title, link, latestEp });
      });

      return list;
    });

    console.log(`✅ Total anime ditemukan di halaman ${i}: ${animeList.length}`);

    if (animeList.length === 0) {
      console.log(`❌ Tidak ada data di halaman ${i}, lewati...`);
      continue;
    }

    for (const anime of animeList) {
      const animeTitleLower = anime.title.toLowerCase();
      const matched = localTitles.find(item => item.title === animeTitleLower);
      if (!matched) continue;

      console.log(`\n🎬 Judul: ${anime.title}`);
      console.log(`🆔 content_id: ${matched.content_id}`);

      try {
        await page.goto(anime.link, { waitUntil: 'networkidle2', timeout: 60000 });
        await page.waitForSelector('#episodeLists', { timeout: 15000 });
      } catch (e) {
        console.log('   - Gagal menemukan daftar episode:', e.message);
        continue;
      }

      const episode = await page.evaluate(() => {
        const epElement = document.querySelector('#episodeLists');
        if (!epElement) return null;

        const contentHtml = epElement.getAttribute('data-content');
        if (!contentHtml) return null;

        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = contentHtml;

        const epLinks = Array.from(tempDiv.querySelectorAll('a.btn-danger'));
        if (epLinks.length === 0) return null;

        const lastEp = epLinks[epLinks.length - 1];
        return {
          episode: lastEp.textContent.trim().replace(/\s+/g, ' '),
          link: lastEp.href
        };
      });

      if (!episode) {
        console.log('   - Tidak ada episode ditemukan.');
        continue;
      }

      console.log(`   📺 Episode Terbaru: ${episode.episode}`);

      try {
        await page.goto(episode.link, { waitUntil: 'networkidle2', timeout: 60000 });
        await page.waitForSelector('#animeDownloadLink', { timeout: 15000 });
      } catch (e) {
        console.log('     - Gagal menemukan link download:', e.message);
        continue;
      }

      const pixeldrainLinks = await page.evaluate(() => {
        const result = {
          '360p': null,
          '480p': null,
          '720p': null,
          '1080p': null,
          '1440p': null,
          '2160p': null
        };

        const sectionTitles = document.querySelectorAll('#animeDownloadLink h6');

        sectionTitles.forEach(title => {
          const sectionText = title.textContent.toLowerCase();
          const parent = title.parentElement;

          let resKey = null;
          if (sectionText.includes('360p')) resKey = '360p';
          else if (sectionText.includes('480p')) resKey = '480p';
          else if (sectionText.includes('720p')) resKey = '720p';
          else if (sectionText.includes('1080p')) resKey = '1080p';
          else if (sectionText.includes('1440p')) resKey = '1440p';
          else if (sectionText.includes('2160p')) resKey = '2160p';

          if (!resKey || !parent) return;

          const links = parent.querySelectorAll('a');
          for (const a of links) {
            const isExtra1 = a.textContent.toLowerCase().includes('extra 1');
            const isPixeldrain = a.href.includes('pixeldrain.com');
            if (isExtra1 && isPixeldrain) {
              result[resKey] = a.href;
              break;
            }
          }
        });

        return result;
      });

      let url_360 = '', url_480 = '', url_720 = '', url_1080 = '', url_1440 = '', url_2160 = '';

      if (!pixeldrainLinks || Object.values(pixeldrainLinks).every(v => !v)) {
        console.log('     - Tidak ada link pixeldrain ditemukan di Extra 1');
      } else {
        for (const [quality, rawUrl] of Object.entries(pixeldrainLinks)) {
          if (!rawUrl) continue;
          const converted = convertPixeldrainUrl(rawUrl) || rawUrl;
          console.log(`     ▶ ${quality}: ${converted}`);

          if (quality === '360p') url_360 = converted;
          if (quality === '480p') url_480 = converted;
          if (quality === '720p') url_720 = converted;
          if (quality === '1080p') url_1080 = converted;
          if (quality === '1440p') url_1440 = converted;
          if (quality === '2160p') url_2160 = converted;
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
            url_480: url_480 || url_360 || '',
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
  }

  await browser.close();
}

scrapeKuramanime().catch(e => {
  console.error('Error di fungsi utama:', e.stack);
});

module.exports = { scrapeKuramanime };
