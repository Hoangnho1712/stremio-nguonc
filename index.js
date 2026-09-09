const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');

const NGUONC_API = 'https://phim.nguonc.com/api';
const PORT = process.env.PORT || 7000;

const builder = new addonBuilder({
    id: 'org.nguonc.stremio.v50',
    version: '5.0.0',
    name: 'NguonC Stream Direct & Proxy',
    description: 'Xem phim NguonC mượt mà, không giật lag trên mọi thiết bị Stremio',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie', 'series', 'anime'],
    idPrefixes: ['tt', 'nguonc_'],
    catalogs: [
        { type: 'movie', id: 'nguonc_movies', name: 'NguonC - Phim Lẻ', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
        { type: 'series', id: 'nguonc_series', name: 'NguonC - Phim Bộ', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
        { type: 'anime', id: 'nguonc_hoathinh', name: 'NguonC - Hoạt Hình', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] }
    ]
});

async function fetchNguonC(endpoint) {
    try {
        const res = await axios.get(`${NGUONC_API}${endpoint}`, { timeout: 10000 });
        return res.data;
    } catch (err) {
        return null;
    }
}

// Bóc tách link M3U8 từ Embed nếu có
async function extractM3u8Url(url) {
    if (!url) return null;
    if (url.includes('.m3u8')) return url;
    try {
        const res = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Referer': 'https://phim.nguonc.com/'
            },
            timeout: 5000
        });
        const match = res.data.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
        return match ? match[1] : url;
    } catch (e) {
        return url;
    }
}

async function getMovieTitleFromImdb(type, imdbId) {
    try {
        const reqType = type === 'anime' ? 'series' : type;
        const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${reqType}/${imdbId}.json`, { timeout: 5000 });
        return res.data?.meta?.name || null;
    } catch (err) {
        return null;
    }
}

// 1. CATALOG HANDLER
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    try {
        const skip = (extra && extra.skip) ? parseInt(extra.skip, 10) : 0;
        const page = Math.floor(skip / 10) + 1;

        let endpoint = `/films/phim-moi-cap-nhat?page=${page}`;
        if (id === 'nguonc_movies') endpoint = `/films/danh-sach/phim-le?page=${page}`;
        else if (id === 'nguonc_series') endpoint = `/films/danh-sach/phim-bo?page=${page}`;
        else if (id === 'nguonc_hoathinh') endpoint = `/films/danh-sach/hoat-hinh?page=${page}`;

        if (extra && extra.search) {
            endpoint = `/films/search?keyword=${encodeURIComponent(extra.search)}&page=${page}`;
        }

        const data = await fetchNguonC(endpoint);
        const items = data?.items || data?.data?.items || data?.data || [];

        const metas = items.map(item => ({
            id: `nguonc_${item.slug}`,
            type: type,
            name: item.name,
            poster: item.poster_url || item.thumb_url,
            description: item.original_name || item.name
        }));

        return { metas };
    } catch (error) {
        return { metas: [] };
    }
});

// 2. META HANDLER
builder.defineMetaHandler(async ({ type, id }) => {
    try {
        if (!id.startsWith('nguonc_')) return { meta: null };
        const slug = id.replace('nguonc_', '').split(':')[0];
        const detailData = await fetchNguonC(`/film/${slug}`);
        const movie = detailData?.movie || detailData?.film;

        if (!movie) return { meta: null };

        const servers = movie.episodes || detailData?.episodes || [];
        const episodesList = [];

        if (servers.length > 0) {
            const epItems = servers[0].items || servers[0].server_data || [];
            epItems.forEach((ep, index) => {
                episodesList.push({
                    id: `nguonc_${slug}:${index + 1}`,
                    title: ep.name ? `Tập ${ep.name}` : `Tập ${index + 1}`,
                    season: 1,
                    episode: index + 1
                });
            });
        }

        return {
            meta: {
                id: `nguonc_${slug}`,
                type: type,
                name: movie.name,
                poster: movie.poster_url || movie.thumb_url,
                background: movie.poster_url || movie.thumb_url,
                description: movie.description || movie.content || movie.original_name || '',
                videos: episodesList.length > 0 ? episodesList : undefined
            }
        };
    } catch (error) {
        return { meta: null };
    }
});

// 3. STREAM HANDLER (Phát trực tiếp không qua Render Proxy)
builder.defineStreamHandler(async ({ type, id }) => {
    try {
        let slug = id;
        let episodeTarget = 1;

        if (id.startsWith('nguonc_')) {
            const parts = id.replace('nguonc_', '').split(':');
            slug = parts[0];
            if (parts.length > 1) episodeTarget = parseInt(parts[1], 10) || 1;
        } else if (id.startsWith('tt')) {
            const parts = id.split(':');
            if (type === 'series' && parts.length > 2) episodeTarget = parseInt(parts[2], 10) || 1;

            const movieTitle = await getMovieTitleFromImdb(type, parts[0]);
            if (!movieTitle) return { streams: [] };

            const searchData = await fetchNguonC(`/films/search?keyword=${encodeURIComponent(movieTitle)}`);
            const items = searchData?.items || searchData?.data?.items || searchData?.data || [];
            if (!items || items.length === 0) return { streams: [] };
            slug = items[0].slug;
        }

        const detailData = await fetchNguonC(`/film/${slug}`);
        const servers = detailData?.movie?.episodes || detailData?.episodes || [];
        if (!servers || servers.length === 0) return { streams: [] };

        const streams = [];
        const renderHost = process.env.RENDER_EXTERNAL_URL || 'https://stremio-nguonc-1.onrender.com';

        for (const server of servers) {
            const epItems = server.items || server.server_data || [];
            if (epItems.length === 0) continue;

            let targetEp = epItems.find(ep => (parseInt(ep.name, 10) || parseInt(ep.slug?.replace(/\D/g, ''), 10)) === episodeTarget);
            if (!targetEp) targetEp = epItems[episodeTarget - 1] || epItems[0];

            if (targetEp) {
                const rawUrl = targetEp.m3u8 || targetEp.link_m3u8 || targetEp.embed || targetEp.link_embed;
                if (rawUrl) {
                    const directM3u8 = await extractM3u8Url(rawUrl);

                    // Luồng 1: Trực Tiếp (Khuyên dùng - Kết nối thẳng thiết bị -> NguonC CDN)
                    streams.push({
                        name: `[NguonC] Direct`,
                        title: `Tập ${targetEp.name || episodeTarget} - Trực Tiếp Full HD (Khuyên dùng)`,
                        url: directM3u8,
                        behaviorHints: {
                            notSupported: false,
                            proxyHeaders: {
                                request: {
                                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                                    "Referer": "https://phim.nguonc.com/"
                                }
                            }
                        }
                    });

                    // Luồng 2: Proxy Backup
                    streams.push({
                        name: `[NguonC] Backup Proxy`,
                        title: `Tập ${targetEp.name || episodeTarget} - Proxy Server`,
                        url: `${renderHost}/proxy-m3u8?url=${encodeURIComponent(directM3u8)}`,
                        behaviorHints: { notSupported: false }
                    });
                }
            }
        }
        return { streams };
    } catch (error) {
        return { streams: [] };
    }
});

// 4. EXPRESS APP & ROUTER
const app = express();

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    next();
});

app.get('/proxy-m3u8', async (req, res) => {
    try {
        let targetUrl = req.query.url;
        if (!targetUrl) return res.status(400).send('Missing url');

        const response = await axios.get(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Referer': 'https://phim.nguonc.com/'
            },
            responseType: 'text',
            timeout: 10000
        });

        const finalUrl = response.request?.res?.responseUrl || targetUrl;
        const hostUrl = `${req.protocol}://${req.get('host')}`;

        let m3u8Content = response.data.replace(/URI="(.*?)"/g, (match, p1) => {
            const absUrl = new URL(p1, finalUrl).href;
            return `URI="${hostUrl}/proxy-ts?url=${encodeURIComponent(absUrl)}"`;
        });

        const proxiedLines = m3u8Content.split('\n').map(line => {
            const tLine = line.trim();
            if (!tLine || tLine.startsWith('#')) return line;
            
            const absUrl = new URL(tLine, finalUrl).href;
            return absUrl.includes('.m3u8')
                ? `${hostUrl}/proxy-m3u8?url=${encodeURIComponent(absUrl)}`
                : `${hostUrl}/proxy-ts?url=${encodeURIComponent(absUrl)}`;
        });

        res.setHeader('Content-Type', 'application/x-mpegURL');
        res.send(proxiedLines.join('\n'));
    } catch (e) {
        res.status(500).send('M3U8 Proxy Error');
    }
});

app.get('/proxy-ts', async (req, res) => {
    try {
        const targetUrl = req.query.url;
        if (!targetUrl) return res.status(400).send('Missing url');

        const response = await axios({
            method: 'get',
            url: targetUrl,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Referer': 'https://phim.nguonc.com/',
                'Origin': 'https://phim.nguonc.com'
            },
            timeout: 15000
        });

        res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp2t');
        response.data.pipe(res);
    } catch (e) {
        res.status(500).send('TS Proxy Error');
    }
});

const addonRouter = getRouter(builder.getInterface());
app.use('/', addonRouter);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
