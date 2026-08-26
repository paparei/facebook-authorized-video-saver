import { createFile } from './mp4box.mjs';

const MOVIE_TIMESCALE = 1_000;
const SUPPORTED_TRACK_TYPES = new Set(['audio', 'video']);

function asMp4Buffer(value) {
    const buffer = value instanceof ArrayBuffer
        ? value
        : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    buffer.fileStart = 0;
    return buffer;
}

function trackKind(track) {
    if (SUPPORTED_TRACK_TYPES.has(track.type)) return track.type;
    if (track.video) return 'video';
    if (track.audio) return 'audio';
    return null;
}

export function parseMp4(value, keepMediaData = false) {
    const file = createFile(keepMediaData);
    let info;
    let parseError;
    file.onReady = (value) => { info = value; };
    file.onError = (module, message) => { parseError = new Error(`${module}: ${message}`); };

    try {
        file.appendBuffer(asMp4Buffer(value), true);
        file.flush();
    } catch (error) {
        if (!info) throw error;
    }
    if (!info) throw parseError || new Error('The response is not a complete supported MP4 header.');
    return { file, info };
}

export function describeTracks(parsed) {
    return parsed.info.tracks
        .map((track) => {
            const kind = trackKind(track);
            if (!kind) return null;
            const internal = parsed.file.getTrackById(track.id);
            const entry = internal?.mdia?.minf?.stbl?.stsd?.entries?.[0];
            const sampleCount = Number(track.nb_samples ?? internal?.samples?.length ?? 0);
            return {
                id: track.id,
                kind,
                codec: track.codec || entry?.type || 'unknown',
                language: typeof track.language === 'string' ? track.language : 'und',
                duration: Number(track.duration) || 0,
                timescale: Number(track.timescale) || 1,
                sampleCount,
                width: Number(track.video?.width || entry?.width) || 0,
                height: Number(track.video?.height || entry?.height) || 0,
                sampleRate: Number(track.audio?.sample_rate) || 0,
                channels: Number(track.audio?.channel_count || entry?.channel_count) || 0,
            };
        })
        .filter(Boolean);
}

function cloneDescriptionBox(box) {
    const Constructor = box?.constructor;
    if (typeof Constructor !== 'function') throw new Error('Unsupported MP4 codec description.');
    const clone = new Constructor();
    for (const [key, value] of Object.entries(box)) {
        if (['box_name', 'boxes', 'parent', 'start'].includes(key)) continue;
        clone[key] = ArrayBuffer.isView(value)
            ? new value.constructor(value)
            : value instanceof ArrayBuffer
                ? value.slice(0)
                : Array.isArray(value)
                    ? value.map((item) => item && typeof item === 'object' ? cloneDescriptionBox(item) : item)
                    : value;
    }
    for (const child of box.boxes || []) clone.addBox(cloneDescriptionBox(child));
    return clone;
}

function creationOptions(parsed, track) {
    const internal = parsed.file.getTrackById(track.id);
    const entry = internal?.mdia?.minf?.stbl?.stsd?.entries?.[0];
    if (!internal || !entry?.type) throw new Error(`Track ${track.id} has no MP4 sample description.`);
    if (/^(?:enc[av]|drm)/i.test(entry.type)) throw new Error('Encrypted/DRM tracks are not supported.');

    const seconds = track.duration / track.timescale;
    return {
        type: entry.type,
        hdlr: track.kind === 'video' ? 'vide' : 'soun',
        name: track.kind === 'video' ? 'VideoHandler' : 'SoundHandler',
        language: track.language,
        timescale: track.timescale,
        media_duration: track.duration,
        duration: Math.max(0, Math.round(seconds * MOVIE_TIMESCALE)),
        width: entry.width || track.width || 0,
        height: entry.height || track.height || 0,
        channel_count: entry.channel_count || track.channels || 2,
        samplesize: entry.samplesize || 16,
        samplerate: entry.samplerate || (track.sampleRate << 16) || 65_536,
        description_boxes: (entry.boxes || []).map(cloneDescriptionBox),
    };
}

function sampleOptions(sample) {
    return {
        sample_description_index: (sample.description_index || 0) + 1,
        duration: sample.duration,
        cts: sample.cts,
        dts: sample.dts,
        is_sync: sample.is_sync,
        is_leading: sample.is_leading,
        depends_on: sample.depends_on,
        is_depended_on: sample.is_depended_on,
        has_redundancy: sample.has_redundancy,
        degradation_priority: sample.degradation_priority,
        subsamples: sample.subsamples,
    };
}

export function assertCompatiblePair(tracks) {
    const video = tracks.find((track) => track.kind === 'video');
    const audio = tracks.find((track) => track.kind === 'audio');
    if (!video) throw new Error('No video track was selected.');
    if (!audio) throw new Error('No audio track was selected.');
    if (!video.sampleCount || !audio.sampleCount) throw new Error('A selected track contains no media samples.');

    const videoSeconds = video.duration / video.timescale;
    const audioSeconds = audio.duration / audio.timescale;
    const difference = Math.abs(videoSeconds - audioSeconds);
    if (difference > Math.max(8, Math.min(videoSeconds, audioSeconds) * 0.15)) {
        throw new Error('The selected audio and video durations do not match; replay the target video and try again.');
    }
}

export async function mergeMp4(sources, onProgress = () => {}) {
    const selected = sources.map(({ parsed, trackId, kind }) => {
        const track = describeTracks(parsed).find((item) => item.id === trackId && item.kind === kind);
        if (!track) throw new Error(`The selected ${kind} track is missing from the complete download.`);
        return { parsed, track };
    });
    assertCompatiblePair(selected.map(({ track }) => track));

    const longestSeconds = Math.max(...selected.map(({ track }) => track.duration / track.timescale));
    const output = createFile();
    output.init({
        brands: ['isom', 'iso6', 'mp41'],
        timescale: MOVIE_TIMESCALE,
        duration: Math.round(longestSeconds * MOVIE_TIMESCALE),
    });

    const totalSamples = selected.reduce((total, { track }) => total + track.sampleCount, 0);
    let copied = 0;
    for (const { parsed, track } of selected) {
        const outputTrackId = output.addTrack(creationOptions(parsed, track));
        if (!outputTrackId) throw new Error(`Codec ${track.codec} is not supported by the local MP4 merger.`);

        const samples = parsed.file.getTrackSamplesInfo(track.id) || [];
        if (samples.length !== track.sampleCount) track.sampleCount = samples.length;
        for (let index = 0; index < samples.length; index++) {
            const sample = parsed.file.getTrackSample(track.id, index);
            if (!sample?.data || sample.data.byteLength !== sample.size) {
                throw new Error(`The ${track.kind} download is incomplete at sample ${index + 1}.`);
            }
            output.addSample(outputTrackId, sample.data, sampleOptions(sample));
            sample.data = undefined;
            copied++;
            if (copied % 200 === 0) {
                onProgress(copied / totalSamples);
                await new Promise((resolve) => setTimeout(resolve));
            }
        }
    }

    onProgress(1);
    const result = output.getBuffer().buffer;
    const validation = parseMp4(result);
    const resultTracks = describeTracks(validation);
    if (!resultTracks.some(({ kind, sampleCount }) => kind === 'video' && sampleCount > 0)
        || !resultTracks.some(({ kind, sampleCount }) => kind === 'audio' && sampleCount > 0)) {
        throw new Error('Merged MP4 validation failed; no file was saved.');
    }
    return result;
}

// ponytail: Whole tracks and the merged result are held in memory; use a native
// yt-dlp/FFmpeg helper when routinely processing files larger than 500 MB.
