const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');

const NGUONC_API = 'https://phim.nguonc.com/api';
const PORT = process.env.PORT || 7000;

const builder = new addonBuilder({
    id: 'org.nguonc.stremio.v80',
    version: '8.0.0',
    name: 'NguonC God Mode',
    description: 'Tự động giải mã Base64 & Gọi Server Dự Phòng (Ophim/KKPhim)',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie', 'series', 'anime'],
    idPrefixes: ['tt', 'nguonc_'],
    catalogs: [
        { type: 'movie', id: 'nguonc_movies', name: 'NguonC - Phim Lẻ', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
        { type: 'series', id: 'nguonc_series', name: 'NguonC - Phim Bộ', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
        { type: 'anime', id: 'nguonc_hoathinh', name: 'NguonC - Hoạt Hình', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] }
    ]
});

// Hàm hỗ trợ
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

// THUẬT TOÁN BÓC TÁCH M3U8 MÃ HÓA
function extractM3U8(data) {
    try {
        const str = typeof data === 'string' ? data : JSON.stringify(data);
        let decoded = str.replace(/\\u[\dA-F]{4}/gi, m => String.fromCharCode(parseInt(m.replace(/\\u/g, ''), 16)));
        decoded = decoded.replace(/\\\//g, '/');

        // Tìm M3U8 dạng thường
        let match = decoded.match(/(?:https?:)?\/\/[^"'\s<>\[\]{}()]+\.m3u8[^"'\s<>\[\]{}()]*/i);
        if (match) {
            let url = match[0];
            if (url.startsWith('//')) url = 'https:' + url;
            return url;
        }

        // Tìm M3U8 dạng Base64 ẩn
        let b64Matches = decoded.match(/(aHR0c[A-Za-z0-9+/=]+)/g);
        if (b64Matches) {
            for (let b64 of b64Matches) {
                try {
                    let dec = Buffer.from(b64, 'base64').toString('utf8');
                    let m = dec.match(/(?:https?:)?\/\/[^"'\s<>\[\]{}()]+\.m3u8[^"'\s<>\[\]{}()]*/i);
                    if (m) {
                        let url = m[0];
                        if (url.startsWith('//')) url = 'https:' + url;
                        return url;
                    }
                } catch (e) {}
            }
        }
    } catch (e) {}
    return null;
}

// THUẬT TOÁN TÌM LINK TỪ SERVER DỰ PHÒNG
async function fetchFallbackStream(slug, episodeTarget) {
    const fallbackApis = [`https://ophim1.com/phim/${slug}`, `https://phimapi.com/phim/${slug}`];
    for (const apiUrl of fallbackApis) {
        try {
            const res = await axios.get(apiUrl, { timeout: 5000 });
            const servers = res.data?.episodes || [];
            for (const server of servers) {
                const epItems = server.server_data || [];
                let targetEp = epItems.find(ep => (parseInt(ep.name, 10) || parseInt(ep.slug?.replace(/\D/g, ''), 10)) === episodeTarget);
                if (!targetEp) targetEp = epItems[episodeTarget - 1] || epItems[0];
                if (targetEp && targetEp.link_m3u8 && targetEp.link_m3u8.includes('.m3u8')) {
                    return targetEp.link_m3u8;
                }
            }
        } catch (e) {}
    }
    return null;
}

// 1. CATALOG & 2. META (Rút gọn hiển thị)
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

// 3. STREAM HANDLER (Tối thượng)
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
        const streams = [];
        const renderHost = process.env.RENDER_EXTERNAL_URL || 'https://stremio-nguonc-1.onrender.com';

        for (const server of servers) {
            const epItems = server.items || server.server_data || [];
            if (epItems.length === 0) continue;

            let targetEp = epItems.find(ep => (parseInt(ep.name, 10) || parseInt(ep.slug?.replace(/\D/g, ''), 10)) === episodeTarget);
            if (!targetEp) targetEp = epItems[episodeTarget - 1] || epItems[0];

            if (targetEp) {
                let directM3u8 = extractM3U8(targetEp);
                const embedUrl = targetEp.embed || targetEp.link_embed || "";

                // Nhảy vào quét mã HTML trang Embed
                if (!directM3u8 && embedUrl) {
                    try {
                        const res = await axios.get(embedUrl, { headers: { 'Referer': 'https://phim.nguonc.com/', 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 });
                        directM3u8 = extractM3U8(res.data);
                    } catch (e) {}
                }

                // Nếu quét mã thất bại, gọi API Server Dự phòng cướp link
                if (!directM3u8) directM3u8 = await fetchFallbackStream(slug, episodeTarget);

                if (directM3u8) {
                    streams.push({ name: `[Direct] Mượt`, title: `Tập ${targetEp.name || episodeTarget} - Proxy Server (Khuyên Dùng)`, url: `${renderHost}/proxy-m3u8?url=${encodeURIComponent(directM3u8)}` });
                    streams.push({ name: `[Direct] Local`, title: `Tập ${targetEp.name || episodeTarget} - Mạng Cáp Quang Nhà Bạn`, url: directM3u8, behaviorHints: { requestHeaders: { "Referer": "https://phim.nguonc.com/", "Origin": "https://phim.nguonc.com/" } } });
                }

                if (embedUrl) streams.push({ name: `[Bảo Hiểm] Web`, title: `Tập ${targetEp.name || episodeTarget} - Mở qua web`, externalUrl: embedUrl });
            }
        }

        // Loại bỏ luồng trùng lặp
        const uniqueStreams = []; const seenUrls = new Set();
        for (const st of streams) {
            const idUrl = st.url || st.externalUrl;
            if (!seenUrls.has(idUrl)) { seenUrls.add(idUrl); uniqueStreams.push(st); }
        }

        return { streams: uniqueStreams };
    } catch (e) { return { streams: [] }; }
});

// 4. SERVER PROXY (Bẻ Khóa HLS)
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
