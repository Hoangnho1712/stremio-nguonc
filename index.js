const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');

const NGUONC_API = 'https://phim.nguonc.com/api';
const KKPHIM_API = 'https://phimapi.com';
const OPHIM_API = 'https://ophim1.com';
const PORT = process.env.PORT || 7000;

let PUBLIC_BASE_URL = (process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

const FAKE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://phim.nguonc.com/',
    'Origin': 'https://phim.nguonc.com'
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
    if (cache.size > 1000) cache.clear();
    cache.set(key, { value, expiry: Date.now() + ttlSeconds * 1000 });
}

const builder = new addonBuilder({
    id: 'org.nguonc.stremio.v86',
    version: '9.2.0',
    name: 'NguonC Siêu Nhẹ (Pro + Deep Extract)',
    description: 'Bóc tách sâu AJAX/Player NguonC + HLS Proxy + KKPhim/OPhim',
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

async function fetchNguonC(endpoint) {
    const cacheKey = `nguonc:${endpoint}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;
    try {
        const res = await axios.get(`${NGUONC_API}${endpoint}`, { headers: FAKE_HEADERS, timeout: 7000 });
        if (res.data) setCache(cacheKey, res.data, 900);
        return res.data;
    } catch (err) {
        return null;
    }
}

async function getImdbMeta(type, imdbId) {
    const cacheKey = `imdb:${type}:${imdbId}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;
    try {
        const reqType = type === 'anime' ? 'series' : type;
        const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${reqType}/${imdbId}.json`, { timeout: 5000 });
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

function unpackPacker(str) {
    let unpacked = '';
    try {
        const regex = /eval\(function\(p,a,c,k,e,[rd]\)\{.*?\}\('(.*?)',\s*(\d+),\s*(\d+),\s*'(.*?)'\.split\('\|'\)/gs;
        let match;
        while ((match = regex.exec(str)) !== null) {
            let [_, p, a, c, k] = match;
            a = parseInt(a, 10);
            c = parseInt(c, 10);
            k = k.split('|');
            const e = function (c) {
                return (c < a ? '' : e(parseInt(c / a, 10))) + ((c = c % a) > 35 ? String.fromCharCode(c + 29) : c.toString(36));
            };
            while (c--) {
                if (k[c]) {
                    p = p.replace(new RegExp('\\b' + e(c) + '\\b', 'g'), k[c]);
                }
            }
            unpacked += '\n' + p;
        }
    } catch (e) {}
    return unpacked;
}

// Quét mọi định dạng luồng HLS (.m3u8, .txt playlist, JWPlayer file/sources, Base64)
function extractStreamUrl(data, baseEmbedUrl = '') {
    try {
        if (!data) return null;
        if (typeof data === 'object') {
            const direct = data.m3u8 || data.link_m3u8 || data.m3u8_link || data.file || data.url || data.source;
            if (typeof direct === 'string' && (direct.includes('.m3u8') || direct.includes('/hls/') || direct.includes('.txt'))) {
                return baseEmbedUrl ? new URL(direct, baseEmbedUrl).href : direct;
            }
        }
        let str = typeof data === 'string' ? data : JSON.stringify(data);
        if (str.includes('eval(function(p,a,c,k,e,')) {
            str += '\n' + unpackPacker(str);
        }

        // Giải mã các chuỗi atob("...") hoặc Base64 ẩn trong script
        const atobRegex = /atob\(\s*["']([A-Za-z0-9+/=]+)["']\s*\)/g;
        let atobMatch;
        while ((atobMatch = atobRegex.exec(str)) !== null) {
            try {
                str += '\n' + Buffer.from(atobMatch[1], 'base64').toString('utf8');
            } catch (e) {}
        }

        let decoded = str.replace(/\\u[\dA-F]{4}/gi, m => String.fromCharCode(parseInt(m.replace(/\\u/g, ''), 16)));
        decoded = decoded.replace(/\\\//g, '/');

        // 1. Tìm trực tiếp URL .m3u8
        let match = decoded.match(/(?:https?:)?\/\/[^"'\s<>\[\]{}()]+\.m3u8[^"'\s<>\[\]{}()]*/i);
        if (match) return match[0].startsWith('//') ? 'https:' + match[0] : match[0];

        // 2. Tìm trong cấu hình Player: file: "...", src: "...", url: "..." (kể cả khi đổi đuôi sang .txt hoặc không đuôi)
        const fileRegex = /(?:["']?(?:file|src|url|source|link)["']?\s*:\s*["'])((?:https?:\/\/|\/)[^"'\s]+\.(?:m3u8|txt|mp4)[^"'\s]*|(?:https?:\/\/|\/)[^"'\s]*(?:\/hls\/|\/playlist\/|\/master|\/index)[^"'\s]*)/i;
        const fileMatch = decoded.match(fileRegex);
        if (fileMatch && fileMatch[1] && !fileMatch[1].endsWith('.js') && !fileMatch[1].endsWith('.css')) {
            return baseEmbedUrl ? new URL(fileMatch[1], baseEmbedUrl).href : fileMatch[1];
        }

        // 3. Quét các chuỗi Base64 bắt đầu bằng aHR0c (http)
        let b64Matches = decoded.match(/(aHR0c[A-Za-z0-9+/=]{15,})/g);
        if (b64Matches) {
            for (let b64 of b64Matches) {
                try {
                    let dec = Buffer.from(b64, 'base64').toString('utf8');
                    let m = dec.match(/(?:https?:)?\/\/[^"'\s<>\[\]{}()]+(?:\.m3u8|\/hls\/|\.txt)[^"'\s<>\[\]{}()]*/i);
                    if (m) return m[0].startsWith('//') ? 'https:' + m[0] : m[0];
                } catch (e) {}
            }
        }
    } catch (e) {}
    return null;
}

// Bóc tách sâu trang embed NguonC (Hỗ trợ cả iframe lồng nhau + gọi AJAX POST ngầm của streamc.xyz)
async function scrapeNguonCEmbed(embedUrl) {
    if (!embedUrl) return { m3u8: null, reason: 'NoURL' };
    const cacheKey = `embed_v92:${embedUrl}`;
    const cached = getCache(cacheKey);
    if (cached !== null) return cached;

    try {
        const parsedUrl = new URL(embedUrl);
        const embedOrigin = parsedUrl.origin;
        const hash = parsedUrl.searchParams.get('hash') || parsedUrl.searchParams.get('id') || parsedUrl.pathname.split('/').pop();

        const res = await axios.get(embedUrl, {
            headers: {
                'User-Agent': FAKE_HEADERS['User-Agent'],
                'Referer': 'https://phim.nguonc.com/',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
            },
            timeout: 4500,
            validateStatus: () => true
        });

        if (res.status !== 200) {
            return { m3u8: null, reason: `HTTP_${res.status}` };
        }

        const cookies = Array.isArray(res.headers['set-cookie'])
            ? res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ')
            : '';

        const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

        if (html.includes('cf-browser-verification') || html.includes('Just a moment...')) {
            return { m3u8: null, reason: 'Cloudflare_Block' };
        }

        // Bước 1: Quét trực tiếp trong HTML / Packer
        let m3u8 = extractStreamUrl(html, embedUrl);
        if (m3u8) {
            const out = { m3u8, reason: 'OK_HTML' };
            setCache(cacheKey, out, 1800);
            return out;
        }

        // Bước 2: Tìm các đường dẫn AJAX được gọi trong script của trang embed
        const ajaxHeaders = {
            'User-Agent': FAKE_HEADERS['User-Agent'],
            'Referer': embedUrl,
            'Origin': embedOrigin,
            'X-Requested-With': 'XMLHttpRequest',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
        };
        if (cookies) ajaxHeaders['Cookie'] = cookies;

        const ajaxEndpoints = new Set();
        const ajaxRegex = /(?:fetch|\$\.post|\$\.ajax|\$\.get|axios\.post|axios\.get|open)\s*\(\s*(?:["'](?:POST|GET)["']\s*,\s*)?["']([^"']+\.(?:php|json|txt)|\/ajax\/[^"']+|\/api\/[^"']+)["']/gi;
        let m;
        while ((m = ajaxRegex.exec(html)) !== null) {
            if (m[1] && !m[1].includes('google') && !m[1].includes('analytics')) {
                try {
                    ajaxEndpoints.add(new URL(m[1], embedUrl).href);
                } catch (e) {}
            }
        }

        // Các endpoint AJAX phổ biến của hệ thống streamc.xyz / NguonC player
        if (hash) {
            ajaxEndpoints.add(`${embedOrigin}/ajax.php`);
            ajaxEndpoints.add(`${embedOrigin}/get.php?hash=${encodeURIComponent(hash)}`);
            ajaxEndpoints.add(`${embedOrigin}/player/index.php?data=${encodeURIComponent(hash)}&do=getVideo`);
        }

        for (const ep of ajaxEndpoints) {
            try {
                const bodyData = `hash=${encodeURIComponent(hash || '')}&id=${encodeURIComponent(hash || '')}&r=${encodeURIComponent('https://phim.nguonc.com/')}`;
                const ajaxRes = await axios.post(ep, bodyData, { headers: ajaxHeaders, timeout: 2500, validateStatus: () => true });
                if (ajaxRes.status === 200 && ajaxRes.data) {
                    m3u8 = extractStreamUrl(ajaxRes.data, embedUrl);
                    if (m3u8) {
                        const out = { m3u8, reason: 'OK_AJAX' };
                        setCache(cacheKey, out, 1800);
                        return out;
                    }
                }
            } catch (e) {}
        }

        // Bước 3: Kiểm tra nếu trang embed chứa 1 iframe con khác
        const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
        if (iframeMatch && iframeMatch[1]) {
            const subUrl = new URL(iframeMatch[1], embedUrl).href;
            if (subUrl !== embedUrl) {
                const subRes = await axios.get(subUrl, { headers: { ...ajaxHeaders, 'Referer': embedUrl }, timeout: 3000, validateStatus: () => true });
                if (subRes.status === 200 && subRes.data) {
                    m3u8 = extractStreamUrl(subRes.data, subUrl);
                    if (m3u8) {
                        const out = { m3u8, reason: 'OK_IFRAME' };
                        setCache(cacheKey, out, 1800);
                        return out;
                    }
                }
            }
        }

        return { m3u8: null, reason: 'Encrypted_Player' };
    } catch (e) {
        return { m3u8: null, reason: e.code || 'Timeout_Or_Blocked' };
    }
}

function pickBestSearchMatch(items, queryTitle, targetYear) {
    if (!Array.isArray(items) || items.length === 0) return null;
    const normQuery = normalizeStr(queryTitle);

    let bestItem = items[0];
    let bestScore = -1;

    for (const item of items) {
        let score = 0;
        const normName = normalizeStr(item.name);
        const normOrigin = normalizeStr(item.original_name || item.origin_name);

        if (normOrigin === normQuery || normName === normQuery) score += 50;
        else if (normOrigin.includes(normQuery) || normName.includes(normQuery)) score += 20;

        const itemYear = parseInt(item.year, 10);
        if (targetYear && itemYear) {
            if (itemYear === targetYear) score += 30;
            else if (Math.abs(itemYear - targetYear) <= 1) score += 10;
            else score -= 15;
        }

        if (score > bestScore) {
            bestScore = score;
            bestItem = item;
        }
    }
    return bestItem;
}

async function getExternalStreams(providerName, baseUrl, slug, searchKeyword, targetYear, episodeTarget, type) {
    const results = [];
    let targetSlug = slug;

    try {
        let movieData = null;
        if (targetSlug && !targetSlug.startsWith('tt')) {
            try {
                const res = await axios.get(`${baseUrl}/phim/${targetSlug}`, { timeout: 4500 });
                if (res.data?.episodes?.length > 0) movieData = res.data;
            } catch (e) {}
        }

        if (!movieData && searchKeyword) {
            const searchRes = await axios.get(`${baseUrl}/v1/api/tim-kiem?keyword=${encodeURIComponent(searchKeyword)}&limit=5`, { timeout: 4500 });
            const items = searchRes.data?.data?.items || [];
            const matched = pickBestSearchMatch(items, searchKeyword, targetYear);
            if (matched?.slug) {
                const detailRes = await axios.get(`${baseUrl}/phim/${matched.slug}`, { timeout: 4500 });
                if (detailRes.data?.episodes?.length > 0) movieData = detailRes.data;
            }
        }

        const servers = movieData?.episodes || [];
        for (const server of servers) {
            const epItems = server.server_data || server.items || [];
            const targetEp = findEpisodeItem(epItems, episodeTarget, type);
            if (targetEp && targetEp.link_m3u8 && targetEp.link_m3u8.includes('.m3u8')) {
                const srvName = server.server_name ? ` - ${server.server_name}` : '';
                const cleanEpName = String(targetEp.name || episodeTarget).replace(/^(tập|tap)\s*/i, '');
                results.push({
                    name: `[${providerName}] Direct`,
                    title: `Tập ${cleanEpName}${srvName} (Tốc độ cao)`,
                    url: targetEp.link_m3u8
                });
            }
        }
    } catch (e) {}

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
        const items = data?.items || data?.data?.items || data?.data || [];

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
        const detailData = await fetchNguonC(`/film/${slug}`);
        const movie = detailData?.movie || detailData?.film;
        if (!movie) return { meta: null };

        const servers = movie.episodes || detailData?.episodes || [];
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
        const streamCacheKey = `stream_v92:${type}:${id}`;
        const cachedStreams = getCache(streamCacheKey);
        if (cachedStreams) return { streams: cachedStreams };

        let slug = null;
        let episodeTarget = 1;
        let searchKeyword = null;
        let targetYear = null;

        if (id.startsWith('nguonc_')) {
            const parts = id.replace('nguonc_', '').split(':');
            slug = parts[0];
            if (parts.length > 1) episodeTarget = parseInt(parts[1], 10) || 1;
        } else if (id.startsWith('tt')) {
            const parts = id.split(':');
            const imdbId = parts[0];
            if (parts.length > 2) episodeTarget = parseInt(parts[2], 10) || 1;

            const imdbMeta = await getImdbMeta(type, imdbId);
            if (!imdbMeta) return { streams: [] };
            searchKeyword = imdbMeta.name;
            targetYear = imdbMeta.year;

            const searchData = await fetchNguonC(`/films/search?keyword=${encodeURIComponent(searchKeyword)}`);
            const items = searchData?.items || searchData?.data?.items || searchData?.data || [];
            const bestMatch = pickBestSearchMatch(items, searchKeyword, targetYear);
            if (bestMatch) slug = bestMatch.slug;
        }

        const detailData = slug ? await fetchNguonC(`/film/${slug}`) : null;
        const movie = detailData?.movie || detailData?.film;

        if (!searchKeyword && movie) {
            searchKeyword = movie.name || movie.original_name;
        }

        const servers = movie?.episodes || detailData?.episodes || [];

        const nguonCTasks = servers.map(async (server) => {
            const epItems = server.items || server.server_data || [];
            const targetEp = findEpisodeItem(epItems, episodeTarget, type);
            if (!targetEp) return null;

            const srvName = server.server_name ? ` - ${server.server_name}` : '';
            const embedUrl = targetEp.embed || targetEp.link_embed || '';
            let directM3u8 = extractStreamUrl(targetEp, embedUrl);
            let failReason = '';

            if (!directM3u8 && embedUrl) {
                const scraped = await scrapeNguonCEmbed(embedUrl);
                directM3u8 = scraped.m3u8;
                failReason = scraped.reason;
            }

            const cleanEpName = String(targetEp.name || episodeTarget).replace(/^(tập|tap)\s*/i, '');
            return {
                epName: cleanEpName,
                srvName,
                embedUrl,
                directM3u8,
                failReason
            };
        });

        const [nguonCResults, kkStreams, ophimStreams] = await Promise.all([
            Promise.all(nguonCTasks),
            getExternalStreams('KKPhim', KKPHIM_API, slug, searchKeyword, targetYear, episodeTarget, type),
            getExternalStreams('OPhim', OPHIM_API, slug, searchKeyword, targetYear, episodeTarget, type)
        ]);

        const directStreams = [];
        const webStreams = [];

        for (const item of nguonCResults) {
            if (!item) continue;
            const { epName, srvName, embedUrl, directM3u8, failReason } = item;

            if (directM3u8) {
                let embedOrigin = 'https://embed.streamc.xyz';
                try {
                    if (embedUrl) embedOrigin = new URL(embedUrl).origin;
                } catch (e) {}

                if (PUBLIC_BASE_URL) {
                    const proxyUrl = `${PUBLIC_BASE_URL}/proxy?url=${encodeURIComponent(directM3u8)}&ref=${encodeURIComponent(embedOrigin + '/')}`;
                    directStreams.push({
                        name: `[NguonC] Direct (Proxy)`,
                        title: `Tập ${epName}${srvName} (Phát trực tiếp)`,
                        url: proxyUrl
                    });
                }

                directStreams.push({
                    name: `[NguonC] Direct`,
                    title: `Tập ${epName}${srvName} (Luồng gốc)`,
                    url: directM3u8,
                    behaviorHints: {
                        notWebReady: true,
                        proxyHeaders: {
                            request: {
                                'User-Agent': FAKE_HEADERS['User-Agent'],
                                'Referer': `${embedOrigin}/`,
                                'Origin': embedOrigin
                            }
                        }
                    }
                });
            }

            if (embedUrl) {
                const statusNote = directM3u8 ? 'Mở trình duyệt' : `Web - ${failReason || 'Không có m3u8'}`;
                webStreams.push({
                    name: `[NguonC] Web`,
                    title: `Tập ${epName}${srvName} (${statusNote})`,
                    externalUrl: embedUrl
                });
            }
        }

        const allStreams = [
            ...directStreams,
            ...kkStreams,
            ...ophimStreams,
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
            setCache(streamCacheKey, uniqueStreams, 900);
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

app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    const referer = req.query.ref || 'https://embed.streamc.xyz/';
    if (!targetUrl) return res.status(400).send('Missing url');

    try {
        let origin = 'https://embed.streamc.xyz';
        try { origin = new URL(referer).origin; } catch (e) {}

        const response = await axios.get(targetUrl, {
            headers: {
                'User-Agent': FAKE_HEADERS['User-Agent'],
                'Referer': referer,
                'Origin': origin
            },
            responseType: 'text',
            timeout: 8000
        });

        const content = response.data;
        if (typeof content === 'string' && content.includes('#EXTM3U')) {
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            const lines = content.split('\n');
            const rewritten = lines.map(line => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) return line;
                try {
                    const absUrl = new URL(trimmed, targetUrl).href;
                    if (absUrl.includes('.m3u8') || absUrl.includes('.txt')) {
                        return `${PUBLIC_BASE_URL}/proxy?url=${encodeURIComponent(absUrl)}&ref=${encodeURIComponent(referer)}`;
                    }
                    return absUrl;
                } catch (e) {
                    return line;
                }
            }).join('\n');
            return res.send(rewritten);
        }

        res.send(content);
    } catch (e) {
        res.status(502).send('Proxy error');
    }
});

// CỔNG SOI MÃ NGUỒN EMBED NGUONC: /debug-embed?url=https://embed.streamc.xyz/embed.php?hash=...
app.get('/debug-embed', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'Hãy truyền ?url=link_embed_nguonc' });
    try {
        const rawRes = await axios.get(url, {
            headers: { 'User-Agent': FAKE_HEADERS['User-Agent'], 'Referer': 'https://phim.nguonc.com/' },
            timeout: 5000,
            validateStatus: () => true
        });
        const html = typeof rawRes.data === 'string' ? rawRes.data : JSON.stringify(rawRes.data);
        const scraped = await scrapeNguonCEmbed(url);
        res.json({
            status: rawRes.status,
            scrapedResult: scraped,
            htmlPreview: html.substring(0, 1500)
        });
    } catch (e) {
        res.json({ error: e.message });
    }
});

app.get('/health', (req, res) => res.status(200).send('OK'));

const addonRouter = getRouter(builder.getInterface());
app.use('/', addonRouter);

app.listen(PORT, () => console.log(`Addon NguonC Pro running on port ${PORT}`));
