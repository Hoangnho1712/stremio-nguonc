const { addonBuilder } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');

const NGUONC_API = 'https://phim.nguonc.com/api';
const PORT = process.env.PORT || 7000;

const builder = new addonBuilder({
    id: 'org.nguonc.stremio.proxy.v4',
    version: '4.0.0',
    name: 'NguonC HLS Proxy Native',
    description: 'Chạy NguonC mượt 100% bằng công nghệ viết lại luồng M3U8/TS',
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
    } catch (err) { return null; }
}

async function getMovieTitleFromImdb(type, imdbId) {
    try {
        const reqType = type === 'anime' ? 'series' : type;
        const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${reqType}/${imdbId}.json`, { timeout: 5000 });
        return res.data?.meta?.name || null;
    } catch (err) { return null; }
}

// 1. CHUẨN HOÁ DANH SÁCH (Fix lỗi 8 phim)
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    try {
        const skip = (extra && extra.skip) ? parseInt(extra.skip, 10) : 0;
        const page = Math.floor(skip / 10) + 1; // NguonC load chuẩn 10 phim / trang

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
    } catch (error) { return { metas: [] }; }
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
                    season: 1, episode: index + 1
                });
            });
        }

        return {
            meta: {
                id: `nguonc_${slug}`, type, name: movie.name,
                poster: movie.poster_url || movie.thumb_url, background: movie.poster_url || movie.thumb_url,
                description: movie.description || movie.content || movie.original_name || '',
                videos: episodesList.length > 0 ? episodesList : undefined
            }
        };
    } catch (error) { return { meta: null }; }
});

// 3. TÌM KIẾM LUỒNG (Fix No Streams Found)
builder.defineStreamHandler(async ({ type, id }) => {
    try {
        let slug = id; let episodeTarget = 1;

        if (id.startsWith('nguonc_')) {
            const parts = id.replace('nguonc_', '').split(':');
            slug = parts[0];
            if (parts.length > 1) episodeTarget = parseInt(parts[1], 10) || 1;
        } else if (id.startsWith('tt')) {
            // Tự động giải mã ID IMDb sang Tên Phim -> Tìm trên NguonC
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
                    streams.push({
                        name: `[NguonC] Server`,
                        title: `Tập ${targetEp.name || 'Full'} - Auto HLS`,
                        url: `${renderHost}/proxy-m3u8?url=${encodeURIComponent(rawUrl)}`
                    });
                }
            }
        }
        return { streams };
    } catch (error) { return { streams: [] }; }
});

// 4. HLS REWRITER PROXY (Ép luồng M3U8/TS chạy qua Render)
const app = express();
const addonInterface = builder.getInterface();

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); next();
});

app.get('/', (req, res) => res.redirect('/manifest.json'));

app.get('/proxy-m3u8', async (req, res) => {
    try {
        let targetUrl = req.query.url;
        if (!targetUrl) return res.status(400).send('Missing url');

        if (!targetUrl.includes('.m3u8')) {
            const htmlRes = await axios.get(targetUrl, { headers: { 'Referer': 'https://phim.nguonc.com/' }});
            const match = htmlRes.data.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
            if (match && match[1]) targetUrl = match[1]; else return res.status(404).send('M3U8 not found');
        }

        const response = await axios.get(targetUrl, { headers: { 'Referer': 'https://phim.nguonc.com/' } });
        const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
        const hostUrl = `${req.protocol}://${req.get('host')}`;

        let m3u8Content = response.data.replace(/URI="(.*?)"/g, (match, p1) => {
            let absUrl = p1.startsWith('http') ? p1 : baseUrl + p1;
            return `URI="${hostUrl}/proxy-ts?url=${encodeURIComponent(absUrl)}"`;
        });

        const proxiedLines = m3u8Content.split('\n').map(line => {
            const tLine = line.trim();
            if (!tLine || tLine.startsWith('#')) return line;
            let absUrl = tLine.startsWith('http') ? tLine : baseUrl + tLine;
            return absUrl.includes('.m3u8') 
                ? `${hostUrl}/proxy-m3u8?url=${encodeURIComponent(absUrl)}` 
                : `${hostUrl}/proxy-ts?url=${encodeURIComponent(absUrl)}`;
        });

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(proxiedLines.join('\n'));
    } catch (e) { res.status(500).send('M3U8 Proxy Error'); }
});

app.get('/proxy-ts', async (req, res) => {
    try {
        const targetUrl = req.query.url;
        const response = await axios({
            method: 'get', url: targetUrl, responseType: 'stream',
            headers: { 'Referer': 'https://phim.nguonc.com/', 'Origin': 'https://phim.nguonc.com' }
        });
        if (response.headers['content-type']) res.setHeader('Content-Type', response.headers['content-type']);
        response.data.pipe(res);
    } catch (e) { res.status(500).send('TS Proxy Error'); }
});

app.get('/manifest.json', (req, res) => res.json(addonInterface.manifest));
app.get('/:resource/:type/:id.json', (req, res) => {
    addonInterface.get(req.params.resource, req.params.type, req.params.id, req.query).then(resp => res.json(resp)).catch(() => res.status(500).send('Err'));
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
