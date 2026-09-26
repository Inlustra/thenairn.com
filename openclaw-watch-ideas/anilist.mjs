// AniList lookups for find_anime. AniList's website renders only with
// JavaScript, so web_fetch gets an empty page there; its public GraphQL API
// needs no key and answers "what's airing this season" and "what's like X"
// directly, with dates and scores, which web articles only paraphrase.
//
// The endpoint and both queries are fixed here. The model supplies variables
// only (season, year, genre, tags, a title to search), each checked below, so
// this is not a way to reach any other address.

export const ANILIST_URL = "https://graphql.anilist.co";

export const SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"];
export const GENRES = [
  "Action", "Adventure", "Comedy", "Drama", "Ecchi", "Fantasy", "Horror", "Mahou Shoujo",
  "Mecha", "Music", "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life",
  "Sports", "Supernatural", "Thriller",
];
const TAG = /^[A-Za-z][A-Za-z0-9 '\-]{1,39}$/;
const MAX_TAGS = 3;
const MAX_TITLE_CHARS = 100;

const SEASON_QUERY = `query($season:MediaSeason,$year:Int,$genre:String,$tags:[String],$n:Int){
  Page(perPage:$n){ media(season:$season,seasonYear:$year,type:ANIME,isAdult:false,genre:$genre,tag_in:$tags,sort:POPULARITY_DESC){
    title{english romaji} synonyms format episodes averageScore status genres
    startDate{year month day}
    relations{edges{relationType node{title{english romaji}}}}
  }}}`;

const SIMILAR_QUERY = `query($search:String,$n:Int){
  Media(search:$search,type:ANIME,isAdult:false){
    title{english romaji}
    recommendations(sort:RATING_DESC,perPage:$n){nodes{rating mediaRecommendation{
      title{english romaji} synonyms format seasonYear averageScore status isAdult genres
    }}}
  }}`;

/** The anime season a date falls in, as AniList counts them. */
export function currentSeason(now = new Date()) {
  const m = now.getUTCMonth();
  return { season: SEASONS[Math.floor(m / 3)], year: now.getUTCFullYear() };
}

/** Check the model's input and build { query, variables }, or { error }. */
export function buildRequest(input, now = new Date()) {
  const mode = input?.mode;
  const n = 10;
  if (mode === "season") {
    const cur = currentSeason(now);
    const season = input.season ? String(input.season).toUpperCase() : cur.season;
    if (!SEASONS.includes(season)) return { error: `season must be one of ${SEASONS.join(", ")}.` };
    const year = input.year === undefined ? cur.year : Math.trunc(Number(input.year));
    if (!Number.isFinite(year) || year < 1960 || year > cur.year + 2) {
      return { error: `year must be between 1960 and ${cur.year + 2}.` };
    }
    let genre;
    if (input.genre !== undefined) {
      genre = GENRES.find((g) => g.toLowerCase() === String(input.genre).toLowerCase());
      if (!genre) return { error: `genre must be one of ${GENRES.join(", ")}.` };
    }
    let tags;
    if (input.tags !== undefined) {
      if (!Array.isArray(input.tags) || input.tags.length > MAX_TAGS || !input.tags.every((t) => typeof t === "string" && TAG.test(t))) {
        return { error: `tags must be up to ${MAX_TAGS} plain words, e.g. ["Isekai"].` };
      }
      tags = input.tags;
    }
    return { query: SEASON_QUERY, variables: { season, year, genre, tags, n }, label: `${season} ${year}` };
  }
  if (mode === "similar") {
    const title = typeof input.title === "string" ? input.title.normalize("NFKC").replace(/\s+/g, " ").trim() : "";
    if (title.length < 2 || title.length > MAX_TITLE_CHARS || /[\u0000-\u001f]|:\/\//.test(title)) {
      return { error: "title must be the name of an anime, in words." };
    }
    return { query: SIMILAR_QUERY, variables: { search: title, n }, label: `like ${title}` };
  }
  return { error: 'mode must be "season" or "similar".' };
}

const name = (t) => (t?.english || t?.romaji || "").replace(/[\u0000-\u001f]/g, " ").trim();
const date = (d) =>
  d?.year ? [d.year, d.month && String(d.month).padStart(2, "0"), d.day && String(d.day).padStart(2, "0")].filter(Boolean).join("-") : "";
const STATUS = { RELEASING: "airing", NOT_YET_RELEASED: "not out yet", FINISHED: "finished", HIATUS: "on hiatus", CANCELLED: "cancelled" };

/** The shows an answer lists, in the order it lists them. */
export function listedMedia(mode, data) {
  if (mode === "season") return data?.Page?.media ?? [];
  return (data?.Media?.recommendations?.nodes ?? []).map((n) => n.mediaRecommendation).filter((m) => m && !m.isAdult);
}

/** Every spelling AniList has for a show, for matching against the library. */
export function spellings(m) {
  return [m?.title?.english, m?.title?.romaji, ...(m?.synonyms ?? [])].filter((t) => typeof t === "string" && t.trim());
}

/** AniList JSON -> plain text for the model. No links. `library` holds one
 * label per listed show, in listing order. */
export function formatAnswer(mode, label, data, library = []) {
  const lib = (i) => (library[i] ? ` | library: ${library[i]}` : "");
  if (mode === "season") {
    const media = listedMedia(mode, data);
    if (!media.length) return `Nothing on AniList for ${label} with those filters.`;
    const lines = media.map((m, i) => {
      const prequel = (m.relations?.edges ?? []).find((e) => e.relationType === "PREQUEL");
      const bits = [
        m.format,
        STATUS[m.status] ?? m.status,
        // The library's own date wins: say one date, not two that disagree.
        !/next episode|, out /.test(library[i] ?? "") && date(m.startDate) && `starts ${date(m.startDate)}`,
        m.averageScore && `score ${m.averageScore}/100`,
        (m.genres ?? []).slice(0, 3).join("/"),
        prequel && `sequel to ${name(prequel.node?.title)}`,
      ].filter(Boolean);
      return `${i + 1}. ${name(m.title)} - ${bits.join(", ")}${lib(i)}`;
    });
    return [`AniList, ${label}, most popular first:`, ...lines].join("\n");
  }
  const media = data?.Media;
  if (!media) return `AniList has no anime matching "${label.replace(/^like /, "")}". Check the title.`;
  const recs = listedMedia(mode, data);
  if (!recs.length) return `AniList has no recommendations for ${name(media.title)}.`;
  const lines = recs.map((m, i) => {
    const bits = [m.format, m.seasonYear, m.averageScore && `score ${m.averageScore}/100`, (m.genres ?? []).slice(0, 3).join("/"), STATUS[m.status] ?? m.status].filter(Boolean);
    return `${i + 1}. ${name(m.title)} - ${bits.join(", ")}${lib(i)}`;
  });
  return [`AniList: people who liked ${name(media.title)} recommend, strongest first:`, ...lines].join("\n");
}
