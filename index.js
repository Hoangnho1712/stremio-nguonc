const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

const NGUONC_API = 'https://phim.nguonc.com/api';

const builder = new addonBuilder({
    id: 'org.nguonc.stremio.official',
    version: '2.2.0',
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

// 3. Stream Handler (Fix triệt để tìm kiếm luồng & fallback)
builder.defineStreamHandler(async ({ type, id }) => {
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
        } else if (id.startsWith('tt')) {
            const parts = id.split(':');
            const imdbId = parts[0];
            if (parts.length > 1) {
                episodeTarget = parseInt(parts[2], 10) || 1;
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

            if (!epItems || epItems.length === 0) continue;

            // Tìm tập tương ứng
            let targetEp = epItems.find(ep => {
                const epNum = parseInt(ep.name, 10) || parseInt(ep.slug?.replace(/\D/g, ''), 10);
                return epNum === episodeTarget;
            });

            if (!targetEp) {
                targetEp = epItems[episodeTarget - 1] || epItems[0];
            }

            if (targetEp) {
                const m3u8Url = targetEp.m3u8 || targetEp.link_m3u8;
                const embedUrl = targetEp.embed || targetEp.link_embed;

                // 1. Luồng Direct Stream M3U8 (Chạy trực tiếp Stremio Player)
                if (m3u8Url) {
                    streams.push({
                        name: `[NguonC] ${serverName}`,
                        title: `${movie?.name || 'Phim'}\n${targetEp.name ? 'Tập ' + targetEp.name : 'Full'} - Auto Player`,
                        url: m3u8Url,
                        behaviorHints: {
                            notSupported: false,
                            proxyHeaders: {
                                request: {
                                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                                    "Referer": "https://phim.nguonc.com/",
                                    "Origin": "https://phim.nguonc.com"
                                }
                            }
                        }
                    });
                }

                // 2. Luồng Fallback Web Embed (Phòng trường hợp m3u8 bị chết/chặn)
                if (embedUrl && embedUrl !== m3u8Url) {
                    streams.push({
                        name: `[NguonC-Web] ${serverName}`,
                        title: `${movie?.name || 'Phim'}\n${targetEp.name ? 'Tập ' + targetEp.name : 'Full'} - Link Web Dự Phòng`,
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

const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
