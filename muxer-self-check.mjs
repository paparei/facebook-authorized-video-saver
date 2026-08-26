import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describeTracks, mergeMp4, parseMp4 } from './muxer.mjs';

const fixture = process.argv[2];
if (!fixture) throw new Error('Usage: node muxer-self-check.mjs <audio-video.mp4>');

const parsed = parseMp4(await readFile(fixture), true);
const inputTracks = describeTracks(parsed);
const video = inputTracks.find(({ kind }) => kind === 'video');
const audio = inputTracks.find(({ kind }) => kind === 'audio');
assert(video && audio, 'Fixture must contain video and audio tracks');

const output = await mergeMp4([
    { parsed, trackId: video.id, kind: 'video' },
    { parsed, trackId: audio.id, kind: 'audio' },
]);
const outputTracks = describeTracks(parseMp4(output));
const outputVideo = outputTracks.find(({ kind }) => kind === 'video');
const outputAudio = outputTracks.find(({ kind }) => kind === 'audio');
assert(outputVideo?.sampleCount === video.sampleCount, 'Video samples were not preserved');
assert(outputAudio?.sampleCount === audio.sampleCount, 'Audio samples were not preserved');
assert(output.byteLength > 100_000, 'Output is unexpectedly small');

console.log(JSON.stringify({ inputTracks, outputTracks, outputBytes: output.byteLength }, null, 2));
