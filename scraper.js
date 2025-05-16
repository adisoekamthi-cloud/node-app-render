const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const moment = require('moment');

puppeteer.use(StealthPlugin());

const CONFIG = {
  maxRetries: 3,
  timeout: 120000,
  delayBetweenRequests: 5000, // delay 5 detik antar request
  headless: true,
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
const CACHE_DURATION = 3600000; // cache 1 jam

async function getLocalTitles() {
  const now = Date.now();
  if (localTitlesCache && (now - lastFetchTime) < CACHE_DURATION) {
    return localTitlesCache;
  }
  try {
    const res = await axios.get('https://app.ciptakode.my.id/getData.php', {
      timeout: 15000,
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' }
    });
    if (res.data?.success) {
      localTitlesCache = res.data.data.map(item => ({
        content_id: item.content_id,
        title: item.title.toLowerCase().trim()
      }));
      lastFetchTime = now;
      return localTitlesCache;
    }
  } catch (err) {
    console.error('Gagal ambil data lokal:', err.message);
    if (localTitlesCache) return localTitlesCache;
  }
  return [];
}

async function withRetry(fn, context = '', maxRetries = CONFIG.maxRetries) {
  let attempts = 0;
  let lastError = null;
  async function attempt() {
    try {
      return await fn();
    } catch (err) {
      attempts++;
      lastError = err;
      if (attempts < maxRetries) {
        const delay = Math.min(30000, Math.pow(2, attempts) * 1000);
        console.log(`⚠️ [${context}] Gagal percobaan ${attempts}/${maxRetries}, retry dalam ${delay/1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        return attempt();
      }
      throw lastError;
    }
  }
  return attempt();
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
        '--js-flags=--max-old-space-size=4096',
        '--disable-features=site-per-process'
      ],
      defaultViewport: CONFIG.viewport
    });
    return this.browser;
  }

  async newPage() {
    if (!this.browser) throw new Error('Browser belum diinisialisasi');
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
      }
    } catch (e) {
      console.error('Error tutup page:', e.message);
    } finally {
      this.activePages.delete(page);
    }
  }

  async close() {
    try {
      await Promise.all(Array.from(this.activePages).map(p => this.closePage(p)));
      if (this.browser) await this.browser.close();
    } catch (e) {
      console.error('Error tutup browser:', e.message);
    } finally {
      this.browser = null;
    }
  }
}

async function processEpisode(browserManager, anime, matched, ep, id) {
  let epPage;
  try {
    epPage = await browserManager.newPage();
    console.log(`  [${id}] Buka episode: ${ep.episode}`);

    await epPage.goto(ep.link, { waitUntil: CONFIG.waitUntil, timeout: CONFIG.timeout });
    await epPage.waitForSelector('#animeDownloadLink', { timeout: 30000 });

    if (epPage.isClosed()) throw new Error('Page episode tertutup tiba-tiba');

    // Ambil link download pixeldrain
    const downloadData = await epPage.evaluate(() => {
      const container = document.querySelector('#animeDownloadLink');
      if (!container) return null;
      const result = { pixeldrain: {} };
      let currentRes = null;

      container.childNodes.forEach(node => {
        if (node.nodeType !== 1) return;

        if (node.tagName === 'H6' && node.classList.contains('font-weight-bold')) {
          const resMatch = node.textContent.match(/(\d{3,4}p)/i);
          currentRes = resMatch ? resMatch[1] : 'unknown';
        } else if (node.tagName === 'A' && node.href && currentRes) {
          if (!result.pixeldrain[currentRes]) result.pixeldrain[currentRes] = [];
          if (node.href.includes('pixeldrain.com')) result.pixeldrain[currentRes].push(node.href);
        }
      });
      return result;
    });

    if (!downloadData) {
      console.log(`  [${id}] ❌ Tidak ada link download ditemukan`);
      return null;
    }

    let url_480 = '';
    let url_720 = '';

    for (const [res, links] of Object.entries(downloadData.pixeldrain || {})) {
      if (links.length > 0) {
        const converted = convertPixeldrainUrl(links[0]) || links[0];
        if (/480p/i.test(res)) url_480 = converted;
        if (/720p/i.test(res)) url_720 = converted;
        console.log(`    ▶ ${res}: ${converted}`);
      }
    }

    const fileName = `${anime.title} episode ${ep.episode}`;
    const episodeNumber = parseInt(ep.episode.replace(/[^\d]/g, ''), 10) || 0;

    const payload = {
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

    console.log(`  [${id}] Kirim data ke server...`);
    const res = await axios.post('https://app.ciptakode.my.id/insertEpisode.php', payload, {
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' }
    });
    console.log(`  [${id}] Berhasil kirim data:`, res.data);

    return res.data;

  } catch (error) {
    console.error(`  [${id}] Error proses episode:`, error.message);
    throw error;
  } finally {
    if (epPage && !epPage.isClosed()) {
      try {
        await epPage.close();
      } catch (e) {
        console.error(`  [${id}] Error tutup halaman episode:`, e.message);
      }
    }
    await new Promise(r => setTimeout(r, CONFIG.delayBetweenRequests)); // delay stabilitas
  }
}

async function scrapeKuramanime() {
  const browserManager = new BrowserManager();
  await browserManager.launch();

  try {
    console.log('🚀 Mulai scraping kuramanime...');
    const localTitles = await getLocalTitles();
    if (localTitles.length === 0) {
      console.log('❌ Tidak ada judul lokal ditemukan');
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
              link: linkElem?.href || null
            };
          }).filter(a => a.link);
        });
  } finally {
    await browserManager.closePage(page);
  }
}, 'Ambil daftar anime');

console.log(`📄 Ditemukan ${animeList.length} anime`);

for (const anime of animeList) {
  const match = localTitles.find(t => anime.title.toLowerCase().includes(t.title));
  if (!match) continue;

  console.log(`🔍 Cek anime: ${anime.title}`);
  const page = await browserManager.newPage();
  try {
    await page.goto(anime.link, { waitUntil: CONFIG.waitUntil, timeout: CONFIG.timeout });
    await page.waitForSelector('#epsList', { timeout: 30000 });

    const episodes = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('#epsList a')).map(ep => ({
        episode: ep.textContent.trim(),
        link: ep.href
      }));
    });

    console.log(`📺 ${anime.title} - ${episodes.length} episode ditemukan`);

    for (let i = 0; i < episodes.length; i++) {
      await withRetry(() =>
        processEpisode(browserManager, anime, match, episodes[i], `${match.content_id}-${i + 1}`),
        `Episode ${i + 1}`
      );
    }

  } catch (err) {
    console.error(`❌ Gagal proses anime ${anime.title}:`, err.message);
  } finally {
    await browserManager.closePage(page);
  }
}
} catch (err) {
console.error('❌ Terjadi error utama:', err.message);
} finally {
await browserManager.close();
console.log('✅ Selesai scraping.');
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
