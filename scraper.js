const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const moment = require('moment');

puppeteer.use(StealthPlugin());

// Configuration
const CONFIG = {
  timeout: 60000,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36',
  waitUntil: 'networkidle2'
};

// PixelDrain URL converter
function convertPixeldrainUrl(url) {
    const regex = /https?:\/\/pixeldrain\.com\/[du]\/([a-zA-Z0-9]+)/;
    const match = url.match(regex);
    if (match) {
        return `https://pixeldrain.com/api/filesystem/${match[1]}?attach`;
    }
    return null;
}

// Get local titles from server
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

// Main scraping function
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
    await page.setUserAgent(CONFIG.userAgent);
    const baseUrl = 'https://v6.kuramanime.run/quick/ongoing?order_by=latest&page=1';

    try {
        // Load anime list
        await page.goto(baseUrl, { waitUntil: CONFIG.waitUntil, timeout: CONFIG.timeout });
        await page.waitForSelector('.product__item', { timeout: 30000 });

        const animeList = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('.product__item')).map(item => {
                const linkElem = item.querySelector('h5 a');
                return {
                    title: linkElem?.textContent?.trim() || 'Tidak ada judul',
                    link: linkElem?.href || null
                };
            }).filter(a => a.link);
        });

        console.log(`📊 Found ${animeList.length} anime`);

        // Process each anime
        for (const anime of animeList) {
            const animeTitleLower = anime.title.toLowerCase();
            const matched = localTitles.find(item => item.title === animeTitleLower);

            if (!matched) continue;

            console.log(`\n🎬 Processing: ${anime.title}`);
            console.log(`🆔 Content ID: ${matched.content_id}`);

            try {
                // Go to anime page
                await page.goto(anime.link, { waitUntil: CONFIG.waitUntil, timeout: CONFIG.timeout });
                await page.waitForSelector('#animeEpisodes a.ep-button', { timeout: 15000 });

                // Get latest episode only
                const episode = await page.evaluate(() => {
                    const epButtons = Array.from(document.querySelectorAll('#animeEpisodes a.ep-button'));
                    if (epButtons.length === 0) return null;
                    const latest = epButtons[epButtons.length - 1]; // Get last episode
                    return {
                        episode: latest.innerText.trim().replace(/\s+/g, ' '),
                        link: latest.href
                    };
                });

                if (!episode) {
                    console.log('   - No episodes found');
                    continue;
                }

                console.log(`   📺 Latest Episode: ${episode.episode}`);

                // Go to episode page
                await page.goto(episode.link, { waitUntil: CONFIG.waitUntil, timeout: CONFIG.timeout });
                await page.waitForSelector('#animeDownloadLink', { timeout: 15000 });

                // Extract PixelDrain links for MP4 480p and 720p
                const pixeldrainLinks = await page.evaluate(() => {
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

                let url_480 = '';
                let url_720 = '';

                if (pixeldrainLinks) {
                    for (const [quality, links] of Object.entries(pixeldrainLinks)) {
                        const convertedLinks = links.map(rawUrl => convertPixeldrainUrl(rawUrl) || rawUrl);
                        
                        if (/480p/i.test(quality)) {
                            url_480 = convertedLinks[0] || '';
                            console.log(`     ▶ 480p: ${url_480}`);
                        }
                        if (/720p/i.test(quality)) {
                            url_720 = convertedLinks[0] || '';
                            console.log(`     ▶ 720p: ${url_720}`);
                        }
                    }
                } else {
                    console.log('     - No PixelDrain links found');
                }

                // Prepare data for API
                const fileName = `${anime.title} episode ${episode.episode}`;
                const episodeNumber = parseInt(episode.episode.replace(/[^\d]/g, ''), 10) || 0;

                try {
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
                    });

                    console.log('     ✅ Data sent to server:', response.data.message || 'Success');
                } catch (error) {
                    console.log('     ❌ Failed to send data:', error.message);
                }

            } catch (error) {
                console.log(`   ❌ Error processing anime: ${error.message}`);
            }
        }
    } catch (error) {
        console.error('🔥 Main error:', error);
    } finally {
        await browser.close();
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
