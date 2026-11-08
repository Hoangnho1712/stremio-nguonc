const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');
const https = require('https');

const NGUONC_API = 'https://phim.nguonc.com/api';
const KKPHIM_API = 'https://phimapi.com';
const PORT = process.env.PORT || 7000;

// Tắt keepAlive để giải phóng socket ngay sau mỗi request, chống treo Render tuyệt đối
const httpsAgent = new https.Agent({
    keepAlive: false,
    rejectUnauthorized: false
});

const CLIENT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*'
};

// Bộ nhớ đệm RAM tự giải phóng
const cache = new Map();
function getCache(key) {
    const item = cache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiry) {
        cache.delete(key);
        return null;
    }
    return item.value;
}
function setCache(key, value, ttlSeconds = 1800) {
    if (cache.size > 1000) cache.clear();
    cache.set(key, { value, expiry: Date.now() + ttlSeconds * 1000 });
}

const builder = new addonBuilder({
    id: 'org.nguonc.stremio.v86',
    version: '10.2.0',
    name: 'NguonC + KKPhim (Direct Chuẩn)',
    description: 'Bản tối ưu trực tiếp: Tốc độ cao, xem phim mượt mà, không lỗi 404',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie', 'series', 'anime'],
    idPrefixes: ['tt', 'nguonc_'],
    catalogs: [
        { type: 'movie', id: 'nguonc_movies', name: 'NguonC - Phim Lẻ', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
        { type: 'series', id: 'nguonc_series', name: 'NguonC - Phim Bộ', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
        { type: 'anime', id: 'nguonc_hoathinh', name: 'NguonC - Hoạt Hình', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] }
    ]
});

function normalizeStr(str) {
    if (!str) return '';
    return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseEpisodeNumber(str) {
    if (!str) return null;
    const s = String(str).toLowerCase().trim();
    if (s.includes('full') || s === 'hd' || s === 'fhd' || s === 'vietsub' || s === 'thuyet minh') return 1;
    const matches = s.match(/\d+/g);
    if (!matches || matches.length === 0) return null;
    return parseInt(matches[matches.length - 1], 10);
}

function findEpisodeItem(epItems, episodeTarget, type) {
    if (!Array.isArray(epItems) || epItems.length === 0) return null;
    if (type === 'movie') return epItems[0];

    let found = epItems.find(ep => {
        const numFromName = parseEpisodeNumber(ep.name);
        if (numFromName === episodeTarget) return true;
        const numFromSlug = parseEpisodeNumber(ep.slug);
        return numFromSlug === episodeTarget;
    });

    if (found) return found;
    if (episodeTarget === 1) return epItems[0];
    return null;
}

function pickBestSearchMatch(items, queries, targetYear, seasonTarget = 1) {
    if (!Array.isArray(items) || items.length === 0) return null;
    const normQueries = queries.map(q => normalizeStr(q)).filter(Boolean);

    let bestItem = items[0];
    let bestScore = -999;

    for (const item of items) {
        let score = 0;
        const normName = normalizeStr(item.name);
        const normOrigin = normalizeStr(item.original_name || item.origin_name);

        for (const q of normQueries) {
            if (!q) continue;
            if (normOrigin === q || normName === q) score += 60;
            else if (normOrigin.includes(q) || normName.includes(q)) score += 25;
        }

        if (seasonTarget > 1) {
            const seasonPatterns = [`phan ${seasonTarget}`, `season ${seasonTarget}`, ` p${seasonTarget}`, ` s${seasonTarget}`];
            if (seasonPatterns.some(p => normName.includes(p) || normOrigin.includes(p))) {
                score += 40;
            }
        } else if (seasonTarget === 1) {
            if (/(phan|season)\s*[2-9]/.test(normName)) score -= 25;
        }

        const itemYear = parseInt(item.year, 10);
        if (targetYear && itemYear) {
            if (itemYear === targetYear) score += 30;
            else if (Math.abs(itemYear - targetYear) <= 1) score += 10;
        }

        if (score > bestScore) {
            bestScore = score;
            bestItem = item;
        }
    }
    return bestItem;
}

async function fetchNguonC(endpoint) {
    const cacheKey = `nguonc:${endpoint}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;
    try {
        const res = await axios.get(`${NGUONC_API}${endpoint}`, {
            headers: CLIENT_HEADERS,
            httpsAgent,
            timeout: 5000
        });
        if (res.data && (res.data.status === 'success' || res.data.items || res.data.movie || res.data.film)) {
            setCache(cacheKey, res.data, 1800);
            return res.data;
        }
        return null;
    } catch (err) {
        return null;
    }
}

async function fetchKKPhimCatalog(id, page, search) {
    try {
        let url = `${KKPHIM_API}/danh-sach/phim-moi-cap-nhat?page=${page}`;
        if (search) {
            url = `${KKPHIM_API}/v1/api/tim-kiem?keyword=${encodeURIComponent(search)}&limit=20`;
        } else if (id.includes('movies')) {
            url = `${KKPHIM_API}/v1/api/danh-sach/phim-le?page=${page}`;
        } else if (id.includes('series')) {
            url = `${KKPHIM_API}/v1/api/danh-sach/phim-bo?page=${page}`;
        } else if (id.includes('hoathinh')) {
            url = `${KKPHIM_API}/v1/api/danh-sach/hoat-hinh?page=${page}`;
        }

        const res = await axios.get(url, { headers: CLIENT_HEADERS, httpsAgent, timeout: 5000 });
        const items = res.data?.data?.items || res.data?.items || [];
        const imgDomain = res.data?.data?.APP_DOMAIN_CDN_IMAGE || 'https://phimimg.com';

        return items.map(item => {
            let poster = item.poster_url || item.thumb_url || '';
            if (poster && !poster.startsWith('http')) {
                poster = `${imgDomain}/${poster.replace(/^\//, '')}`;
            }
            return {
                slug: item.slug,
                name: item.name,
                original_name: item.origin_name || item.original_name || '',
                poster_url: poster,
                quality: item.quality || 'HD',
                language: item.lang || 'Vietsub'
            };
        });
    } catch (e) {
        return [];
    }
}

async function getImdbMeta(type, imdbId) {
    const cacheKey = `imdb:${type}:${imdbId}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;
    try {
        const reqType = type === 'anime' ? 'series' : type;
        const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${reqType}/${imdbId}.json`, { httpsAgent, timeout: 4500 });
        const meta = res.data?.meta;
        if (!meta?.name) return null;
        const yearMatch = String(meta.releaseInfo || meta.year || '').match(/\d{4}/);
        const info = {
            name: meta.name,
            year: yearMatch ? parseInt(yearMatch[0], 10) : null
        };
        setCache(cacheKey, info, 86400);
        return info;
    } catch (err) {
        return null;
    }
}

async function fetchKKPhimMovieDetail(slug, searchKeywords, targetYear, seasonTarget) {
    const cacheKey = `kk_detail:${slug || ''}:${searchKeywords.join('|')}:s${seasonTarget}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    // 1. Thử lấy trực tiếp theo slug
    if (slug && !slug.startsWith('tt') && seasonTarget === 1) {
        try {
            const res = await axios.get(`${KKPHIM_API}/phim/${slug}`, { headers: CLIENT_HEADERS, httpsAgent, timeout: 4500 });
            if (res.data?.episodes?.length > 0) {
                setCache(cacheKey, res.data, 1800);
                return res.data;
            }
        } catch (e) {}
    }

    // 2. Tìm kiếm tự động nếu NguonC và KKPhim bị lệch slug
    for (const kw of searchKeywords) {
        if (!kw) continue;
        try {
            const searchRes = await axios.get(`${KKPHIM_API}/v1/api/tim-kiem?keyword=${encodeURIComponent(kw)}&limit=6`, {
                headers: CLIENT_HEADERS,
                httpsAgent,
                timeout: 4500
            });
            const items = searchRes.data?.data?.items || [];
            if (items.length > 0) {
                const matched = pickBestSearchMatch(items, searchKeywords, targetYear, seasonTarget);
                if (matched?.slug) {
                    const detailRes = await axios.get(`${KKPHIM_API}/phim/${matched.slug}`, { headers: CLIENT_HEADERS, httpsAgent, timeout: 4500 });
                    if (detailRes.data?.episodes?.length > 0) {
                        setCache(cacheKey, detailRes.data, 1800);
                        return detailRes.data;
                    }
                }
            }
        } catch (e) {}
    }

    return null;
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
        let items = data?.items || data?.data?.items || data?.data || [];

        if (!Array.isArray(items) || items.length === 0) {
            items = await fetchKKPhimCatalog(id, page, extra?.search);
        }

        return {
            metas: items.map(item => ({
                id: `nguonc_${item.slug}`,
                type,
                name: item.name,
                poster: item.poster_url || item.thumb_url,
                description: item.original_name ? `${item.original_name} (${item.quality || 'HD'} - ${item.language || 'Vietsub'})` : item.name
            }))
        };
    } catch (e) {
        return { metas: [] };
    }
});

// 2. META HANDLER
builder.defineMetaHandler(async ({ type, id }) => {
    try {
        if (!id.startsWith('nguonc_')) return { meta: null };
        const slug = id.replace('nguonc_', '').split(':')[0];

        let detailData = await fetchNguonC(`/film/${slug}`);
        let movie = detailData?.movie || detailData?.film;
        let servers = movie?.episodes || detailData?.episodes || [];

        if (!movie) {
            const extData = await fetchKKPhimMovieDetail(slug, [], null, 1);
            if (extData?.movie) {
                movie = {
                    name: extData.movie.name,
                    poster_url: extData.movie.poster_url || extData.movie.thumb_url,
                    thumb_url: extData.movie.thumb_url || extData.movie.poster_url,
                    description: extData.movie.content || '',
                    quality: extData.movie.quality || 'HD',
                    language: extData.movie.lang || 'Vietsub'
                };
                servers = extData.episodes || [];
            }
        }

        if (!movie) return { meta: null };

        const episodesList = [];
        if (type !== 'movie' && servers.length > 0) {
            let maxEpItems = [];
            for (const srv of servers) {
                const items = srv.items || srv.server_data || [];
                if (items.length > maxEpItems.length) maxEpItems = items;
            }

            maxEpItems.forEach((ep, index) => {
                const epNum = parseEpisodeNumber(ep.name) || parseEpisodeNumber(ep.slug) || (index + 1);
                episodesList.push({
                    id: `nguonc_${slug}:${epNum}`,
                    title: ep.name ? (String(ep.name).toLowerCase().startsWith('tập') ? ep.name : `Tập ${ep.name}`) : `Tập ${epNum}`,
                    season: 1,
                    episode: epNum
                });
            });
        }

        return {
            meta: {
                id: `nguonc_${slug}`,
                type,
                name: movie.name,
                poster: movie.poster_url || movie.thumb_url,
                background: movie.thumb_url || movie.poster_url,
                description: movie.description ? movie.description.replace(/<[^>]*>?/gm, '') : '',
                releaseInfo: movie.quality ? `${movie.quality} | ${movie.language || ''}` : undefined,
                videos: episodesList.length > 0 ? episodesList : undefined
            }
        };
    } catch (e) {
        return { meta: null };
    }
});

// 3. STREAM HANDLER (Luồng Direct tốc độ cao, không qua proxy)
builder.defineStreamHandler(async ({ type, id }) => {
    try {
        const streamCacheKey = `stream_v102:${type}:${id}`;
        const cachedStreams = getCache(streamCacheKey);
        if (cachedStreams) return { streams: cachedStreams };

        let slug = null;
        let seasonTarget = 1;
        let episodeTarget = 1;
        let imdbName = null;
        let targetYear = null;

        if (id.startsWith('nguonc_')) {
            const parts = id.replace('nguonc_', '').split(':');
            slug = parts[0];
            if (parts.length > 1) episodeTarget = parseInt(parts[1], 10) || 1;
        } else if (id.startsWith('tt')) {
            const parts = id.split(':');
            const imdbId = parts[0];
            if (parts.length > 2) {
                seasonTarget = parseInt(parts[1], 10) || 1;
                episodeTarget = parseInt(parts[2], 10) || 1;
            }

            const imdbMeta = await getImdbMeta(type, imdbId);
            if (!imdbMeta) return { streams: [] };
            imdbName = imdbMeta.name;
            targetYear = imdbMeta.year;
        }

        let detailData = null;
        if (slug) {
            detailData = await fetchNguonC(`/film/${slug}`);
        } else if (imdbName) {
            const searchData = await fetchNguonC(`/films/search?keyword=${encodeURIComponent(imdbName)}`);
            const items = searchData?.items || searchData?.data?.items || searchData?.data || [];
            const best = pickBestSearchMatch(items, [imdbName], targetYear, seasonTarget);
            if (best?.slug) {
                slug = best.slug;
                detailData = await fetchNguonC(`/film/${best.slug}`);
            }
        }

        const movie = detailData?.movie || detailData?.film;

        const searchKeywords = [];
        if (movie?.name) searchKeywords.push(movie.name);
        if (movie?.original_name && !searchKeywords.includes(movie.original_name)) searchKeywords.push(movie.original_name);
        if (imdbName && !searchKeywords.includes(imdbName)) searchKeywords.push(imdbName);
        if (slug) searchKeywords.push(slug.replace(/-/g, ' '));

        const streams = [];

        // Lấy luồng phát Direct m3u8 từ KKPhim
        const kkData = await fetchKKPhimMovieDetail(slug, searchKeywords, targetYear, seasonTarget);
        if (kkData?.episodes) {
            for (const server of kkData.episodes) {
                const epItems = server.server_data || server.items || [];
                const targetEp = findEpisodeItem(epItems, episodeTarget, type);
                if (targetEp && targetEp.link_m3u8 && targetEp.link_m3u8.startsWith('http')) {
                    const srvName = server.server_name ? ` - ${server.server_name}` : '';
                    const cleanEpName = String(targetEp.name || episodeTarget).replace(/^(tập|tap)\s*/i, '');
                    streams.push({
                        name: `⚡ [KK] Direct`,
                        title: `Tập ${cleanEpName}${srvName}`,
                        url: targetEp.link_m3u8
                    });
                }
            }
        }

        // Luồng Web từ NguonC làm dự phòng
        const servers = movie?.episodes || detailData?.episodes || [];
        for (const server of servers) {
            const epItems = server.items || server.server_data || [];
            const targetEp = findEpisodeItem(epItems, episodeTarget, type);
            if (!targetEp) continue;

            const srvName = server.server_name ? ` - ${server.server_name}` : '';
            const cleanEpName = String(targetEp.name || episodeTarget).replace(/^(tập|tap)\s*/i, '');
            const embedUrl = targetEp.embed || targetEp.link_embed || '';

            if (embedUrl) {
                streams.push({
                    name: `🌐 [NguonC] Web`,
                    title: `Tập ${cleanEpName}${srvName} (Mở trình duyệt)`,
                    externalUrl: embedUrl
                });
            }
        }

        const uniqueStreams = [];
        const seenUrls = new Set();
        for (const s of streams) {
            const key = s.url || s.externalUrl;
            if (key && !seenUrls.has(key)) {
                seenUrls.add(key);
                uniqueStreams.push(s);
            }
        }

        if (uniqueStreams.length > 0) {
            setCache(streamCacheKey, uniqueStreams, 1800);
        }

        return { streams: uniqueStreams };
    } catch (e) {
        return { streams: [] };
    }
});

const app = express();
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    next();
});

app.get('/status', (req, res) => res.json({ ok: true, version: '10.2.0', uptime: process.uptime() }));
app.get('/health', (req, res) => res.status(200).send('OK'));

const addonRouter = getRouter(builder.getInterface());
app.use('/', addonRouter);

app.listen(PORT, () => {
    console.log(`Addon NguonC v10.2.0 running on port ${PORT}`);
});
