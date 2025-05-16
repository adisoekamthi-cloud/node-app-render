const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const moment = require('moment');

puppeteer.use(StealthPlugin());

const CONFIG = {
  maxRetries: 3,
  timeout: 120000,
  delayBetweenRequests: 5000,
  headless: true,
  maxConcurrentPages: 1,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36',
  waitUntil: 'networkidle2',
  viewport: { width: 1920, height: 1080 }
};

function convertPixeldrainUrl(url) {
  const match = url.match(/pixeldrain\.com\/(?:[a-z]+\/)?([a-zA-Z0-9]+)/);
  if (match) {
    return `https://pixeldrain.com/api/filesystem/${match[1]}?attach`;
  }
  return null;
}

let localTitlesCache = null;
let lastFetchTime = 0;
const CACHE_DURATION = 3600000;

async function getLocalTitles() {
  const now = Date.now();
  if (localTitlesCache && (now - lastFetchTime) < CACHE_DURATION) {
    return localTitlesCache;
  }
  try {
    const response = await axios.get('https://app.ciptakode.my.id/getData.php', {
      timeout: 15000,
      headers: {
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });
    if (response.data?.success) {
      localTitlesCache = response.data.data.map(item => ({
        content_id: item.content_id,
        title: item.title.toLowerCase().trim()
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
        console.log(`   ⚠️ [${context}] Attempt ${attempts}/${maxRetries} failed. Retrying in ${delay/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
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
      defaultViewport: CONFIG.viewport
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
      await Promise.all(Array.from(this.activePages).map(p => this.closePage(p)));
      if (this.browser) await this.browser.close();
    } catch (e) {
      console.error('Error closing browser:', e.message);
    } finally {
      this.browser = null;
    }
  }
}

async function processEpisode(browserManager, anime, matched, ep, processingId) {
  let epPage;
  try {
    epPage = await browserManager.newPage();
    console.log(`     [${processingId}] Loading episode page...`);
    await epPage.goto(ep.link, { waitUntil: CONFIG.waitUntil, timeout: CONFIG.timeout });

    console.log(`     [${processingId}] Looking for download links...`);
    await epPage.waitForSelector('#animeDownloadLink', { timeout: 30000 });

    // Cek apakah page masih terbuka
    if (epPage.isClosed()) throw new Error('Page closed unexpectedly');

    const downloadData = await epPage.evaluate(() => {
      const container = document.querySelector('#animeDownloadLink');
      if (!container) return null;

      const result = { pixeldrain: {}, other: {} };
      let currentSection = null;

      container.childNodes.forEach(node => {
        if (node.nodeType === 1) {
          if (node.tagName === 'H6' && node.classList.contains('font-weight-bold')) {
            const text = node.textContent.trim();
            currentSection = {
              resolution: text.match(/(\d{3,4}p)/i)?.[0] || 'unknown',
              isHardsub: /hardsub/i.test(text),
            };
          } else if (node.tagName === 'A' && node.href && currentSection) {
            const rawUrl = node.href;
            const type = rawUrl.includes('pixeldrain.com') ? 'pixeldrain' : 'other';
            if (!result[type][currentSection.resolution]) result[type][currentSection.resolution] = [];
            result[type][currentSection.resolution].push({
              url: rawUrl,
              label: node.textContent.trim(),
              type
            });
          }
        }
      });

      return result;
    });

    if (!downloadData || Object.keys(downloadData).length === 0) {
      console.log(`     ❌ [${processingId}] No download links found`);
      return null;
    }

    let url_480 = '';
    let url_720 = '';

    console.log(`     [${processingId}] Found download links:`);

    for (const [resolution, links] of Object.entries(downloadData.pixeldrain || {})) {
      if (links.length > 0) {
        if (resolution === '480p' || resolution === '720p') {
          const convertedUrl = convertPixeldrainUrl(links[0].url);
          if (convertedUrl) {
            console.log(`       ▶ ${resolution}: ${convertedUrl}`);
            if (resolution === '480p') url_480 = convertedUrl;
            if (resolution === '720p') url_720 = convertedUrl;
          }
        }
      }
    }

    if (!url_480 || !url_720) {
      console.log(`     [${processingId}] Checking alternative links...`);
      for (const [resolution, links] of Object.entries(downloadData.other || {})) {
        if (links.length > 0) {
          if (resolution === '480p' || resolution === '720p') {
            console.log(`       ▶ ${resolution}: ${links[0].url} (${links[0].type})`);
            if (resolution === '480p' && !url_480) url_480 = links[0].url;
            if (resolution === '720p' && !url_720) url_720 = links[0].url;
          }
        }
      }
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
      title: anime.title
    };

    console.log(`     [${processingId}] Sending data to server...`);
    const response = await axios.post('https://app.ciptakode.my.id/insertEpisode.php', postData, {
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' }
    });

    return response.data;
  } catch (error) {
    console.error(`     ❌ [${processingId}] Processing failed:`, error.message);
    throw error;
  } finally {
    if (epPage && !epPage.isClosed()) {
      try {
        await epPage.close();
      } catch (e) {
        console.error(`Error closing page [${processingId}]:`, e.message);
      }
    }
    // Delay setelah tutup page untuk stabilitas browser
    await new Promise(resolve => setTimeout(resolve, CONFIG.delayBetweenRequests));
  }
}

async function scrapeKuramanime() {
  let browserManager = new BrowserManager();
  await browserManager.launch();

  try {
    console.log('🚀 Starting scraping process...');
    const localTitles = await getLocalTitles();
    if (localTitles.length === 0) {
      console.log('❌ No local titles found');
      return;
    }

    const animeList = await withRetry(async () => {
      const page = await browserManager.newPage();
      try {
        await page.goto('https://v6.kuramanime.run/quick/ongoing?order_by=updated&page=1', {
          waitUntil: CONFIG.waitUntil,
          timeout: CONFIG.timeout
        });
        await page.waitForSelector('.product__item', { timeout: 30000 });
        return await page.evaluate(() => {
          return Array.from(document.querySelectorAll('.product__item')).map(item => {
            const linkElem = item.querySelector('h5 a');
            return {
              title: linkElem?.textContent?.trim() || 'No title',
              link: linkElem?.href || null,
              image: item.querySelector('img')?.src || null
            };
          }).filter(a => a.link);
        });
      } finally {
        await browserManager.closePage(page);
      }
    }, 'fetch anime list');

    console.log(`📊 Found ${animeList.length} anime`);

    for (const [index, anime] of animeList.entries()) {
      const animeTitleLower = anime.title.toLowerCase().trim();
      const matched = localTitles.find(item => item.title === animeTitleLower);
      if (!matched) continue;

      console.log(`\n🎬 Processing (${index + 1}/${animeList.length}): ${anime.title}`);
      console.log(`🆔 Content ID: ${matched.content_id}`);

      try {
        await withRetry(async () => {
          const animePage = await browserManager.newPage();
          try {
            console.log('   🌐 Loading anime page...');
            await animePage.goto(anime.link, {
              waitUntil: CONFIG.waitUntil,
              timeout: CONFIG.timeout
            });

            console.log('   📺 Finding episodes...');
            await animePage.waitForSelector('#animeEpisodes a.ep-button', { timeout: 30000 });

            const episodes = await animePage.evaluate(() => {
              return Array.from(document.querySelectorAll('#animeEpisodes a.ep-button')).map(ep => ({
                episode: ep.innerText.trim().replace(/\s+/g, ' '),
                link: ep.href
              }));
            });

            console.log(`   📺 Found ${episodes.length} episodes`);

            for (const [epIndex, ep] of episodes.entries()) {
              try {
                await processEpisode(browserManager, anime, matched, ep, `Ep${epIndex + 1}`);
              } catch (epErr) {
                console.error(`   ❌ Error processing episode ${ep.episode}:`, epErr.message);
              }
            }
          } finally {
            await browserManager.closePage(animePage);
          }
        }, `anime ${anime.title}`, CONFIG.maxRetries);
      } catch (e) {
        console.error(`❌ Failed processing anime ${anime.title}:`, e.message);
      }
    }
  } catch (err) {
    console.error('❌ Scraping error:', err.message);
  } finally {
    await browserManager.close();
    console.log('✔️ Scraping finished');
  }
}

// Start the scraping process
(async () => {
  try {
    await scrapeKuramanime();
  } catch (e) {
    console.error('⛔ Fatal error:', e);
    process.exit(1);
  }
})();

module.exports = { scrapeKuramanime };
