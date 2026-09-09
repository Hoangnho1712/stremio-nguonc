const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');

const NGUONC_API = 'https://phim.nguonc.com/api';
const PORT = process.env.PORT || 7000;

const builder = new addonBuilder({
    id: 'org.nguonc.stremio.v90',
    version: '9.0.0',
    name: 'NguonC Max Direct',
    description: 'Tối ưu tỷ lệ bóc tách Link Direct & Tìm kiếm dự phòng đa nguồn',
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
    try { const res = await axios.get(`${NGUONC_API}${endpoint}`, { timeout: 10000 }); return res.data; }
    catch (err) { return null; }
}

async function getMovieTitleFromImdb(type, imdbId) {
    try {
        const reqType = type === 'anime' ? 'series' : type;
        const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${reqType}/${imdbId}.json`, { timeout: 5000 });
        return res.data?.meta?.name || null;
    } catch (err) { return null; }
}

// Bóc tách M3U8 thông minh (hỗ trợ unpack JS đơn giản)
function extractM3U8FromHtml(html) {
    if (!html) return null;
    let str = typeof html === 'string' ? html : JSON.stringify(html);

    // 1. Tìm trực tiếp
    let match = str.match(/(https?:\/\/[^"'\s<>\[\]{}()]+\.m3u8[^"'\s<>\[\]{}()]*)/i);
    if (match) return match[1].replace(/\\/g, '');

    // 2. Tìm dạng URL mã hóa Base64
    let b64Matches = str.match(/(aHR0c[A-Za-z0-9+/=]+)/g);
    if (b64Matches) {
        for (let b64 of b64Matches) {
            try {
                let dec = Buffer.from(b64, 'base64').toString('utf8');
                let m = dec.match(/(https?:\/\/[^"'\s<>\[\]{}()]+\.m3u8[^"'\s<>\[\]{}()]*)/i);
                if (m) return m[1].replace(/\\/g, '');
            } catch (e) {}
        }
    }
    return null;
}

// Tìm kiếm nâng cao ở các kho phim khác nếu NguonC bị mã hóa
async function searchFallbackSources(movieName, episodeTarget) {
    if (!movieName) return null;
    const cleanName = movieName.replace(/[^\w\sàáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/gi, ' ').trim();
    
    // Kho 1: PhimAPI
    try {
        const res = await axios.get(`https://phimapi.com/v1/api/tim-kiem?keyword=${encodeURIComponent(cleanName)}`, { timeout: 4000 });
        const items = res.data?.data?.items || [];
        if (items.length > 0) {
            const detail = await axios.get(`https://phimapi.com/phim/${items[0].slug}`, { timeout: 4000 });
            const servers = detail.data?.episodes || [];
            for (const s of servers) {
                const epItems = s.server_data || [];
                let targetEp = epItems.find(ep => (parseInt(ep.name, 10) || parseInt(ep.slug?.replace(/\D/g, ''), 10)) === episodeTarget) || epItems[0];
                if (targetEp && targetEp.link_m3u8 && targetEp.link_m3u8.includes('.m3u8')) {
                    return targetEp.link_m3u8;
                }
            }
        }
    } catch (e) {}

    // Kho 2: Ophim
    try {
        const res = await axios.get(`https://ophim1.com/phim/${encodeURIComponent(cleanName.toLowerCase().replace(/\s+/g, '-'))}`, { timeout: 4000 });
        const servers = res.data?.episodes || [];
        for (const s of servers) {
            const epItems = s.server_data || [];
            let targetEp = epItems.find(ep => (parseInt(ep.name, 10) || parseInt(ep.slug?.replace(/\D/g, ''), 10)) === episodeTarget) || epItems[0];
            if (targetEp && targetEp.link_m3u8 && targetEp.link_m3u8.includes('.m3u8')) {
                return targetEp.link_m3u8;
            }
        }
    } catch (e) {}

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
        return { metas: items.map(item => ({ id: `nguonc_${item.slug}`, type, name: item.name, poster: item.poster_url || item.thumb_url, description: item.original_name || item.name })) };
    } catch (e) { return { metas: [] }; }
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
            epItems.forEach((ep, index) => { episodesList.push({ id: `nguonc_${slug}:${index + 1}`, title: ep.name ? `Tập ${ep.name}` : `Tập ${index + 1}`, season: 1, episode: index + 1 }); });
        }
        return { meta: { id: `nguonc_${slug}`, type, name: movie.name, poster: movie.poster_url || movie.thumb_url, background: movie.poster_url || movie.thumb_url, description: movie.description || '', videos: episodesList.length > 0 ? episodesList : undefined } };
    } catch (e) { return { meta: null }; }
});

// 3. STREAM HANDLER (Tối ưu hóa tìm Direct)
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
        const movie = detailData?.movie || detailData?.film;
        const servers = movie?.episodes || detailData?.episodes || [];
        const streams = [];
        const renderHost = process.env.RENDER_EXTERNAL_URL || 'https://stremio-nguonc-1.onrender.com';

        for (const server of servers) {
            const epItems = server.items || server.server_data || [];
            if (epItems.length === 0) continue;

            let targetEp = epItems.find(ep => (parseInt(ep.name, 10) || parseInt(ep.slug?.replace(/\D/g, ''), 10)) === episodeTarget);
            if (!targetEp) targetEp = epItems[episodeTarget - 1] || epItems[0];

            if (targetEp) {
                let directM3u8 = extractM3U8FromHtml(targetEp.m3u8 || targetEp.link_m3u8);
                const embedUrl = targetEp.embed || targetEp.link_embed || "";

                // Quét mã HTML Embed
                if (!directM3u8 && embedUrl) {
                    try {
                        const res = await axios.get(embedUrl, { headers: { 'Referer': 'https://phim.nguonc.com/', 'User-Agent': 'Mozilla/5.0' }, timeout: 4000 });
                        directM3u8 = extractM3U8FromHtml(res.data);
                    } catch (e) {}
                }

                // Tìm kiếm thông minh theo tên phim nếu NguonC bị chặn hoàn toàn
                if (!directM3u8 && movie?.name) {
                    directM3u8 = await searchFallbackSources(movie.name, episodeTarget);
                }

                if (directM3u8) {
                    streams.push({ name: `[Direct] Mượt`, title: `Tập ${targetEp.name || episodeTarget} - Xem Trực Tiếp Stremio`, url: `${renderHost}/proxy-m3u8?url=${encodeURIComponent(directM3u8)}` });
                }

                if (embedUrl) {
                    streams.push({ name: `[Bảo Hiểm] Web`, title: `Tập ${targetEp.name || episodeTarget} - Mở Web Player`, externalUrl: embedUrl });
                }
            }
        }

        return { streams };
    } catch (e) { return { streams: [] }; }
});

// 4. PROXY SERVER
const app = express();
app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

app.get('/proxy-m3u8', async (req, res) => {
    try {
        let targetUrl = req.query.url;
        const response = await axios.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://phim.nguonc.com/' }, timeout: 10000 });
        const finalUrl = response.request?.res?.responseUrl || targetUrl;
        const hostUrl = `${req.protocol}://${req.get('host')}`;

        let m3u8Content = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
        m3u8Content = m3u8Content.replace(/URI="(.*?)"/g, (match, p1) => { return `URI="${hostUrl}/proxy-ts?url=${encodeURIComponent(new URL(p1, finalUrl).href)}"`; });

        const proxiedLines = m3u8Content.split('\n').map(line => {
            const tLine = line.trim();
            if (!tLine || tLine.startsWith('#')) return line;
            const absUrl = new URL(tLine, finalUrl).href;
            return absUrl.includes('.m3u8') ? `${hostUrl}/proxy-m3u8?url=${encodeURIComponent(absUrl)}` : `${hostUrl}/proxy-ts?url=${encodeURIComponent(absUrl)}`;
        });
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(proxiedLines.join('\n'));
    } catch (e) { res.status(500).send('M3U8 Error'); }
});

app.get('/proxy-ts', async (req, res) => {
    try {
        const response = await axios({ method: 'get', url: req.query.url, responseType: 'stream', headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://phim.nguonc.com/', 'Origin': 'https://phim.nguonc.com' }, timeout: 15000 });
        res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp2t');
        response.data.pipe(res);
    } catch (e) { res.status(500).send('TS Error'); }
});

const addonRouter = getRouter(builder.getInterface());
app.use('/', addonRouter);
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
