const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

const NGUONC_API = 'https://phim.nguonc.com/api';

const builder = new addonBuilder({
    id: 'org.nguonc.stremio.official',
    version: '1.0.0',
    name: 'NguonC Stream',
    description: 'Cung cấp nguồn phim Vietsub/Thuyết minh từ NguonC',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [] // Thêm dòng này để sửa lỗi "manifest.catalogs must be an array"
});

async function fetchNguonC(endpoint) {
    try {
        const res = await axios.get(`${NGUONC_API}${endpoint}`, { timeout: 8000 });
        return res.data;
    } catch (err) {
        return null;
    }
}

builder.defineStreamHandler(async ({ type, id }) => {
    try {
        let slug = id;
        let episode = 1;

        if (id.startsWith('tt')) {
            const parts = id.split(':');
            const imdbId = parts[0];
            if (parts.length > 1) {
                episode = parseInt(parts[2], 10) || 1;
            }

            const searchData = await fetchNguonC(`/films/search?keyword=${imdbId}`);
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
            if (type === 'series') {
                targetEp = epItems.find(ep => 
                    ep.name == episode || 
                    ep.slug == `tap-${episode}`
                ) || epItems[0];
            } else {
                targetEp = epItems[0];
            }

            if (targetEp && (targetEp.m3u8 || targetEp.link_m3u8)) {
                streams.push({
                    name: `[NguonC] ${serverName}`,
                    title: `${movie.name}\n${targetEp.name ? 'Tập ' + targetEp.name : ''} - [Full HD]`,
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
