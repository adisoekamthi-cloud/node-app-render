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
  maxConcurrentPages: 3,
};

// Improved URL validation with error handling
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

// Enhanced local titles fetching with timeout
async function getLocalTitles() {
  try {
    const response = await axios.get('https://app.ciptakode.my.id/getData.php', {
      timeout: 10000
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

// More robust retry mechanism
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

// Enhanced download links extraction
async function extractDownloadLinks(page) {
  return await page.evaluate(() => {
    const result = {};
    const container = document.querySelector('#animeDownloadLink');
    if (!container) return null;

    const qualitySections = Array.from(container.querySelectorAll('h6.font-weight-bold'));
    
    qualitySections.forEach(header => {
      const qualityText = header.innerText.trim();
      const resolutionMatch = qualityText.match(/(\d+p)/i);
      const resolution = resolutionMatch ? resolutionMatch[0] : '';
      const isHardsub = /hardsub/i.test(qualityText);
      
      let sib = header.nextElementSibling;
      const links = [];

      while (sib && sib.tagName !== 'H6') {
        if (sib.tagName === 'A' && sib.href) {
          links.push({
            url: sib.href,
            label: sib.innerText.trim() || 'Unknown',
            type: sib.href.includes('pixeldrain.com') ? 'pixeldrain' : 'other'
          });
        }
        sib = sib.nextElementSibling;
      }

      if (links.length > 0 && resolution) {
        if (!result[resolution]) {
          result[resolution] = {
            quality: qualityText,
            links: []
          };
        }
        result[resolution].links.push(...links.filter(link => link.type === 'pixeldrain'));
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
        await page.close();
      }
    }, 'mengambil daftar anime');

    console.log(`📊 Ditemukan ${animeList.length} anime`);

    // Process anime with concurrency control
    const processingQueue = [];
    const activePages = new Set();

    for (const anime of animeList) {
      const animeTitleLower = anime.title.toLowerCase().trim();
      const matched = localTitles.find(item => item.title === animeTitleLower);
      if (!matched) continue;

      console.log(`\n🎬 Memproses: ${anime.title}`);
      console.log(`🆔 ID Konten: ${matched.content_id}`);

      try {
        // Wait if we have too many concurrent pages
        while (activePages.size >= CONFIG.maxConcurrentPages) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        const animePage = await browser.newPage();
        activePages.add(animePage);
        processingQueue.push(
          processAnime(browser, animePage, anime, matched).finally(() => {
            activePages.delete(animePage);
          })
        );
      } catch (animeError) {
        console.log(`❌ Gagal memproses anime: ${animeError.message}`);
      }
    }

    // Wait for all anime processing to complete
    await Promise.all(processingQueue);
    
  } catch (mainError) {
    console.error('🔥 Error utama:', mainError);
  } finally {
    await browser.close();
    console.log('✅ Proses scraping selesai');
  }
}

// Process individual anime
async function processAnime(browser, animePage, anime, matched) {
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
            await epPage.waitForSelector('#animeDownloadLink', { timeout: 15000 });
            return await extractDownloadLinks(epPage);
          }, `mengambil link download ${ep.episode}`);

          let url_480 = '', url_720 = '';
          if (downloadLinks) {
            // Process 480p links
            if (downloadLinks['480p']?.links?.length > 0) {
              const convertedUrl = convertPixeldrainUrl(downloadLinks['480p'].links[0].url);
              if (convertedUrl) {
                url_480 = convertedUrl;
                console.log(`     ▶ 480p: ${convertedUrl}`);
              }
            }
            
            // Process 720p links
            if (downloadLinks['720p']?.links?.length > 0) {
              const convertedUrl = convertPixeldrainUrl(downloadLinks['720p'].links[0].url);
              if (convertedUrl) {
                url_720 = convertedUrl;
                console.log(`     ▶ 720p: ${convertedUrl}`);
              }
            }
          } else {
            console.log('     ❌ Tidak menemukan link download');
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
}

scrapeKuramanime().catch(e => {
  console.error('⛔ Error di fungsi utama:', e);
});

module.exports = { scrapeKuramanime };
