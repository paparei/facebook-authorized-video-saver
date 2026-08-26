import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertCompatiblePair, describeTracks, mergeMp4, parseMp4 } from './muxer.mjs';

const fixture = process.argv[2];
if (!fixture) throw new Error('Usage: node muxer-self-check.mjs <audio-video.mp4>');

const parsed = parseMp4(await readFile(fixture), true);
const inputTracks = describeTracks(parsed);
const video = inputTracks.find(({ kind }) => kind === 'video');
const audio = inputTracks.find(({ kind }) => kind === 'audio');
assert(video && audio, 'Fixture must contain video and audio tracks');
assert(video.duration > 0 && audio.duration > 0, 'Sample-derived durations must be non-zero');
assert.throws(
    () => assertCompatiblePair([
        { ...video, duration: video.timescale * 60 },
        { ...audio, duration: audio.timescale * 115 },
    ]),
    /durations do not match/,
    'Mismatched tracks must be rejected',
);

const output = await mergeMp4([
    { parsed, trackId: video.id, kind: 'video' },
    { parsed, trackId: audio.id, kind: 'audio' },
]);
const outputParsed = parseMp4(output);
const outputTracks = describeTracks(outputParsed);
const outputVideo = outputTracks.find(({ kind }) => kind === 'video');
const outputAudio = outputTracks.find(({ kind }) => kind === 'audio');
assert(outputVideo?.sampleCount === video.sampleCount, 'Video samples were not preserved');
assert(outputAudio?.sampleCount === audio.sampleCount, 'Audio samples were not preserved');
assert(outputVideo.duration === video.duration, 'Video duration was not preserved');
assert(outputAudio.duration === audio.duration, 'Audio duration was not preserved');
assert(outputAudio.sampleRate === audio.sampleRate, 'Audio sample rate was not preserved');
assert(output.byteLength > 100_000, 'Output is unexpectedly small');

const timescales = new Map(outputTracks.map((track) => [track.id, track.timescale]));
const fragments = outputParsed.file.boxes
    .filter(({ type }) => type === 'moof')
    .map(({ trafs }) => ({
        trackId: trafs?.[0]?.tfhd?.track_id,
        decodeTime: trafs?.[0]?.tfdt?.baseMediaDecodeTime,
    }));
assert(fragments.some(({ trackId }) => trackId === outputVideo.id), 'Video fragments are missing');
assert(fragments.some(({ trackId }) => trackId === outputAudio.id), 'Audio fragments are missing');
for (let index = 1; index < fragments.length; index++) {
    const previous = fragments[index - 1];
    const current = fragments[index];
    assert(
        current.decodeTime / timescales.get(current.trackId)
            >= previous.decodeTime / timescales.get(previous.trackId),
        'Audio/video fragments are not in timestamp order',
    );
}

console.log(JSON.stringify({
    inputTracks,
    outputTracks,
    outputBytes: output.byteLength,
    fragmentCount: fragments.length,
}, null, 2));
