import { readFile, mkdir, writeFile, rename, rmdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

const SERVICES = {
  movie: { base: 'http://radarr:7878/api/v3/', config: '/mnt/user/Config/radarr/config.xml', resource: 'movie', id: 'tmdbId', root: '/movies', profile: 6 },
  series: { base: 'http://sonarr:8989/api/v3/', config: '/mnt/user/Config/sonarr/config.xml', resource: 'series', id: 'tvdbId', root: '/tv', profile: 1 },
};
const STATE = '/home/node/.openclaw/media-requests';
const safeError = (code) => Object.assign(new Error(code), { publicCode: code });
export function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw safeError('invalid_request');
  const p = { ...input, mediaType: input.mediaType === 'film' ? 'movie' : input.mediaType };
  if (!['lookup', 'availability', 'status', 'acquire'].includes(p.operation) || !SERVICES[p.mediaType]) throw safeError('invalid_request');
  if (typeof p.title !== 'string' || p.title.length < 2 || p.title.length > 160 || /[\x00-\x1f]/.test(p.title)) throw safeError('invalid_title');
  if (!/^agent:concierge:(?!cron:)[A-Za-z0-9:+._@-]{1,180}$/.test(p.sourceSession ?? '')) throw safeError('missing_conversation');
  if (p.season !== undefined && (!Number.isInteger(p.season) || p.season < 1 || p.season > 99)) throw safeError('invalid_season');
  if (p.operation === 'acquire' && (p.confirmed !== true || (p.mediaType === 'series' && p.season === undefined))) throw safeError('confirmation_required');
  if (p.operation !== 'lookup' && (!Number.isInteger(p[SERVICES[p.mediaType].id]) || p[SERVICES[p.mediaType].id] < 1)) throw safeError('candidate_required');
  return p;
}
export function createMediaApi() {
  return async (kind, path, method = 'GET', body) => {
    const s = SERVICES[kind];
    const xml = await readFile(s.config, 'utf8');
    const key = xml.match(/<ApiKey>([^<]+)<\/ApiKey>/)?.[1];
    if (!key) throw safeError('service_unavailable');
    const response = await fetch(s.base + path, { method, redirect: 'error', headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw safeError('service_unavailable');
    return response.status === 204 ? null : response.json();
  };
}
const refFor = (p) => createHash('sha256').update(JSON.stringify([p.sourceSession, p.mediaType, p[SERVICES[p.mediaType].id], p.season ?? null])).digest('hex').slice(0, 32);
export async function runRequest(raw, { api = createMediaApi(), stateDir = STATE, locked = false } = {}) {
  const p = validate(raw), s = SERVICES[p.mediaType];
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  if (p.operation === 'acquire' && !locked) {
    const lock = `${stateDir}/lock-${refFor(p)}`;
    try { await mkdir(lock, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') throw safeError('request_in_progress'); throw e; }
    try { return await runRequest(p, { api, stateDir, locked: true }); }
    finally { await rmdir(lock); }
  }
  const scope = createHash('sha256').update(p.sourceSession).digest('hex');
  const read = async (name) => { try { return JSON.parse(await readFile(`${stateDir}/${name}.json`, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  const save = async (name, value) => { const dest = `${stateDir}/${name}.json`, temp = `${dest}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await rename(temp, dest); };
  if (p.operation === 'lookup') {
    const rows = await api(p.mediaType, `${s.resource}/lookup?term=${encodeURIComponent(p.title)}`);
    const candidates = rows.filter(x => !p.year || x.year === p.year).slice(0, 3).map(x => ({ title: x.title, mediaType: p.mediaType, year: x.year, [s.id]: x[s.id], ...(p.mediaType === 'series' ? { seasons: (x.seasons ?? []).map(y => y.seasonNumber).filter(n => n > 0) } : {}) }));
    const previous = await read(`candidates-${scope}`) ?? [];
    await save(`candidates-${scope}`, [...previous, ...candidates].slice(-30));
    return { state: candidates.length ? 'found' : 'not_found', candidates };
  }
  const ref = refFor(p), old = await read(ref);
  if (p.requestRef && (p.requestRef !== ref || !old)) throw safeError('request_not_found');
  if (p.operation === 'status' && (!p.requestRef || !old)) throw safeError('request_reference_required');
  let rows = await api(p.mediaType, s.resource);
  let item = rows.find(x => x[s.id] === p[s.id]);
  async function status() {
    if (!item) return { state: 'not_found' };
    let complete = item.hasFile === true, counts;
    if (p.mediaType === 'series') {
      if (!p.season) throw safeError('season_required');
      const episodes = (await api('series', `episode?seriesId=${item.id}`)).filter(e => e.seasonNumber === p.season);
      const aired = episodes.filter(e => e.airDateUtc && new Date(e.airDateUtc).getTime() <= Date.now());
      const have = aired.filter(e => e.hasFile).length;
      complete = aired.length > 0 && have === aired.length && aired.length === episodes.length;
      counts = { availableEpisodes: have, totalEpisodes: episodes.length };
    }
    if (complete) return { state: 'ready', ...(counts ?? {}) };
    if (p.operation === 'availability') return { state: 'not_ready' };
    const queue = await api(p.mediaType, 'queue?page=1&pageSize=1000&includeUnknownSeriesItems=false&includeEpisode=true');
    const relevant = (queue.records ?? []).filter(q => p.mediaType === 'movie' ? q.movieId === item.id : q.seriesId === item.id && (q.episode?.seasonNumber === p.season || q.seasonNumber === p.season));
    const importing = relevant.some(q => q.trackedDownloadState === 'importPending' || q.status === 'completed');
    return { state: importing ? 'importing' : relevant.length ? 'downloading' : 'not_ready', ...(counts ?? {}) };
  }
  if (p.operation !== 'acquire') return { ...(await status()), ...(old ? { requestRef: ref } : {}), verifiedAt: new Date().toISOString() };
  const candidates = await read(`candidates-${scope}`) ?? [];
  const candidate = candidates.find(x => x.mediaType === p.mediaType && x[s.id] === p[s.id] && x.title === p.title && (!p.year || x.year === p.year));
  if (!candidate) throw safeError('lookup_required');
  if (p.mediaType === 'series' && !candidate.seasons.includes(p.season)) throw safeError('invalid_season');
  if (old) return { ...(await status()), requestRef: ref, duplicateSuppressed: true, followupRequired: old.followup !== 'delivered' };
  const before = await status();
  if (before.state === 'ready') return { ...before, alreadyAvailable: true };
  // Persist intent before any mutation. An uncertain operation is never blindly repeated.
  const record = { requestRef: ref, sourceSession: p.sourceSession, mediaType: p.mediaType, title: candidate.title, year: candidate.year, [s.id]: p[s.id], ...(p.season ? { season: p.season } : {}), createdAt: new Date().toISOString(), stage: 'intent', followup: 'needed' };
  await save(ref, record);
  if (!item) {
    const candidatesFull = await api(p.mediaType, `${s.resource}/lookup?term=${s.id === 'tmdbId' ? 'tmdb' : 'tvdb'}:${p[s.id]}`);
    const full = candidatesFull.find(x => x[s.id] === p[s.id]);
    if (!full) throw safeError('candidate_unavailable');
    const body = { ...full, qualityProfileId: s.profile, rootFolderPath: s.root, monitored: true, addOptions: p.mediaType === 'movie' ? { searchForMovie: false } : { searchForMissingEpisodes: false, monitor: 'none' } };
    if (p.mediaType === 'series') { body.seasonFolder = true; body.seasons = (full.seasons ?? []).map(x => ({ ...x, monitored: x.seasonNumber === p.season })); }
    item = await api(p.mediaType, s.resource, 'POST', body);
  }
  if (p.mediaType === 'series') {
    await api('series', `series/${item.id}`, 'PUT', { ...item, monitored: true, seasons: item.seasons.map(x => x.seasonNumber === p.season ? { ...x, monitored: true } : x) });
  } else if (!item.monitored) item = await api('movie', `movie/${item.id}`, 'PUT', { ...item, monitored: true });
  await save(ref, { ...record, stage: 'added', serviceId: item.id });
  const command = await api(p.mediaType, 'command', 'POST', p.mediaType === 'movie' ? { name: 'MoviesSearch', movieIds: [item.id] } : { name: 'SeasonSearch', seriesId: item.id, seasonNumber: p.season });
  await save(ref, { ...record, stage: 'search_started', serviceId: item.id, commandId: command.id });
  rows = await api(p.mediaType, s.resource); item = rows.find(x => x[s.id] === p[s.id]);
  if (!item) throw safeError('verification_failed');
  return { state: 'queued', requestRef: ref, followupRequired: true };
}
