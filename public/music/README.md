# Background music for generated product videos

Drop royalty-free audio tracks here (`.mp3`, `.m4a`, `.aac`, `.wav`, `.ogg`).

The FFmpeg slideshow engine (`src/lib/video-engines/ffmpeg-slideshow.ts`) picks
one track at random per render and mixes it in at `VIDEO_BRAND.music.volume`
(currently **-18 dB**). If this folder is empty, videos render **silently** —
no error.

**Licensing:** only add tracks you are licensed to use commercially on social
media (e.g. royalty-free / Creative-Commons-with-attribution libraries). Do not
commit copyrighted music.

## Why the MP3s aren't in the repo

Audio files are large and binary — committing them bloats the git history and
slows clones. So this folder ships **empty** (just this README): add tracks
locally / on the deploy box, and they're picked up automatically at render time.

## Test tracks to get started

Three royalty-free tracks suitable for short-form product video. Download the
MP3 from each page and drop it in this folder (suggested filenames in parens):

1. **Pixabay — "Stylish Fashion / Background"** (Pixabay Content License, no
   attribution required) → save as `upbeat-fashion.mp3`
   https://pixabay.com/music/search/fashion/
2. **Pixabay — "Corporate / Inspiring Upbeat"** (Pixabay Content License) →
   save as `corporate-upbeat.mp3`
   https://pixabay.com/music/search/corporate%20upbeat/
3. **Free Music Archive — Scott Holmes Music, "Upbeat Party"**
   (CC BY — credit "Scott Holmes Music" in the post/description) →
   save as `upbeat-party.mp3`
   https://freemusicarchive.org/music/scott-holmes-music/

> Pixabay's license needs no attribution; the FMA/CC-BY track does — credit the
> artist when you publish a video that uses it. Always confirm the license on
> the track page before committing it commercially.

### Quick download (PowerShell)

```powershell
# after copying a direct MP3 link from the track page:
Invoke-WebRequest -Uri "<direct-mp3-url>" -OutFile "public/music/upbeat-fashion.mp3"
```
