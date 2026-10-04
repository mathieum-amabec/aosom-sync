/**
 * Background-music candidates for the Ameublo videos (2026-10-03).
 *
 * Mat found the stock tracks "trop commercial BS" and asked for a big list to pick ~10 from.
 * All are free for paid social ads with no attribution: Pixabay Content License
 * (https://pixabay.com/service/license-summary/) and Mixkit Stock Music Free License
 * (https://mixkit.co/license/#musicFree). Tracks badged "Content ID Registered" or
 * "AI generated" on Pixabay were left out. Moods come from the sites' tags, not from listening.
 *
 * `audio` is the preview MP3 the Studio plays inline; `page` is where the licence lives.
 * Mat's picks are stored in the `ameublo_music_picks` setting (see /api/ameublo/music).
 */

export type MusicGroup =
  | "lofi" | "jazz" | "funk" | "disco" | "ludique" | "acoustique" | "noel"
  | "s2_chill" | "s2_house" | "s2_noel" | "s2_electro" | "s2_hiphop";

export const MUSIC_GROUPS: Record<MusicGroup, string> = {
  lofi: "Lo-fi / chillhop jazzy",
  jazz: "Jazz lounge / bossa / café français",
  funk: "Funk / soul rétro 70s",
  disco: "Nu-disco / house douce",
  ludique: "Ludique mais sobre",
  acoustique: "Acoustique chaleureux / automne",
  noel: "Noël",
  s2_chill: "Série 2 — Chillhop / jazz enjoué",
  s2_house: "Série 2 — House / nu-disco joyeux",
  s2_noel: "Série 2 — Noël enjoué",
  s2_electro: "Série 2 — Électro joyeux",
  s2_hiphop: "Série 2 — Hip-hop doux"
};

export interface MusicCandidate {
  num: number;
  title: string;
  artist: string;
  group: MusicGroup;
  mood: string;
  source: "pixabay" | "mixkit";
  page: string;
  audio: string;
  /** Claude's favourite, from the descriptions. */
  claudePick: boolean;
  /** Why it is riskier (over-used, AI-heavy artist…). */
  warning?: string;
}

export const MUSIC_CANDIDATES: MusicCandidate[] = [
  {
    num: 1,
    title: "Gentle",
    artist: "37660440",
    group: "lofi",
    mood: "soul jazzy, beat feutré",
    source: "pixabay",
    page: "https://pixabay.com/music/beats-jazzy-soul-trap-x-chill-hip-hop-beat-quotgentlequot-158756/",
    audio: "https://cdn.pixabay.com/download/audio/2023/07/18/audio_e012efc435.mp3?filename=37660440-jazzy-soul-trap-x-chill-hip-hop-beat-quotgentlequot-158756.mp3",
    claudePick: false
  },
  {
    num: 2,
    title: "Chimes",
    artist: "808xri",
    group: "lofi",
    mood: "boom-bap jazzy, carillons",
    source: "pixabay",
    page: "https://pixabay.com/music/beats-jazzy-soul-x-boom-bap-x-hip-hop-instrumental-quotchimesquot-220606/",
    audio: "https://cdn.pixabay.com/download/audio/2024/06/28/audio_369e0616b9.mp3?filename=808xri-jazzy-soul-x-boom-bap-x-hip-hop-instrumental-quotchimesquot-220606.mp3",
    claudePick: true
  },
  {
    num: 3,
    title: "Smooth hip hop",
    artist: "justinhughes",
    group: "lofi",
    mood: "hip-hop doux, court",
    source: "pixabay",
    page: "https://pixabay.com/music/beats-smooth-hip-hop-118860/",
    audio: "https://cdn.pixabay.com/download/audio/2022/09/01/audio_59a50e978a.mp3?filename=justinhughes-smooth-hip-hop-118860.mp3",
    claudePick: false
  },
  {
    num: 4,
    title: "ChILLest",
    artist: "OgifeeltheBeat",
    group: "lofi",
    mood: "chillhop rêveur",
    source: "pixabay",
    page: "https://pixabay.com/music/beats-ogi-feel-the-beat-chillest-191265/",
    audio: "https://cdn.pixabay.com/download/audio/2024/02/14/audio_28c0c946b7.mp3?filename=ogifeelthebeat-ogi-feel-the-beat-chillest-191265.mp3",
    claudePick: false
  },
  {
    num: 5,
    title: "Chillhop Jazz Coffee Shop",
    artist: "alex-morgan",
    group: "lofi",
    mood: "café jazzy lo-fi",
    source: "pixabay",
    page: "https://pixabay.com/music/lofi-chillhop-jazz-coffee-shop-552792/",
    audio: "https://cdn.pixabay.com/download/audio/2026/06/16/audio_912babebe1.mp3?filename=alex-morgan-chillhop-jazz-coffee-shop-552792.mp3",
    claudePick: false,
    warning: "Artiste qui publie souvent de l’IA"
  },
  {
    num: 6,
    title: "Tokyo Cafe",
    artist: "TVARI",
    group: "lofi",
    mood: "lo-fi solaire",
    source: "pixabay",
    page: "https://pixabay.com/music/beats-tvari-tokyo-cafe-159065/",
    audio: "https://cdn.pixabay.com/download/audio/2023/07/22/audio_720626056a.mp3?filename=tvari-tvari-tokyo-cafe-159065.mp3",
    claudePick: false,
    warning: "Très connu (305 k téléchargements)"
  },
  {
    num: 7,
    title: "Sleepy Cat",
    artist: "Alejandro Magaña",
    group: "lofi",
    mood: "lo-fi chill",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/lo-fi-beats/",
    audio: "https://assets.mixkit.co/music/135/135.mp3",
    claudePick: true
  },
  {
    num: 8,
    title: "Sweet September",
    artist: "Arulo",
    group: "lofi",
    mood: "hip-hop lo-fi",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/lo-fi-beats/",
    audio: "https://assets.mixkit.co/music/282/282.mp3",
    claudePick: false
  },
  {
    num: 9,
    title: "Lo-Fi 03",
    artist: "Lily J",
    group: "lofi",
    mood: "lounge lo-fi",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/lounge/",
    audio: "https://assets.mixkit.co/music/765/765.mp3",
    claudePick: false
  },
  {
    num: 10,
    title: "Once In Paris",
    artist: "Pumpupthemind",
    group: "jazz",
    mood: "Paris rêveur, romantique",
    source: "pixabay",
    page: "https://pixabay.com/music/beats-once-in-paris-168895/",
    audio: "https://cdn.pixabay.com/download/audio/2023/09/29/audio_0eaceb1002.mp3?filename=pumpupthemind-once-in-paris-168895.mp3",
    claudePick: false,
    warning: "Très connu (377 k téléchargements)"
  },
  {
    num: 11,
    title: "Paris Cafe",
    artist: "BFCMUSIC",
    group: "jazz",
    mood: "café parisien, beat léger",
    source: "pixabay",
    page: "https://pixabay.com/music/beats-paris-cafe-541773/",
    audio: "https://cdn.pixabay.com/download/audio/2026/06/04/audio_5a7368569b.mp3?filename=bfcmusic-paris-cafe-541773.mp3",
    claudePick: true
  },
  {
    num: 12,
    title: "French Cafe Music",
    artist: "BFCMUSIC",
    group: "jazz",
    mood: "café français, court",
    source: "pixabay",
    page: "https://pixabay.com/music/electronic-french-cafe-music-541771/",
    audio: "https://cdn.pixabay.com/download/audio/2026/06/04/audio_8b6264eb07.mp3?filename=bfcmusic-french-cafe-music-541771.mp3",
    claudePick: false
  },
  {
    num: 13,
    title: "Lounge",
    artist: "prettyjohn1",
    group: "jazz",
    mood: "bossa lounge, boucle de 35 s",
    source: "pixabay",
    page: "https://pixabay.com/music/bossa-nova-lounge-494159/",
    audio: "https://cdn.pixabay.com/download/audio/2026/03/02/audio_f41b7a3546.mp3?filename=prettyjohn1-lounge-494159.mp3",
    claudePick: false
  },
  {
    num: 14,
    title: "Midnight",
    artist: "JuliusH",
    group: "jazz",
    mood: "piano électrique, lounge nocturne",
    source: "pixabay",
    page: "https://pixabay.com/music/smooth-jazz-midnight-e-piano-lounge-amp-chill-music-617/",
    audio: "https://cdn.pixabay.com/download/audio/2020/08/14/audio_b6a6a9f9f7.mp3?filename=juliush-midnight-e-piano-lounge-amp-chill-music-617.mp3",
    claudePick: false
  },
  {
    num: 15,
    title: "Latin Lovers",
    artist: "Ahjay Stelino",
    group: "jazz",
    mood: "bossa nova jazz",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/bossa-nova/",
    audio: "https://assets.mixkit.co/music/39/39.mp3",
    claudePick: false
  },
  {
    num: 16,
    title: "Groovy Jazz",
    artist: "Francisco Alvear",
    group: "jazz",
    mood: "jazz lounge groovy",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/lounge/",
    audio: "https://assets.mixkit.co/music/646/646.mp3",
    claudePick: true
  },
  {
    num: 17,
    title: "Fun Jazz",
    artist: "Francisco Alvear",
    group: "jazz",
    mood: "jazz enjoué",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/lounge/",
    audio: "https://assets.mixkit.co/music/647/647.mp3",
    claudePick: false
  },
  {
    num: 18,
    title: "Swing is the Answer",
    artist: "Diego Nava",
    group: "jazz",
    mood: "swing rétro",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/jazz/",
    audio: "https://assets.mixkit.co/music/526/526.mp3",
    claudePick: false
  },
  {
    num: 19,
    title: "Funk",
    artist: "prettyjohn1",
    group: "funk",
    mood: "funk groovy, basse",
    source: "pixabay",
    page: "https://pixabay.com/music/funk-funk-503900/",
    audio: "https://cdn.pixabay.com/download/audio/2026/03/17/audio_e60526735a.mp3?filename=prettyjohn1-funk-503900.mp3",
    claudePick: true
  },
  {
    num: 20,
    title: "Retro Funk",
    artist: "prettyjohn1",
    group: "funk",
    mood: "funk rétro",
    source: "pixabay",
    page: "https://pixabay.com/music/funk-retro-funk-523181/",
    audio: "https://cdn.pixabay.com/download/audio/2026/04/22/audio_4df23b471a.mp3?filename=prettyjohn1-retro-funk-523181.mp3",
    claudePick: false
  },
  {
    num: 21,
    title: "Funk Groove Soul",
    artist: "prettyjohn1",
    group: "funk",
    mood: "funk-soul",
    source: "pixabay",
    page: "https://pixabay.com/music/funk-funk-groove-soul-527077/",
    audio: "https://cdn.pixabay.com/download/audio/2026/05/09/audio_932f1bd8f9.mp3?filename=prettyjohn1-funk-groove-soul-527077.mp3",
    claudePick: false
  },
  {
    num: 22,
    title: "Groove",
    artist: "prettyjohn1",
    group: "funk",
    mood: "groove de basse",
    source: "pixabay",
    page: "https://pixabay.com/music/funk-groove-525025/",
    audio: "https://cdn.pixabay.com/download/audio/2026/04/26/audio_3a2a2d02cc.mp3?filename=prettyjohn1-groove-525025.mp3",
    claudePick: false
  },
  {
    num: 23,
    title: "Vintage Funk Bass Groove Loop",
    artist: "Black_Kumizhi",
    group: "funk",
    mood: "boucle de basse vintage",
    source: "pixabay",
    page: "https://pixabay.com/music/funk-vintage-funk-bass-groove-loop-553937/",
    audio: "https://cdn.pixabay.com/download/audio/2026/06/27/audio_3324deed8b.mp3?filename=black_kumizhi-vintage-funk-bass-groove-loop-553937.mp3",
    claudePick: true
  },
  {
    num: 24,
    title: "70s-80s Funk Beat",
    artist: "BlueGrayA10",
    group: "funk",
    mood: "beat funk 70s",
    source: "pixabay",
    page: "https://pixabay.com/music/beats-70s-80s-funk-beat-271581/",
    audio: "https://cdn.pixabay.com/download/audio/2024/12/02/audio_fc6d94697c.mp3?filename=bluegraya10-70s-80s-funk-beat-271581.mp3",
    claudePick: false
  },
  {
    num: 25,
    title: "Dry Gin",
    artist: "Michael Ramir C.",
    group: "funk",
    mood: "acid jazz",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/acid-jazz/",
    audio: "https://assets.mixkit.co/music/868/868.mp3",
    claudePick: false
  },
  {
    num: 26,
    title: "Blue Funk",
    artist: "Michael Ramir C.",
    group: "funk",
    mood: "funk bluesy",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/funk/",
    audio: "https://assets.mixkit.co/music/1054/1054.mp3",
    claudePick: false
  },
  {
    num: 27,
    title: "Funky Triplets",
    artist: "Michael Ramir C.",
    group: "funk",
    mood: "funk R&B",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/funk/",
    audio: "https://assets.mixkit.co/music/1141/1141.mp3",
    claudePick: false
  },
  {
    num: 28,
    title: "Gimme that Groove!",
    artist: "Michael Ramir C.",
    group: "funk",
    mood: "funk énergique",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/funk/",
    audio: "https://assets.mixkit.co/music/872/872.mp3",
    claudePick: false
  },
  {
    num: 29,
    title: "Cotton Candy R&B Beat",
    artist: "Michael Ramir C.",
    group: "funk",
    mood: "soul R&B doux",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/soul/",
    audio: "https://assets.mixkit.co/music/1094/1094.mp3",
    claudePick: false
  },
  {
    num: 30,
    title: "Chill Reel",
    artist: "Kulakovka",
    group: "disco",
    mood: "house chill, groovy",
    source: "pixabay",
    page: "https://pixabay.com/music/house-chill-reel-570198/",
    audio: "https://cdn.pixabay.com/download/audio/2026/07/19/audio_cb944b1856.mp3?filename=kulakovka-chill-reel-570198.mp3",
    claudePick: true
  },
  {
    num: 31,
    title: "Attraction",
    artist: "47643651",
    group: "disco",
    mood: "nu-disco pop",
    source: "pixabay",
    page: "https://pixabay.com/music/dance-attraction-disco-x-nudisco-x-pop-instrumental-450602/",
    audio: "https://cdn.pixabay.com/download/audio/2025/12/12/audio_41d14915eb.mp3?filename=47643651-attraction-disco-x-nudisco-x-pop-instrumental-450602.mp3",
    claudePick: false
  },
  {
    num: 32,
    title: "Nu Disco",
    artist: "DRAGON-STUDIO",
    group: "disco",
    mood: "nu-disco décontracté",
    source: "pixabay",
    page: "https://pixabay.com/music/disco-nu-disco-584761/",
    audio: "https://cdn.pixabay.com/download/audio/2026/08/12/audio_7025184ee0.mp3?filename=dragon-studio-nu-disco-584761.mp3",
    claudePick: false
  },
  {
    num: 33,
    title: "Disco Funk",
    artist: "prettyjohn1",
    group: "disco",
    mood: "disco-funk",
    source: "pixabay",
    page: "https://pixabay.com/music/disco-disco-funk-520385/",
    audio: "https://cdn.pixabay.com/download/audio/2026/04/16/audio_de515aaccf.mp3?filename=prettyjohn1-disco-funk-520385.mp3",
    claudePick: false
  },
  {
    num: 34,
    title: "Disco Ain’t Old School",
    artist: "Michael Ramir C.",
    group: "disco",
    mood: "disco moderne",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/disco/",
    audio: "https://assets.mixkit.co/music/935/935.mp3",
    claudePick: false
  },
  {
    num: 35,
    title: "Life is a Dream",
    artist: "Michael Ramir C.",
    group: "disco",
    mood: "disco",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/disco/",
    audio: "https://assets.mixkit.co/music/837/837.mp3",
    claudePick: false
  },
  {
    num: 36,
    title: "Pizzicato Flow",
    artist: "VitMatNotes",
    group: "ludique",
    mood: "pizzicato ludique",
    source: "pixabay",
    page: "https://pixabay.com/music/cartoons-pizzicato-flow-558613/",
    audio: "https://cdn.pixabay.com/download/audio/2026/06/28/audio_cf3868161d.mp3?filename=vitmatnotes-pizzicato-flow-558613.mp3",
    claudePick: false
  },
  {
    num: 37,
    title: "Playful Marimba",
    artist: "JorisVermeer",
    group: "ludique",
    mood: "marimba groovy, décalé",
    source: "pixabay",
    page: "https://pixabay.com/music/cartoons-playful-marimba-background-570155/",
    audio: "https://cdn.pixabay.com/download/audio/2026/07/19/audio_0ba1240e50.mp3?filename=jorisvermeer-playful-marimba-background-570155.mp3",
    claudePick: true
  },
  {
    num: 38,
    title: "A Cute Ghost Story",
    artist: "MMAudio",
    group: "ludique",
    mood: "mignon-mystère (Halloween)",
    source: "pixabay",
    page: "https://pixabay.com/music/eccentric-quirky-a-cute-ghost-story-512522/",
    audio: "https://cdn.pixabay.com/download/audio/2026/04/01/audio_ac5a8fae80.mp3?filename=mmaudio-a-cute-ghost-story-512522.mp3",
    claudePick: false
  },
  {
    num: 39,
    title: "Start Somewhere Good",
    artist: "MMAudio",
    group: "ludique",
    mood: "décalé, enjoué",
    source: "pixabay",
    page: "https://pixabay.com/music/happy-childrens-tunes-start-somewhere-good-512524/",
    audio: "https://cdn.pixabay.com/download/audio/2026/04/01/audio_0602b49d1d.mp3?filename=mmaudio-start-somewhere-good-512524.mp3",
    claudePick: false
  },
  {
    num: 40,
    title: "Bamboo marimba",
    artist: "Jean-Paul-V",
    group: "ludique",
    mood: "marimba bambou, 124 BPM",
    source: "pixabay",
    page: "https://pixabay.com/music/world-bamboo-marimba-tempo-124-236925/",
    audio: "https://cdn.pixabay.com/download/audio/2024/08/31/audio_200b37ff2e.mp3?filename=jean-paul-v-bamboo-marimba-tempo-124-236925.mp3",
    claudePick: false
  },
  {
    num: 41,
    title: "Sylvia Pizzicato",
    artist: "Abydos_Music",
    group: "ludique",
    mood: "classique espiègle",
    source: "pixabay",
    page: "https://pixabay.com/music/sneaky-leo-delibes-sylvia-pizzicato-183826/",
    audio: "https://cdn.pixabay.com/download/audio/2024/01/02/audio_b2eab2f32a.mp3?filename=abydos_music-leo-delibes-sylvia-pizzicato-183826.mp3",
    claudePick: false,
    warning: "Air classique très connu"
  },
  {
    num: 42,
    title: "Simple Acoustic Folk",
    artist: "33462198",
    group: "acoustique",
    mood: "guitare folk douce",
    source: "pixabay",
    page: "https://pixabay.com/music/solo-guitar-simple-acoustic-folk-138360/",
    audio: "https://cdn.pixabay.com/download/audio/2023/02/08/audio_7877637d63.mp3?filename=33462198-simple-acoustic-folk-138360.mp3",
    claudePick: false
  },
  {
    num: 43,
    title: "Positive Acoustic Guitar Vibes",
    artist: "JorisVermeer",
    group: "acoustique",
    mood: "acoustique lumineux",
    source: "pixabay",
    page: "https://pixabay.com/music/acoustic-group-positive-acoustic-guitar-vibes-526510/",
    audio: "https://cdn.pixabay.com/download/audio/2026/05/07/audio_ae2727885c.mp3?filename=jorisvermeer-positive-acoustic-guitar-vibes-526510.mp3",
    claudePick: true
  },
  {
    num: 44,
    title: "Autumn Acoustic Guitar",
    artist: "YuraSoop",
    group: "acoustique",
    mood: "automne, guitare",
    source: "pixabay",
    page: "https://pixabay.com/music/folk-autumn-acoustic-guitar-593902/",
    audio: "https://cdn.pixabay.com/download/audio/2026/08/29/audio_6a30e4095f.mp3?filename=yurasoop-autumn-acoustic-guitar-593902.mp3",
    claudePick: false
  },
  {
    num: 45,
    title: "Autumn Fall",
    artist: "34910776",
    group: "acoustique",
    mood: "lo-fi automnal",
    source: "pixabay",
    page: "https://pixabay.com/music/beats-autumn-fall-lofi-playlist-edition-and-royalty-free-use-237955/",
    audio: "https://cdn.pixabay.com/download/audio/2024/09/04/audio_5da1902935.mp3?filename=34910776-autumn-fall-lofi-playlist-edition-and-royalty-free-use-237955.mp3",
    claudePick: false
  },
  {
    num: 46,
    title: "Lofi Chillhop Upbeat Guitar",
    artist: "34910776",
    group: "acoustique",
    mood: "chillhop guitare",
    source: "pixabay",
    page: "https://pixabay.com/music/beats-lofi-x-chillhop-upbeat-guitar-playlist-addition-cut-239663/",
    audio: "https://cdn.pixabay.com/download/audio/2024/09/11/audio_500af1a9b4.mp3?filename=34910776-lofi-x-chillhop-upbeat-guitar-playlist-addition-cut-239663.mp3",
    claudePick: false
  },
  {
    num: 47,
    title: "Autumn Leaves",
    artist: "LofCosmos",
    group: "acoustique",
    mood: "lo-fi mélancolique",
    source: "pixabay",
    page: "https://pixabay.com/music/beats-autumn-leaves-157898/",
    audio: "https://cdn.pixabay.com/download/audio/2023/07/12/audio_860e20dd20.mp3?filename=lofcosmos-autumn-leaves-157898.mp3",
    claudePick: false
  },
  {
    num: 48,
    title: "Long Gone",
    artist: "Michael Ramir C.",
    group: "acoustique",
    mood: "indie folk",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/indie-folk/",
    audio: "https://assets.mixkit.co/music/1186/1186.mp3",
    claudePick: false
  },
  {
    num: 49,
    title: "That Christmas",
    artist: "Looptape",
    group: "noel",
    mood: "Noël chill, court",
    source: "pixabay",
    page: "https://pixabay.com/music/christmas-that-christmas-176114/",
    audio: "https://cdn.pixabay.com/download/audio/2023/11/13/audio_a87c92393c.mp3?filename=looptape-that-christmas-176114.mp3",
    claudePick: false
  },
  {
    num: 50,
    title: "This Christmas LoFi Lounge",
    artist: "SigmaMusicArt",
    group: "noel",
    mood: "lo-fi lounge de Noël",
    source: "pixabay",
    page: "https://pixabay.com/music/christmas-this-christmas-lofi-lounge-182488/",
    audio: "https://cdn.pixabay.com/download/audio/2023/12/21/audio_616485b37b.mp3?filename=sigmamusicart-this-christmas-lofi-lounge-182488.mp3",
    claudePick: true
  },
  {
    num: 51,
    title: "Christmas Tree Chillhop",
    artist: "DopSimon",
    group: "noel",
    mood: "chillhop de Noël",
    source: "pixabay",
    page: "https://pixabay.com/music/beats-20-christmas-tree-chillhop-lofi-christmas-background-music-432409/",
    audio: "https://cdn.pixabay.com/download/audio/2025/11/06/audio_f945faf07c.mp3?filename=dopsimon-20-christmas-tree-chillhop-lofi-christmas-background-music-432409.mp3",
    claudePick: false
  },
  {
    num: 52,
    title: "Christmas Jazz",
    artist: "Diego Nava",
    group: "noel",
    mood: "jazz de Noël",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/tag/christmas/",
    audio: "https://assets.mixkit.co/music/503/503.mp3",
    claudePick: false
  },
  {
    num: 53,
    title: "Let’s All Dance This Christmas",
    artist: "Michael Ramir C.",
    group: "noel",
    mood: "funk festif",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/funk/",
    audio: "https://assets.mixkit.co/music/911/911.mp3",
    claudePick: false
  },
  {
    num: 54,
    title: "Cold Day",
    artist: "Diego Nava",
    group: "noel",
    mood: "valse hivernale",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/tag/christmas/",
    audio: "https://assets.mixkit.co/music/504/504.mp3",
    claudePick: false
  },
  {
    num: 55,
    title: "Happy Lofi",
    artist: "AtlasAudio",
    group: "s2_chill",
    mood: "lofi joyeux, doux, ensoleillé · 2:20",
    source: "pixabay",
    page: "https://pixabay.com/music/beats-happy-lofi-593048/",
    audio: "https://cdn.pixabay.com/download/audio/2026/08/27/audio_287d530bef.mp3?filename=atlasaudio-happy-lofi-593048.mp3",
    claudePick: true
  },
  {
    num: 56,
    title: "For Her Chill Upbeat Summel Travel Vlog and IG Music Royalty Free Use",
    artist: "34910776",
    group: "s2_chill",
    mood: "chill upbeat, voyage, lumineux · 2:13 · 487 000 téléchargements",
    source: "pixabay",
    page: "https://pixabay.com/music/beats-for-her-chill-upbeat-summel-travel-vlog-and-ig-music-royalty-free-use-202298/",
    audio: "https://cdn.pixabay.com/download/audio/2024/04/14/audio_5d6668b1f0.mp3?filename=34910776-for-her-chill-upbeat-summel-travel-vlog-and-ig-music-royalty-free-use-202298.mp3",
    claudePick: true
  },
  {
    num: 57,
    title: "bouncy soul",
    artist: "DesiFreeMusic",
    group: "s2_chill",
    mood: "soul rebondissant, café, léger · 2:00",
    source: "pixabay",
    page: "https://pixabay.com/music/beats-bouncy-soul-269874/",
    audio: "https://cdn.pixabay.com/download/audio/2024/11/28/audio_327043e17a.mp3?filename=desifreemusic-bouncy-soul-269874.mp3",
    claudePick: false
  },
  {
    num: 58,
    title: "Jazz Lo Fi Beat",
    artist: "YuraSoop",
    group: "s2_chill",
    mood: "jazz lo-fi, brillant, détendu · 2:25",
    source: "pixabay",
    page: "https://pixabay.com/music/lofi-jazz-lo-fi-beat-473336/",
    audio: "https://cdn.pixabay.com/download/audio/2026/01/25/audio_c839835161.mp3?filename=yurasoop-jazz-lo-fi-beat-473336.mp3",
    claudePick: false
  },
  {
    num: 59,
    title: "Sunny Beat",
    artist: "-WATERMEL0N-",
    group: "s2_chill",
    mood: "lofi ensoleillé, chill, tranquille · 3:24",
    source: "pixabay",
    page: "https://pixabay.com/music/lofi-sunny-beat-583142/",
    audio: "https://cdn.pixabay.com/download/audio/2026/08/10/audio_d9526b9320.mp3?filename=watermel0n-sunny-beat-583142.mp3",
    claudePick: false
  },
  {
    num: 60,
    title: "Happy Energetic Lo Fi Hip Hop",
    artist: "Musinova",
    group: "s2_chill",
    mood: "lofi joyeux, énergique, rêveur · 1:45",
    source: "pixabay",
    page: "https://pixabay.com/music/beats-happy-energetic-lo-fi-hip-hop-367076/",
    audio: "https://cdn.pixabay.com/download/audio/2025/06/27/audio_444b49dfd6.mp3?filename=musinova-happy-energetic-lo-fi-hip-hop-367076.mp3",
    claudePick: false
  },
  {
    num: 61,
    title: "Chillhop",
    artist: "prettyjohn1",
    group: "s2_chill",
    mood: "chillhop doux, lisse, détendu · 1:46",
    source: "pixabay",
    page: "https://pixabay.com/music/beats-chillhop-595571/",
    audio: "https://cdn.pixabay.com/download/audio/2026/09/07/audio_2e05f6f98a.mp3?filename=prettyjohn1-chillhop-595571.mp3",
    claudePick: false
  },
  {
    num: 62,
    title: "Upbeat Chillhop Vlog Reels Voice Background Music Use",
    artist: "34910776",
    group: "s2_chill",
    mood: "chillhop upbeat, vlog, lumineux · 1:37",
    source: "pixabay",
    page: "https://pixabay.com/music/beats-upbeat-chillhop-vlog-reels-voice-background-music-use-419865/",
    audio: "https://cdn.pixabay.com/download/audio/2025/10/14/audio_a3cc15bbfc.mp3?filename=34910776-upbeat-chillhop-vlog-reels-voice-background-music-use-419865.mp3",
    claudePick: false
  },
  {
    num: 63,
    title: "Twas Lofi Upbeat Chillhop Backgroud Instrgram Vlog Use",
    artist: "34910776",
    group: "s2_chill",
    mood: "lofi upbeat, Instagram, léger · 1:54",
    source: "pixabay",
    page: "https://pixabay.com/music/beats-twas-lofi-upbeat-chillhop-backgroud-instrgram-vlog-use-419876/",
    audio: "https://cdn.pixabay.com/download/audio/2025/10/21/audio_f7214330a7.mp3?filename=34910776-twas-lofi-upbeat-chillhop-backgroud-instrgram-vlog-use-419876.mp3",
    claudePick: false
  },
  {
    num: 64,
    title: "Feel Good Jazz Groove",
    artist: "JorisVermeer",
    group: "s2_chill",
    mood: "jazz groovy, feel good, chaleureux · 2:30",
    source: "pixabay",
    page: "https://pixabay.com/music/traditional-jazz-feel-good-jazz-groove-574580/",
    audio: "https://cdn.pixabay.com/download/audio/2026/07/26/audio_9ee3873fc7.mp3?filename=jorisvermeer-feel-good-jazz-groove-574580.mp3",
    claudePick: true
  },
  {
    num: 65,
    title: "Feel Good Swing Jazz",
    artist: "JorisVermeer",
    group: "s2_chill",
    mood: "swing jazz, feel good, élégant · 1:40",
    source: "pixabay",
    page: "https://pixabay.com/music/smooth-jazz-feel-good-swing-jazz-574578/",
    audio: "https://cdn.pixabay.com/download/audio/2026/07/26/audio_ccd63672b0.mp3?filename=jorisvermeer-feel-good-swing-jazz-574578.mp3",
    claudePick: false
  },
  {
    num: 66,
    title: "Melodic Jazz Funk",
    artist: "-WATERMEL0N-",
    group: "s2_chill",
    mood: "jazz funk mélodique, ludique · 2:34",
    source: "pixabay",
    page: "https://pixabay.com/music/modern-jazz-melodic-jazz-funk-556615/",
    audio: "https://cdn.pixabay.com/download/audio/2026/07/01/audio_527a751be2.mp3?filename=watermel0n-melodic-jazz-funk-556615.mp3",
    claudePick: false
  },
  {
    num: 67,
    title: "Upbeat Jazz",
    artist: "Francisco Alvear",
    group: "s2_chill",
    mood: "jazz entraînant, positif, vif · 1:50",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/jazz/",
    audio: "https://assets.mixkit.co/music/644/644.mp3",
    claudePick: false
  },
  {
    num: 68,
    title: "You Got Jazz",
    artist: "Diego Nava",
    group: "s2_chill",
    mood: "jazz positif, swing, léger · 1:40",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/jazz/",
    audio: "https://assets.mixkit.co/music/528/528.mp3",
    claudePick: false
  },
  {
    num: 69,
    title: "Funky Fit",
    artist: "Ahjay Stelino",
    group: "s2_chill",
    mood: "funky, lounge, optimiste · 1:40",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/lounge/",
    audio: "https://assets.mixkit.co/music/74/74.mp3",
    claudePick: false
  },
  {
    num: 70,
    title: "Chill Electronic House",
    artist: "Musinova",
    group: "s2_house",
    mood: "chill house, groovy, lumineux · 1:42",
    source: "pixabay",
    page: "https://pixabay.com/music/house-chill-electronic-house-563479/",
    audio: "https://cdn.pixabay.com/download/audio/2026/07/13/audio_5077a61d2b.mp3?filename=musinova-chill-electronic-house-563479.mp3",
    claudePick: false
  },
  {
    num: 71,
    title: "Funky Summer House",
    artist: "BerryDeep",
    group: "s2_house",
    mood: "funk-house d'été, énergique · 2:22",
    source: "pixabay",
    page: "https://pixabay.com/music/funk-funky-summer-house-565437/",
    audio: "https://cdn.pixabay.com/download/audio/2026/07/10/audio_90888a7c64.mp3?filename=berrydeep-funky-summer-house-565437.mp3",
    claudePick: true
  },
  {
    num: 72,
    title: "Tropical House",
    artist: "BerryDeep",
    group: "s2_house",
    mood: "tropical house, chill, ensoleillé · 2:24",
    source: "pixabay",
    page: "https://pixabay.com/music/house-tropical-house-592396/",
    audio: "https://cdn.pixabay.com/download/audio/2026/08/26/audio_3af82c5d7b.mp3?filename=berrydeep-tropical-house-592396.mp3",
    claudePick: false
  },
  {
    num: 73,
    title: "Happy Tropical House",
    artist: "AurosonMusic",
    group: "s2_house",
    mood: "tropical house, joyeux, entraînant · 2:00",
    source: "pixabay",
    page: "https://pixabay.com/music/dance-happy-tropical-house-555953/",
    audio: "https://cdn.pixabay.com/download/audio/2026/07/01/audio_b476755e36.mp3?filename=aurosonmusic-happy-tropical-house-555953.mp3",
    claudePick: true
  },
  {
    num: 74,
    title: "Stylish Stomp (Light Fresh Lounge House)",
    artist: "PineAppleMusic",
    group: "s2_house",
    mood: "lounge house, frais, léger · 2:22",
    source: "pixabay",
    page: "https://pixabay.com/music/soft-house-stylish-stomp-light-fresh-lounge-house-180507/",
    audio: "https://cdn.pixabay.com/download/audio/2023/12/08/audio_39d0369e53.mp3?filename=pineapplemusic-stylish-stomp-light-fresh-lounge-house-180507.mp3",
    claudePick: false
  },
  {
    num: 75,
    title: "Soul Chill House",
    artist: "Rockot",
    group: "s2_house",
    mood: "soul chill house, chaleureux · 3:07",
    source: "pixabay",
    page: "https://pixabay.com/music/soft-house-soul-chill-house-587986/",
    audio: "https://cdn.pixabay.com/download/audio/2026/08/18/audio_228b27b740.mp3?filename=rockot-soul-chill-house-587986.mp3",
    claudePick: false
  },
  {
    num: 76,
    title: "House - Flying",
    artist: "tape-echo",
    group: "s2_house",
    mood: "soft house, groovy, aérien · 2:10",
    source: "pixabay",
    page: "https://pixabay.com/music/house-house-flying-580004/",
    audio: "https://cdn.pixabay.com/download/audio/2026/08/04/audio_44ad41c06c.mp3?filename=tape-echo-house-flying-580004.mp3",
    claudePick: false
  },
  {
    num: 77,
    title: "Techsonik - Chest Hair",
    artist: "Kromaspere",
    group: "s2_house",
    mood: "soft house disco, dansant · 4:51 (longue)",
    source: "pixabay",
    page: "https://pixabay.com/music/soft-house-techsonik-chest-hair-470825/",
    audio: "https://cdn.pixabay.com/download/audio/2026/01/22/audio_b8c8018b53.mp3?filename=kromaspere-techsonik-chest-hair-470825.mp3",
    claudePick: false
  },
  {
    num: 78,
    title: "Funky Disco Dance",
    artist: "BerryDeep",
    group: "s2_house",
    mood: "funky disco, énergique, lumineux · 2:11",
    source: "pixabay",
    page: "https://pixabay.com/music/funk-funky-disco-dance-565442/",
    audio: "https://cdn.pixabay.com/download/audio/2026/07/16/audio_ebd0e6f262.mp3?filename=berrydeep-funky-disco-dance-565442.mp3",
    claudePick: false
  },
  {
    num: 79,
    title: "Dance Disco Move",
    artist: "bearstockmusic",
    group: "s2_house",
    mood: "disco funk, groovy, euphorique · 2:10",
    source: "pixabay",
    page: "https://pixabay.com/music/disco-dance-disco-move-603586/",
    audio: "https://cdn.pixabay.com/download/audio/2026/09/15/audio_26752e5c4f.mp3?filename=bearstockmusic-dance-disco-move-603586.mp3",
    claudePick: false
  },
  {
    num: 80,
    title: "Classic Deep House",
    artist: "-SunSet-",
    group: "s2_house",
    mood: "deep house classique, chaleureux · 2:32",
    source: "pixabay",
    page: "https://pixabay.com/music/deep-house-classic-deep-house-562924/",
    audio: "https://cdn.pixabay.com/download/audio/2026/07/06/audio_9a6f28e8d2.mp3?filename=sunset-classic-deep-house-562924.mp3",
    claudePick: false
  },
  {
    num: 81,
    title: "Happy Funk Groove",
    artist: "JorisVermeer",
    group: "s2_house",
    mood: "funk heureux, groovy, euphorique · 2:34",
    source: "pixabay",
    page: "https://pixabay.com/music/funk-happy-funk-groove-578947/",
    audio: "https://cdn.pixabay.com/download/audio/2026/08/02/audio_22e7ade9ce.mp3?filename=jorisvermeer-happy-funk-groove-578947.mp3",
    claudePick: false
  },
  {
    num: 82,
    title: "Tech House vibes",
    artist: "Alejandro Magaña",
    group: "s2_house",
    mood: "tech house, positif, rythmé · 1:42",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/electronica/",
    audio: "https://assets.mixkit.co/music/130/130.mp3",
    claudePick: false
  },
  {
    num: 83,
    title: "House 02",
    artist: "Lily J",
    group: "s2_house",
    mood: "house, positif, entraînant · 1:53",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/house/",
    audio: "https://assets.mixkit.co/music/744/744.mp3",
    claudePick: false
  },
  {
    num: 84,
    title: "Cat Walk",
    artist: "Arulo",
    group: "s2_house",
    mood: "house, positif, rythmé · 2:04",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/house/",
    audio: "https://assets.mixkit.co/music/371/371.mp3",
    claudePick: false
  },
  {
    num: 85,
    title: "Tropical Summer Christmas",
    artist: "SigmaMusicArt",
    group: "s2_noel",
    mood: "Noël tropical, ensoleillé, happy · 2:23",
    source: "pixabay",
    page: "https://pixabay.com/music/christmas-tropical-summer-christmas-182482/",
    audio: "https://cdn.pixabay.com/download/audio/2023/12/21/audio_cd4c52b3dc.mp3?filename=sigmamusicart-tropical-summer-christmas-182482.mp3",
    claudePick: true
  },
  {
    num: 86,
    title: "Jazzy Christmas (Christmas)",
    artist: "PineAppleMusic",
    group: "s2_noel",
    mood: "Noël jazzy, chaleureux, léger · 2:27",
    source: "pixabay",
    page: "https://pixabay.com/music/christmas-jazzy-christmas-christmas-177787/",
    audio: "https://cdn.pixabay.com/download/audio/2023/11/22/audio_bc80a9a5b4.mp3?filename=pineapplemusic-jazzy-christmas-christmas-177787.mp3",
    claudePick: false
  },
  {
    num: 87,
    title: "Its Christmas Time",
    artist: "PHANTASTICBEATS",
    group: "s2_noel",
    mood: "Noël upbeat, électro, brillant · 2:40",
    source: "pixabay",
    page: "https://pixabay.com/music/christmas-its-christmas-time-12904/",
    audio: "https://cdn.pixabay.com/download/audio/2021/12/26/audio_d05897544a.mp3?filename=phantasticbeats-its-christmas-time-12904.mp3",
    claudePick: false
  },
  {
    num: 88,
    title: "Happy New Year - Lo-fi Beat",
    artist: "AmsleyBeats",
    group: "s2_noel",
    mood: "Nouvel An lo-fi, détendu, doux · 4:16",
    source: "pixabay",
    page: "https://pixabay.com/music/beats-happy-new-year-lo-fi-beat-281422/",
    audio: "https://cdn.pixabay.com/download/audio/2025/01/08/audio_16a6ee2f87.mp3?filename=amsleybeats-happy-new-year-lo-fi-beat-281422.mp3",
    claudePick: false
  },
  {
    num: 89,
    title: "Christmas Celebration",
    artist: "MiroMaxMusic",
    group: "s2_noel",
    mood: "Noël pop-funk, piano, joyeux · 2:17",
    source: "pixabay",
    page: "https://pixabay.com/music/christmas-christmas-celebration-449887/",
    audio: "https://cdn.pixabay.com/download/audio/2025/12/10/audio_7f2059f79a.mp3?filename=miromaxmusic-christmas-celebration-449887.mp3",
    claudePick: false
  },
  {
    num: 90,
    title: "Tutur - Jingle Bass (Jingle Bells Remix)",
    artist: "QuibSunMusic",
    group: "s2_noel",
    mood: "Jingle Bells house, remix, festif · 2:29",
    source: "pixabay",
    page: "https://pixabay.com/music/house-tutur-jingle-bass-jingle-bells-remix-128602/",
    audio: "https://cdn.pixabay.com/download/audio/2022/12/08/audio_30ce76a053.mp3?filename=quibsunmusic-tutur-jingle-bass-jingle-bells-remix-128602.mp3",
    claudePick: false
  },
  {
    num: 91,
    title: "Cool Holiday Pop Type Beat - Holiday Smiles",
    artist: "14584889",
    group: "s2_noel",
    mood: "Noël pop beat, léger, énergique · 3:00",
    source: "pixabay",
    page: "https://pixabay.com/music/pop-cool-holiday-pop-type-beat-holiday-smiles-226889/",
    audio: "https://cdn.pixabay.com/download/audio/2024/07/25/audio_b4314b314c.mp3?filename=14584889-cool-holiday-pop-type-beat-holiday-smiles-226889.mp3",
    claudePick: false
  },
  {
    num: 92,
    title: "Funk Holiday",
    artist: "asproductionmusic",
    group: "s2_noel",
    mood: "funk des fêtes, groovy, joyeux · 1:22",
    source: "pixabay",
    page: "https://pixabay.com/music/funk-funk-holiday-576080/",
    audio: "https://cdn.pixabay.com/download/audio/2026/07/29/audio_a741e55e93.mp3?filename=asproductionmusic-funk-holiday-576080.mp3",
    claudePick: false
  },
  {
    num: 93,
    title: "It’s Christmas Day!",
    artist: "Michael Ramir C.",
    group: "s2_noel",
    mood: "Noël house, énergique, festif · 1:51",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/house/",
    audio: "https://assets.mixkit.co/music/875/875.mp3",
    claudePick: false
  },
  {
    num: 94,
    title: "Future Funk Music",
    artist: "YuraSoop",
    group: "s2_electro",
    mood: "future funk, groovy, euphorique · 2:48",
    source: "pixabay",
    page: "https://pixabay.com/music/funk-future-funk-music-521735/",
    audio: "https://cdn.pixabay.com/download/audio/2026/04/19/audio_a01c923d3e.mp3?filename=yurasoop-future-funk-music-521735.mp3",
    claudePick: true
  },
  {
    num: 95,
    title: "Embrace",
    artist: "ItsWatR",
    group: "s2_electro",
    mood: "future bass, lumineux, planant · 3:00",
    source: "pixabay",
    page: "https://pixabay.com/music/future-bass-embrace-12278/",
    audio: "https://cdn.pixabay.com/download/audio/2021/12/16/audio_e13e329328.mp3?filename=itswatr-embrace-12278.mp3",
    claudePick: false
  },
  {
    num: 96,
    title: "Ever Flowing",
    artist: "ItsWatR",
    group: "s2_electro",
    mood: "future bass, fluide, brillant · 3:01",
    source: "pixabay",
    page: "https://pixabay.com/music/future-bass-ever-flowing-12277/",
    audio: "https://cdn.pixabay.com/download/audio/2021/12/16/audio_e7d0534280.mp3?filename=itswatr-ever-flowing-12277.mp3",
    claudePick: false
  },
  {
    num: 97,
    title: "WatR - Whipped Cream",
    artist: "ItsWatR",
    group: "s2_electro",
    mood: "beats funk, léger, rêveur · 3:48",
    source: "pixabay",
    page: "https://pixabay.com/music/beats-watr-whipped-cream-10152/",
    audio: "https://cdn.pixabay.com/download/audio/2021/11/01/audio_03d6f2a1a3.mp3?filename=itswatr-watr-whipped-cream-10152.mp3",
    claudePick: false
  },
  {
    num: 98,
    title: "Upbeat",
    artist: "prettyjohn1",
    group: "s2_electro",
    mood: "électro upbeat, heureux, rythmé · 1:16",
    source: "pixabay",
    page: "https://pixabay.com/music/electro-upbeat-513865/",
    audio: "https://cdn.pixabay.com/download/audio/2026/04/10/audio_1109a41117.mp3?filename=prettyjohn1-upbeat-513865.mp3",
    claudePick: false
  },
  {
    num: 99,
    title: "Neon-Powered World",
    artist: "Lesiakower",
    group: "s2_electro",
    mood: "synthwave pop, néon, lumineux · 2:15",
    source: "pixabay",
    page: "https://pixabay.com/music/synthwave-neon-powered-world-110353/",
    audio: "https://cdn.pixabay.com/download/audio/2022/04/29/audio_9bbfc7253c.mp3?filename=lesiakower-neon-powered-world-110353.mp3",
    claudePick: false
  },
  {
    num: 100,
    title: "Freccero - Get Up (Do It Again)",
    artist: "86349",
    group: "s2_electro",
    mood: "funk électro, dansant, upbeat · 3:40",
    source: "pixabay",
    page: "https://pixabay.com/music/funk-freccero-get-up-do-it-again-122677/",
    audio: "https://cdn.pixabay.com/download/audio/2022/10/12/audio_643ed9c33e.mp3?filename=86349-freccero-get-up-do-it-again-122677.mp3",
    claudePick: false
  },
  {
    num: 101,
    title: "Electro Pop 116 BPM",
    artist: "KlemLoden",
    group: "s2_electro",
    mood: "électro-pop, doux, optimiste · 2:16",
    source: "pixabay",
    page: "https://pixabay.com/music/pop-electro-pop-116-bpm-153714/",
    audio: "https://cdn.pixabay.com/download/audio/2023/06/14/audio_584d224794.mp3?filename=klemloden-electro-pop-116-bpm-153714.mp3",
    claudePick: false
  },
  {
    num: 102,
    title: "Vlog Future Bass",
    artist: "lvymusic",
    group: "s2_electro",
    mood: "future bass, vlog, lumineux · 2:12",
    source: "pixabay",
    page: "https://pixabay.com/music/future-bass-vlog-future-bass-233141/",
    audio: "https://cdn.pixabay.com/download/audio/2024/08/17/audio_35a31c3cb9.mp3?filename=lvymusic-vlog-future-bass-233141.mp3",
    claudePick: false
  },
  {
    num: 103,
    title: "Summer x Chill UpTempo Electro-Pop (Arm wrestling)",
    artist: "47643651",
    group: "s2_electro",
    mood: "électro-pop d'été, chill, afro · 2:29",
    source: "pixabay",
    page: "https://pixabay.com/music/upbeat-summer-x-chill-uptempo-electro-pop-arm-wrestling-328612/",
    audio: "https://cdn.pixabay.com/download/audio/2025/05/13/audio_d8971289a6.mp3?filename=47643651-summer-x-chill-uptempo-electro-pop-arm-wrestling-328612.mp3",
    claudePick: false
  },
  {
    num: 104,
    title: "Mario Kart Electro pop Music",
    artist: "kontraa",
    group: "s2_electro",
    mood: "électro-pop, ludique, entraînant · 2:50",
    source: "pixabay",
    page: "https://pixabay.com/music/upbeat-mario-kart-electro-pop-music-126781/",
    audio: "https://cdn.pixabay.com/download/audio/2022/11/22/audio_239101f12f.mp3?filename=kontraa-mario-kart-electro-pop-music-126781.mp3",
    claudePick: false
  },
  {
    num: 105,
    title: "Can’t Get You Off My Mind",
    artist: "Michael Ramir C.",
    group: "s2_electro",
    mood: "future bass, positif, aérien · 1:31",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/mood/positive/",
    audio: "https://assets.mixkit.co/music/1210/1210.mp3",
    claudePick: false
  },
  {
    num: 106,
    title: "Pop Track 03",
    artist: "Lily J",
    group: "s2_electro",
    mood: "pop électro, positif, léger · 1:37",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/mood/positive/",
    audio: "https://assets.mixkit.co/music/729/729.mp3",
    claudePick: false
  },
  {
    num: 107,
    title: "Hip-Hop - Hip Hop Beat",
    artist: "prettyjohn1",
    group: "s2_hiphop",
    mood: "hip-hop old school, brillant, léger · 1:36",
    source: "pixabay",
    page: "https://pixabay.com/music/old-school-hip-hop-hip-hop-hip-hop-beat-525029/",
    audio: "https://cdn.pixabay.com/download/audio/2026/04/26/audio_178cfc4c96.mp3?filename=prettyjohn1-hip-hop-hip-hop-beat-525029.mp3",
    claudePick: false
  },
  {
    num: 108,
    title: "Urban Hip-Hop Beat",
    artist: "prettyjohn1",
    group: "s2_hiphop",
    mood: "hip-hop urbain, uplifting, souple · 1:15",
    source: "pixabay",
    page: "https://pixabay.com/music/old-school-hip-hop-urban-hip-hop-beat-523746/",
    audio: "https://cdn.pixabay.com/download/audio/2026/04/23/audio_8593d985e3.mp3?filename=prettyjohn1-urban-hip-hop-beat-523746.mp3",
    claudePick: false
  },
  {
    num: 109,
    title: "Hip-Hop Groove",
    artist: "prettyjohn1",
    group: "s2_hiphop",
    mood: "hip-hop groove, lumineux, relax · 1:36",
    source: "pixabay",
    page: "https://pixabay.com/music/old-school-hip-hop-hip-hop-groove-526148/",
    audio: "https://cdn.pixabay.com/download/audio/2026/04/28/audio_257e377861.mp3?filename=prettyjohn1-hip-hop-groove-526148.mp3",
    claudePick: false
  },
  {
    num: 110,
    title: "Hip Hop - Upbeat",
    artist: "MusicForPeople",
    group: "s2_hiphop",
    mood: "hip-hop upbeat, brillant, groovy · 2:03",
    source: "pixabay",
    page: "https://pixabay.com/music/beats-hip-hop-upbeat-491996/",
    audio: "https://cdn.pixabay.com/download/audio/2026/03/04/audio_cdc41b47eb.mp3?filename=musicforpeople-hip-hop-upbeat-491996.mp3",
    claudePick: true
  },
  {
    num: 111,
    title: "Cool Old School – Classic Boom Bap Hip-Hop",
    artist: "Rockot",
    group: "s2_hiphop",
    mood: "boom bap classique, uplifting · 1:47",
    source: "pixabay",
    page: "https://pixabay.com/music/beats-cool-old-school-classic-boom-bap-hip-hop-483600/",
    audio: "https://cdn.pixabay.com/download/audio/2026/02/12/audio_aa94bcae4a.mp3?filename=rockot-cool-old-school-classic-boom-bap-hip-hop-483600.mp3",
    claudePick: false
  },
  {
    num: 112,
    title: "Luxurious Layer – Golden Era Boom Bap Flow",
    artist: "Rockot",
    group: "s2_hiphop",
    mood: "boom bap golden era, lumineux · 2:50",
    source: "pixabay",
    page: "https://pixabay.com/music/beats-luxurious-layer-golden-era-boom-bap-flow-351435/",
    audio: "https://cdn.pixabay.com/download/audio/2025/05/29/audio_861a0556af.mp3?filename=rockot-luxurious-layer-golden-era-boom-bap-flow-351435.mp3",
    claudePick: false
  },
  {
    num: 113,
    title: "Classic Hip Hop Beat",
    artist: "YuraSoop",
    group: "s2_hiphop",
    mood: "hip-hop classique, groovy, happy · 2:29",
    source: "pixabay",
    page: "https://pixabay.com/music/alternative-hip-hop-classic-hip-hop-beat-514180/",
    audio: "https://cdn.pixabay.com/download/audio/2026/04/11/audio_7f830b89bb.mp3?filename=yurasoop-classic-hip-hop-beat-514180.mp3",
    claudePick: false
  },
  {
    num: 114,
    title: "Happy Jumping Creatures (Funky Electronic Hip Hop)",
    artist: "Musinova",
    group: "s2_hiphop",
    mood: "hip-hop funky, ludique, rêveur · 2:09",
    source: "pixabay",
    page: "https://pixabay.com/music/beats-happy-jumping-creatures-funky-electronic-hip-hop-361782/",
    audio: "https://cdn.pixabay.com/download/audio/2025/06/18/audio_d317668dee.mp3?filename=musinova-happy-jumping-creatures-funky-electronic-hip-hop-361782.mp3",
    claudePick: false
  },
  {
    num: 115,
    title: "Summer Games (Happy Playful Electronic Hip Hop)",
    artist: "Musinova",
    group: "s2_hiphop",
    mood: "hip-hop électro, ludique, doux · 2:55",
    source: "pixabay",
    page: "https://pixabay.com/music/beats-summer-games-happy-playful-electronic-hip-hop-354914/",
    audio: "https://cdn.pixabay.com/download/audio/2025/06/04/audio_c93cedbef9.mp3?filename=musinova-summer-games-happy-playful-electronic-hip-hop-354914.mp3",
    claudePick: false
  },
  {
    num: 116,
    title: "Hip Hop 02",
    artist: "Lily J",
    group: "s2_hiphop",
    mood: "hip-hop positif, léger, groove · 1:55",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/hip-hop/",
    audio: "https://assets.mixkit.co/music/738/738.mp3",
    claudePick: false
  },
  {
    num: 117,
    title: "Hip Hop 03",
    artist: "Lily J",
    group: "s2_hiphop",
    mood: "hip-hop, souple, rythmé · 1:52",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/hip-hop/",
    audio: "https://assets.mixkit.co/music/739/739.mp3",
    claudePick: false
  },
  {
    num: 118,
    title: "Hip Hop Two",
    artist: "Francisco Alvear",
    group: "s2_hiphop",
    mood: "hip-hop chill, léger, groove · 2:20",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/chillout/",
    audio: "https://assets.mixkit.co/music/666/666.mp3",
    claudePick: false
  },
  {
    num: 119,
    title: "Move Your Body",
    artist: "Michael Ramir C.",
    group: "s2_hiphop",
    mood: "hip-hop fun, dansant, vif · 1:38",
    source: "mixkit",
    page: "https://mixkit.co/free-stock-music/mood/fun/",
    audio: "https://assets.mixkit.co/music/1007/1007.mp3",
    claudePick: false
  }
];

/** Mat's picks, as stored in the `ameublo_music_picks` setting. */
export interface MusicPicks {
  nums: number[];
  comment: string;
}

export function parsePicks(raw: string | null): MusicPicks {
  try {
    const o = JSON.parse(raw ?? "{}") as Partial<MusicPicks>;
    const valid = new Set(MUSIC_CANDIDATES.map((c) => c.num));
    return {
      nums: Array.isArray(o.nums) ? [...new Set(o.nums.map(Number).filter((n) => valid.has(n)))].sort((a, b) => a - b) : [],
      comment: typeof o.comment === "string" ? o.comment.slice(0, 2000) : "",
    };
  } catch {
    return { nums: [], comment: "" };
  }
}
