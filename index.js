const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');
const https = require('https');

const NGUONC_API = 'https://phim.nguonc.com/api';
const KKPHIM_API = 'https://phimapi.com';
const OPHIM_API = 'https://ophim1.com';
const PORT = process.env.PORT || 7000;

let PUBLIC_BASE_URL = (process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

const httpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });

const CLIENT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
};

// Bộ nhớ đệm RAM
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
    if (cache.size > 1500) cache.clear();
    cache.set(key, { value, expiry: Date.now() + ttlSeconds * 1000 });
}

const builder = new addonBuilder({
    id: 'org.nguonc.stremio.v86',
    version: '9.5.0',
    name: 'NguonC Siêu Nhẹ (AdBlock Direct)',
    description: 'Tự động lọc bỏ quảng cáo ngầm trong luồng Direct (KKPhim/OPhim) + Chống sập',
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
    if (s === 'full' || s === 'full hd' || s === 'tap full' || s === 'tập full') return 1;
    const matches = s.match(/\d+/g);
    if (!matches || matches.length === 0) return null;
    return parseInt(matches[matches.length - 1], 10);
}

function findEpisodeItem(epItems, episodeTarget, type) {
    if (!Array.isArray(epItems) || epItems.length === 0) return null;
    if (type === 'movie' && epItems.length === 1) return epItems[0];

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

// THUẬT TOÁN LỌC BỎ QUẢNG CÁO CHÈN NGẦM TRONG FILE M3U8 (#EXT-X-DISCONTINUITY)
function stripAdsFromM3U8(m3u8Content, baseUrl, proxyBaseUrl) {
    const lines = m3u8Content.split(/\r?\n/);

    // 1. Nếu là Master Playlist (chứa các luồng độ phân giải con) -> viết lại link trỏ về bộ lọc
    if (m3u8Content.includes('#EXT-X-STREAM-INF')) {
        return lines.map(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return line;
            try {
                const absUrl = new URL(trimmed, baseUrl).href;
                return `${proxyBaseUrl}/clean.m3u8?url=${encodeURIComponent(absUrl)}`;
            } catch (e) {
                return line;
            }
        }).join('\n');
    }

    // 2. Nếu là Media Playlist (chứa các phân đoạn .ts / .png / .jpg)
    const headerLines = [];
    const blocks = [];
    let currentBlock = [];
    let seenFirstSegment = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        if (line === '#EXT-X-ENDLIST') continue;

        if (line === '#EXT-X-DISCONTINUITY') {
            seenFirstSegment = true;
            if (currentBlock.length > 0) {
                blocks.push(currentBlock);
                currentBlock = [];
            }
            continue;
        }

        if (!seenFirstSegment && line.startsWith('#') && !line.startsWith('#EXTINF') && !line.startsWith('#EXT-X-KEY') && !line.startsWith('#EXT-X-BYTERANGE')) {
            headerLines.push(line);
            continue;
        }

        seenFirstSegment = true;
        currentBlock.push(line);
    }
    if (currentBlock.length > 0) blocks.push(currentBlock);

    // Phân tích từng khối phân đoạn (ngăn cách bởi DISCONTINUITY)
    const analyzedBlocks = blocks.map(block => {
        let duration = 0;
        let segCount = 0;
        const urls = [];
        for (const l of block) {
            if (l.startsWith('#EXTINF:')) {
                const dur = parseFloat(l.substring(8).split(',')[0]);
                if (!isNaN(dur)) duration += dur;
            } else if (!l.startsWith('#')) {
                segCount++;
                try {
                    urls.push(new URL(l, baseUrl).href);
                } catch (e) {
                    urls.push(l);
                }
            }
        }
        // Lấy thư mục gốc của các phân đoạn trong khối để nhận diện nguồn
        let prefix = '';
        if (urls.length > 0) {
            try {
                const u = new URL(urls[0]);
                const pathParts = u.pathname.split('/');
                pathParts.pop();
                prefix = u.origin + pathParts.join('/');
            } catch (e) {}
        }
        return { rawLines: block, duration, segCount, prefix };
    }).filter(b => b.segCount > 0);

    // Tìm prefix (thư mục máy chủ) của bộ phim chính (chiếm tổng thời lượng lớn nhất)
    const prefixTotals = {};
    for (const b of analyzedBlocks) {
        prefixTotals[b.prefix] = (prefixTotals[b.prefix] || 0) + b.duration;
    }
    let mainPrefix = '';
    let maxDur = -1;
    for (const [pref, dur] of Object.entries(prefixTotals)) {
        if (dur > maxDur) {
            maxDur = dur;
            mainPrefix = pref;
        }
    }

    // Lọc bỏ các khối quảng cáo:
    // - Khối khác thư mục gốc với phim chính VÀ ngắn dưới 90 giây
    // - Hoặc khối chèn giữa rất ngắn (dưới 45 giây, ít hơn 12 phân đoạn) khi có nhiều khối trong phim
    const cleanBlocks = analyzedBlocks.filter(b => {
        if (analyzedBlocks.length <= 1) return true;
        const isDifferentServer = mainPrefix && b.prefix && b.prefix !== mainPrefix;
        if (isDifferentServer && b.duration < 120) return false;
        if (b.duration <= 45 && b.segCount <= 12 && maxDur > 180) return false;
        return true;
    });

    const finalBlocks = cleanBlocks.length > 0 ? cleanBlocks : analyzedBlocks;

    // Ráp lại file M3U8 sạch với URL tuyệt đối
    const output = [...headerLines];
    finalBlocks.forEach((b, idx) => {
        if (idx > 0) output.push('#EXT-X-DISCONTINUITY');
        for (const l of b.rawLines) {
            if (l.startsWith('#')) {
                // Nếu có thẻ #EXT-X-KEY chứa URI tương đối -> chuyển thành tuyệt đối
                if (l.startsWith('#EXT-X-KEY') && l.includes('URI="')) {
                    const replaced = l.replace(/URI="([^"]+)"/, (m, uri) => {
                        try { return `URI="${new URL(uri, baseUrl).href}"`; } catch (e) { return m; }
                    });
                    output.push(replaced);
                } else {
                    output.push(l);
                }
            } else {
                try {
                    output.push(new URL(l, baseUrl).href);
                } catch (e) {
                    output.push(l);
                }
            }
        }
    });

    output.push('#EXT-X-ENDLIST');
    return output.join('\n');
}

async function fetchNguonC(endpoint) {
    const cacheKey = `nguonc:${endpoint}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;
    try {
        const res = await axios.get(`${NGUONC_API}${endpoint}`, {
            headers: CLIENT_HEADERS,
            httpsAgent,
            timeout: 6500
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
        } else if (id === 'nguonc_movies') {
            url = `${KKPHIM_API}/v1/api/danh-sach/phim-le?page=${page}`;
        } else if (id === 'nguonc_series') {
            url = `${KKPHIM_API}/v1/api/danh-sach/phim-bo?page=${page}`;
        } else if (id === 'nguonc_hoathinh') {
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
            else if (seasonTarget === 1) score -= 15;
        }

        if (score > bestScore) {
            bestScore = score;
            bestItem = item;
        }
    }
    return bestItem;
}

async function fetchExternalMovieDetail(baseUrl, slug, searchKeywords, targetYear, seasonTarget) {
    const cacheKey = `ext_movie:${baseUrl}:${slug || ''}:${searchKeywords.join('|')}:s${seasonTarget}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    try {
        if (slug && !slug.startsWith('tt') && seasonTarget === 1) {
            try {
                const res = await axios.get(`${baseUrl}/phim/${slug}`, { headers: CLIENT_HEADERS, httpsAgent, timeout: 4500 });
                if (res.data?.episodes?.length > 0) {
                    setCache(cacheKey, res.data, 1800);
                    return res.data;
                }
            } catch (e) {}
        }

        for (const kw of searchKeywords) {
            if (!kw) continue;
            try {
                const searchRes = await axios.get(`${baseUrl}/v1/api/tim-kiem?keyword=${encodeURIComponent(kw)}&limit=6`, { headers: CLIENT_HEADERS, httpsAgent, timeout: 4500 });
                const items = searchRes.data?.data?.items || [];
                if (items.length > 0) {
                    const matched = pickBestSearchMatch(items, searchKeywords, targetYear, seasonTarget);
                    if (matched?.slug) {
                        const detailRes = await axios.get(`${baseUrl}/phim/${matched.slug}`, { headers: CLIENT_HEADERS, httpsAgent, timeout: 4500 });
                        if (detailRes.data?.episodes?.length > 0) {
                            setCache(cacheKey, detailRes.data, 1800);
                            return detailRes.data;
                        }
                    }
                }
            } catch (e) {}
        }
    } catch (e) {}

    return null;
}

async function getExternalStreams(providerName, baseUrl, slug, searchKeywords, targetYear, seasonTarget, episodeTarget, type) {
    const results = [];
    const movieData = await fetchExternalMovieDetail(baseUrl, slug, searchKeywords, targetYear, seasonTarget);
    if (!movieData) return results;

    const servers = movieData.episodes || [];
    for (const server of servers) {
        const epItems = server.server_data || server.items || [];
        const targetEp = findEpisodeItem(epItems, episodeTarget, type);
        if (targetEp && targetEp.link_m3u8 && targetEp.link_m3u8.includes('.m3u8')) {
            const srvName = server.server_name ? ` - ${server.server_name}` : '';
            const cleanEpName = String(targetEp.name || episodeTarget).replace(/^(tập|tap)\s*/i, '');
            const rawM3u8 = targetEp.link_m3u8;

            // Luồng 1: Đã lọc sạch quảng cáo chèn ngầm (Khuyên dùng)
            if (PUBLIC_BASE_URL) {
                results.push({
                    name: `🛡️ [${providerName}] Không QC`,
                    title: `Tập ${cleanEpName}${srvName} (Đã cắt Quảng Cáo)`,
                    url: `${PUBLIC_BASE_URL}/clean.m3u8?url=${encodeURIComponent(rawM3u8)}`
                });
            }

            // Luồng 2: Luồng gốc dự phòng
            results.push({
                name: `⚡ [${providerName}] Direct`,
                title: `Tập ${cleanEpName}${srvName} (Luồng gốc)`,
                url: rawM3u8
            });
        }
    }
    return results;
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
            const extData = await fetchExternalMovieDetail(KKPHIM_API, slug, [], null, 1)
                         || await fetchExternalMovieDetail(OPHIM_API, slug, [], null, 1);
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

// 3. STREAM HANDLER
builder.defineStreamHandler(async ({ type, id }) => {
    try {
        const streamCacheKey = `stream_v95:${type}:${id}`;
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

        let nguonCPromise;
        if (slug) {
            nguonCPromise = fetchNguonC(`/film/${slug}`);
        } else if (imdbName) {
            nguonCPromise = (async () => {
                const searchData = await fetchNguonC(`/films/search?keyword=${encodeURIComponent(imdbName)}`);
                const items = searchData?.items || searchData?.data?.items || searchData?.data || [];
                const best = pickBestSearchMatch(items, [imdbName], targetYear, seasonTarget);
                if (best?.slug) {
                    slug = best.slug;
                    return await fetchNguonC(`/film/${best.slug}`);
                }
                return null;
            })();
        } else {
            nguonCPromise = Promise.resolve(null);
        }

        const detailData = await nguonCPromise;
        const movie = detailData?.movie || detailData?.film;

        const searchKeywords = [];
        if (imdbName) searchKeywords.push(imdbName);
        if (movie?.name && !searchKeywords.includes(movie.name)) searchKeywords.push(movie.name);
        if (movie?.original_name && !searchKeywords.includes(movie.original_name)) searchKeywords.push(movie.original_name);

        const [kkStreams, ophimStreams] = await Promise.all([
            getExternalStreams('KK', KKPHIM_API, slug, searchKeywords, targetYear, seasonTarget, episodeTarget, type),
            getExternalStreams('OP', OPHIM_API, slug, searchKeywords, targetYear, seasonTarget, episodeTarget, type)
        ]);

        const webStreams = [];
        const servers = movie?.episodes || detailData?.episodes || [];
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

        // Ưu tiên đẩy các luồng 🛡️ Không Quảng Cáo lên đầu tiên
        const cleanStreams = [...kkStreams, ...ophimStreams].filter(s => s.name.includes('Không QC'));
        const rawDirectStreams = [...kkStreams, ...ophimStreams].filter(s => !s.name.includes('Không QC'));

        const allStreams = [
            ...cleanStreams,
            ...rawDirectStreams,
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
    if (!PUBLIC_BASE_URL && req.headers.host) {
        const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
        PUBLIC_BASE_URL = `${proto}://${req.headers.host}`;
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    next();
});

// TRẠM LỌC SẠCH QUẢNG CÁO TRONG PLAYLIST M3U8 (/clean.m3u8)
app.get('/clean.m3u8', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing url');

    try {
        const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
        const hostUrl = PUBLIC_BASE_URL || `${proto}://${req.headers.host}`;

        const response = await axios.get(targetUrl, {
            headers: CLIENT_HEADERS,
            httpsAgent,
            responseType: 'text',
            timeout: 7000
        });

        const content = response.data;
        if (typeof content === 'string' && content.includes('#EXTM3U')) {
            const cleanedM3u8 = stripAdsFromM3U8(content, targetUrl, hostUrl);
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Cache-Control', 'public, max-age=600');
            return res.send(cleanedM3u8);
        }

        res.redirect(targetUrl);
    } catch (e) {
        res.redirect(targetUrl);
    }
});

app.get('/health', (req, res) => res.status(200).send('OK'));

const addonRouter = getRouter(builder.getInterface());
app.use('/', addonRouter);

app.listen(PORT, () => console.log(`Addon NguonC v9.5.0 (AdBlock) running on port ${PORT}`));
