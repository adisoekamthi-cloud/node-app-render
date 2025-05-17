const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const moment = require('moment');

puppeteer.use(StealthPlugin());

// Konfigurasi utama
const CONFIG = {
  timeout: 60000,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36',
  waitUntil: 'networkidle2',
  maxRetries: 3,
  delayBetweenRequests: 2000
};

// Fungsi konversi URL Pixeldrain
function convertPixeldrainUrl(url) {
  const regex = /https?:\/\/pixeldrain\.com\/[du]\/([a-zA-Z0-9]+)/;
  const match = url.match(regex);
  return match ? `https://pixeldrain.com/api/filesystem/${match[1]}?attach` : null;
}

// Fungsi untuk ambil data judul lokal dengan retry dan error handling
async function getLocalTitles() {
  try {
    const response = await axios.get('https://app.ciptakode.my.id/getData.php', { timeout: 15000 });
    if (response.data?.success) {
      return response.data.data.map(item => ({
        content_id: item.content_id,
        title: item.title.toLowerCase()
      }));
    }
    return [];
  } catch (error) {
    console.error('Failed to fetch local titles:', error.message);
    return [];
  }
}

// Fungsi utama scraping Kuramanime
async function scrapeKuramanime() {
  const localTitles = await getLocalTitles();
  if (localTitles.length === 0) {
    console.log('❌ No local titles found');
    return;
  }

  // Launch puppeteer dengan opsi yang cukup lengkap
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
    ignoreDefaultArgs: ["--disable-extensions"],
    timeout: 0
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(CONFIG.userAgent);
    await page.setDefaultNavigationTimeout(CONFIG.timeout);

    // Load halaman anime ongoing
    console.log('🌐 Loading anime list...');
    await page.goto('https://v6.kuramanime.run/quick/ongoing?order_by=latest&page=1', {
      waitUntil: CONFIG.waitUntil,
      timeout: CONFIG.timeout
    });

    await page.waitForSelector('.product__item', { timeout: 30000 });

    // Ambil list anime dari halaman
    const animeList = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.product__item')).map(item => {
        const linkElem = item.querySelector('h5 a');
        return {
          title: linkElem?.textContent?.trim() || 'No title',
          link: linkElem?.href || null
        };
      }).filter(a => a.link);
    });

    console.log(`📊 Found ${animeList.length} anime`);

    // Filter hanya anime yang ada di local data
    const matchedAnimes = animeList.filter(anime => {
      return localTitles.some(local => local.title === anime.title.toLowerCase());
    });

    console.log(`✅ Total anime di local data yang ditemukan di target: ${matchedAnimes.length}`);

    // Proses tiap anime yang ditemukan
    for (const anime of matchedAnimes) {
      const animeTitleLower = anime.title.toLowerCase();
      const matched = localTitles.find(item => item.title === animeTitleLower);

      console.log(`\n🎬 Processing: ${anime.title}`);
      console.log(`🆔 Content ID: ${matched.content_id}`);

      let retryCount = 0;
      let success = false;

      while (retryCount < CONFIG.maxRetries && !success) {
        try {
          const animePage = await browser.newPage();
          await animePage.setUserAgent(CONFIG.userAgent);
          await animePage.setDefaultNavigationTimeout(CONFIG.timeout);

          // Buka halaman detail anime
          await animePage.goto(anime.link, {
            waitUntil: CONFIG.waitUntil,
            timeout: CONFIG.timeout
          });

          await animePage.waitForSelector('#animeEpisodes a.ep-button', { timeout: 15000 });

          // Ambil episode terbaru
          const episode = await animePage.evaluate(() => {
            const epButtons = Array.from(document.querySelectorAll('#animeEpisodes a.ep-button'));
            if (epButtons.length === 0) return null;
            const lastEp = epButtons[epButtons.length - 1];
            return {
              episode: lastEp.innerText.trim(),
              link: lastEp.href
            };
          });

          if (!episode) {
            console.log('   - No episodes found');
            await animePage.close();
            break;
          }

          console.log(`   📺 Latest Episode: ${episode.episode}`);

          // Buka halaman episode untuk ambil link download
          const episodePage = await browser.newPage();
          await episodePage.setUserAgent(CONFIG.userAgent);
          await episodePage.setDefaultNavigationTimeout(CONFIG.timeout);

          await episodePage.goto(episode.link, {
            waitUntil: CONFIG.waitUntil,
            timeout: CONFIG.timeout
          });

          await episodePage.waitForSelector('#animeDownloadLink', { timeout: 15000 });

          // Ambil link pixeldrain per kualitas
          const pixeldrainLinks = await episodePage.evaluate(() => {
            const container = document.querySelector('#animeDownloadLink');
            if (!container) return null;

            const result = {};
            const headers = Array.from(container.querySelectorAll('h6.font-weight-bold'))
              .filter(h => /mp4 (480p|720p)/i.test(h.innerText));

            headers.forEach(header => {
              const quality = header.innerText.match(/mp4 (480p|720p)/i)[1].toLowerCase();
              let sib = header.nextElementSibling;
              const urls = [];

              while (sib && sib.tagName !== 'H6') {
                if (sib.tagName === 'A' && sib.href.includes('pixeldrain.com')) {
                  urls.push(sib.href);
                }
                sib = sib.nextElementSibling;
              }

              if (urls.length > 0) result[quality] = urls;
            });

            return result;
          });

          let url_480 = '';
          let url_720 = '';

          if (pixeldrainLinks) {
            if (pixeldrainLinks['480p']) {
              url_480 = convertPixeldrainUrl(pixeldrainLinks['480p'][0]) || '';
              console.log(`     ▶ 480p: ${url_480}`);
            }
            if (pixeldrainLinks['720p']) {
              url_720 = convertPixeldrainUrl(pixeldrainLinks['720p'][0]) || '';
              console.log(`     ▶ 720p: ${url_720}`);
            }
          } else {
            console.log('     - No PixelDrain links found');
          }

          // Kirim data episode ke server
          try {
            const response = await axios.post('https://app.ciptakode.my.id/insertEpisode.php', {
              content_id: matched.content_id,
              file_name: `${anime.title} episode ${episode.episode}`,
              episode_number: parseInt(episode.episode.replace(/\D/g, '')) || 0,
              time: moment().format('YYYY-MM-DD HH:mm:ss'),
              view: 0,
              url_480,
              url_720,
              url_1080: '',
              url_1440: '',
              url_2160: '',
              title: anime.title
            }, { timeout: 10000 });

            console.log(`     ✅ Server response: ${response.data.message || 'Success'}`);
            success = true;
          } catch (error) {
            console.log(`     ❌ Failed to send data: ${error.message}`);
          }

          await episodePage.close();
          await animePage.close();

          // Delay antar request supaya tidak terlalu cepat
          await new Promise(resolve => setTimeout(resolve, CONFIG.delayBetweenRequests));

        } catch (error) {
          retryCount++;
          console.log(`   ❌ Attempt ${retryCount}/${CONFIG.maxRetries} failed: ${error.message}`);
          if (retryCount < CONFIG.maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 2000 * retryCount));
          }
        }
      }
    }
  } catch (error) {
    console.error('🔥 Main error:', error);
  } finally {
    await browser.close();
    console.log('✅ Scraping process completed');
  }
}

// Jalankan scraping
(async () => {
  try {
    await scrapeKuramanime();
  } catch (e) {
    console.error('⛔ Fatal error:', e);
    process.exit(1);
  }
})();

module.exports = { scrapeKuramanime };
