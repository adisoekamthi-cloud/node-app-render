const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const moment = require('moment');

puppeteer.use(StealthPlugin());

const CONFIG = {
  maxRetries: 3,
  timeout: 120000, // 2 menit timeout
  delayBetweenRequests: 5000, // 5 detik delay antar request
  headless: true,
  maxConcurrentPages: 1,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36',
  waitUntil: 'networkidle2',
  viewport: { width: 1920, height: 1080 },
};

function convertPixeldrainUrl(url) {
  if (!url) return null;

  try {
    const patterns = [
      /https?:\/\/pixeldrain\.com\/[du]\/([a-zA-Z0-9]+)/,
      /https?:\/\/pixeldrain\.com\/api\/filesystem\/([a-zA-Z0-9]+)/,
      /https?:\/\/pixeldrain\.com\/d\/([a-zA-Z0-9]+)\?/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        return `https://pixeldrain.com/api/filesystem/${match[1]}?attach`;
      }
    }
    return url;
  } catch (e) {
    console.error('URL Conversion Error:', e);
    return url;
  }
}

let localTitlesCache = null;
let lastFetchTime = 0;
const CACHE_DURATION = 3600000; // 1 jam

async function getLocalTitles() {
  const now = Date.now();
  if (localTitlesCache && now - lastFetchTime < CACHE_DURATION) {
    return localTitlesCache;
  }

  try {
    const response = await axios.get('https://app.ciptakode.my.id/getData.php', {
      timeout: 15000,
      headers: {
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
    });

    if (response.data?.success) {
      localTitlesCache = response.data.data.map((item) => ({
        content_id: item.content_id,
        title: item.title.toLowerCase().trim(),
      }));
      lastFetchTime = now;
      return localTitlesCache;
    }
  } catch (error) {
    console.error('Failed to fetch local titles:', error.message);
    if (localTitlesCache) return localTitlesCache;
  }
  return [];
}

async function withRetry(fn, context = '', maxRetries = CONFIG.maxRetries) {
  let attempts = 0;
  let lastError = null;

  const retry = async () => {
    try {
      return await fn();
    } catch (error) {
      attempts++;
      lastError = error;
      if (attempts < maxRetries) {
        const delay = Math.min(30000, Math.pow(2, attempts) * 1000);
        console.log(`   ⚠️ [${context}] Attempt ${attempts}/${maxRetries} failed. Retry in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
        return retry();
      }
      throw lastError;
    }
  };

  return retry();
}

class BrowserManager {
  constructor() {
    this.browser = null;
    this.activePages = new Set();
  }

  async launch() {
    this.browser = await puppeteer.launch({
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
      defaultViewport: CONFIG.viewport,
    });
    return this.browser;
  }

  async newPage() {
    if (!this.browser) throw new Error('Browser not initialized');

    const page = await this.browser.newPage();
    this.activePages.add(page);

    await page.setUserAgent(CONFIG.userAgent);
    await page.setDefaultNavigationTimeout(CONFIG.timeout);

    return page;
  }

  async closePage(page) {
    try {
      if (page && !page.isClosed()) {
        await page.close();
        this.activePages.delete(page);
      }
    } catch (e) {
      console.error('Error closing page:', e.message);
      this.activePages.delete(page);
    }
  }

  async close() {
    try {
      await Promise.all(Array.from(this.activePages).map((p) => this.closePage(p)));

      if (this.browser) {
        await this.browser.close();
      }
    } catch (e) {
      console.error('Error closing browser:', e.message);
    } finally {
      this.browser = null;
    }
  }
}

async function processEpisode(browserManager, anime, matched, ep, processingId) {
  const epPage = await browserManager.newPage();

  try {
    console.log(`     [${processingId}] Loading episode page...`);

    await epPage.goto(ep.link, { waitUntil: CONFIG.waitUntil, timeout: CONFIG.timeout });

    console.log(`     [${processingId}] Looking for download links...`);
    await epPage.waitForSelector('#animeDownloadLink', { timeout: 30000 });

    const pixeldrainLinks = await epPage.evaluate(() => {
      const results = [];
      const anchors = document.querySelectorAll('a');

      anchors.forEach((a) => {
        const href = a.href;
        if (href.includes('pixeldrain.com')) {
          let quality = a.textContent.trim();

          if (!quality.match(/\d{3,4}p/)) {
            const prevText = a.previousSibling?.textContent || '';
            const match = prevText.match(/(\d{3,4}p)/);
            quality = match ? match[1] : 'unknown';
          }

          results.push({ quality, url: href });
        }
      });

      return results;
    });

    if (!pixeldrainLinks || pixeldrainLinks.length === 0) {
      console.log(`     ❌ [${processingId}] Tidak ada link pixeldrain ditemukan`);
      return null;
    }

    console.log(`     [${processingId}] Found download links:`);

    let url_480 = '';
    let url_720 = '';

    pixeldrainLinks.forEach((link) => {
      const convertedUrl = convertPixeldrainUrl(link.url);
      console.log(`       ▶ ${link.quality}: ${convertedUrl}`);

      if (link.quality === '480p') url_480 = convertedUrl;
      if (link.quality === '720p') url_720 = convertedUrl;
    });

    if (!url_480 || !url_720) {
      console.log(`     [${processingId}] Salah satu resolusi tidak tersedia (480p / 720p)`);
    }

    const fileName = `${anime.title} episode ${ep.episode}`;
    const episodeNumber = parseInt(ep.episode.replace(/[^\d]/g, ''), 10) || 0;

    const postData = {
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
      title: anime.title,
    };

    console.log(`     [${processingId}] Sending data to server...`);
    const response = await axios.post('https://app.ciptakode.my.id/insertEpisode.php', postData, {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    return response.data;
  } catch (error) {
    console.error(`     ❌ [${processingId}] Processing failed:`, error.message);
    throw error;
  } finally {
    await browserManager.closePage(epPage);
    await new Promise((resolve) => setTimeout(resolve, CONFIG.delayBetweenRequests));
  }
}

async function scrapeKuramanime() {
  const browserManager = new BrowserManager();
  let browser = null;

  try {
    console.log('🚀 Starting scraping process...');
    browser = await browserManager.launch();

    console.log('🔍 Fetching local titles...');
    const localTitles = await getLocalTitles();
    if (localTitles.length === 0) {
      console.log('❌ No local titles found');
      return;
    }

    console.log('🌐 Fetching anime list...');
    const animeList = await withRetry(async () => {
      const page = await browserManager.newPage();
      try {
        await page.goto('https://v6.kuramanime.run/quick/ongoing?order_by=updated&page=1', {
          waitUntil: CONFIG.waitUntil,
          timeout: CONFIG.timeout,
        });

        await page.waitForSelector('.product__item', { timeout: 30000 });

        return await page.evaluate(() => {
          return Array.from(document.querySelectorAll('.product__item'))
            .map((item) => {
              const linkElem = item.querySelector('h5 a');
              return {
                title: linkElem ? linkElem.textContent.trim() : '',
                link: linkElem ? linkElem.href : '',
              };
            })
            .filter((item) => item.title && item.link);
        });
      } finally {
        await browserManager.closePage(page);
      }
    }, 'Fetch Anime List');

    for (const anime of animeList) {
      console.log(`\n🎬 Processing anime: ${anime.title}`);

      const matched = localTitles.find((lt) =>
        anime.title.toLowerCase().trim().includes(lt.title)
      );

      if (!matched) {
        console.log(`   ⚠️ Anime tidak ditemukan di database lokal: ${anime.title}`);
        continue;
      }

      console.log(`   ✅ Ditemukan di database lokal: ${matched.title || matched.content_id}`);

      const episodes = await withRetry(async () => {
        const page = await browserManager.newPage();
        try {
          await page.goto(anime.link, { waitUntil: CONFIG.waitUntil, timeout: CONFIG.timeout });
          await page.waitForSelector('.product__episode', { timeout: 30000 });

          return await page.evaluate(() => {
            return Array.from(document.querySelectorAll('.product__episode a')).map((ep) => ({
              episode: ep.textContent.trim(),
              link: ep.href,
            }));
          });
        } finally {
          await browserManager.closePage(page);
        }
      }, `Fetch Episodes for ${anime.title}`);

        if (episodes.length > 0) {
            const latestEpisode = episodes[0]; // Asumsikan episode terbaru ada di urutan pertama
            const processingId = `${matched.content_id}_${latestEpisode.episode}`;
            try {
              await withRetry(() => processEpisode(browserManager, anime, matched, latestEpisode, processingId), `Episode ${processingId}`);
              console.log(`     ✅ [${processingId}] Selesai diproses`);
            } catch (e) {
              console.error(`     ❌ [${processingId}] Gagal memproses episode`);
            }
          } else {
            console.log(`     ⚠️ Tidak ditemukan episode untuk ${anime.title}`);
          }

      }
    }

    console.log('🏁 Scraping selesai.');
  } catch (error) {
    console.error('❌ Error utama:', error);
  } finally {
    if (browserManager) await browserManager.close();
  }
}

module.exports = { scrapeKuramanime };
