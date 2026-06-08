# Background music for generated product videos

Drop royalty-free audio tracks here (`.mp3`, `.m4a`, `.aac`, `.wav`, `.ogg`).

The FFmpeg slideshow engine (`src/lib/video-engines/ffmpeg-slideshow.ts`) picks
one track at random per render and mixes it in at `VIDEO_BRAND.music.volume`
(currently **-18 dB**). If this folder is empty, videos render **silently** —
no error.

**Licensing:** only add tracks you are licensed to use commercially on social
media (e.g. royalty-free / Creative-Commons-with-attribution libraries). Do not
commit copyrighted music.
