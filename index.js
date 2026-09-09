const { addonBuilder } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');

const NGUONC_API = 'https://phim.nguonc.com/api';
const PORT = process.env.PORT || 7000;

const builder = new addonBuilder({
    id: 'org.nguonc.stremio.proxy',
    version: '3.1.0',
    name: 'NguonC Stream Proxy',
    description: 'Xem đầy đủ Phim Lẻ, Phim Bộ, Hoạt Hình Vietsub từ NguonC phát trực tiếp 100% trên Stremio',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie', 'series', 'anime'],
    idPrefixes: ['tt', 'nguonc_'],
    catalogs: [
        {
            type: 'movie',
            id: 'nguonc_movies',
            name: 'NguonC - Phim Lẻ',
            extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
        },
        {
            type: 'series',
            id: 'nguonc_series',
            name: 'NguonC - Phim Bộ',
            extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
        },
        {
            type: 'anime',
            id: 'nguonc_hoathinh',
            name: 'NguonC - Hoạt Hình',
            extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
        },
        {
            type: 'series',
            id: 'nguonc_tvshows',
            name: 'NguonC - TV Shows',
            extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
        }
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

// 1. Catalog Handler
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    try {
        const skip = (extra && extra.skip) ? parseInt(extra.skip, 10) : 0;
        const page = Math.floor(skip / 10) + 1;

        let endpoint = `/films/phim-moi-cap-nhat?page=${page}`;
        if (id === 'nguonc_movies') endpoint = `/films/danh-sach/phim-le?page=${page}`;
        else if (id === 'nguonc_series') endpoint = `/films/danh-sach/phim-bo?page=${page}`;
        else if (id === 'nguonc_hoathinh') endpoint = `/films/danh-sach/hoat-hinh?page=${page}`;
        else if (id === 'nguonc_tvshows') endpoint = `/films/danh-sach/tv-shows?page=${page}`;

        if (extra && extra.search) {
            endpoint = `/films/search?keyword=${encodeURIComponent(extra.search)}`;
        }

        const data = await fetchNguonC(endpoint);
        const items = data?.items || data?.data?.items || [];

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

// 2. Meta Handler
builder.defineMetaHandler(async ({ type, id }) => {
    try {
        if (!id.startsWith('nguonc_')) return { meta: null };

        const rawId = id.replace('nguonc_', '');
        const slug = rawId.split(':')[0];

        const detailData = await fetchNguonC(`/film/${slug}`);
        const movie = detailData?.movie || detailData?.film;

        if (!movie) return { meta: null };

        const servers = movie.episodes || detailData?.episodes || [];
        const episodesList = [];

        if (servers.length > 0) {
            const firstServer = servers[0];
            const epItems = firstServer.items || firstServer.server_data || [];

            epItems.forEach((ep, index) => {
                episodesList.push({
                    id: `nguonc_${slug}:${index + 1}`,
                    title: ep.name ? `Tập ${ep.name}` : `Tập ${index + 1}`,
                    season: 1,
                    episode: index + 1
                });
            });
        }

        const meta = {
            id: `nguonc_${slug}`,
            type: type,
            name: movie.name,
            poster: movie.poster_url || movie.thumb_url,
            background: movie.poster_url || movie.thumb_url,
            description: movie.description || movie.content || movie.original_name || '',
            videos: episodesList.length > 0 ? episodesList : undefined
        };

        return { meta };
    } catch (error) {
        return { meta: null };
    }
});

// 3. Stream Handler (Gửi URL trỏ về Proxy Server của chính Addon)
builder.defineStreamHandler(async ({ type, id, host }) => {
    try {
        let slug = id;
        let episodeTarget = 1;

        if (id.startsWith('nguonc_')) {
            const rawId = id.replace('nguonc_', '');
            const parts = rawId.split(':');
            slug = parts[0];
            if (parts.length > 1) {
                episodeTarget = parseInt(parts[1], 10) || 1;
            }
        }

        const detailData = await fetchNguonC(`/film/${slug}`);
        const movie = detailData?.movie || detailData?.film;
        const servers = movie?.episodes || detailData?.episodes || [];

        if (!servers || servers.length === 0) return { streams: [] };

        const streams = [];

        for (const server of servers) {
            const serverName = server.server_name || server.name || 'NguonC';
            const epItems = server.items || server.server_data || [];

            if (!epItems || epItems.length === 0) continue;

            let targetEp = epItems.find(ep => {
                const epNum = parseInt(ep.name, 10) || parseInt(ep.slug?.replace(/\D/g, ''), 10);
                return epNum === episodeTarget;
            });

            if (!targetEp) {
                targetEp = epItems[episodeTarget - 1] || epItems[0];
            }

            if (targetEp) {
                const rawUrl = targetEp.m3u8 || targetEp.link_m3u8 || targetEp.embed || targetEp.link_embed;
                if (rawUrl) {
                    // Định tuyến luồng phát qua đường dẫn Proxy /proxy-stream trên Render
                    const proxyUrl = `${host}/proxy-stream?url=${encodeURIComponent(rawUrl)}`;
                    
                    streams.push({
                        name: `[NguonC] ${serverName}`,
                        title: `${movie?.name || 'Phim'}\n${targetEp.name ? 'Tập ' + targetEp.name : 'Full'} - Full HD Direct Proxy`,
                        url: proxyUrl
                    });
                }
            }
        }

        return { streams };
    } catch (error) {
        return { streams: [] };
    }
});

// 4. KHỞI TẠO EXPRESS APP & PROXY ENGINE
const app = express();
const addonInterface = builder.getInterface();

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    next();
});

// Trạm trung chuyển Proxy Stream: Tự động giả lập Referer NguonC cho toàn bộ dữ liệu video
app.get('/proxy-stream', async (req, res) => {
    try {
        const targetUrl = req.query.url;
        if (!targetUrl) return res.status(400).send('Missing url parameter');

        // Bóc tách link m3u8 nếu truyền vào link embed web
        let streamUrl = targetUrl;
        if (!streamUrl.includes('.m3u8')) {
            const embedRes = await axios.get(streamUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                    'Referer': 'https://phim.nguonc.com/'
                },
                timeout: 5000
            });
            const match = embedRes.data.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
            if (match && match[1]) {
                streamUrl = match[1];
            }
        }

        const response = await axios({
            method: 'get',
            url: streamUrl,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://phim.nguonc.com/',
                'Origin': 'https://phim.nguonc.com'
            },
            responseType: 'stream'
        });

        if (response.headers['content-type']) {
            res.setHeader('Content-Type', response.headers['content-type']);
        }

        response.data.pipe(res);
    } catch (err) {
        res.status(500).send('Proxy Stream Error');
    }
});

// Phục vụ Stremio Addon Router
app.get('/manifest.json', (req, res) => res.json(addonInterface.manifest));
app.get('/:resource/:type/:id.json', (req, res) => {
    const { resource, type, id } = req.params;
    const extra = req.query;
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = `${protocol}://${req.get('host')}`;

    addonInterface.get(resource, type, id, extra, { host }).then(resp => {
        res.json(resp);
    }).catch(err => {
        res.status(500).json({ err: 'Internal error' });
    });
});

app.listen(PORT, () => {
    console.log(`NguonC Proxy Addon is running on port ${PORT}`);
});
