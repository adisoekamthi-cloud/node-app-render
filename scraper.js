const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const moment = require('moment');

puppeteer.use(StealthPlugin());

// Enhanced configuration
const CONFIG = {
  maxRetries: 3,
  timeout: 90000,
  delayBetweenRequests: 3000,
  headless: true,
  maxConcurrentPages: 1
};

// Your exact PixelDrain URL converter
function convertPixeldrainUrl(url) {
  const regex = /https?:\/\/pixeldrain\.com\/[du]\/([a-zA-Z0-9]+)/;
  const match = url.match(regex);
  if (match) {
    return `https://pixeldrain.com/api/filesystem/${match[1]}?attach`;
  }
  return null;
}

// Enhanced local titles fetching
async function getLocalTitles() {
  try {
    const response = await axios.get('https://app.ciptakode.my.id/getData.php', {
      timeout: 15000
    });
    if (response.data?.success) {
      return response.data.data.map(item => ({
        content_id: item.content_id,
        title: item.title.toLowerCase().trim()
      }));
    }
  } catch (error) {
    console.error('Gagal mengambil data dari server:', error.message);
  }
  return [];
}

// Robust retry mechanism
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

// Enhanced download link extractor
async function extractDownloadLinks(page) {
  return await page.evaluate(() => {
    const result = {};
    const container = document.querySelector('#animeDownloadLink');
    if (!container) return null;

    // Process all quality sections
    const qualitySections = Array.from(container.querySelectorAll('h6.font-weight-bold'));
    
    qualitySections.forEach(header => {
      const qualityText = header.innerText.trim();
      const resolutionMatch = qualityText.match(/(\d+p)/i);
      if (!resolutionMatch) return;

      const resolution = resolutionMatch[0];
      let sib = header.nextElementSibling;
      const links = [];

      // Collect all links until next header
      while (sib && sib.tagName !== 'H6') {
        if (sib.tagName === 'A' && sib.href) {
          links.push({
            url: sib.href,
            label: sib.innerText.trim() || 'Extra',
            type: sib.href.includes('pixeldrain.com') ? 'pixeldrain' : 'other'
          });
        }
        sib = sib.nextElementSibling;
      }

      if (links.length > 0) {
        result[resolution] = links;
      }
    });

    return result;
  });
}

// Main scraping function
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
    
    // Get anime list
    const animeList = await withRetry(async () => {
      const page = await browser.newPage();
      try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36');
        await page.setDefaultNavigationTimeout(CONFIG.timeout);

        await page.goto('https://v6.kuramanime.run/quick/ongoing?order_by=updated&page=1', {
          waitUntil: 'domcontentloaded',
          timeout: CONFIG.timeout
        });

        await page.waitForSelector('.product__item', { timeout: 30000 });

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
        await page.close();
      }
    }, 'mengambil daftar anime');

    console.log(`📊 Ditemukan ${animeList.length} anime`);

    // Process anime sequentially
    for (const anime of animeList) {
      const animeTitleLower = anime.title.toLowerCase().trim();
      const matched = localTitles.find(item => item.title === animeTitleLower);
      if (!matched) continue;

      console.log(`\n🎬 Memproses: ${anime.title}`);
      console.log(`🆔 ID Konten: ${matched.content_id}`);

      try {
        const animePage = await browser.newPage();
        try {
          await animePage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36');
          await animePage.setDefaultNavigationTimeout(CONFIG.timeout);

          await animePage.goto(anime.link, { 
            waitUntil: 'domcontentloaded',
            timeout: CONFIG.timeout
          });

          const episodes = await withRetry(async () => {
            await animePage.waitForSelector('#animeEpisodes a.ep-button', { timeout: 30000 });
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
              const epPage = await browser.newPage();
              try {
                await epPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36');
                await epPage.setDefaultNavigationTimeout(CONFIG.timeout);

                await epPage.goto(ep.link, { 
                  waitUntil: 'domcontentloaded',
                  timeout: CONFIG.timeout
                });

                const downloadLinks = await withRetry(async () => {
                  await epPage.waitForSelector('#animeDownloadLink', { timeout: 30000 });
                  return await extractDownloadLinks(epPage);
                }, `mengambil link download ${ep.episode}`);

                let url_480 = '', url_720 = '';
                if (downloadLinks) {
                  // Process 480p links
                  if (downloadLinks['480p']) {
                    const pixelLinks = downloadLinks['480p'].filter(link => link.type === 'pixeldrain');
                    if (pixelLinks.length > 0) {
                      url_480 = convertPixeldrainUrl(pixelLinks[0].url);
                      console.log(`     ▶ 480p: ${url_480 || 'Tidak valid'}`);
                    }
                  }
                  
                  // Process 720p links
                  if (downloadLinks['720p']) {
                    const pixelLinks = downloadLinks['720p'].filter(link => link.type === 'pixeldrain');
                    if (pixelLinks.length > 0) {
                      url_720 = convertPixeldrainUrl(pixelLinks[0].url);
                      console.log(`     ▶ 720p: ${url_720 || 'Tidak valid'}`);
                    }
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
                  }, { timeout: 15000 });
                  return response.data;
                }, `mengirim data episode ${ep.episode}`);

                console.log(`     ✅ [${processingId}] Response: ${result.message || 'Berhasil'}`);
              } finally {
                await epPage.close();
                await new Promise(resolve => setTimeout(resolve, CONFIG.delayBetweenRequests));
              }
            } catch (epError) {
              console.log(`     ❌ [${processingId}] Gagal memproses episode: ${epError.message}`);
            }
          }
        } finally {
          await animePage.close();
        }
      } catch (animeError) {
        console.log(`❌ Gagal memproses anime: ${animeError.message}`);
      }
    }
  } catch (mainError) {
    console.error('🔥 Error utama:', mainError);
  } finally {
    await browser.close();
    console.log('✅ Proses scraping selesai');
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
