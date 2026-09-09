const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

const NGUONC_API = 'https://phim.nguonc.com/api';

const builder = new addonBuilder({
    id: 'org.nguonc.stremio.official',
    version: '1.3.0',
    name: 'NguonC Full Catalog & Stream',
    description: 'Danh mục phim mới cập nhật và nguồn phát Vietsub từ NguonC',
    resources: ['catalog', 'stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'nguonc_'],
    catalogs: [
        {
            type: 'movie',
            id: 'nguonc_movies',
            name: 'NguonC - Phim Mới',
            extra: [{ name: 'search', isRequired: false }]
        },
        {
            type: 'series',
            id: 'nguonc_series',
            name: 'NguonC - Phim Bộ',
            extra: [{ name: 'search', isRequired: false }]
        }
    ]
});

// Hàm hỗ trợ gọi API NguonC
async function fetchNguonC(endpoint) {
    try {
        const res = await axios.get(`${NGUONC_API}${endpoint}`, { timeout: 8000 });
        return res.data;
    } catch (err) {
        return null;
    }
}

// Hàm lấy Tên phim từ IMDb ID bằng API Cinemeta của Stremio
async function getMovieTitleFromImdb(type, imdbId) {
    try {
        const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, { timeout: 5000 });
        return res.data?.meta?.name || null;
    } catch (err) {
        return null;
    }
}

// 1. Xử lý Danh mục hiển thị ở Trang chủ & Thanh tìm kiếm
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    try {
        let endpoint = '/films/phim-moi-cap-nhat?page=1';
        
        // Nếu người dùng gõ từ khóa tìm kiếm trên Stremio
        if (extra && extra.search) {
            endpoint = `/films/search?keyword=${encodeURIComponent(extra.search)}`;
        }

        const data = await fetchNguonC(endpoint);
        const items = data?.items || [];

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

// 2. Xử lý lấy Link phát (Stream)
builder.defineStreamHandler(async ({ type, id }) => {
    try {
        let slug = id;
        let episode = 1;

        // Nếu bấm từ danh mục NguonC (ID có dạng nguonc_slug-phim)
        if (id.startsWith('nguonc_')) {
            slug = id.replace('nguonc_', '');
        } 
        // Nếu bấm từ danh mục IMDb/Cinemeta (ID có dạng tt1234567 hoặc tt1234567:1:2)
        else if (id.startsWith('tt')) {
            const parts = id.split(':');
            const imdbId = parts[0];
            if (parts.length > 1) {
                episode = parseInt(parts[2], 10) || 1;
            }

            const movieTitle = await getMovieTitleFromImdb(type, imdbId);
            if (!movieTitle) return { streams: [] };

            const searchData = await fetchNguonC(`/films/search?keyword=${encodeURIComponent(movieTitle)}`);
            const film = searchData?.items?.[0];

            if (!film || !film.slug) return { streams: [] };
            slug = film.slug;
        }

        // Lấy danh sách tập phim & link m3u8 từ NguonC
        const detailData = await fetchNguonC(`/film/${slug}`);
        const movie = detailData?.movie;

        if (!movie || !movie.episodes) return { streams: [] };

        const streams = [];

        for (const server of movie.episodes) {
            const serverName = server.server_name || 'NguonC';
            const epItems = server.items || server.server_data || [];

            let targetEp = null;
            if (type === 'series') {
                targetEp = epItems.find(ep => 
                    ep.name == episode || 
                    ep.slug == `tap-${episode}` ||
                    ep.name == `Tập ${episode}`
                ) || epItems[0];
            } else {
                targetEp = epItems[0];
            }

            if (targetEp && (targetEp.m3u8 || targetEp.link_m3u8)) {
                streams.push({
                    name: `[NguonC] ${serverName}`,
                    title: `${movie.name}\n${targetEp.name ? 'Tập ' + targetEp.name : 'Full'} - [Full HD]`,
                    url: targetEp.m3u8 || targetEp.link_m3u8
                });
            }
        }

        return { streams };
    } catch (error) {
        return { streams: [] };
    }
});

const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
