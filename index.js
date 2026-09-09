const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');

const NGUONC_API = 'https://phim.nguonc.com/api';
const PORT = process.env.PORT || 7000;

const builder = new addonBuilder({
    id: 'org.nguonc.stremio.v6',
    version: '6.0.0',
    name: 'NguonC Stremio Native',
    description: 'Phiên bản hoàn hảo chạy trực tiếp trên Player Stremio',
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

// Tự động Cào link M3U8 từ Web Embed
async function getDirectM3u8(ep) {
    if (ep.m3u8 && ep.m3u8.includes('.m3u8')) return ep.m3u8;
    if (ep.link_m3u8 && ep.link_m3u8.includes('.m3u8')) return ep.link_m3u8;

    const embedUrl = ep.embed || ep.link_embed;
    if (embedUrl) {
        try {
            const res = await axios.get(embedUrl, {
                headers: { 'Referer': 'https://phim.nguonc.com/' },
                timeout: 5000
            });
            const match = res.data.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
            if (match) return match[1];
        } catch (e) {}
    }
    return null;
}

// 1. CATALOG & 2. META
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    try {
        const skip = (extra && extra.skip) ? parseInt(extra.skip, 10) : 0;
        const page = Math.floor(skip / 10) + 1;
        let endpoint = `/films/phim-moi-cap-nhat?page=${page}`;
        
        if (id === 'nguonc_movies') endpoint = `/films/danh-sach/phim-le?page=${page}`;
        else if (id === 'nguonc_series') endpoint = `/films/danh-sach/phim-bo?page=${page}`;
        else if (id === 'nguonc_hoathinh') endpoint = `/films/danh-sach/hoat-hinh?page=${page}`;
        
        if (extra && extra.search) endpoint = `/films/search?keyword=${encodeURIComponent(extra.search)}&page=${page}`;

        const data = await fetchNguonC(endpoint);
        const items = data?.items || data?.data?.items || data?.data || [];
        const metas = items.map(item => ({
            id: `nguonc_${item.slug}`, type, name: item.name,
            poster: item.poster_url || item.thumb_url, description: item.original_name || item.name
        }));
        return { metas };
    } catch (error) { return { metas: [] }; }
});

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
                episodesList.push({ id: `nguonc_${slug}:${index + 1}`, title: ep.name ? `Tập ${ep.name}` : `Tập ${index + 1}`, season: 1, episode: index + 1 });
            });
        }
        return { meta: { id: `nguonc_${slug}`, type, name: movie.name, poster: movie.poster_url || movie.thumb_url, background: movie.poster_url || movie.thumb_url, description: movie.description || movie.content || movie.original_name || '', videos: episodesList.length > 0 ? episodesList : undefined } };
    } catch (error) { return { meta: null }; }
});

// 3. STREAM HANDLER
builder.defineStreamHandler(async ({ type, id }) => {
    try {
        let slug = id; let episodeTarget = 1;
        if (id.startsWith('nguonc_')) {
            const parts = id.replace('nguonc_', '').split(':');
            slug = parts[0]; if (parts.length > 1) episodeTarget = parseInt(parts[1], 10) || 1;
        } else if (id.startsWith('tt')) {
            const parts = id.split(':'); if (type === 'series' && parts.length > 2) episodeTarget = parseInt(parts[2], 10) || 1;
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
                const directM3u8 = await getDirectM3u8(targetEp);
                if (directM3u8) {
                    streams.push({
                        name: `[NguonC] Stremio`,
                        title: `Tập ${targetEp.name || episodeTarget} - Xem trực tiếp siêu mượt`,
                        url: `${renderHost}/proxy-m3u8?url=${encodeURIComponent(directM3u8)}`
                    });
                }
            }
        }
        return { streams };
    } catch (error) { return { streams: [] }; }
});

// 4. EXPRESS APP & HYBRID PROXY ENGINE
const app = express();
app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

// Proxy Playlist M3U8 để bẻ khóa NguonC
app.get('/proxy-m3u8', async (req, res) => {
    try {
        const targetUrl = req.query.url;
        const response = await axios.get(targetUrl, { headers: { 'Referer': 'https://phim.nguonc.com/' }, timeout: 10000 });
        const finalUrl = response.request?.res?.responseUrl || targetUrl;
        const hostUrl = `${req.protocol}://${req.get('host')}`;

        // Trích xuất File Key bẻ khóa
        let m3u8Content = response.data.replace(/URI="(.*?)"/g, (match, p1) => {
            const absUrl = new URL(p1, finalUrl).href;
            return `URI="${hostUrl}/proxy-key?url=${encodeURIComponent(absUrl)}"`;
        });

        // Chỉ proxy m3u8, để nguyên link .ts cho thiết bị người dùng tự tải max tốc độ
        const proxiedLines = m3u8Content.split('\n').map(line => {
            const tLine = line.trim();
            if (!tLine || tLine.startsWith('#')) return line;
            const absUrl = new URL(tLine, finalUrl).href;
            if (absUrl.includes('.m3u8')) return `${hostUrl}/proxy-m3u8?url=${encodeURIComponent(absUrl)}`;
            return absUrl; 
        });

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(proxiedLines.join('\n'));
    } catch (e) { res.status(500).send('Proxy M3U8 Error'); }
});

// Proxy Key Giải Mã
app.get('/proxy-key', async (req, res) => {
    try {
        const response = await axios.get(req.query.url, { headers: { 'Referer': 'https://phim.nguonc.com/' }, responseType: 'arraybuffer' });
        res.setHeader('Content-Type', 'application/octet-stream');
        res.send(response.data);
    } catch(e) { res.status(500).send('Key Error'); }
});

const addonRouter = getRouter(builder.getInterface());
app.use('/', addonRouter);
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
