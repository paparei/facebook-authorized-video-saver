'use strict';

const MAX_ENTRIES_PER_TAB = 40;
const MAX_AGE_MS = 5 * 60 * 1000;
const tabMedia = new Map();
const requestIndex = new Map();

function isAllowedCdn(hostname) {
    return hostname === 'fbcdn.net' || hostname.endsWith('.fbcdn.net');
}

function canonicalMediaUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || !isAllowedCdn(url.hostname)) return null;
        for (const key of [...url.searchParams.keys()]) {
            if (/^(?:byte)?(?:start|end)|range$/i.test(key)) url.searchParams.delete(key);
        }
        url.hash = '';
        return url.href;
    } catch {
        return null;
    }
}

function decodeEfg(url) {
    try {
        const encoded = new URL(url).searchParams.get('efg');
        if (!encoded) return {};
        const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
        const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
        const value = JSON.parse(new TextDecoder().decode(bytes));
        return {
            tag: String(value.vencode_tag || value.encode_tag || '').slice(0, 120),
            isAudio: Boolean(value.is_audio_only || /audio/i.test(value.vencode_tag || '')),
            isVideo: Boolean(value.is_video_only || /(?:dash|video|h26[45]|av1)/i.test(value.vencode_tag || '')),
        };
    } catch {
        return {};
    }
}

function looksLikeMedia(details, metadata) {
    return details.type === 'media' || Boolean(metadata.isAudio || metadata.isVideo);
}

function prune(tabId, now = Date.now()) {
    const entries = tabMedia.get(tabId);
    if (!entries) return;
    for (const [url, entry] of entries) {
        if (now - entry.lastSeen > MAX_AGE_MS) entries.delete(url);
    }
    while (entries.size > MAX_ENTRIES_PER_TAB) entries.delete(entries.keys().next().value);
    if (!entries.size) tabMedia.delete(tabId);
}

chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        if (details.tabId < 0 || details.initiator?.startsWith('chrome-extension://')) return;
        const canonicalUrl = canonicalMediaUrl(details.url);
        if (!canonicalUrl) return;
        const metadata = decodeEfg(details.url);
        if (!looksLikeMedia(details, metadata)) return;

        const now = Date.now();
        const entries = tabMedia.get(details.tabId) || new Map();
        const entry = entries.get(canonicalUrl) || {
            url: canonicalUrl,
            firstSeen: now,
            lastSeen: now,
            mime: '',
            totalBytes: 0,
            ...metadata,
        };
        entry.lastSeen = now;
        entry.requestType = details.type;
        entries.delete(canonicalUrl);
        entries.set(canonicalUrl, entry);
        tabMedia.set(details.tabId, entries);
        requestIndex.set(details.requestId, { tabId: details.tabId, url: canonicalUrl });
        prune(details.tabId, now);
    },
    { urls: ['https://*.fbcdn.net/*'] },
);

chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
        const indexed = requestIndex.get(details.requestId);
        const entry = indexed && tabMedia.get(indexed.tabId)?.get(indexed.url);
        if (!entry) return;
        const headers = Object.fromEntries(
            (details.responseHeaders || []).map(({ name, value = '' }) => [name.toLowerCase(), value]),
        );
        entry.mime = headers['content-type']?.split(';')[0].trim() || entry.mime;
        if (/^image\//i.test(entry.mime)) {
            tabMedia.get(indexed.tabId)?.delete(indexed.url);
            requestIndex.delete(details.requestId);
            return;
        }
        const total = headers['content-range']?.match(/\/(\d+)$/)?.[1] || headers['content-length'];
        entry.totalBytes = Math.max(entry.totalBytes, Number(total) || 0);
        entry.statusCode = details.statusCode;
    },
    { urls: ['https://*.fbcdn.net/*'] },
    ['responseHeaders'],
);

function forgetRequest(details) {
    requestIndex.delete(details.requestId);
}

chrome.webRequest.onCompleted.addListener(forgetRequest, { urls: ['https://*.fbcdn.net/*'] });
chrome.webRequest.onErrorOccurred.addListener(forgetRequest, { urls: ['https://*.fbcdn.net/*'] });
chrome.tabs.onRemoved.addListener((tabId) => tabMedia.delete(tabId));

function recentCandidates(tabId) {
    prune(tabId);
    return [...(tabMedia.get(tabId)?.values() || [])]
        .sort((a, b) => b.lastSeen - a.lastSeen)
        .map((entry) => ({ ...entry }));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!sender.tab?.id || !['GET_MEDIA', 'OPEN_PROCESSOR'].includes(message?.type)) return;

    (async () => {
        const candidates = recentCandidates(sender.tab.id);
        if (message.type === 'GET_MEDIA') return { ok: true, candidates };
        if (!candidates.length) return { ok: false, error: 'No recent Facebook media requests were found.' };

        const jobId = crypto.randomUUID();
        await chrome.storage.session.set({
            [`job:${jobId}`]: {
                candidates,
                createdAt: Date.now(),
                pageUrl: String(message.pageUrl || sender.tab.url || ''),
                title: String(message.title || sender.tab.title || 'Facebook video'),
            },
        });
        await chrome.tabs.create({ url: chrome.runtime.getURL(`processor.html?job=${encodeURIComponent(jobId)}`) });
        return { ok: true };
    })().then(sendResponse, (error) => {
        console.error('[Facebook Authorized Video Saver]', error);
        sendResponse({ ok: false, error: error.message || String(error) });
    });
    return true;
});

console.assert(
    canonicalMediaUrl('https://video.example.fbcdn.net/v/file.mp4?bytestart=0&byteend=99&token=x')
        === 'https://video.example.fbcdn.net/v/file.mp4?token=x'
        && canonicalMediaUrl('https://fbcdn.net.example.com/video.mp4') === null
        && !looksLikeMedia({ type: 'image' }, {})
        && looksLikeMedia({ type: 'xmlhttprequest' }, { isVideo: true }),
    '[Facebook Authorized Video Saver] URL self-check failed',
);
