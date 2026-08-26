import { assertCompatiblePair, describeTracks, mergeMp4, parseMp4 } from './muxer.mjs';

const MAX_MEDIA_BYTES = 750 * 1024 * 1024;
const status = document.querySelector('#status');
const progress = document.querySelector('#progress');
const selection = document.querySelector('#selection');
const videoSelect = document.querySelector('#video');
const audioSelect = document.querySelector('#audio');
const prepareButton = document.querySelector('#prepare');
const previewSection = document.querySelector('#preview-section');
const preview = document.querySelector('#preview');
const saveButton = document.querySelector('#save');
const logElement = document.querySelector('#log');
let job;
let previewUrl = '';

function log(message) {
    logElement.textContent += `${new Date().toLocaleTimeString()}  ${message}\n`;
    logElement.scrollTop = logElement.scrollHeight;
}

function setStatus(message, percent) {
    status.textContent = message;
    if (Number.isFinite(percent)) progress.value = Math.max(0, Math.min(100, percent));
}

function humanBytes(bytes) {
    if (!bytes) return 'size unknown';
    const units = ['B', 'KB', 'MB', 'GB'];
    const order = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** order).toFixed(order > 1 ? 1 : 0)} ${units[order]}`;
}

function allowedUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:'
            && (url.hostname === 'fbcdn.net' || url.hostname.endsWith('.fbcdn.net'));
    } catch {
        return false;
    }
}

function candidateKind(candidate) {
    const hint = `${candidate.mime || ''} ${candidate.tag || ''}`;
    if (candidate.isAudio && !candidate.isVideo) return 'audio';
    if (candidate.isVideo && !candidate.isAudio) return 'video';
    if (/audio|aac|opus/i.test(hint)) return 'audio';
    if (/video|dash|h26[45]|av1|vp9/i.test(hint)) return 'video';
    return 'unknown';
}

function candidateLabel(candidate, index) {
    const age = Math.max(0, Math.round((Date.now() - candidate.lastSeen) / 1000));
    const details = [candidate.tag, candidate.mime, humanBytes(candidate.totalBytes)]
        .filter(Boolean)
        .join(' • ');
    return `Captured ${age}s ago • ${details || `media option ${index + 1}`}`;
}

function populate(select, candidates, kind) {
    select.replaceChildren();
    candidates.forEach((candidate, index) => {
        const option = document.createElement('option');
        option.value = candidate.url;
        option.textContent = candidateLabel(candidate, index);
        select.append(option);
    });
    if (!candidates.length) {
        const option = document.createElement('option');
        option.textContent = `No likely ${kind} track captured`;
        option.disabled = true;
        option.selected = true;
        select.append(option);
    }
}

function filename(extension = 'mp4') {
    const title = String(job?.title || 'Facebook video')
        .replace(/\s*[|·-]\s*Facebook.*$/i, '')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .trim()
        .slice(0, 120) || 'Facebook video';
    return `${title}.${extension}`;
}

async function downloadBuffer(candidate, label, fromPercent, toPercent) {
    if (!candidate || !allowedUrl(candidate.url)) throw new Error(`Invalid ${label} CDN URL.`);
    log(`Downloading ${label}: ${candidate.tag || candidate.mime || 'Facebook CDN track'}`);
    const response = await fetch(candidate.url, { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) {
        throw new Error(`${label} download returned HTTP ${response.status}. Replay the video to refresh its temporary link.`);
    }

    const announced = Number(response.headers.get('content-length')) || candidate.totalBytes || 0;
    if (announced > MAX_MEDIA_BYTES) throw new Error(`${label} is larger than the 750 MB in-browser safety limit.`);
    if (!response.body) throw new Error(`${label} response has no readable body.`);

    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        if (received > MAX_MEDIA_BYTES) {
            await reader.cancel();
            throw new Error(`${label} exceeded the 750 MB in-browser safety limit.`);
        }
        const ratio = announced ? Math.min(1, received / announced) : Math.min(0.95, received / (50 * 1024 * 1024));
        setStatus(`Downloading ${label}: ${humanBytes(received)}${announced ? ` / ${humanBytes(announced)}` : ''}`, fromPercent + (toPercent - fromPercent) * ratio);
    }

    const output = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    log(`${label} downloaded: ${humanBytes(received)}.`);
    return output.buffer;
}

function bestTrack(parsed, kind) {
    return describeTracks(parsed)
        .filter((track) => track.kind === kind && track.sampleCount > 0)
        .sort((a, b) => kind === 'video'
            ? (b.width * b.height - a.width * a.height) || (b.duration / b.timescale - a.duration / a.timescale)
            : (b.channels - a.channels) || (b.sampleRate - a.sampleRate))[0];
}

function clearPreview() {
    preview.pause();
    preview.removeAttribute('src');
    preview.load();
    previewSection.hidden = true;
    saveButton.disabled = true;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = '';
}

async function savePreview(saveAs = true) {
    if (!previewUrl) return;
    saveButton.disabled = true;
    try {
        const downloadId = await chrome.downloads.download({ url: previewUrl, filename: filename(), saveAs });
        if (!Number.isInteger(downloadId)) throw new Error('The browser did not accept the download.');
        log(`Browser download started with ID ${downloadId}.`);
        setStatus('MP4 download started. The preview remains available in this tab.', 100);
    } catch (error) {
        console.error('[Facebook Authorized Video Saver]', error);
        log(`ERROR: ${error.stack || error.message || error}`);
        setStatus(error.message || String(error), 100);
    } finally {
        saveButton.disabled = !previewUrl;
    }
}

async function preparePreview(autoSave = false) {
    const videoCandidate = job.candidates.find(({ url }) => url === videoSelect.value);
    const audioCandidate = job.candidates.find(({ url }) => url === audioSelect.value);
    if (!videoCandidate || !audioCandidate) {
        setStatus('Replay the target video on Facebook, then reopen the saver.', 0);
        return;
    }

    prepareButton.disabled = true;
    videoSelect.disabled = true;
    audioSelect.disabled = true;
    clearPreview();
    try {
        const videoBuffer = await downloadBuffer(videoCandidate, 'video track', 0, 36);
        setStatus('Validating the video track…', 38);
        const videoParsed = parseMp4(videoBuffer, true);
        const videoTrack = bestTrack(videoParsed, 'video');
        if (!videoTrack) throw new Error('The selected video response contains no complete video track. Choose another captured option.');

        let output = videoBuffer;
        const embeddedAudio = bestTrack(videoParsed, 'audio');
        if (embeddedAudio) {
            log('Facebook exposed a complete MP4 with embedded audio; no merge is needed.');
        } else {
            const alternatives = autoSave
                ? [audioCandidate, ...job.candidates.filter((candidate) =>
                    candidate.url !== audioCandidate.url && candidateKind(candidate) === 'audio')]
                : [audioCandidate];
            let lastError;
            for (const candidate of alternatives) {
                try {
                    const audioBuffer = videoCandidate.url === candidate.url
                        ? videoBuffer
                        : await downloadBuffer(candidate, 'audio track', 40, 76);
                    setStatus('Validating the audio track…', 78);
                    const audioParsed = videoCandidate.url === candidate.url
                        ? videoParsed
                        : parseMp4(audioBuffer, true);
                    const audioTrack = bestTrack(audioParsed, 'audio');
                    if (!audioTrack) throw new Error('The selected audio response contains no complete audio track. Choose another captured option.');
                    assertCompatiblePair([videoTrack, audioTrack]);

                    log(`Muxing ${videoTrack.codec} video with ${audioTrack.codec} audio without re-encoding.`);
                    output = await mergeMp4([
                        { parsed: videoParsed, trackId: videoTrack.id, kind: 'video' },
                        { parsed: audioParsed, trackId: audioTrack.id, kind: 'audio' },
                    ], (ratio) => setStatus('Merging tracks locally…', 80 + ratio * 15));
                    audioSelect.value = candidate.url;
                    lastError = null;
                    break;
                } catch (error) {
                    if (!autoSave) throw error;
                    lastError = error;
                    log(`Skipping captured audio: ${error.message || error}`);
                }
            }
            if (lastError) {
                throw new Error(`No captured audio matched this video. Replay only the target video and retry. ${lastError.message || lastError}`);
            }
        }

        setStatus('Preparing the local preview…', 98);
        previewUrl = URL.createObjectURL(new Blob([output], { type: 'video/mp4' }));
        preview.src = previewUrl;
        previewSection.hidden = false;
        saveButton.disabled = false;
        setStatus(`Preview ready (${humanBytes(output.byteLength)}).${autoSave ? ' Starting the MP4 download…' : ' Check it, then download the MP4.'}`, 100);
        if (autoSave) await savePreview(false);
    } catch (error) {
        console.error('[Facebook Authorized Video Saver]', error);
        log(`ERROR: ${error.stack || error.message || error}`);
        setStatus(error.message || String(error), 0);
    } finally {
        prepareButton.disabled = false;
        videoSelect.disabled = false;
        audioSelect.disabled = false;
    }
}

async function init() {
    const jobId = new URL(location.href).searchParams.get('job');
    if (!jobId || !/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error('Missing or invalid processing job.');
    const key = `job:${jobId}`;
    job = (await chrome.storage.session.get(key))[key];
    await chrome.storage.session.remove(key);
    if (!job || Date.now() - job.createdAt > 10 * 60 * 1000) throw new Error('This processing job expired. Replay the Facebook video and try again.');

    job.candidates = job.candidates.filter(({ url, mime = '' }) => allowedUrl(url) && !/^image\//i.test(mime));
    const videoCandidates = job.candidates.filter((candidate) => candidateKind(candidate) === 'video');
    const likelyAudioCandidates = job.candidates.filter((candidate) => candidateKind(candidate) === 'audio');
    const audioCandidates = likelyAudioCandidates.length ? likelyAudioCandidates : videoCandidates;
    const canPrepare = Boolean(videoCandidates.length && audioCandidates.length);
    populate(videoSelect, videoCandidates, 'video');
    populate(audioSelect, audioCandidates, likelyAudioCandidates.length ? 'audio' : 'combined MP4');
    selection.hidden = false;
    prepareButton.disabled = !canPrepare;
    setStatus(
        canPrepare
            ? 'Automatically preparing the newest captured video/audio pair…'
            : 'Could not identify both tracks. Return to Facebook, play the target video for several seconds, then retry.',
        0,
    );
    log(`Loaded ${job.candidates.length} recent signed media URL(s) from the authorized Facebook tab.`);
    if (canPrepare) await preparePreview(job.autoSave === true);
}

prepareButton.addEventListener('click', () => void preparePreview());
saveButton.addEventListener('click', () => void savePreview());
for (const select of [videoSelect, audioSelect]) {
    select.addEventListener('change', () => {
        clearPreview();
        setStatus('Track selection changed. Prepare the preview again.', 0);
    });
}
preview.addEventListener('error', () => {
    if (previewUrl) setStatus('This browser cannot preview the prepared codec, but the MP4 can still be downloaded.', 100);
});
window.addEventListener('pagehide', clearPreview);

init().catch((error) => {
    console.error('[Facebook Authorized Video Saver]', error);
    log(`ERROR: ${error.stack || error.message || error}`);
    setStatus(error.message || String(error), 0);
});

console.assert(
    allowedUrl('https://video.example.fbcdn.net/video.mp4')
        && !allowedUrl('https://fbcdn.net.example.com/video.mp4')
        && candidateKind({ tag: 'dash_h264', isVideo: true }) === 'video'
        && candidateKind({ tag: 'audio_aac', isAudio: true }) === 'audio'
        && candidateKind({ mime: 'image/jpeg' }) === 'unknown',
    '[Facebook Authorized Video Saver] Processor self-check failed',
);
