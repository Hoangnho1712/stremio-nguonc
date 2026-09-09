const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

const NGUONC_API = 'https://phim.nguonc.com/api';

const builder = new addonBuilder({
    id: 'org.nguonc.stremio.official',
    version: '1.7.0',
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
            extra: [{ name: 'search' }, { name: 'skip' }],
            extraSupported: ['search', 'skip']
        },
        {
            type: 'series',
            id: 'nguonc_series',
            name: 'NguonC - Phim Bộ',
            extra: [{ name: 'search' }, { name: 'skip' }],
            extraSupported: ['search', 'skip']
        },
        {
            type: 'anime',
            id: 'nguonc_hoathinh',
            name: 'NguonC - Hoạt Hình',
            extra: [{ name: 'search' }, { name: 'skip' }],
            extraSupported: ['search', 'skip']
        },
        {
            type: 'series',
            id: 'nguonc_tvshows',
            name: 'NguonC - TV Shows',
            extra: [{ name: 'search' }, { name: 'skip' }],
            extraSupported: ['search', 'skip']
        }
    ]
});

async function fetchNguonC(endpoint) {
    try {
        const res = await axios.get(`${NGUONC_API}${endpoint}`, { 
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
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

// 1. Catalog Handler
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    try {
        const skip = (extra && extra.skip) ? parseInt(extra.skip, 10) : 0;
        const page = Math.floor(skip / 10) + 1;

        let endpoint = `/films/phim-moi-cap-nhat?page=${page}`;

        if (id === 'nguonc_movies') {
            endpoint = `/films/danh-sach/phim-le?page=${page}`;
        } else if (id === 'nguonc_series') {
            endpoint = `/films/danh-sach/phim-bo?page=${page}`;
        } else if (id === 'nguonc_hoathinh') {
            endpoint = `/films/danh-sach/hoat-hinh?page=${page}`;
        } else if (id === 'nguonc_tvshows') {
            endpoint = `/films/danh-sach/tv-shows?page=${page}`;
        }

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

// 3. Stream Handler (Đã fix triệt để lỗi không tìm thấy luồng)
builder.defineStreamHandler(async ({ type, id }) => {
    try {
        let slug = id;
        let episode = 1;

        if (id.startsWith('nguonc_')) {
            const rawId = id.replace('nguonc_', '');
            const parts = rawId.split(':');
            slug = parts[0];
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
            const items = searchData?.items || searchData?.data?.items || [];
            const film = items[0];

            if (!film || !film.slug) return { streams: [] };
            slug = film.slug;
        }

        const detailData = await fetchNguonC(`/film/${slug}`);
        const movie = detailData?.movie || detailData?.film;
        const servers = movie?.episodes || detailData?.episodes || [];

        if (!servers || servers.length === 0) return { streams: [] };

        const streams = [];

        for (const server of servers) {
            const serverName = server.server_name || server.name || 'NguonC';
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

            if (targetEp) {
                const streamUrl = targetEp.m3u8 || targetEp.link_m3u8 || targetEp.link_embed;
                if (streamUrl) {
                    streams.push({
                        name: `[NguonC] ${serverName}`,
                        title: `${movie?.name || 'Phim'}\n${targetEp.name ? 'Tập ' + targetEp.name : 'Full'} - Full HD`,
                        url: streamUrl
                    });
                }
            }
        }

        return { streams };
    } catch (error) {
        return { streams: [] };
    }
});

const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
