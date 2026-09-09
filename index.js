const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

const NGUONC_API = 'https://phim.nguonc.com/api';

const builder = new addonBuilder({
    id: 'org.nguonc.stremio.official',
    version: '1.5.0',
    name: 'NguonC Full Multi-Catalog & Stream',
    description: 'Xem đầy đủ Phim Lẻ, Phim Bộ, Hoạt Hình và TV Shows Vietsub từ NguonC',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie', 'series', 'anime'],
    idPrefixes: ['tt', 'nguonc_'],
    catalogs: [
        {
            type: 'movie',
            id: 'nguonc_movies',
            name: 'NguonC - Phim Lẻ',
            extra: [
                { name: 'search', isRequired: false },
                { name: 'skip', isRequired: false }
            ]
        },
        {
            type: 'series',
            id: 'nguonc_series',
            name: 'NguonC - Phim Bộ',
            extra: [
                { name: 'search', isRequired: false },
                { name: 'skip', isRequired: false }
            ]
        },
        {
            type: 'anime',
            id: 'nguonc_hoathinh',
            name: 'NguonC - Hoạt Hình',
            extra: [
                { name: 'search', isRequired: false },
                { name: 'skip', isRequired: false }
            ]
        },
        {
            type: 'series',
            id: 'nguonc_tvshows',
            name: 'NguonC - TV Shows',
            extra: [
                { name: 'search', isRequired: false },
                { name: 'skip', isRequired: false }
            ]
        }
    ]
});

async function fetchNguonC(endpoint) {
    try {
        const res = await axios.get(`${NGUONC_API}${endpoint}`, { timeout: 8000 });
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

// 1. Handler Danh mục & Phân trang (Xem được rất nhiều phim)
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    try {
        // Tính số trang dựa trên độ cuộn (skip) của Stremio
        const skip = (extra && extra.skip) ? parseInt(extra.skip, 10) : 0;
        const page = Math.floor(skip / 20) + 1;

        let endpoint = `/films/phim-moi-cap-nhat?page=${page}`;

        // Phân loại danh mục theo endpoint API NguonC
        if (id === 'nguonc_movies') {
            endpoint = `/films/danh-sach/phim-le?page=${page}`;
        } else if (id === 'nguonc_series') {
            endpoint = `/films/danh-sach/phim-bo?page=${page}`;
        } else if (id === 'nguonc_hoathinh') {
            endpoint = `/films/danh-sach/hoat-hinh?page=${page}`;
        } else if (id === 'nguonc_tvshows') {
            endpoint = `/films/danh-sach/tv-shows?page=${page}`;
        }

        // Xử lý khi người dùng Tìm kiếm từ khóa
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

// 2. Handler Chi tiết phim & Tập phim (Meta)
builder.defineMetaHandler(async ({ type, id }) => {
    try {
        if (!id.startsWith('nguonc_')) return { meta: null };
        const slug = id.replace('nguonc_', '');

        const detailData = await fetchNguonC(`/film/${slug}`);
        const movie = detailData?.movie;

        if (!movie) return { meta: null };

        const episodesList = [];
        if (movie.episodes && movie.episodes.length > 0) {
            const firstServer = movie.episodes[0];
            const epItems = firstServer.items || firstServer.server_data || [];

            epItems.forEach((ep, index) => {
                episodesList.push({
                    id: `${id}:${index + 1}`,
                    title: ep.name ? `Tập ${ep.name}` : `Tập ${index + 1}`,
                    season: 1,
                    episode: index + 1
                });
            });
        }

        const meta = {
            id: id,
            type: type,
            name: movie.name,
            poster: movie.poster_url || movie.thumb_url,
            background: movie.poster_url || movie.thumb_url,
            description: movie.description || movie.original_name || '',
            videos: episodesList.length > 0 ? episodesList : undefined
        };

        return { meta };
    } catch (error) {
        return { meta: null };
    }
});

// 3. Handler Nguồn phát Video (Stream)
builder.defineStreamHandler(async ({ type, id }) => {
    try {
        let slug = id;
        let episode = 1;

        if (id.startsWith('nguonc_')) {
            const parts = id.split(':');
            slug = parts[0].replace('nguonc_', '');
            if (parts.length > 1) {
                episode = parseInt(parts[1], 10) || 1;
            }
        } else if (id.startsWith('tt')) {
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

        const detailData = await fetchNguonC(`/film/${slug}`);
        const movie = detailData?.movie;

        if (!movie || !movie.episodes) return { streams: [] };

        const streams = [];

        for (const server of movie.episodes) {
            const serverName = server.server_name || 'NguonC';
            const epItems = server.items || server.server_data || [];

            let targetEp = null;
            if (type === 'series' || type === 'anime' || id.includes(':')) {
                targetEp = epItems.find(ep => 
                    ep.name == episode || 
                    ep.slug == `tap-${episode}` ||
                    ep.name == `Tập ${episode}`
                ) || epItems[episode - 1] || epItems[0];
            } else {
                targetEp = epItems[0];
            }

            if (targetEp && (targetEp.m3u8 || targetEp.link_m3u8)) {
                streams.push({
                    name: `[NguonC] ${serverName}`,
                    title: `${movie.name}\n${targetEp.name ? 'Tập ' + targetEp.name : 'Full'} - Full HD`,
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
