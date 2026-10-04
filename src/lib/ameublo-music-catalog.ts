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

export type MusicGroup = "lofi" | "jazz" | "funk" | "disco" | "ludique" | "acoustique" | "noel";

export const MUSIC_GROUPS: Record<MusicGroup, string> = {
  lofi: "Lo-fi / chillhop jazzy",
  jazz: "Jazz lounge / bossa / café français",
  funk: "Funk / soul rétro 70s",
  disco: "Nu-disco / house douce",
  ludique: "Ludique mais sobre",
  acoustique: "Acoustique chaleureux / automne",
  noel: "Noël"
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
