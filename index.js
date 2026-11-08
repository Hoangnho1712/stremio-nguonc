const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');
const https = require('https');

const NGUONC_API = 'https://phim.nguonc.com/api';
const KKPHIM_API = 'https://phimapi.com';
const OPHIM_API = 'https://ophim1.com';
const PORT = process.env.PORT || 7000;

const httpsAgent = new https.Agent({
    keepAlive: false,
    rejectUnauthorized: false
});

const CLIENT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
};

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
    if (cache.size > 1200) cache.clear();
    cache.set(key, { value, expiry: Date.now() + ttlSeconds * 1000 });
}

const builder = new addonBuilder({
    id: 'org.nguonc.stremio.v86',
    version: '10.1.0',
    name: 'OPhim + NguonC + KKPhim (Siêu Nhẹ v10.1)',
    description: 'Ưu tiên nguồn OPhim sạch + NguonC + KKPhim Direct tốc độ cao, không lỗi 404',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie', 'series', 'anime'],
    idPrefixes: ['tt', 'ophim_', 'nguonc_'],
    catalogs: [
        { type: 'movie', id: 'ophim_movies', name: 'OPhim - Phim Lẻ', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
        { type: 'series', id: 'ophim_series', name: 'OPhim - Phim Bộ', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
        { type: 'anime', id: 'ophim_hoathinh', name: 'OPhim - Hoạt Hình', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
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

function cleanSearchKeyword(kw) {
    if (!kw) return '';
    return String(kw)
        .replace(/\(\d{4}\)/g, '')
        .replace(/[:\-–—|\/]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseEpisodeNumber(str) {
    if (!str) return null;
    const s = String(str).toLowerCase().trim();
    if (s.includes('full') || s === 'hd' || s === 'fhd' || s === 'cam' || s === 'vietsub' || s === 'thuyet minh' || s === 'long tieng') return 1;
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
    if (episodeTarget === 1 && epItems.length === 1) return epItems[0];
    return null;
}

function buildOphimImage(rawPath, imgDomain = 'https://img.ophim.live') {
    if (!rawPath) return '';
    if (rawPath.startsWith('http')) return rawPath;
    const clean = rawPath.replace(/^\//, '');
    if (clean.startsWith('uploads/')) return `${imgDomain}/${clean}`;
    return `${imgDomain}/uploads/movies/${clean}`;
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
            else if (normOrigin.includes(q) || normName.includes(q) || q.includes(normName)) score += 25;
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
            timeout: 5500
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

async function fetchOPhimCatalog(id, page, search) {
    try {
        let url = `${OPHIM_API}/v1/api/danh-sach/phim-moi-cap-nhat?page=${page}`;
        if (search) {
            url = `${OPHIM_API}/v1/api/tim-kiem?keyword=${encodeURIComponent(search)}&page=${page}`;
        } else if (id.includes('movies')) {
            url = `${OPHIM_API}/v1/api/danh-sach/phim-le?page=${page}`;
        } else if (id.includes('series')) {
            url = `${OPHIM_API}/v1/api/danh-sach/phim-bo?page=${page}`;
        } else if (id.includes('hoathinh')) {
            url = `${OPHIM_API}/v1/api/danh-sach/hoat-hinh?page=${page}`;
        }

        const res = await axios.get(url, { headers: CLIENT_HEADERS, httpsAgent, timeout: 6000 });
        const items = res.data?.data?.items || res.data?.items || [];
        const imgDomain = res.data?.data?.APP_DOMAIN_CDN_IMAGE || 'https://img.ophim.live';

        return items.map(item => ({
            slug: item.slug,
            name: item.name,
            original_name: item.origin_name || item.original_name || '',
            poster_url: buildOphimImage(item.poster_url || item.thumb_url, imgDomain),
            quality: item.quality || 'HD',
            language: item.lang || 'Vietsub'
        }));
    } catch (e) {
        return [];
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

        const res = await axios.get(url, { headers: CLIENT_HEADERS, httpsAgent, timeout: 6000 });
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

// Đọc chuẩn xác cả 2 định dạng JSON của OPhim (/v1/api/phim và /phim) & KKPhim
function extractDetailObject(rawData, baseUrl = '') {
    if (!rawData) return null;
    const item = rawData.data?.item || rawData.movie || rawData.item || null;
    const episodes = rawData.data?.item?.episodes || rawData.episodes || item?.episodes || [];
    if (!item || !Array.isArray(episodes) || episodes.length === 0) return null;

    const imgDomain = rawData.data?.APP_DOMAIN_CDN_IMAGE || (baseUrl.includes('ophim') ? 'https://img.ophim.live' : 'https://phimimg.com');
    const poster = buildOphimImage(item.poster_url || item.thumb_url, imgDomain);
    const thumb = buildOphimImage(item.thumb_url || item.poster_url, imgDomain);

    return {
        movie: {
            ...item,
            name: item.name,
            original_name: item.origin_name || item.original_name || '',
            poster_url: poster,
            thumb_url: thumb,
            description: item.content || item.description || '',
            quality: item.quality || 'HD',
            language: item.lang || 'Vietsub'
        },
        episodes
    };
}

async function fetchBySlug(baseUrl, slug) {
    if (!slug) return null;
    const cacheKey = `slug_v101:${baseUrl}:${slug}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    // Ưu tiên gọi v1/api/phim cho OPhim vì đầy đủ dữ liệu nhất
    const urlsToTry = baseUrl.includes('ophim')
        ? [`${baseUrl}/v1/api/phim/${slug}`, `${baseUrl}/phim/${slug}`]
        : [`${baseUrl}/phim/${slug}`, `${baseUrl}/v1/api/phim/${slug}`];

    for (const url of urlsToTry) {
        try {
            const res = await axios.get(url, { headers: CLIENT_HEADERS, httpsAgent, timeout: 4500 });
            const parsed = extractDetailObject(res.data, baseUrl);
            if (parsed) {
                setCache(cacheKey, parsed, 1800);
                return parsed;
            }
        } catch (e) {}
    }
    return null;
}

async function fetchExternalMovieDetail(baseUrl, slug, searchKeywords, targetYear, seasonTarget) {
    const cleanKeywords = [];
    for (const kw of searchKeywords) {
        const cleaned = cleanSearchKeyword(kw);
        if (cleaned && !cleanKeywords.includes(cleaned)) cleanKeywords.push(cleaned);
    }

    const cacheKey = `ext_v101:${baseUrl}:${slug || ''}:${cleanKeywords.join('|')}:s${seasonTarget}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    // 1. Thử lấy trực tiếp bằng slug
    if (slug && !slug.startsWith('tt') && seasonTarget === 1) {
        const direct = await fetchBySlug(baseUrl, slug);
        if (direct) {
            setCache(cacheKey, direct, 1800);
            return direct;
        }
    }

    // 2. Nếu lệch slug, tìm theo từ khóa tên phim
    for (const kw of cleanKeywords) {
        try {
            const searchRes = await axios.get(`${baseUrl}/v1/api/tim-kiem?keyword=${encodeURIComponent(kw)}&limit=8`, {
                headers: CLIENT_HEADERS,
                httpsAgent,
                timeout: 4500
            });
            const items = searchRes.data?.data?.items || searchRes.data?.items || [];
            if (items.length > 0) {
                const matched = pickBestSearchMatch(items, cleanKeywords, targetYear, seasonTarget);
                if (matched?.slug) {
                    const detail = await fetchBySlug(baseUrl, matched.slug);
                    if (detail) {
                        setCache(cacheKey, detail, 1800);
                        return detail;
                    }
                }
            }
        } catch (e) {}
    }

    return null;
}

async function getExternalStreams(providerName, baseUrl, slug, searchKeywords, targetYear, seasonTarget, episodeTarget, type) {
    const results = [];
    const movieData = await fetchExternalMovieDetail(baseUrl, slug, searchKeywords, targetYear, seasonTarget);
    if (!movieData) return results;

    const servers = movieData.episodes || [];
    for (const server of servers) {
        const epItems = server.server_data || server.items || [];
        if (epItems.length === 0) continue;

        const srvName = server.server_name ? ` - ${server.server_name}` : '';

        // Nếu là phim lẻ, lấy toàn bộ các bản phát có trong server (Vietsub, Thuyết Minh...)
        if (type === 'movie') {
            for (const ep of epItems) {
                if (ep && ep.link_m3u8 && ep.link_m3u8.startsWith('http')) {
                    const epLabel = ep.name || 'Full';
                    results.push({
                        name: `⚡ [${providerName}] Direct`,
                        title: `${epLabel}${srvName}`,
                        url: ep.link_m3u8
                    });
                }
            }
        } else {
            const targetEp = findEpisodeItem(epItems, episodeTarget, type);
            if (targetEp && targetEp.link_m3u8 && targetEp.link_m3u8.startsWith('http')) {
                const cleanEpName = String(targetEp.name || episodeTarget).replace(/^(tập|tap)\s*/i, '');
                results.push({
                    name: `⚡ [${providerName}] Direct`,
                    title: `Tập ${cleanEpName}${srvName}`,
                    url: targetEp.link_m3u8
                });
            }
        }
    }
    return results;
}

// 1. CATALOG HANDLER
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    try {
        const skip = (extra && extra.skip) ? parseInt(extra.skip, 10) : 0;
        const page = Math.floor(skip / 10) + 1;

        // Nếu người dùng chọn danh mục OPhim
        if (id.startsWith('ophim_')) {
            const items = await fetchOPhimCatalog(id, page, extra?.search);
            return {
                metas: items.map(item => ({
                    id: `ophim_${item.slug}`,
                    type,
                    name: item.name,
                    poster: item.poster_url,
                    description: item.original_name ? `${item.original_name} (${item.quality} - ${item.language})` : item.name
                }))
            };
        }

        // Danh mục NguonC (tự động fallback sang KKPhim & OPhim nếu NguonC lỗi)
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
        if (!Array.isArray(items) || items.length === 0) {
            items = await fetchOPhimCatalog(id, page, extra?.search);
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
        const isOphimId = id.startsWith('ophim_');
        const isNguoncId = id.startsWith('nguonc_');
        if (!isOphimId && !isNguoncId) return { meta: null };

        const prefix = isOphimId ? 'ophim_' : 'nguonc_';
        const slug = id.replace(prefix, '').split(':')[0];

        let movie = null;
        let servers = [];

        if (isOphimId) {
            const opData = await fetchBySlug(OPHIM_API, slug) || await fetchBySlug(KKPHIM_API, slug);
            if (opData) {
                movie = opData.movie;
                servers = opData.episodes || [];
            }
        }

        if (!movie) {
            const detailData = await fetchNguonC(`/film/${slug}`);
            const ncMovie = detailData?.movie || detailData?.film;
            if (ncMovie) {
                movie = ncMovie;
                servers = ncMovie.episodes || detailData?.episodes || [];
            } else {
                const extData = await fetchBySlug(OPHIM_API, slug) || await fetchBySlug(KKPHIM_API, slug);
                if (extData) {
                    movie = extData.movie;
                    servers = extData.episodes || [];
                }
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
                    id: `${prefix}${slug}:${epNum}`,
                    title: ep.name ? (String(ep.name).toLowerCase().startsWith('tập') ? ep.name : `Tập ${ep.name}`) : `Tập ${epNum}`,
                    season: 1,
                    episode: epNum
                });
            });
        }

        return {
            meta: {
                id: `${prefix}${slug}`,
                type,
                name: movie.name,
                poster: movie.poster_url || movie.thumb_url,
                background: movie.thumb_url || movie.poster_url,
                description: movie.description ? String(movie.description).replace(/<[^>]*>?/gm, '') : '',
                releaseInfo: movie.quality ? `${movie.quality} | ${movie.language || ''}` : undefined,
                videos: episodesList.length > 0 ? episodesList : undefined
            }
        };
    } catch (e) {
        return { meta: null };
    }
});

// 3. STREAM HANDLER
builder.defineStreamHandler(async ({ type, id }) => {
    try {
        const streamCacheKey = `stream_v101:${type}:${id}`;
        const cachedStreams = getCache(streamCacheKey);
        if (cachedStreams) return { streams: cachedStreams };

        let slug = null;
        let seasonTarget = 1;
        let episodeTarget = 1;
        let imdbName = null;
        let targetYear = null;

        if (id.startsWith('ophim_') || id.startsWith('nguonc_')) {
            const cleanId = id.replace(/^(ophim_|nguonc_)/, '');
            const parts = cleanId.split(':');
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

        // Lấy thông tin phim từ cả NguonC, OPhim và KKPhim để luôn có tên phim chuẩn xác
        const [ncDetail, opDirect, kkDirect] = await Promise.all([
            slug ? fetchNguonC(`/film/${slug}`) : Promise.resolve(null),
            slug ? fetchBySlug(OPHIM_API, slug) : Promise.resolve(null),
            slug ? fetchBySlug(KKPHIM_API, slug) : Promise.resolve(null)
        ]);

        const ncMovie = ncDetail?.movie || ncDetail?.film;
        const baseMovie = opDirect?.movie || ncMovie || kkDirect?.movie;

        const searchKeywords = [];
        const addKw = (val) => {
            if (val && typeof val === 'string' && !searchKeywords.includes(val.trim())) {
                searchKeywords.push(val.trim());
            }
        };

        addKw(baseMovie?.name);
        addKw(baseMovie?.original_name || baseMovie?.origin_name);
        addKw(ncMovie?.name);
        addKw(ncMovie?.original_name);
        addKw(kkDirect?.movie?.name);
        addKw(kkDirect?.movie?.original_name);
        addKw(imdbName);
        if (slug) addKw(slug.replace(/-/g, ' '));

        const [ophimStreams, kkStreams] = await Promise.all([
            getExternalStreams('OP', OPHIM_API, slug, searchKeywords, targetYear, seasonTarget, episodeTarget, type),
            getExternalStreams('KK', KKPHIM_API, slug, searchKeywords, targetYear, seasonTarget, episodeTarget, type)
        ]);

        const webStreams = [];
        const servers = ncMovie?.episodes || ncDetail?.episodes || [];
        for (const server of servers) {
            const epItems = server.items || server.server_data || [];
            const targetEp = findEpisodeItem(epItems, episodeTarget, type);
            if (!targetEp) continue;

            const srvName = server.server_name ? ` - ${server.server_name}` : '';
            const cleanEpName = String(targetEp.name || episodeTarget).replace(/^(tập|tap)\s*/i, '');
            const embedUrl = targetEp.embed || targetEp.link_embed || '';

            if (embedUrl) {
                webStreams.push({
                    name: `🌐 [NguonC] Web`,
                    title: `Tập ${cleanEpName}${srvName} (Mở trình duyệt)`,
                    externalUrl: embedUrl
                });
            }
        }

        // Luôn ưu tiên hiển thị OPhim ([OP]) lên trên đầu
        const allStreams = [
            ...ophimStreams,
            ...kkStreams,
            ...webStreams
        ];

        const uniqueStreams = [];
        const seenUrls = new Set();
        for (const s of allStreams) {
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

// Cổng kiểm tra trực tiếp nguồn OPhim trên trình duyệt
app.get('/debug-op', async (req, res) => {
    const q = req.query.q || 'conan';
    try {
        const searchRes = await axios.get(`${OPHIM_API}/v1/api/tim-kiem?keyword=${encodeURIComponent(q)}&limit=3`, {
            headers: CLIENT_HEADERS,
            httpsAgent,
            timeout: 5000
        });
        const items = searchRes.data?.data?.items || [];
        const firstSlug = items[0]?.slug;
        const detail = firstSlug ? await fetchBySlug(OPHIM_API, firstSlug) : null;
        res.json({
            ok: true,
            query: q,
            foundCount: items.length,
            sampleSlug: firstSlug || null,
            sampleStreamsCount: detail?.episodes?.length || 0,
            sampleFirstM3u8: detail?.episodes?.[0]?.server_data?.[0]?.link_m3u8 || null
        });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.get('/status', (req, res) => res.json({ ok: true, version: '10.1.0', uptime: process.uptime() }));
app.get('/health', (req, res) => res.status(200).send('OK'));

const addonRouter = getRouter(builder.getInterface());
app.use('/', addonRouter);

app.listen(PORT, () => {
    console.log(`Addon OPhim + NguonC v10.1.0 running on port ${PORT}`);
});
