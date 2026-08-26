# Facebook Authorized Video Saver

A local Brave/Chrome/Edge extension for Facebook videos you own or have permission to download. It captures the signed Facebook CDN tracks already requested by your authorized tab, downloads the complete MP4 video/audio tracks, and merges them locally without re-encoding.

It does **not** bypass private-group membership, Facebook login, DRM, or other access controls.

## Install (no other software)

1. Extract the shared ZIP to a permanent folder.
2. Open the browser's extensions page:
   - Brave: `brave://extensions`
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the extracted `facebook-video-downloader-extension` folder.
5. Reload any Facebook tabs that were already open.

A ZIP cannot be loaded directly; extract it first. Unpacked extensions do not auto-update, so replace the folder and click **Reload** on the extensions page when receiving a new version.

## Use

1. Log in to Facebook normally and open the target video.
2. Play the target video for 5–10 seconds. This lets Facebook request its signed audio/video tracks.
3. Click **Save video** at the bottom-right.
4. Choose **Fast download and merge**.
5. The processing tab automatically downloads and merges the newest matching video/audio pair, then shows a local preview.
6. Check the preview and click **Download MP4**.

If the preview is wrong, choose different tracks and click **Prepare preview again**. If Facebook exposes a combined MP4, no merge is needed. Otherwise, separate DASH audio and video tracks are merged locally. The fallback recorder works in real time when Facebook serves an unsupported layout.

## Privacy and permissions

- Media processing stays on the device.
- The extension does not contact an external conversion service.
- It does not read, export, or upload Facebook cookies.
- Temporary signed CDN URLs are kept only in extension memory/session storage and expire quickly.
- Host access is limited to Facebook pages and Facebook's `fbcdn.net` media CDN.
- `webRequest` observes media URLs; `downloads` saves the result; `storage` passes a short-lived job to the visible processor tab.

## Limits

- Only unencrypted MP4/DASH tracks supported by MP4Box can be merged. DRM is rejected.
- Signed links expire. Replay the target video and retry if a download returns HTTP 403/404.
- Keep only the target video playing; ads or another playing video can make the automatically selected pair or preview incorrect.
- Audio and video are held in browser memory while merging. A 750 MB per-track safety limit prevents tab crashes; native yt-dlp/FFmpeg is better for very large files.
- Facebook can change its player/CDN metadata, so automatic track labels may occasionally be vague. Pick the most recent matching pair.

## Included dependency

`mp4box` 2.4.1 (MP4Box.js) is included locally under its BSD-3-Clause license. See `MP4BOX-LICENSE.txt`. No runtime code is loaded from a CDN.

## Developer self-check

Run against any small H.264/AAC MP4 fixture:

```powershell
node .\muxer-self-check.mjs .\fixture.mp4
```

The check parses the source, remuxes its audio/video samples, reparses the output, and asserts that sample counts were preserved.
