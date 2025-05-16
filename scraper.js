const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const moment = require('moment');

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

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36');
    await page.setDefaultNavigationTimeout(60000);

    // Scrape anime list
    console.log('🚀 Mengambil daftar anime...');
    await page.goto('https://v6.kuramanime.run/quick/ongoing?order_by=updated&page=1', { 
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    const animeList = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.product__item')).map(item => {
        const linkElem = item.querySelector('h5 a');
        return {
          title: linkElem?.textContent?.trim() || 'Tidak ada judul',
          link: linkElem?.href || null
        };
      }).filter(a => a.link);
    });

    console.log(`📊 Ditemukan ${animeList.length} anime`);

    for (const anime of animeList) {
      const animeTitleLower = anime.title.toLowerCase();
      const matched = localTitles.find(item => item.title === animeTitleLower);
      if (!matched) continue;

      console.log(`\n🎬 Memproses: ${anime.title}`);
      console.log(`🆔 ID Konten: ${matched.content_id}`);

      try {
        const animePage = await browser.newPage();
        await animePage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36');
        await animePage.setDefaultNavigationTimeout(60000);

        console.log('   🌐 Membuka halaman anime...');
        await animePage.goto(anime.link, { waitUntil: 'networkidle2' });
        
        try {
          await animePage.waitForSelector('#animeEpisodes a.ep-button', { timeout: 15000 });
        } catch (e) {
          console.log('   ❌ Tidak menemukan daftar episode');
          await animePage.close();
          continue;
        }

        const episodes = await animePage.evaluate(() => {
          return Array.from(document.querySelectorAll('#animeEpisodes a.ep-button')).map(ep => ({
            episode: ep.innerText.trim().replace(/\s+/g, ' '),
            link: ep.href
          }));
        });

        console.log(`   📺 Ditemukan ${episodes.length} episode`);

        for (const [index, ep] of episodes.entries()) {
          console.log(`   ${index + 1}/${episodes.length} Memproses episode: ${ep.episode}`);

          try {
            const epPage = await browser.newPage();
            await epPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36');
            await epPage.setDefaultNavigationTimeout(60000);

            await epPage.goto(ep.link, { waitUntil: 'networkidle2' });
            
            try {
              await epPage.waitForSelector('#animeDownloadLink', { timeout: 10000 });
            } catch {
              console.log('     ❌ Gagal menemukan link download');
              await epPage.close();
              continue;
            }

            const pixeldrainLinks = await epPage.evaluate(() => {
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

            let url_480 = '', url_720 = '', url_1080 = '', url_1440 = '', url_2160 = '';

            if (pixeldrainLinks) {
              for (const [quality, links] of Object.entries(pixeldrainLinks)) {
                const convertedLinks = links.map(rawUrl => convertPixeldrainUrl(rawUrl) || rawUrl);
                console.log(`     ▶ ${quality}:`);
                convertedLinks.forEach(link => console.log(`       • ${link}`));

                if (/480p/i.test(quality)) url_480 = convertedLinks[0];
                if (/720p/i.test(quality)) url_720 = convertedLinks[0];
              }
            } else {
              console.log('     ❌ Tidak ada link pixeldrain ditemukan');
            }

            const fileName = `${anime.title} episode ${ep.episode}`;
            const episodeNumber = parseInt(ep.episode.replace(/[^\d]/g, ''), 10);
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

              console.log('     ✅ Response server:', insertRes.data.message || insertRes.data);
            } catch (err) {
              console.log('     ❌ Gagal mengirim ke server:', err.response?.data?.message || err.message);
            }

            await epPage.close();
          } catch (epError) {
            console.log(`     ❌ Error memproses episode: ${epError.message}`);
          }
        }

        await animePage.close();
      } catch (animeError) {
        console.log(`❌ Error memproses anime: ${animeError.message}`);
      }
    }
  } catch (mainError) {
    console.error('🔥 Error utama:', mainError);
  } finally {
    await browser.close();
    console.log('✅ Proses scraping selesai');
  }
}

scrapeKuramanime().catch(e => {
  console.error('⛔ Error di fungsi utama:', e);
});

module.exports = { scrapeKuramanime };
