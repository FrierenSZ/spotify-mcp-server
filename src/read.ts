import type { MaxInt } from '@spotify/web-api-ts-sdk';
import { z } from 'zod';
import type { SpotifyHandlerExtra, SpotifyTrack, tool } from './types.js';
import {
  formatDuration,
  handleSpotifyRequest,
  loadSpotifyConfig,
} from './utils.js';

function isTrack(item: any): item is SpotifyTrack {
  return (
    item &&
    item.type === 'track' &&
    Array.isArray(item.artists) &&
    item.album &&
    typeof item.album.name === 'string'
  );
}

/**
 * Stylized titles swap letters for look-alikes ("REVIVƎЯ", "MØØN"). NFD only
 * strips diacritics, so these have to be folded by hand. Applied to the query
 * and the track alike, so a genuinely Cyrillic title still matches itself.
 */
const HOMOGLYPH_FOLD: Record<string, string> = {
  ǝ: 'e',
  ɘ: 'e',
  ᴇ: 'e',
  э: 'e',
  е: 'e',
  я: 'r',
  ʁ: 'r',
  ɹ: 'r',
  ʌ: 'a',
  ɐ: 'a',
  а: 'a',
  ø: 'o',
  ɵ: 'o',
  ᴏ: 'o',
  о: 'o',
  ł: 'l',
  ɫ: 'l',
  đ: 'd',
  ð: 'd',
  ƨ: 's',
  ѕ: 's',
  и: 'n',
  ᴎ: 'n',
  ɔ: 'c',
  с: 'c',
  ʇ: 't',
  т: 't',
  ʞ: 'k',
  к: 'k',
  м: 'm',
  в: 'b',
  р: 'p',
  у: 'y',
  х: 'x',
};

export function normalizeTrackSearch(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      // Only non-ASCII can be a homoglyph, so leave plain text untouched.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII check intentionally includes NUL
      .replace(/[^\x00-\x7f]/g, (ch) => HOMOGLYPH_FOLD[ch] ?? ch)
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export type IndexedTrack = {
  name: string;
  artists: string;
  id: string;
  playlistName: string;
  playlistId: string;
  position: number;
  nameKey: string;
  haystack: string;
};

/**
 * How well an indexed track answers `needle`. 0 = no match.
 * Exact title beats prefix beats substring beats loose token overlap, so
 * searching "evidencias" returns the original before a dozen live covers.
 */
export function scoreTrack(
  track: Pick<IndexedTrack, 'nameKey' | 'haystack'>,
  needle: string,
  needleTokens: string[],
): number {
  if (!needle) return 0;
  if (track.nameKey === needle) return 100;
  if (track.nameKey.startsWith(needle)) return 80;
  if (track.nameKey.includes(needle)) return 70;
  if (track.haystack.includes(needle)) return 60;

  if (needleTokens.length > 1) {
    const hits = needleTokens.filter((tok) =>
      track.haystack.includes(tok),
    ).length;
    if (hits === needleTokens.length) return 45;
    if (hits > 0) return Math.round((hits / needleTokens.length) * 40);
  }

  // Last resort: typo tolerance. Substring only forgives extra words in the
  // TITLE ("The Reviver" answers to "reviver"); it can do nothing about extra
  // letters in the QUERY ("reviverr"), which is what edit distance is for.
  // ponytail: linear scan over the index. Fine at 10k tracks since it only runs
  // when every cheaper tier already missed - needs a trigram index above that.
  const budget = typoBudget(needle.length);
  if (budget === 0) return 0;

  if (editDistance(needle, track.nameKey, budget) <= budget) return 40;
  for (const token of track.haystack.split(' ')) {
    if (editDistance(needle, token, budget) <= budget) return 30;
  }

  return 0;
}

/**
 * Edit distance counting an adjacent swap as ONE edit, because "revvier" for
 * "reviver" is the typo people actually make and plain Levenshtein charges two
 * for it. Gives up as soon as it exceeds `max` - we never care how far apart
 * two strings are, only whether they are close enough.
 */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let prevPrev: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      let cost = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cost = Math.min(cost, prevPrev[j - 2] + 1);
      }
      row[j] = cost;
      if (cost < best) best = cost;
    }
    if (best > max) return max + 1;
    prevPrev = prev;
    prev = row;
  }
  return prev[b.length];
}

/**
 * How many typos to forgive. Short queries get none: two edits turn "que" into
 * half the library.
 */
function typoBudget(length: number): number {
  if (length <= 4) return 0;
  if (length <= 7) return 1;
  return 2;
}

const MIN_SCORE = 20;

/**
 * Ranked, de-duplicated matches. A track sitting in five playlists is one
 * result (its best-scoring playlist wins) - repeating it just burns tokens.
 */
export function matchIndexedTracks(
  index: IndexedTrack[],
  query: string,
  limit: number,
): { matches: IndexedTrack[]; total: number } {
  const needle = normalizeTrackSearch(query);
  const needleTokens = needle.split(' ').filter(Boolean);

  const scored = index
    .map((track) => ({ track, score: scoreTrack(track, needle, needleTokens) }))
    .filter((entry) => entry.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.track.position - b.track.position);

  const seen = new Set<string>();
  const deduped: IndexedTrack[] = [];
  for (const { track } of scored) {
    if (seen.has(track.id)) continue;
    seen.add(track.id);
    deduped.push(track);
  }

  return { matches: deduped.slice(0, limit), total: deduped.length };
}

const searchSpotify: tool<{
  query: z.ZodString;
  type: z.ZodEnum<['track', 'album', 'artist', 'playlist']>;
  limit: z.ZodOptional<z.ZodNumber>;
}> = {
  name: 'searchSpotify',
  description:
    "--- LAST RESORT ONLY --- Use this ONLY if the item is NOT in the user's library (getMusicalProfile/getPlaylistList). NEVER search for music the user already has. This tool is for DISCOVERING NEW CONTENT.",
  schema: {
    query: z.string().describe('The search query'),
    type: z
      .enum(['track', 'album', 'artist', 'playlist'])
      .describe(
        'The type of item to search for either track, album, artist, or playlist',
      ),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of results to return (10-50)'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { query, type, limit } = args;
    const limitValue = limit ?? 10;

    try {
      const results = await handleSpotifyRequest(async (spotifyApi) => {
        return await spotifyApi.search(
          query,
          [type],
          undefined,
          limitValue as MaxInt<50>,
        );
      });

      let formattedResults = '';

      if (type === 'track' && results.tracks) {
        formattedResults = results.tracks.items
          .map((track, i) => {
            const artists = track.artists.map((a) => a.name).join(', ');
            const duration = formatDuration(track.duration_ms);
            return `${i + 1}. "${track.name}" by ${artists} (${duration}) - ID: ${track.id}`;
          })
          .join('\n');
      } else if (type === 'album' && results.albums) {
        formattedResults = results.albums.items
          .map((album, i) => {
            const artists = album.artists.map((a) => a.name).join(', ');
            return `${i + 1}. "${album.name}" by ${artists} - ID: ${album.id}`;
          })
          .join('\n');
      } else if (type === 'artist' && results.artists) {
        formattedResults = results.artists.items
          .map((artist, i) => {
            return `${i + 1}. ${artist.name} - ID: ${artist.id}`;
          })
          .join('\n');
      } else if (type === 'playlist' && results.playlists) {
        formattedResults = results.playlists.items
          .filter((playlist) => !!playlist?.id)
          .map((playlist, i) => {
            const description = playlist.description
              ? ` - ${playlist.description}`
              : '';
            return `${i + 1}. "${playlist.name}" by ${playlist.owner?.display_name ?? 'Unknown owner'} - ID: ${playlist.id}${description}`;
          })
          .join('\n');
      }

      return {
        content: [
          {
            type: 'text',
            text:
              formattedResults.length > 0
                ? `# Search results for "${query}" (type: ${type})\n\n${formattedResults}`
                : `No ${type} results found for "${query}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error searching for ${type}s: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const getNowPlaying: tool<Record<string, never>> = {
  name: 'getNowPlaying',
  description:
    '--- STATUS CHECK --- Get current track and context. USE THIS to identify the current playlist/context before making playback changes.',
  schema: {},
  handler: async (_args, _extra: SpotifyHandlerExtra) => {
    try {
      const playback = await handleSpotifyRequest(async (spotifyApi) => {
        return await spotifyApi.player.getPlaybackState();
      });

      if (!playback?.item) {
        return {
          content: [
            {
              type: 'text',
              text: 'Nothing is currently playing on Spotify',
            },
          ],
        };
      }

      const item = playback.item;

      if (!isTrack(item)) {
        return {
          content: [
            {
              type: 'text',
              text: 'Currently playing item is not a track (might be a podcast episode)',
            },
          ],
        };
      }

      const artists = item.artists.map((a) => a.name).join(', ');
      const album = item.album.name;
      const duration = formatDuration(item.duration_ms);
      const progress = formatDuration(playback.progress_ms || 0);
      const isPlaying = playback.is_playing;

      const device = playback.device;
      const deviceInfo = device
        ? `${device.name} (${device.type})`
        : 'Unknown device';
      const volume =
        device?.volume_percent !== null && device?.volume_percent !== undefined
          ? `${device.volume_percent}%`
          : 'N/A';
      const shuffle = playback.shuffle_state ? 'On' : 'Off';
      const repeat = playback.repeat_state || 'off';
      const imageUrl =
        item.album.images?.[1]?.url || item.album.images?.[0]?.url;

      return {
        content: [
          {
            type: 'text',
            text: `# Currently ${isPlaying ? 'Playing' : 'Paused'}\n\n${imageUrl ? `![Album Art](${imageUrl})\n\n` : ''}**Track**: "${item.name}"\n**Artist**: ${artists}\n**Album**: ${album}\n**Progress**: ${progress} / ${duration}\n**ID**: ${item.id}\n\n**Device**: ${deviceInfo}\n**Volume**: ${volume}\n**Shuffle**: ${shuffle} | **Repeat**: ${repeat}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting current track: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const getPlaylistList: tool<{
  limit: z.ZodOptional<z.ZodNumber>;
  offset: z.ZodOptional<z.ZodNumber>;
}> = {
  name: 'getPlaylistList',
  description:
    "--- BROWSE PLAYLISTS --- ONLY returns playlist names and IDs. IT DOES NOT LIST SONGS. Use this when the user wants to see or pick a playlist. To FIND A SPECIFIC SONG, use 'searchMyPlaylists' instead - do NOT walk playlists one by one. NEVER assume you know the contents of a playlist without calling 'getPlaylistDetails'.",
  schema: {
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of playlists to return (1-50)'),
    offset: z
      .number()
      .min(0)
      .optional()
      .describe('Offset for pagination (0-based index)'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { limit = 50, offset = 0 } = args;

    const playlists = await handleSpotifyRequest(async (spotifyApi) => {
      return await spotifyApi.currentUser.playlists.playlists(
        limit as MaxInt<50>,
        offset,
      );
    });

    if (playlists.items.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: "You don't have any playlists on Spotify",
          },
        ],
      };
    }

    const formattedPlaylists = playlists.items
      .map((pl, i) => {
        // /me/playlists does not always carry tracks.total. Printing `?? 0`
        // stated "0 songs" for a 259-track playlist, so omit what we don't
        // know - getPlaylistDetails reports the real count.
        const total = (pl as any).tracks?.total ?? (pl as any).items?.total;
        const count = typeof total === 'number' ? ` (${total} songs)` : '';
        return `${offset + i + 1}. "${pl.name}" - ID: ${pl.id}${count} - Owner: ${pl.owner.display_name}`;
      })
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `# Your Spotify Playlists (${offset + 1}-${offset + playlists.items.length} of ${playlists.total})\n\n${formattedPlaylists}\n\n--- INSTRUCTION: Use 'getPlaylistDetails' with a Playlist ID above to see the songs and get URIs for playback. Use offset to see more playlists. ---`,
        },
      ],
    };
  },
};

const getPlaylistDetails: tool<{
  playlistId: z.ZodString;
  query: z.ZodOptional<z.ZodString>;
}> = {
  name: 'getPlaylistDetails',
  description:
    "--- ONE KNOWN PLAYLIST --- Fetches track URIs for a playlist you ALREADY identified. Use it to list, sort or summarize that playlist. To find a song when you don't know which playlist it is in, use 'searchMyPlaylists' instead. If you do want one specific song from THIS playlist, always pass 'query' - it returns only the matching lines instead of hundreds of tracks. NEVER try to play a song by name if you can find its URI here.",
  schema: {
    playlistId: z.string().describe('The Spotify ID of the playlist'),
    query: z
      .string()
      .optional()
      .describe(
        'Filter by song or artist name (accent/case-insensitive substring match). Use this whenever you want one specific track - it avoids dumping hundreds of tracks.',
      ),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { playlistId, query } = args;

    try {
      const playlist = await handleSpotifyRequest(async (spotifyApi) => {
        return await spotifyApi.playlists.getPlaylist(playlistId);
      });

      if (!playlist) {
        return {
          content: [
            {
              type: 'text',
              text: 'Error: Playlist not found or access denied.',
            },
          ],
        };
      }

      const tracksData = (playlist as any).tracks || (playlist as any).items;
      let allTracks = [...(tracksData?.items || [])];
      let nextUrl = tracksData?.next;
      const totalTracks = tracksData?.total || 0;

      if (allTracks.length < totalTracks && allTracks.length < 300) {
        const { accessToken } = loadSpotifyConfig();
        if (accessToken) {
          while (nextUrl && allTracks.length < 300) {
            try {
              const response = await fetch(nextUrl, {
                headers: { Authorization: `Bearer ${accessToken}` },
              });
              if (!response.ok) break;
              const data = (await response.json()) as any;
              if (data.items) {
                allTracks.push(...data.items);
                nextUrl = data.next;
              } else {
                break;
              }
            } catch (_e) {
              break;
            }
          }
        }
      }

      if (allTracks.length > 300) {
        allTracks = allTracks.slice(0, 300);
      }

      // Keep the original playlist position in the label: reorderPlaylistItems indexes off it.
      const entries = allTracks.map((item: any, i: number) => {
        const track = item?.track || item?.item;

        if (!track) {
          return {
            text: `${i + 1}. [Removed track]`,
            nameKey: '',
            haystack: '',
          };
        }

        if (isTrack(track)) {
          const artists = track.artists.map((a: any) => a.name).join(', ');
          return {
            // ponytail: URI already contains the ID, printing both doubles the token cost
            text: `${i + 1}. "${track.name}" by ${artists} - ${track.uri}`,
            nameKey: normalizeTrackSearch(track.name),
            haystack: normalizeTrackSearch(`${track.name} ${artists}`),
          };
        }
        return {
          text: `${i + 1}. Unknown item type: ${track?.type || 'unknown'}`,
          nameKey: '',
          haystack: '',
        };
      });

      // Same scorer as searchMyPlaylists: one matcher, so accents, stylized
      // letters and typos behave identically wherever you search from.
      const needle = query ? normalizeTrackSearch(query) : null;
      const needleTokens = needle ? needle.split(' ').filter(Boolean) : [];
      const shown = needle
        ? entries
            .map((e) => ({ e, score: scoreTrack(e, needle, needleTokens) }))
            .filter((s) => s.score >= MIN_SCORE)
            .sort((a, b) => b.score - a.score)
            .map((s) => s.e)
        : entries;

      const tracksInfo = shown.map((e) => e.text).join('\n');

      const scope = needle
        ? `## Matches for "${query}" (${shown.length} of ${allTracks.length} scanned tracks, numbers are playlist positions):`
        : `## Tracks (showing ${allTracks.length} of ${totalTracks} tracks):`;

      const header =
        `# Playlist: ${playlist.name}\n` +
        `**Owner**: ${playlist.owner?.display_name || 'Unknown'}\n` +
        `**URI (contextUri)**: ${playlist.uri}\n` +
        `**Total Tracks**: ${totalTracks}\n\n` +
        `${scope}\n\n${tracksInfo || (needle ? `No track matching "${query}" found in this playlist.` : 'No tracks found.')}`;

      return {
        content: [
          {
            type: 'text',
            text: header,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting playlist: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const getRecentlyPlayed: tool<{
  limit: z.ZodOptional<z.ZodNumber>;
}> = {
  name: 'getRecentlyPlayed',
  description:
    '--- HISTORY SCAN --- Get recently played tracks. USE THIS to find tracks the user was just listening to so you can resume them in context.',
  schema: {
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of tracks to return (1-50)'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { limit = 50 } = args;

    const history = await handleSpotifyRequest(async (spotifyApi) => {
      return await spotifyApi.player.getRecentlyPlayedTracks(
        limit as MaxInt<50>,
      );
    });

    if (history.items.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: "You don't have any recently played tracks on Spotify",
          },
        ],
      };
    }

    const formattedHistory = history.items
      .map((item, i) => {
        const track = item.track;
        if (!track) return `${i + 1}. [Removed track]`;

        if (isTrack(track)) {
          const artists = track.artists.map((a) => a.name).join(', ');
          const duration = formatDuration(track.duration_ms);
          const playedAt = item.played_at
            ? new Date(item.played_at).toLocaleString()
            : 'Unknown time';
          return `${i + 1}. "${track.name}" by ${artists} (${duration}) - ID: ${track.id} - Played at: ${playedAt}`;
        }

        return `${i + 1}. Unknown item`;
      })
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `# Recently Played Tracks\n\n${formattedHistory}`,
        },
      ],
    };
  },
};

const getQueue: tool<{
  limit: z.ZodOptional<z.ZodNumber>;
}> = {
  name: 'getQueue',
  description:
    'Get a list of the currently playing track and the next items in your Spotify queue',
  schema: {
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of upcoming items to show (1-50)'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { limit = 10 } = args;

    try {
      const queue = await handleSpotifyRequest(async (spotifyApi) => {
        return await spotifyApi.player.getUsersQueue();
      });

      const current = (queue as any)?.currently_playing;
      const upcoming = ((queue as any)?.queue ?? []) as any[];

      const header = '# Spotify Queue\n\n';

      let currentText = 'Nothing is currently playing';
      if (current) {
        const name = current?.name ?? 'Unknown';
        const artists = Array.isArray(current?.artists)
          ? (current.artists as Array<{ name: string }>)
              .map((a) => a.name)
              .join(', ')
          : 'Unknown';
        const duration =
          typeof current?.duration_ms === 'number'
            ? formatDuration(current.duration_ms)
            : 'Unknown';
        currentText = `Currently Playing: "${name}" by ${artists} (${duration})`;
      }

      if (upcoming.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `${header}${currentText}\n\nNo upcoming items in the queue`,
            },
          ],
        };
      }

      const toShow = upcoming.slice(0, limit);
      const formatted = toShow
        .map((track, i) => {
          const name = track?.name ?? 'Unknown';
          const artists = Array.isArray(track?.artists)
            ? (track.artists as Array<{ name: string }>)
                .map((a) => a.name)
                .join(', ')
            : 'Unknown';
          const duration =
            typeof track?.duration_ms === 'number'
              ? formatDuration(track.duration_ms)
              : 'Unknown';
          const id = track?.id ?? 'Unknown';
          return `${i + 1}. "${name}" by ${artists} (${duration}) - ID: ${id}`;
        })
        .join('\n');

      return {
        content: [
          {
            type: 'text',
            text: `${header}${currentText}\n\nNext ${toShow.length} in queue:\n\n${formatted}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error fetching queue: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const getAvailableDevices: tool<Record<string, never>> = {
  name: 'getAvailableDevices',
  description:
    "Get information about the user's available Spotify Connect devices",
  schema: {},
  handler: async (_args, _extra: SpotifyHandlerExtra) => {
    try {
      const devices = await handleSpotifyRequest(async (spotifyApi) => {
        return await spotifyApi.player.getAvailableDevices();
      });

      if (!devices.devices || devices.devices.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No available devices found. Make sure Spotify is open on at least one device.',
            },
          ],
        };
      }

      const formattedDevices = devices.devices
        .map((device, i) => {
          const status = device.is_active ? '▶ Active' : '○ Inactive';
          const volume =
            device.volume_percent !== null
              ? `${device.volume_percent}%`
              : 'N/A';
          const restricted = device.is_restricted ? ' (Restricted)' : '';
          return `${i + 1}. ${device.name} (${device.type})${restricted}\n   Status: ${status} | Volume: ${volume} | ID: ${device.id}`;
        })
        .join('\n\n');

      return {
        content: [
          {
            type: 'text',
            text: `# Available Spotify Devices\n\n${formattedDevices}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting available devices: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const getMusicalProfile: tool<Record<string, never>> = {
  name: 'getMusicalProfile',
  description:
    "--- BRAIN TOOL --- MANDATORY for taste analysis. Provides a summary of user's music for accurate recommendations. ALWAYS check this before suggesting new music.",
  schema: {},
  handler: async (_args, _extra: SpotifyHandlerExtra) => {
    try {
      const profile = await handleSpotifyRequest(async (spotifyApi) => {
        // 1. Get a larger sample of Liked Songs (50 tracks)
        const likedTracks = await spotifyApi.currentUser.tracks.savedTracks(50);

        // 2. Get Playlists summary
        const playlists = await spotifyApi.currentUser.playlists.playlists(50);

        // Derive taste from the 50 recent liked tracks
        const artistsCount: Record<string, number> = {};
        likedTracks.items.forEach((it) => {
          if (it.track) {
            it.track.artists.forEach((a) => {
              artistsCount[a.name] = (artistsCount[a.name] || 0) + 1;
            });
          }
        });

        const frequentArtists = Object.entries(artistsCount)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([name, count]) => `${name} (${count} songs)`);

        return {
          likedTotal: likedTracks.total,
          likedSample: likedTracks.items.map(
            (it) => `${it.track.name} - ${it.track.artists[0].name}`,
          ),
          frequentArtists,
          playlists: playlists.items.map((pl) => {
            const total =
              (pl as any).tracks?.total ?? (pl as any).items?.total ?? 0;
            return `${pl.name} (${total} tracks)`;
          }),
        };
      });

      if (!profile) throw new Error('Could not fetch profile data');

      const text = `# Musical Taste Profile Scan\n\n## Statistics\n- Liked Songs: ${profile.likedTotal}\n- Total Playlists: ${profile.playlists.length}\n\n## Most Frequent Artists in your Recent Likes\n${profile.frequentArtists.join(', ') || 'Not enough data'}\n\n## Recent Liked Songs (Sample of 50)\n${profile.likedSample.map((s) => `- ${s}`).join('\n')}\n\n## Your Playlists\n${profile.playlists.map((p) => `- ${p}`).join('\n')}`;

      return {
        content: [{ type: 'text', text }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error generating profile: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
};

const TRACK_URI_PREFIX = 'spotify:track:';
const PLAYLIST_SCAN_CONCURRENCY = 5;
// ponytail: hard ceiling so a runaway library can't hang the scan. Raise if anyone hits it.
const MAX_INDEXED_TRACKS = 10000;

type PlaylistRef = { id: string; name: string };

// ponytail: in-memory only, dies with the process. Disk cache only if the
// first-scan wait turns out to be annoying in practice.
let playlistIndex: {
  tracks: IndexedTrack[];
  playlistCount: number;
  failed: string[];
} | null = null;

async function fetchAllPlaylistRefs(): Promise<PlaylistRef[]> {
  const refs: PlaylistRef[] = [];
  let offset = 0;

  while (true) {
    const page = await handleSpotifyRequest(async (spotifyApi) => {
      return await spotifyApi.currentUser.playlists.playlists(50, offset);
    });

    const items = page?.items ?? [];
    for (const pl of items) {
      if (pl?.id) refs.push({ id: pl.id, name: pl.name ?? 'Unnamed playlist' });
    }

    offset += items.length;
    if (items.length === 0 || offset >= (page?.total ?? 0)) break;
  }

  return refs;
}

async function fetchIndexedTracks(
  playlist: PlaylistRef,
  accessToken: string,
): Promise<IndexedTrack[]> {
  const tracks: IndexedTrack[] = [];
  // `fields` keeps the payload to what we index - without it every track drags
  // its whole album object along, which is most of the bytes.
  // The /items endpoint nests each entry under `item`, NOT `track`: asking for
  // `items(track(...))` returns 200 with empty objects, not an error. The legacy
  // /tracks endpoint answers 403 here, so /items is the only way in.
  let url = `https://api.spotify.com/v1/playlists/${playlist.id}/items?fields=items(item(name,uri,artists(name))),next&limit=100`;
  let position = 0;

  while (url) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`${response.status} on "${playlist.name}"`);
    }

    const data = (await response.json()) as {
      items?: Array<{ item?: any; track?: any }>;
      next?: string | null;
    };

    for (const entry of data.items ?? []) {
      // Count every slot, including removed/local tracks: the number we print
      // has to line up with the real playlist position.
      position++;

      // Both keys, same reason getPlaylistDetails reads both: /items says
      // `item`, the older shape says `track`.
      const track = entry?.item ?? entry?.track;
      if (
        typeof track?.uri !== 'string' ||
        !track.uri.startsWith(TRACK_URI_PREFIX)
      ) {
        continue;
      }

      const name = typeof track.name === 'string' ? track.name : 'Unknown';
      const artists = (track.artists ?? [])
        .map((a: any) => a?.name)
        .filter(Boolean)
        .join(', ');

      tracks.push({
        name,
        artists,
        id: track.uri.slice(TRACK_URI_PREFIX.length),
        playlistName: playlist.name,
        playlistId: playlist.id,
        position,
        nameKey: normalizeTrackSearch(name),
        haystack: normalizeTrackSearch(`${name} ${artists}`),
      });
    }

    url = data.next ?? '';
  }

  return tracks;
}

async function buildPlaylistIndex(): Promise<
  NonNullable<typeof playlistIndex>
> {
  const accessToken = await handleSpotifyRequest(async (spotifyApi) => {
    await spotifyApi.currentUser.profile();
    const config = loadSpotifyConfig();
    if (!config.accessToken) {
      throw new Error('No access token available in config');
    }
    return config.accessToken;
  });

  const refs = await fetchAllPlaylistRefs();
  const tracks: IndexedTrack[] = [];
  const failed: string[] = [];

  for (let i = 0; i < refs.length; i += PLAYLIST_SCAN_CONCURRENCY) {
    if (tracks.length >= MAX_INDEXED_TRACKS) break;

    const batch = refs.slice(i, i + PLAYLIST_SCAN_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((pl) => fetchIndexedTracks(pl, accessToken)),
    );

    results.forEach((result, j) => {
      if (result.status === 'fulfilled') {
        tracks.push(...result.value);
      } else {
        failed.push(batch[j].name);
      }
    });
  }

  const index = { tracks, playlistCount: refs.length, failed };

  // A partial scan must not become the permanent cache, otherwise the one song
  // that failed to load is never findable again.
  if (failed.length === 0) {
    playlistIndex = index;
  }

  return index;
}

const searchMyPlaylists: tool<{
  query: z.ZodString;
  limit: z.ZodOptional<z.ZodNumber>;
  refresh: z.ZodOptional<z.ZodBoolean>;
}> = {
  name: 'searchMyPlaylists',
  description:
    "--- FIND A SONG THE USER ALREADY HAS --- Searches ALL of the user's playlists at once and returns ranked matches with the track ID and the playlist ID, ready for 'playMusic'. ALWAYS use this as the FIRST step when the user asks to play something. Do NOT chain 'getPlaylistList' + 'getPlaylistDetails' to hunt for a song - that is the expensive path. Only fall back to 'searchSpotify' if this returns no matches.",
  schema: {
    query: z
      .string()
      .describe(
        'Song name, artist name, or both. Accents and case are ignored.',
      ),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum matches to return (default 8)'),
    refresh: z
      .boolean()
      .optional()
      .describe(
        'Rebuild the index. Only needed if playlists changed outside this session.',
      ),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { query, limit = 8, refresh } = args;

    try {
      const index =
        refresh || !playlistIndex ? await buildPlaylistIndex() : playlistIndex;

      const { matches, total } = matchIndexedTracks(index.tracks, query, limit);

      const warning = index.failed.length
        ? `\n! ${index.failed.length} playlist(s) could not be read, results may be incomplete: ${index.failed.join(', ')}`
        : '';

      // An empty index is a broken scan, not an honest "not found" - saying
      // "no match" here sent us hunting the wrong bug once already.
      if (index.tracks.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text:
                `Index is EMPTY: scanned ${index.playlistCount} playlist(s) but read 0 tracks, so no search can succeed.` +
                ` This is a server-side failure, not a missing song - do not conclude the track is absent.${warning}`,
              isError: true,
            },
          ],
        };
      }

      if (matches.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text:
                `No track matching "${query}" in your ${index.playlistCount} playlists (${index.tracks.length} tracks scanned).` +
                ` Use 'searchSpotify' to look it up in the Spotify catalog instead.${warning}`,
            },
          ],
        };
      }

      const lines = matches
        .map(
          (t, i) =>
            `${i + 1}. ${t.name} — ${t.artists} | ${t.playlistName} #${t.position}\n` +
            `   ${t.id} @ ${t.playlistId}`,
        )
        .join('\n');

      const truncated =
        total > matches.length
          ? `\n(showing ${matches.length} of ${total} — refine the query for more)`
          : '';

      return {
        content: [
          {
            type: 'text',
            text: `# "${query}" — ${total} match(es) in ${index.tracks.length} tracks / ${index.playlistCount} playlists\n\n${lines}\n\nFormat: \`<trackId> @ <playlistId>\` — pass them to 'playMusic' as uri and contextUri.${truncated}${warning}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error searching your playlists: ${error instanceof Error ? error.message : String(error)}`,
            isError: true,
          },
        ],
      };
    }
  },
};

export const readTools = [
  searchMyPlaylists,
  searchSpotify,
  getNowPlaying,
  getPlaylistList,
  getPlaylistDetails,
  getRecentlyPlayed,
  getQueue,
  getAvailableDevices,
  getMusicalProfile,
];
