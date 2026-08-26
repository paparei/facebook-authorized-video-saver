'use strict';

function visibleArea(video) {
    const rect = video.getBoundingClientRect();
    const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
    return width * height * (video.paused ? 1 : 2);
}

function activeVideo() {
    return [...document.querySelectorAll('video')]
        .map((video) => ({ video, area: visibleArea(video) }))
        .filter(({ area }) => area > 0)
        .sort((a, b) => b.area - a.area)[0]?.video;
}

function safeFilename(extension) {
    const title = document.title
        .replace(/\s*[|·-]\s*Facebook.*$/i, '')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .trim()
        .slice(0, 120) || 'Facebook video';
    return `${title}.${extension}`;
}

const host = document.createElement('div');
host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647';
const shadow = host.attachShadow({ mode: 'closed' });
shadow.innerHTML = `
    <style>
        :host { color-scheme: light dark; font: 14px/1.4 system-ui, sans-serif }
        button { border: 0; border-radius: 8px; min-height: 40px; padding: 9px 12px; color: white; background: #0866ff; cursor: pointer; font: inherit; font-weight: 650 }
        button:hover { filter: brightness(.92) }
        button:focus-visible { outline: 3px solid #83afff; outline-offset: 2px }
        button:disabled { opacity: .6; cursor: wait }
        #panel { box-sizing: border-box; width: min(360px, calc(100vw - 32px)); margin-bottom: 8px; padding: 13px; border: 1px solid #7777; border-radius: 12px; color: CanvasText; background: Canvas; box-shadow: 0 8px 30px #0006 }
        #panel[hidden] { display: none }
        header { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-weight: 750 }
        #close { min-height: 30px; padding: 1px 8px; color: CanvasText; background: transparent; font-size: 21px }
        #status { margin: 9px 0; white-space: pre-line }
        #actions { display: grid; gap: 8px }
        #record { color: CanvasText; background: color-mix(in srgb, CanvasText 14%, Canvas) }
        small { display: block; margin-top: 9px; opacity: .72 }
    </style>
    <section id="panel" role="dialog" aria-label="Facebook video saver" hidden>
        <header><span>Authorized video saver</span><button id="close" type="button" aria-label="Close">×</button></header>
        <p id="status" aria-live="polite">Play the target video for several seconds before downloading.</p>
        <div id="actions">
            <button id="download" type="button">Fast download and merge</button>
            <button id="record" type="button">Record active video (fallback)</button>
        </div>
        <small>Processing stays on this device. Only save videos you own or have permission to download.</small>
    </section>
    <button id="open" type="button" aria-haspopup="dialog" aria-expanded="false">Save video</button>`;
document.documentElement.append(host);

const panel = shadow.querySelector('#panel');
const openButton = shadow.querySelector('#open');
const closeButton = shadow.querySelector('#close');
const downloadButton = shadow.querySelector('#download');
const recordButton = shadow.querySelector('#record');
const status = shadow.querySelector('#status');
let recording;

function setPanel(open) {
    panel.hidden = !open;
    openButton.setAttribute('aria-expanded', String(open));
    (open ? closeButton : openButton).focus();
}

function setStatus(message) {
    status.textContent = message;
}

function stopRecording() {
    if (recording?.recorder.state !== 'inactive') {
        setStatus('Finishing the recording…');
        recording.recorder.stop();
    }
}

function startRecording() {
    const video = activeVideo();
    const capture = video && (video.captureStream || video.mozCaptureStream);
    if (!video) {
        setStatus('No visible video found. Open and play the target video first.');
        return;
    }
    if (!capture || typeof MediaRecorder === 'undefined') {
        setStatus('This browser does not expose recording for the active player.');
        return;
    }

    try {
        const stream = capture.call(video);
        if (!stream.getVideoTracks().length) {
            stream.getTracks().forEach((track) => track.stop());
            setStatus('No active video track was exposed. Keep playback running and retry.');
            return;
        }
        const mimeType = [
            'video/webm;codecs=vp9,opus',
            'video/webm;codecs=vp8,opus',
            'video/webm',
        ].find((type) => MediaRecorder.isTypeSupported(type));
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        const chunks = [];
        const startedAt = Date.now();
        const ended = () => stopRecording();
        const timer = setInterval(() => {
            const seconds = Math.floor((Date.now() - startedAt) / 1_000);
            setStatus(`Recording ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} in real time. Keep this tab and video playing.`);
        }, 1_000);

        recording = { recorder, stream, chunks, timer, video, ended };
        recorder.addEventListener('dataavailable', (event) => {
            if (event.data.size) chunks.push(event.data);
        });
        recorder.addEventListener('error', (event) => {
            console.error('[Facebook Authorized Video Saver]', event.error);
            setStatus(`Recording failed: ${event.error?.message || 'unknown recorder error'}`);
        });
        recorder.addEventListener('stop', () => {
            clearInterval(timer);
            video.removeEventListener('ended', ended);
            stream.getTracks().forEach((track) => track.stop());
            recording = undefined;
            recordButton.textContent = 'Record active video (fallback)';
            openButton.textContent = 'Save video';
            if (!chunks.length) {
                setStatus('The recording contained no data. Keep playback running and retry.');
                return;
            }
            const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = safeFilename('webm');
            anchor.hidden = true;
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
            setStatus(`Saved ${Math.max(1, Math.round(blob.size / 1_048_576))} MB WebM recording.`);
        }, { once: true });
        video.addEventListener('ended', ended, { once: true });
        recorder.start(1_000);
        recordButton.textContent = 'Stop and save recording';
        openButton.textContent = 'Stop recording';
        setStatus('Recording started. Keep this tab and video playing.');
    } catch (error) {
        console.error('[Facebook Authorized Video Saver]', error);
        setStatus(`Could not record this player: ${error.message}`);
    }
}

openButton.addEventListener('click', () => {
    if (recording) stopRecording();
    else setPanel(true);
});
closeButton.addEventListener('click', () => setPanel(false));
recordButton.addEventListener('click', () => recording ? stopRecording() : startRecording());
downloadButton.addEventListener('click', async () => {
    if (!activeVideo()) {
        setStatus('No visible video found. Open and play the target video first.');
        return;
    }
    downloadButton.disabled = true;
    setStatus('Opening the local track downloader…');
    try {
        const response = await chrome.runtime.sendMessage({
            type: 'OPEN_PROCESSOR',
            pageUrl: location.href,
            title: document.title,
        });
        if (!response?.ok) throw new Error(response?.error || 'Could not open the downloader.');
        setStatus('Downloader opened in a new tab.');
    } catch (error) {
        console.error('[Facebook Authorized Video Saver]', error);
        setStatus(`${error.message}\nPlay the video for several seconds, then retry.`);
    } finally {
        downloadButton.disabled = false;
    }
});
shadow.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) setPanel(false);
});
