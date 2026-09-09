const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');

const NGUONC_API = 'https://phim.nguonc.com/api';
const PORT = process.env.PORT || 7000;

const builder = new addonBuilder({
    id: 'org.nguonc.stremio.v51',
    version: '5.1.0',
    name: 'NguonC Stream Fix Perfect',
    description: 'Sửa triệt để lỗi nhấp nháy logo Stremio - Hỗ trợ Direct & External Player',
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

// 3. STREAM HANDLER (Fix chuẩn RequestHeaders & Validation M3U8)
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

        for (const server of servers) {
            const epItems = server.items || server.server_data || [];
            if (epItems.length === 0) continue;

            let targetEp = epItems.find(ep => (parseInt(ep.name, 10) || parseInt(ep.slug?.replace(/\D/g, ''), 10)) === episodeTarget);
            if (!targetEp) targetEp = epItems[episodeTarget - 1] || epItems[0];

            if (targetEp) {
                const m3u8Url = targetEp.m3u8 || targetEp.link_m3u8;
                const embedUrl = targetEp.embed || targetEp.link_embed;

                // Luồng 1: Direct M3U8 truyền kèm requestHeaders chuẩn Stremio SDK
                if (m3u8Url && m3u8Url.includes('.m3u8')) {
                    streams.push({
                        name: `[NguonC] Direct HLS`,
                        title: `Tập ${targetEp.name || episodeTarget} - Phát Trực Tiếp (HLS)`,
                        url: m3u8Url,
                        behaviorHints: {
                            notSupported: false,
                            requestHeaders: {
                                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                                "Referer": "https://phim.nguonc.com/",
                                "Origin": "https://phim.nguonc.com"
                            }
                        }
                    });
                }

                // Luồng 2: Mở Web Player / Trình duyệt ngoài
                if (embedUrl) {
                    streams.push({
                        name: `[NguonC] Web Player`,
                        title: `Tập ${targetEp.name || episodeTarget} - Mở Player Trình Duyệt / App Ngoài`,
                        externalUrl: embedUrl
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

const addonRouter = getRouter(builder.getInterface());
app.use('/', addonRouter);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
