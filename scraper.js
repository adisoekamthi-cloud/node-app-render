const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const moment = require('moment');

puppeteer.use(StealthPlugin());

// Enhanced configuration with detailed options
const CONFIG = {
  maxRetries: 3,
  timeout: 120000, // 2 minute timeout
  delayBetweenRequests: 5000, // 5 second delay
  headless: true,
  maxConcurrentPages: 1, // Process one at a time for stability
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36',
  waitUntil: 'networkidle2',
  viewport: { width: 1920, height: 1080 }
};

// Comprehensive URL converter with multiple patterns
function convertPixeldrainUrl(url) {
  if (!url) return null;

  try {
    const patterns = [
      // Format standar: https://pixeldrain.com/d/xxxx atau /u/xxxx
      /https?:\/\/pixeldrain\.com\/[du]\/([a-zA-Z0-9]+)/,

      // Format API lama: https://pixeldrain.com/api/filesystem/xxxx
      /https?:\/\/pixeldrain\.com\/api\/filesystem\/([a-zA-Z0-9]+)/,

      // Format dengan parameter: https://pixeldrain.com/d/xxxx?token=...
      /https?:\/\/pixeldrain\.com\/d\/([a-zA-Z0-9]+)\?/
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        return `https://pixeldrain.com/api/filesystem/${match[1]}?attach`;
      }
    }

    return url; // Jika tidak cocok, kembalikan URL asli
  } catch (e) {
    console.error('URL Conversion Error:', e);
    return url;
  }
}


// Enhanced local titles fetching with caching
let localTitlesCache = null;
let lastFetchTime = 0;
const CACHE_DURATION = 3600000; // 1 hour cache

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
    if (localTitlesCache) return localTitlesCache; // Return cached if available
  }
  
  return [];
}

// Robust retry mechanism with exponential backoff
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
        const delay = Math.min(30000, Math.pow(2, attempts) * 1000); // Exponential backoff with max 30s
        console.log(`   ⚠️ [${context}] Attempt ${attempts}/${maxRetries} failed. Retrying in ${delay/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return retry();
      }
      throw lastError;
    }
  };
  
  return retry();
}

// Enhanced browser instance management
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
    if (!this.browser) {
      throw new Error('Browser not initialized');
    }
    
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
      // Close all active pages first
      await Promise.all(Array.from(this.activePages).map(p => this.closePage(p)));
      
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

// Comprehensive download link extractor
async function extractDownloadLinks(page) {
  return await page.evaluate(() => {
    const result = {
      pixeldrain: {},
      other: {}
    };

    const container = document.querySelector('#animeDownloadLink');
    if (!container) return null;

    const children = Array.from(container.children);
    for (let i = 0; i < children.length; i++) {
      const node = children[i];

      if (node.tagName === 'H6' && node.classList.contains('font-weight-bold')) {
        const title = node.textContent.trim();
        const resolution = title.match(/(\d{3,4}p)/)?.[0] || 'unknown';
        const isHardsub = title.toLowerCase().includes('hardsub');

        // Cari <a> setelah <h6>, biasanya setelah <hr>
        let nextLink = null;
        for (let j = i + 1; j < children.length; j++) {
          if (children[j].tagName === 'A') {
            nextLink = children[j];
            break;
          }
        }

        if (nextLink && nextLink.href) {
          const link = {
            url: nextLink.href,
            label: nextLink.textContent.trim() || 'link',
            type: nextLink.href.includes('pixeldrain.com') ? 'pixeldrain' : 'other',
            isHardsub
          };

          const group = link.type === 'pixeldrain' ? result.pixeldrain : result.other;

          if (!group[resolution]) {
            group[resolution] = [];
          }

          group[resolution].push(link);
        }
      }
    }

    return result;
  });
}




// Enhanced episode processor
async function processEpisode(browserManager, anime, matched, ep, processingId) {
  const epPage = await browserManager.newPage();
  try {
    console.log(`     [${processingId}] Loading episode page...`);
    
    await epPage.goto(ep.link, {
      waitUntil: CONFIG.waitUntil,
      timeout: CONFIG.timeout
    });

    // Wait for download section to load
    console.log(`     [${processingId}] Looking for download links...`);
    await epPage.waitForSelector('#animeDownloadLink', { timeout: 30000 });

    // Extract all download links
    const downloadData = await extractDownloadLinks(epPage);
    if (!downloadData || !downloadData.pixeldrain) {
      console.log(`     ❌ [${processingId}] No download links found`);
      return null;
    }

    // Process PixelDrain links first
    let url_480 = '';
    let url_720 = '';
    
    console.log(`     [${processingId}] Found download links:`);
    
    // Process by resolution
    for (const [resolution, links] of Object.entries(downloadData.pixeldrain)) {
      if (links.length > 0) {
        const convertedUrl = convertPixeldrainUrl(links[0].url);
        console.log(`       ▶ ${resolution}: ${convertedUrl}`);
        
        if (resolution === '480p') url_480 = convertedUrl;
        if (resolution === '720p') url_720 = convertedUrl;
      }
    }

    // Fallback to other links if no PixelDrain found
    if (!url_480 || !url_720) {
      console.log(`     [${processingId}] Checking alternative links...`);
     for (const [resolution, links] of Object.entries(downloadData.other || {})) {
        if (links.length > 0) {
          console.log(`       ▶ ${resolution}: ${links[0].url} (${links[0].type})`);
          
          if (resolution === '480p' && !url_480) url_480 = links[0].url;
          if (resolution === '720p' && !url_720) url_720 = links[0].url;
        }
      }
    }

    // Prepare data for API
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
      headers: {
        'Content-Type': 'application/json'
      }
    });

    return response.data;
  } catch (error) {
    console.error(`     ❌ [${processingId}] Processing failed:`, error.message);
    throw error;
  } finally {
    await browserManager.closePage(epPage);
    await new Promise(resolve => setTimeout(resolve, CONFIG.delayBetweenRequests));
  }
}

// Main scraping function
async function scrapeKuramanime() {
  const browserManager = new BrowserManager();
  let browser = null;

  try {
    // Initialize
    console.log('🚀 Starting scraping process...');
    browser = await browserManager.launch();
    
    // Get local titles
    console.log('🔍 Fetching local titles...');
    const localTitles = await getLocalTitles();
    if (localTitles.length === 0) {
      console.log('❌ No local titles found');
      return;
    }

    // Get anime list
    console.log('🌐 Fetching anime list...');
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

        if (!episodes.length) {
          console.warn('   ⚠️ No episodes found, skipping...');
          return;
        }

        console.log(`   Found ${episodes.length} episodes`);

        for (const [epIndex, ep] of episodes.entries()) {
          const processingId = Math.random().toString(36).substring(2, 8);
          console.log(`   ${epIndex + 1}/${episodes.length} [${processingId}] Processing: ${ep.episode}`);

          try {
            const result = await processEpisode(browserManager, anime, matched, ep, processingId);
            if (result) {
              console.log(`     ✅ [${processingId}] Server response: ${result.message || 'Success'}`);
            }
          } catch (epError) {
            console.error(`     ❌ [${processingId}] Failed to process episode: ${epError.message}`);
            console.error(epError.stack);
          }
        }
      } finally {
        await browserManager.closePage(animePage);
      }
    }, `process anime ${anime.title}`);
  } catch (animeError) {
    console.error(`❌ Failed to process anime: ${animeError.message}`);
    console.error(animeError.stack);
  }
}

console.log('🛑 Closing browser...');
await browserManager.close();
console.log('✅ Scraping process completed');

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
