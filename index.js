const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');

const NGUONC_API = 'https://phim.nguonc.com/api';
const KKPHIM_API = 'https://phimapi.com';
const OPHIM_API = 'https://ophim1.com';
const PORT = process.env.PORT || 7000;

const FAKE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://phim.nguonc.com/',
    'Origin': 'https://phim.nguonc.com'
};

// Bộ nhớ đệm nhẹ trong RAM (giúp load lại phim/chuyển tập tức thì)
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
    id: 'org.nguonc.stremio.v86', // Giữ nguyên ID để không phải cài lại addon trên Stremio
    version: '9.0.0',
    name: 'NguonC Siêu Nhẹ (Pro)',
    description: 'Tối ưu tốc độ cao: Kết hợp song song NguonC + KKPhim + OPhim (Direct HLS + Web)',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie', 'series', 'anime'],
    idPrefixes: ['tt', 'nguonc_'],
    catalogs: [
        { type: 'movie', id: 'nguonc_movies', name: 'NguonC - Phim Lẻ', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
        { type: 'series', id: 'nguonc_series', name: 'NguonC - Phim Bộ', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
        { type: 'anime', id: 'nguonc_hoathinh', name: 'NguonC - Hoạt Hình', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] }
    ]
});

// Chuẩn hóa chuỗi để so sánh tên phim chính xác hơn
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

// Trích xuất số tập chuẩn xác từ tên hoặc slug (tránh lỗi "Tập 01" -> NaN)
function parseEpisodeNumber(str) {
    if (!str) return null;
    const s = String(str).toLowerCase().trim();
    if (s === 'full' || s === 'full hd' || s === 'tap full' || s === 'tập full') return 1;
    const matches = s.match(/\d+/g);
    if (!matches || matches.length === 0) return null;
    return parseInt(matches[matches.length - 1], 10);
}

// Tìm tập tương ứng trong danh sách tập của Server
function findEpisodeItem(epItems, episodeTarget, type) {
    if (!Array.isArray(epItems) || epItems.length === 0) return null;
    if (type === 'movie' && epItems.length === 1) return epItems[0];

    // Ưu tiên khớp chính xác số tập trong name hoặc slug
    let found = epItems.find(ep => {
        const numFromName = parseEpisodeNumber(ep.name);
        if (numFromName === episodeTarget) return true;
        const numFromSlug = parseEpisodeNumber(ep.slug);
        return numFromSlug === episodeTarget;
    });

    if (found) return found;
    // Nếu chỉ có 1 tập duy nhất và đang tìm tập 1 (thường là phim lẻ gắn nhầm mác series)
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

function extractM3U8(data) {
    try {
        if (!data) return null;
        if (typeof data === 'object') {
            const direct = data.m3u8 || data.link_m3u8 || data.m3u8_link;
            if (typeof direct === 'string' && direct.includes('.m3u8')) return direct;
        }
        const str = typeof data === 'string' ? data : JSON.stringify(data);
        let decoded = str.replace(/\\u[\dA-F]{4}/gi, m => String.fromCharCode(parseInt(m.replace(/\\u/g, ''), 16)));
        decoded = decoded.replace(/\\\//g, '/');

        let match = decoded.match(/(?:https?:)?\/\/[^"'\s<>\[\]{}()]+\.m3u8[^"'\s<>\[\]{}()]*/i);
        if (match) return match[0].startsWith('//') ? 'https:' + match[0] : match[0];

        let b64Matches = decoded.match(/(aHR0c[A-Za-z0-9+/=]+)/g);
        if (b64Matches) {
            for (let b64 of b64Matches) {
                try {
                    let dec = Buffer.from(b64, 'base64').toString('utf8');
                    let m = dec.match(/(?:https?:)?\/\/[^"'\s<>\[\]{}()]+\.m3u8[^"'\s<>\[\]{}()]*/i);
                    if (m) return m[0].startsWith('//') ? 'https:' + m[0] : m[0];
                } catch (e) {}
            }
        }
    } catch (e) {}
    return null;
}

// Chọn kết quả khớp nhất từ danh sách tìm kiếm (ưu tiên khớp tên gốc + năm phát hành)
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

// Lấy toàn bộ luồng M3U8 từ KKPhim hoặc OPhim (theo slug hoặc tự tìm theo tên phim)
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

        // Nếu không có slug hoặc khác slug với NguonC -> tự động tìm theo tên phim
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
                results.push({
                    name: `[${providerName}] Direct`,
                    title: `Tập ${targetEp.name || episodeTarget}${srvName} (Tốc độ cao)`,
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

        // Chỉ tạo danh sách tập nếu là Phim Bộ hoặc Hoạt Hình nhiều tập
        // Giúp Phim Lẻ (movie) bấm vào là hiện luồng phát ngay lập tức
        if (type !== 'movie' && servers.length > 0) {
            // Chọn server có nhiều tập nhất để làm danh sách tập chuẩn
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
        const streamCacheKey = `stream:${type}:${id}`;
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
            // Với series dạng tt123456:season:episode
            if (parts.length > 2) episodeTarget = parseInt(parts[2], 10) || 1;

            const imdbMeta = await getImdbMeta(type, imdbId);
            if (!imdbMeta) return { streams: [] };
            searchKeyword = imdbMeta.name;
            targetYear = imdbMeta.year;

            // Tìm slug trên NguonC
            const searchData = await fetchNguonC(`/films/search?keyword=${encodeURIComponent(searchKeyword)}`);
            const items = searchData?.items || searchData?.data?.items || searchData?.data || [];
            const bestMatch = pickBestSearchMatch(items, searchKeyword, targetYear);
            if (bestMatch) slug = bestMatch.slug;
        }

        // Gọi lấy chi tiết NguonC (nếu có slug)
        const nguonCPromise = slug ? fetchNguonC(`/film/${slug}`) : Promise.resolve(null);
        const detailData = await nguonCPromise;
        const movie = detailData?.movie || detailData?.film;

        if (!searchKeyword && movie) {
            searchKeyword = movie.original_name || movie.name;
        }

        // Chạy SONG SONG việc lấy luồng từ KKPhim và OPhim để đạt tốc độ tối đa
        const [kkStreams, ophimStreams] = await Promise.all([
            getExternalStreams('KKPhim', KKPHIM_API, slug, searchKeyword, targetYear, episodeTarget, type),
            getExternalStreams('OPhim', OPHIM_API, slug, searchKeyword, targetYear, episodeTarget, type)
        ]);

        const directStreams = [];
        const webStreams = [];

        // Xử lý các server từ NguonC
        const servers = movie?.episodes || detailData?.episodes || [];
        for (const server of servers) {
            const epItems = server.items || server.server_data || [];
            const targetEp = findEpisodeItem(epItems, episodeTarget, type);
            if (!targetEp) continue;

            const srvName = server.server_name ? ` - ${server.server_name}` : '';
            let directM3u8 = extractM3U8(targetEp);
            const embedUrl = targetEp.embed || targetEp.link_embed || '';

            if (directM3u8) {
                directStreams.push({
                    name: `[NguonC] Direct`,
                    title: `Tập ${targetEp.name || episodeTarget}${srvName} (Xem ngay)`,
                    url: directM3u8
                });
            }

            if (embedUrl) {
                webStreams.push({
                    name: `[NguonC] Web`,
                    title: `Tập ${targetEp.name || episodeTarget}${srvName} (Mở trình duyệt)`,
                    externalUrl: embedUrl
                });
            }
        }

        // Gộp tất cả luồng Direct (NguonC + KKPhim + OPhim) lên đầu, luồng Web dự phòng ở cuối
        const allStreams = [
            ...directStreams,
            ...kkStreams,
            ...ophimStreams,
            ...webStreams
        ];

        // Lọc bỏ các URL trùng nhau
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
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    next();
});

// Route kiểm tra trạng thái server (tiện lợi khi ping giữ thức trên Render)
app.get('/health', (req, res) => res.status(200).send('OK'));

const addonRouter = getRouter(builder.getInterface());
app.use('/', addonRouter);

app.listen(PORT, () => console.log(`Addon NguonC Pro running on port ${PORT}`));
