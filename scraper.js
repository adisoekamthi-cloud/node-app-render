const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const moment = require('moment');

puppeteer.use(StealthPlugin());

// Enhanced configuration
const CONFIG = {
  maxRetries: 3,
  timeout: 60000,
  delayBetweenRequests: 3000,
  headless: true,
  maxConcurrentPages: 2, // Reduced to prevent overload
};

// Improved URL validation
function convertPixeldrainUrl(url) {
  if (!url) return null;
  try {
    const regex = /https?:\/\/pixeldrain\.com\/(?:u\/|d\/|l\/)?([a-zA-Z0-9]+)/;
    const match = url.match(regex);
    return match ? `https://pixeldrain.com/api/file/${match[1]}?download` : null;
  } catch (e) {
    console.error('Error converting pixeldrain URL:', e);
    return null;
  }
}

// More robust local titles fetching
async function getLocalTitles() {
  try {
    const response = await axios.get('https://app.ciptakode.my.id/getData.php', {
      timeout: 10000
    });
    return response.data?.success ? response.data.data.map(item => ({
      content_id: item.content_id,
      title: item.title.toLowerCase().trim()
    })) : [];
  } catch (error) {
    console.error('Gagal mengambil data dari server:', error.message);
    return [];
  }
}

// Enhanced retry mechanism with page cleanup
async function withRetry(fn, context = '', maxRetries = CONFIG.maxRetries) {
  let attempts = 0;
  let lastError;
  
  while (attempts < maxRetries) {
    try {
      return await fn();
    } catch (error) {
      attempts++;
      lastError = error;
      console.log(`   ⚠️ [${context}] Percobaan ${attempts}/${maxRetries} gagal: ${error.message}`);
      if (attempts < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, CONFIG.delayBetweenRequests * attempts));
      }
    }
  }
  throw lastError;
}

// Main scraping function with better resource management
async function scrapeKuramanime() {
  const localTitles = await getLocalTitles();
  if (localTitles.length === 0) {
    console.log('❌ Tidak ada data lokal ditemukan.');
    return;
  }

  const browser = await puppeteer.launch({
    headless: CONFIG.headless,
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

  try {
    console.log('🚀 Memulai proses scraping...');
    
    // Get anime list with single page
    const animeList = await withRetry(async () => {
      const page = await browser.newPage();
      try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36');
        await page.setDefaultNavigationTimeout(CONFIG.timeout);

        await page.goto('https://v6.kuramanime.run/quick/ongoing?order_by=updated&page=1', {
          waitUntil: 'domcontentloaded',
          timeout: CONFIG.timeout
        });

        await page.waitForSelector('.product__item', { timeout: 20000 });

        return await page.evaluate(() => {
          return Array.from(document.querySelectorAll('.product__item')).map(item => {
            const linkElem = item.querySelector('h5 a');
            return {
              title: linkElem?.textContent?.trim() || 'Tidak ada judul',
              link: linkElem?.href || null
            };
          }).filter(a => a.link);
        });
      } finally {
        await safeClosePage(page);
      }
    }, 'mengambil daftar anime');

    console.log(`📊 Ditemukan ${animeList.length} anime`);

    // Process anime sequentially to prevent connection issues
    for (const anime of animeList) {
      const animeTitleLower = anime.title.toLowerCase().trim();
      const matched = localTitles.find(item => item.title === animeTitleLower);
      if (!matched) continue;

      console.log(`\n🎬 Memproses: ${anime.title}`);
      console.log(`🆔 ID Konten: ${matched.content_id}`);

      try {
        await processAnime(browser, anime, matched);
      } catch (animeError) {
        console.log(`❌ Gagal memproses anime: ${animeError.message}`);
      }
    }
  } catch (mainError) {
    console.error('🔥 Error utama:', mainError);
  } finally {
    await safeCloseBrowser(browser);
    console.log('✅ Proses scraping selesai');
  }
}

// Safe page closing
async function safeClosePage(page) {
  try {
    if (page && !page.isClosed()) {
      await page.close();
    }
  } catch (e) {
    console.error('Error closing page:', e.message);
  }
}

// Safe browser closing
async function safeCloseBrowser(browser) {
  try {
    if (browser) {
      await browser.close();
    }
  } catch (e) {
    console.error('Error closing browser:', e.message);
  }
}

// Process individual anime
async function processAnime(browser, anime, matched) {
  const animePage = await browser.newPage();
  try {
    await animePage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36');
    await animePage.setDefaultNavigationTimeout(CONFIG.timeout);

    await animePage.goto(anime.link, { 
      waitUntil: 'domcontentloaded',
      timeout: CONFIG.timeout
    });

    const episodes = await withRetry(async () => {
      await animePage.waitForSelector('#animeEpisodes a.ep-button', { timeout: 20000 });
      return await animePage.evaluate(() => {
        return Array.from(document.querySelectorAll('#animeEpisodes a.ep-button')).map(ep => ({
          episode: ep.innerText.trim().replace(/\s+/g, ' '),
          link: ep.href
        }));
      });
    }, `mengambil episode ${anime.title}`);

    console.log(`   📺 Ditemukan ${episodes.length} episode`);

    // Process episodes sequentially
    for (const [index, ep] of episodes.entries()) {
      const processingId = Math.random().toString(36).substring(2, 8);
      console.log(`   ${index + 1}/${episodes.length} [${processingId}] Memproses: ${ep.episode}`);

      try {
        await processEpisode(browser, anime, matched, ep, processingId);
      } catch (epError) {
        console.log(`     ❌ [${processingId}] Gagal memproses episode: ${epError.message}`);
      }
    }
  } finally {
    await safeClosePage(animePage);
  }
}

// Process individual episode
async function processEpisode(browser, anime, matched, ep, processingId) {
  const epPage = await browser.newPage();
  try {
    await epPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36');
    await epPage.setDefaultNavigationTimeout(CONFIG.timeout);

    await epPage.goto(ep.link, { 
      waitUntil: 'domcontentloaded',
      timeout: CONFIG.timeout
    });

    // Extract download links
    const downloadLinks = await withRetry(async () => {
      await epPage.waitForSelector('#animeDownloadLink', { timeout: 15000 });
      return await epPage.evaluate(() => {
        const container = document.querySelector('#animeDownloadLink');
        if (!container) return null;

        const result = {};
        const headers = Array.from(container.querySelectorAll('h6.font-weight-bold'));

        headers.forEach(header => {
          const qualityText = header.innerText.trim();
          const resolutionMatch = qualityText.match(/(\d+p)/i);
          if (!resolutionMatch) return;

          const resolution = resolutionMatch[0];
          let sib = header.nextElementSibling;
          const links = [];

          while (sib && sib.tagName !== 'H6') {
            if (sib.tagName === 'A' && sib.href && sib.href.includes('pixeldrain.com')) {
              links.push(sib.href);
            }
            sib = sib.nextElementSibling;
          }

          if (links.length > 0) {
            result[resolution] = links[0]; // Take first pixeldrain link
          }
        });

        return result;
      });
    }, `mengambil link download ${ep.episode}`);

    let url_480 = '', url_720 = '';
    if (downloadLinks) {
      if (downloadLinks['480p']) {
        url_480 = convertPixeldrainUrl(downloadLinks['480p']);
        console.log(`     ▶ 480p: ${url_480 || 'Tidak valid'}`);
      }
      if (downloadLinks['720p']) {
        url_720 = convertPixeldrainUrl(downloadLinks['720p']);
        console.log(`     ▶ 720p: ${url_720 || 'Tidak valid'}`);
      }
    }

    const fileName = `${anime.title} episode ${ep.episode}`;
    const episodeNumber = parseInt(ep.episode.replace(/[^\d]/g, ''), 10) || 0;

    const result = await withRetry(async () => {
      const response = await axios.post('https://app.ciptakode.my.id/insertEpisode.php', {
        content_id: matched.content_id,
        file_name: fileName,
        episode_number: episodeNumber,
        time: moment().format('YYYY-MM-DD HH:mm:ss'),
        view: 0,
        url_480,
        url_720,
        url_1080: '',
        url_1440: '',
        url_2160: '',
        title: anime.title
      }, { timeout: 10000 });
      return response.data;
    }, `mengirim data episode ${ep.episode}`);

    console.log(`     ✅ [${processingId}] Response: ${result.message || 'Berhasil'}`);
  } finally {
    await safeClosePage(epPage);
    await new Promise(resolve => setTimeout(resolve, CONFIG.delayBetweenRequests));
  }
}

// Start scraping with top-level error handling
(async () => {
  try {
    await scrapeKuramanime();
  } catch (e) {
    console.error('⛔ Error di fungsi utama:', e);
    process.exit(1);
  }
})();

module.exports = { scrapeKuramanime };
