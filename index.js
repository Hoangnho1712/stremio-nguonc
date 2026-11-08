const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');
const https = require('https');

const NGUONC_API = 'https://phim.nguonc.com/api';
const KKPHIM_API = 'https://phimapi.com';
const OPHIM_API = 'https://ophim1.com';
const PORT = process.env.PORT || 7000;

let PUBLIC_BASE_URL = (process.env.RENDER_EXTERNAL_URL || 'https://stremio-nguonc-hzjc.onrender.com').replace(/\/$/, '');

const httpsAgent = new https.Agent({
    keepAlive: false,
    rejectUnauthorized: false
});

const CLIENT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': '*/*',
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
    if (cache.size > 1500) cache.clear();
    cache.set(key, { value, expiry: Date.now() + ttlSeconds * 1000 });
}

let lastPlayedM3U8Info = null;

function encodeUrlBase64(url) {
    return Buffer.from(url, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function decodeUrlBase64(b64) {
    try {
        let str = b64.replace(/-/g, '+').replace(/_/g, '/');
        while (str.length % 4) str += '=';
        return Buffer.from(str, 'base64').toString('utf8');
    } catch (e) {
        return null;
    }
}

const builder = new addonBuilder({
    id: 'org.nguonc.stremio.v86',
    version: '9.8.3',
    name: 'NguonC Siêu Nhẹ (Deep AdBlock v9.8.3)',
    description: 'Vượt lỗi 404 CDN phim1280 + Chống treo Render + Cắt quảng cáo phút 15',
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

function pickBestVariantUrl(masterContent, masterUrl) {
    const lines = masterContent.split(/\r?\n/);
    let bestUrl = null;
    let maxBandwidth = -1;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXT-X-STREAM-INF')) {
            const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
            const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
            for (let j = i + 1; j < lines.length; j++) {
                const nextLine = lines[j].trim();
                if (!nextLine) continue;
                if (!nextLine.startsWith('#')) {
                    try {
                        const abs = new URL(nextLine, masterUrl).href;
                        if (bw >= maxBandwidth) {
                            maxBandwidth = bw;
                            bestUrl = abs;
                        }
                    } catch (e) {}
                }
                break;
            }
        }
    }
    return bestUrl;
}

function analyzeSegmentUrl(absUrl) {
    try {
        const u = new URL(absUrl);
        const parts = u.pathname.split('/');
        const filename = parts.pop() || '';
        const dir = u.origin + parts.join('/');

        const numMatches = [...filename.matchAll(/\d+/g)];
        const lastNumMatch = numMatches.length > 0 ? numMatches[numMatches.length - 1] : null;
        const seqNum = lastNumMatch ? parseInt(lastNumMatch[0], 10) : null;

        const pattern = filename.replace(/\d+/g, '#');
        const isHexHash = /^[a-f0-9]{16,}\.[a-z0-9]+$/i.test(filename);
        const sig = isHexHash ? `${dir}|HEX_LEN_${filename.length}` : `${dir}|${pattern}`;

        return { absUrl, dir, filename, sig, seqNum };
    } catch (e) {
        return { absUrl, dir: '', filename: absUrl, sig: 'unknown', seqNum: null };
    }
}

function stripAdsSegmentLevel(m3u8Content, baseUrl) {
    const lines = m3u8Content.split(/\r?\n/);
    const headerLines = [];
    const segments = [];

    let currentExtInf = null;
    let currentDur = 0;
    let currentKeyLine = null;
    let currentByteRange = null;
    let hasDiscontinuityBefore = false;
    let seenFirstSegment = false;
    let runningTime = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line === '#EXT-X-ENDLIST') continue;

        if (line === '#EXT-X-DISCONTINUITY') {
            seenFirstSegment = true;
            hasDiscontinuityBefore = true;
            continue;
        }

        if (line.startsWith('#EXT-X-KEY')) {
            seenFirstSegment = true;
            if (line.includes('URI="')) {
                currentKeyLine = line.replace(/URI="([^"]+)"/, (m, uri) => {
                    try { return `URI="${new URL(uri, baseUrl).href}"`; } catch (e) { return m; }
                });
            } else {
                currentKeyLine = line;
            }
            continue;
        }

        if (line.startsWith('#EXT-X-BYTERANGE')) {
            seenFirstSegment = true;
            currentByteRange = line;
            continue;
        }

        if (line.startsWith('#EXTINF:')) {
            seenFirstSegment = true;
            currentExtInf = line;
            const d = parseFloat(line.substring(8).split(',')[0]);
            currentDur = isNaN(d) ? 0 : d;
            continue;
        }

        if (line.startsWith('#')) {
            if (!seenFirstSegment && !line.startsWith('#EXT-X-PLAYLIST-TYPE')) {
                headerLines.push(line);
            }
            continue;
        }

        seenFirstSegment = true;
        let absUrl = line;
        try { absUrl = new URL(line, baseUrl).href; } catch (e) {}

        const info = analyzeSegmentUrl(absUrl);
        segments.push({
            index: segments.length,
            startTime: runningTime,
            duration: currentDur,
            extInf: currentExtInf || `#EXTINF:${currentDur.toFixed(3)},`,
            keyLine: currentKeyLine,
            byteRange: currentByteRange,
            discontinuityBefore: hasDiscontinuityBefore,
            ...info,
            isAd: false,
            adReason: ''
        });

        runningTime += currentDur;
        currentExtInf = null;
        currentDur = 0;
        currentByteRange = null;
        hasDiscontinuityBefore = false;
    }

    if (segments.length === 0) return { cleanedM3u8: m3u8Content, stats: { total: 0, removed: 0 } };

    // 1. Tìm Chữ ký (Signature) và Thư mục (Dir) chủ đạo của bộ phim chính
    const sigDurations = {};
    const dirDurations = {};
    const durCounts = {};

    for (const seg of segments) {
        sigDurations[seg.sig] = (sigDurations[seg.sig] || 0) + seg.duration;
        dirDurations[seg.dir] = (dirDurations[seg.dir] || 0) + seg.duration;
        const rDur = seg.duration.toFixed(2);
        durCounts[rDur] = (durCounts[rDur] || 0) + 1;
    }

    let dominantSig = '';
    let maxSigDur = -1;
    for (const [s, d] of Object.entries(sigDurations)) {
        if (d > maxSigDur) { maxSigDur = d; dominantSig = s; }
    }

    let dominantDir = '';
    let maxDirDur = -1;
    for (const [dir, d] of Object.entries(dirDurations)) {
        if (d > maxDirDur) { maxDirDur = d; dominantDir = dir; }
    }

    let standardDur = 0;
    let maxDurCount = 0;
    for (const [d, c] of Object.entries(durCounts)) {
        if (c > maxDurCount) { maxDurCount = c; standardDur = parseFloat(d); }
    }

    // 2. Đánh dấu phân đoạn theo từ khóa / thư mục / kiểu tên file
    for (const seg of segments) {
        const lowerUrl = seg.absUrl.toLowerCase();
        if (lowerUrl.includes('9922') || lowerUrl.includes('/adjump/') || lowerUrl.includes('/ads/') || lowerUrl.includes('quangcao') || lowerUrl.includes('promo')) {
            seg.isAd = true;
            seg.adReason = 'Blacklisted_Keyword';
            continue;
        }
        if (dominantDir && seg.dir !== dominantDir) {
            seg.isAd = true;
            seg.adReason = 'Different_Directory';
            continue;
        }
        if (dominantSig && seg.sig !== dominantSig) {
            seg.isAd = true;
            seg.adReason = 'Different_Filename_Pattern';
            continue;
        }
    }

    // 3. Quét khối ngắn nằm giữa DISCONTINUITY
    if (segments.some(s => s.discontinuityBefore)) {
        let blockStart = 0;
        for (let i = 1; i <= segments.length; i++) {
            if (i === segments.length || segments[i].discontinuityBefore) {
                const blockSegs = segments.slice(blockStart, i);
                const blockDur = blockSegs.reduce((sum, s) => sum + s.duration, 0);
                if (runningTime > 200 && blockDur < 110) {
                    for (const s of blockSegs) {
                        s.isAd = true;
                        s.adReason = `Short_Discontinuity_Block(${blockDur.toFixed(1)}s)`;
                    }
                }
                blockStart = i;
            }
        }
    }

    // 4. Quét đứt gãy chuỗi số thứ tự tên file
    for (let i = 0; i < segments.length; i++) {
        if (segments[i].isAd || segments[i].seqNum === null) continue;
        if (i > 0 && segments[i - 1].seqNum !== null) {
            const prevNum = segments[i - 1].seqNum;
            const currNum = segments[i].seqNum;
            if (currNum < prevNum) {
                let resumeIdx = -1;
                for (let j = i + 1; j < Math.min(segments.length, i + 45); j++) {
                    if (segments[j].seqNum !== null && segments[j].seqNum >= prevNum && segments[j].seqNum <= prevNum + 5) {
                        resumeIdx = j;
                        break;
                    }
                }
                if (resumeIdx !== -1) {
                    for (let k = i; k < resumeIdx; k++) {
                        segments[k].isAd = true;
                        segments[k].adReason = `Sequence_Reset_Ad(${prevNum}->${currNum})`;
                    }
                    i = resumeIdx - 1;
                }
            }
        }
    }

    // 5. Quét dị biệt thời lượng phân đoạn (#EXTINF) quanh mốc phút 15 (từ 14m30s đến 16m00s)
    for (let i = 0; i < segments.length; i++) {
        const s = segments[i];
        if (s.isAd) continue;
        if (s.startTime >= 870 && s.startTime <= 960) {
            const isWeirdDur = standardDur > 0 && Math.abs(s.duration - standardDur) > 0.15;
            if (s.discontinuityBefore || isWeirdDur) {
                let cutDur = 0;
                for (let k = i; k < segments.length && cutDur < 28; k++) {
                    segments[k].isAd = true;
                    segments[k].adReason = `Minute15_Anomaly_Cut(dur=${segments[k].duration}s,std=${standardDur}s)`;
                    cutDur += segments[k].duration;
                }
                break;
            }
        }
    }

    const keptSegments = segments.filter(s => !s.isAd);
    const removedSegments = segments.filter(s => s.isAd);
    const finalSegments = keptSegments.length > 0 ? keptSegments : segments;

    const output = [...headerLines, '#EXT-X-PLAYLIST-TYPE:VOD'];
    let lastKeyLine = null;
    let lastDir = null;

    finalSegments.forEach((seg, idx) => {
        if (idx > 0 && lastDir && seg.dir && lastDir !== seg.dir) {
            output.push('#EXT-X-DISCONTINUITY');
        }
        lastDir = seg.dir;

        if (seg.keyLine && seg.keyLine !== lastKeyLine) {
            output.push(seg.keyLine);
            lastKeyLine = seg.keyLine;
        }
        if (seg.byteRange) {
            output.push(seg.byteRange);
        }
        output.push(seg.extInf);
        output.push(seg.absUrl);
    });

    output.push('#EXT-X-ENDLIST');

    const minute15Sample = segments
        .filter(s => s.startTime >= 810 && s.startTime <= 990)
        .map(s => ({
            idx: s.index,
            time: `${Math.floor(s.startTime / 60)}m${Math.floor(s.startTime % 60)}s`,
            dur: s.duration,
            disc: s.discontinuityBefore,
            isAd: s.isAd,
            reason: s.adReason,
            file: s.filename,
            url: s.absUrl
        }));

    return {
        cleanedM3u8: output.join('\n'),
        stats: {
            standardSegmentDuration: standardDur,
            totalSegments: segments.length,
            removedCount: removedSegments.length,
            removedSamples: removedSegments.slice(0, 20).map(s => ({
                idx: s.index,
                time: `${Math.floor(s.startTime / 60)}m${Math.floor(s.startTime % 60)}s`,
                reason: s.adReason,
                url: s.absUrl
            })),
            minute15Window: minute15Sample
        }
    };
}

// Hàm tải M3U8 thông minh: Tự động thử nhiều bộ Header để vượt lỗi 404/403 của CDN phim1280.tv
async function fetchM3U8WithFallback(targetUrl) {
    const headerProfiles = [
        // Profile 1: Sạch hoàn toàn như Stremio/VLC gọi trực tiếp (Không Referer, Không Origin, Không X-Forwarded-For)
        {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Stremio/4.4.168 Chrome/126.0.0.0 Safari/537.36',
            'Accept': '*/*'
        },
        // Profile 2: Giả lập trình phát gốc của KKPhim
        {
            ...CLIENT_HEADERS,
            'Referer': 'https://player.phimapi.com/',
            'Origin': 'https://player.phimapi.com'
        },
        // Profile 3: Giả lập trình phát OPhim
        {
            ...CLIENT_HEADERS,
            'Referer': 'https://ophim1.com/',
            'Origin': 'https://ophim1.com'
        }
    ];

    let lastError = null;
    for (let i = 0; i < headerProfiles.length; i++) {
        try {
            const res = await axios.get(targetUrl, {
                headers: headerProfiles[i],
                httpsAgent,
                responseType: 'text',
                timeout: 8000
            });
            if (res.data && typeof res.data === 'string' && res.data.includes('#EXTM3U')) {
                return { content: res.data, profileUsed: i + 1 };
            }
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError || new Error('Failed all header profiles');
}

async function buildCleanM3U8(masterOrMediaUrl) {
    const cacheKey = `clean_v983:${masterOrMediaUrl}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    try {
        const res1 = await fetchM3U8WithFallback(masterOrMediaUrl);
        let content = res1.content;
        let finalBaseUrl = masterOrMediaUrl;

        if (typeof content === 'string' && content.includes('#EXT-X-STREAM-INF')) {
            const variantUrl = pickBestVariantUrl(content, masterOrMediaUrl);
            if (variantUrl) {
                const res2 = await fetchM3U8WithFallback(variantUrl);
                if (res2.content && res2.content.includes('#EXTM3U')) {
                    content = res2.content;
                    finalBaseUrl = variantUrl;
                }
            }
        }

        if (typeof content === 'string' && content.includes('#EXTM3U')) {
            const result = stripAdsSegmentLevel(content, finalBaseUrl);
            lastPlayedM3U8Info = {
                status: 'SUCCESS_CLEANED',
                profileUsed: res1.profileUsed,
                masterUrl: masterOrMediaUrl,
                mediaUrl: finalBaseUrl,
                timestamp: new Date().toISOString(),
                stats: result.stats
            };
            setCache(cacheKey, result.cleanedM3u8, 3600);
            return result.cleanedM3u8;
        }

        lastPlayedM3U8Info = {
            status: 'INVALID_M3U8_CONTENT',
            masterUrl: masterOrMediaUrl,
            timestamp: new Date().toISOString(),
            preview: String(content).substring(0, 300)
        };
        return null;
    } catch (err) {
        lastPlayedM3U8Info = {
            status: 'FETCH_ERROR_FALLBACK_TO_RAW',
            masterUrl: masterOrMediaUrl,
            timestamp: new Date().toISOString(),
            error: err.message,
            httpStatus: err.response?.status || null
        };
        return null;
    }
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

            const baseProxyUrl = PUBLIC_BASE_URL || 'https://stremio-nguonc-hzjc.onrender.com';
            const encoded = encodeUrlBase64(rawM3u8);

            results.push({
                name: `🛡️ [${providerName}] Không QC`,
                title: `Tập ${cleanEpName}${srvName} (Lọc sâu v9.8.3)`,
                url: `${baseProxyUrl}/hls/${encoded}/master.m3u8`
            });

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
        const streamCacheKey = `stream_v983:${type}:${id}`;
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

        const opClean = ophimStreams.filter(s => s.name.includes('Không QC'));
        const kkClean = kkStreams.filter(s => s.name.includes('Không QC'));
        const rawDirectStreams = [...ophimStreams, ...kkStreams].filter(s => !s.name.includes('Không QC'));

        const allStreams = [
            ...opClean,
            ...kkClean,
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

app.get('/hls/:encoded/master.m3u8', async (req, res) => {
    const targetUrl = decodeUrlBase64(req.params.encoded);
    if (!targetUrl) return res.status(400).send('Invalid stream URL');

    try {
        const cleanedM3u8 = await buildCleanM3U8(targetUrl);

        if (cleanedM3u8) {
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            return res.send(cleanedM3u8);
        }

        res.redirect(targetUrl);
    } catch (e) {
        res.redirect(targetUrl);
    }
});

app.get('/clean.m3u8', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing url');

    try {
        const cleanedM3u8 = await buildCleanM3U8(targetUrl);

        if (cleanedM3u8) {
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            return res.send(cleanedM3u8);
        }

        res.redirect(targetUrl);
    } catch (e) {
        res.redirect(targetUrl);
    }
});

app.get('/inspect-last', (req, res) => {
    if (!lastPlayedM3U8Info) {
        return res.json({ message: 'Chưa có tập phim nào được mở qua luồng Không QC kể từ lúc server khởi động.' });
    }
    res.json(lastPlayedM3U8Info);
});

app.get('/status', (req, res) => res.json({ ok: true, version: '9.8.3', uptime: process.uptime() }));
app.get('/health', (req, res) => res.status(200).send('OK'));

const addonRouter = getRouter(builder.getInterface());
app.use('/', addonRouter);

app.listen(PORT, () => {
    console.log(`Addon NguonC v9.8.3 (Deep AdBlock) running on port ${PORT}`);

    setInterval(() => {
        const selfUrl = process.env.RENDER_EXTERNAL_URL || PUBLIC_BASE_URL;
        if (selfUrl) {
            axios.get(`${selfUrl}/health`, { timeout: 8000 }).catch(() => {});
        }
    }, 10 * 60 * 1000);
});
