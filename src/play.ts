import { z } from 'zod';
import type { SpotifyHandlerExtra, tool } from './types.js';
import { handleSpotifyRequest, loadSpotifyConfig } from './utils.js';

function formatSpotifyUri(value: string, defaultType = 'track'): string {
  const trimmed = value.trim();
  return trimmed.includes(':') ? trimmed : `spotify:${defaultType}:${trimmed}`;
}

async function getAccessToken(): Promise<string> {
  await handleSpotifyRequest(async (spotifyApi) => {
    await spotifyApi.currentUser.profile();
  });

  const config = loadSpotifyConfig();
  if (!config.accessToken) {
    throw new Error('No access token available in config');
  }

  return config.accessToken;
}

const playMusic: tool<{
  uri: z.ZodOptional<z.ZodString>;
  contextUri: z.ZodOptional<z.ZodString>;
  uris: z.ZodOptional<z.ZodArray<z.ZodString>>;
  type: z.ZodOptional<z.ZodEnum<['track', 'album', 'artist', 'playlist']>>;
  id: z.ZodOptional<z.ZodString>;
  deviceId: z.ZodOptional<z.ZodString>;
}> = {
  name: 'playMusic',
  description:
    '--- DANGER: QUALITY CHECK --- Start playing Spotify content. 1. If you found the track in the user\'s library using "searchMyPlaylists" or "getPlaylistDetails", you MUST provide BOTH "uri" (track) AND "contextUri" (playlist) to ensure music keeps playing. 2. "searchMyPlaylists" returns lines shaped `<trackId> @ <playlistId>`: pass the left side as "uri" and the right side as "contextUri". 3. Providing ONLY a track URI is a FAILURE for library songs.',
  schema: {
    uri: z
      .string()
      .optional()
      .describe('The Spotify URI to play (overrides type and id)'),
    contextUri: z
      .string()
      .optional()
      .describe(
        'The Spotify URI of the context (playlist/album) to play the track within. NOTE: "Liked Songs" (Library) does NOT have a valid context URI, so playback should use a regular playlist context instead.',
      ),
    uris: z
      .array(z.string())
      .optional()
      .describe('An array of Spotify URIs to play (e.g., a list of tracks)'),
    type: z
      .enum(['track', 'album', 'artist', 'playlist'])
      .optional()
      .describe('The type of item to play'),
    id: z.string().optional().describe('The Spotify ID of the item to play'),
    deviceId: z
      .string()
      .optional()
      .describe('The Spotify device ID to play on'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { uris, type, id, deviceId } = args;
    // searchMyPlaylists returns bare IDs to save tokens; accept either form.
    const uri = args.uri ? formatSpotifyUri(args.uri, 'track') : undefined;
    const contextUri = args.contextUri
      ? formatSpotifyUri(args.contextUri, 'playlist')
      : undefined;

    if (!(uri || uris || contextUri || (type && id))) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: Must provide either a URI, contextUri, an array of URIs, or both a type and ID',
            isError: true,
          },
        ],
      };
    }

    let spotifyUri = uri;
    if (!(spotifyUri || uris || contextUri) && type && id) {
      spotifyUri = `spotify:${type}:${id}`;
    }

    try {
      const _playbackInfo = await handleSpotifyRequest(async (spotifyApi) => {
        const device = deviceId || '';

        // Validate track/album/artist/playlist before sending to player to avoid clearing queue with invalid IDs
        const parseUri = (u: string) => {
          const parts = u.split(':');
          return {
            itemType: parts[1] || 'track',
            itemId: parts[2] || parts[0],
          };
        };

        if (spotifyUri && !contextUri && (!uris || uris.length === 0)) {
          const { itemType, itemId } = parseUri(spotifyUri);
          if (itemType === 'track') {
            const track = await spotifyApi.tracks.get(itemId);
            if (!track?.id)
              throw new Error(`Track not found on Spotify (ID: ${itemId})`);
          } else if (itemType === 'album') {
            const album = await spotifyApi.albums.get(itemId);
            if (!album?.id)
              throw new Error(`Album not found on Spotify (ID: ${itemId})`);
          } else if (itemType === 'playlist') {
            const playlist = await spotifyApi.playlists.getPlaylist(itemId);
            if (!playlist?.id)
              throw new Error(`Playlist not found on Spotify (ID: ${itemId})`);
          }
        }

        if (uris && uris.length > 0) {
          await spotifyApi.player.startResumePlayback(device, undefined, uris);
          return 'list of tracks';
        }

        if (contextUri) {
          const offset = spotifyUri ? { uri: spotifyUri } : undefined;
          await spotifyApi.player.startResumePlayback(
            device,
            contextUri,
            undefined,
            offset,
          );
          return contextUri;
        }

        if (!spotifyUri) {
          await spotifyApi.player.startResumePlayback(device);
          return 'playback';
        }

        // Smart Routing: Detect if it's a track URI
        const isTrack = type === 'track' || spotifyUri.includes(':track:');

        if (isTrack) {
          await spotifyApi.player.startResumePlayback(device, undefined, [
            spotifyUri,
          ]);
        } else {
          await spotifyApi.player.startResumePlayback(device, spotifyUri);
        }
        return spotifyUri;
      });

      return {
        content: [
          {
            type: 'text',
            text: `Started playing ${uris ? 'list of tracks' : type || 'music'} ${id ? `(ID: ${id})` : ''}`.trim(),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [
          {
            type: 'text',
            text: `Error playing music: ${err?.message || String(err)}. Make sure to use searchTracks or valid Spotify IDs.`,
            isError: true,
          },
        ],
      };
    }
  },
};

const pausePlayback: tool<{
  deviceId: z.ZodOptional<z.ZodString>;
}> = {
  name: 'pausePlayback',
  description: 'Pause Spotify playback on the active device',
  schema: {
    deviceId: z
      .string()
      .optional()
      .describe('The Spotify device ID to pause playback on'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { deviceId } = args;

    await handleSpotifyRequest(async (spotifyApi) => {
      await spotifyApi.player.pausePlayback(deviceId || '');
    });

    return {
      content: [
        {
          type: 'text',
          text: 'Playback paused',
        },
      ],
    };
  },
};

const skipToNext: tool<{
  deviceId: z.ZodOptional<z.ZodString>;
}> = {
  name: 'skipToNext',
  description: 'Skip to the next track in the current Spotify playback queue',
  schema: {
    deviceId: z
      .string()
      .optional()
      .describe('The Spotify device ID to skip on'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { deviceId } = args;

    await handleSpotifyRequest(async (spotifyApi) => {
      await spotifyApi.player.skipToNext(deviceId || '');
    });

    return {
      content: [
        {
          type: 'text',
          text: 'Skipped to next track',
        },
      ],
    };
  },
};

const skipToPrevious: tool<{
  deviceId: z.ZodOptional<z.ZodString>;
}> = {
  name: 'skipToPrevious',
  description:
    'Skip to the previous track in the current Spotify playback queue',
  schema: {
    deviceId: z
      .string()
      .optional()
      .describe('The Spotify device ID to skip on'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { deviceId } = args;

    await handleSpotifyRequest(async (spotifyApi) => {
      await spotifyApi.player.skipToPrevious(deviceId || '');
    });

    return {
      content: [
        {
          type: 'text',
          text: 'Skipped to previous track',
        },
      ],
    };
  },
};

const createPlaylist: tool<{
  name: z.ZodString;
  description: z.ZodOptional<z.ZodString>;
  public: z.ZodOptional<z.ZodBoolean>;
}> = {
  name: 'createPlaylist',
  description: 'Create a new playlist on Spotify',
  schema: {
    name: z.string().describe('The name of the playlist'),
    description: z
      .string()
      .optional()
      .describe('The description of the playlist'),
    public: z
      .boolean()
      .optional()
      .describe('Whether the playlist should be public'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { name, description, public: isPublic = false } = args;

    const accessToken = await getAccessToken();
    const response = await fetch('https://api.spotify.com/v1/me/playlists', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        description,
        public: isPublic,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Spotify API error: ${response.status} - ${errText}`);
    }

    const result = (await response.json()) as {
      id: string;
      external_urls?: { spotify?: string };
    };

    return {
      content: [
        {
          type: 'text',
          text: `Successfully created playlist "${name}"\nPlaylist ID: ${result.id}\nPlaylist URL: ${result.external_urls?.spotify ?? 'N/A'}`,
        },
      ],
    };
  },
};

const addTracksToPlaylist: tool<{
  playlistId: z.ZodString;
  uris: z.ZodArray<z.ZodString>;
  position: z.ZodOptional<z.ZodNumber>;
}> = {
  name: 'addTracksToPlaylist',
  description:
    '--- MANDATORY: APPEND TO END --- Add tracks to a playlist. 1. By default, DO NOT provide a position (it adds to the END of the list). 2. ONLY provide position if the user explicitly asks for "start" or a "specific index". 3. ALWAYS prioritize adding to the end to maintain playlist chronological order.',
  schema: {
    playlistId: z.string().describe('The Spotify ID of the playlist'),
    uris: z
      .array(z.string())
      .min(1)
      .max(100)
      .describe('Array of Spotify URIs to add (max 100)'),
    position: z
      .number()
      .nonnegative()
      .optional()
      .describe(
        'Optional position (0-based) to insert. Leave empty to add at the END.',
      ),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { playlistId, uris, position } = args;

    if (uris.length === 0) {
      return {
        content: [
          { type: 'text', text: 'Error: No URIs provided', isError: true },
        ],
      };
    }

    try {
      const accessToken = await getAccessToken();

      const formattedUris = uris.map((uri) => formatSpotifyUri(uri));
      const body: any = { uris: formattedUris };
      if (position !== undefined) {
        body.position = position;
      }

      const response = await fetch(
        `https://api.spotify.com/v1/playlists/${playlistId}/items`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Spotify API error: ${response.status} - ${errText}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: `Successfully added ${uris.length} items to playlist ${playlistId}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error adding items: ${error instanceof Error ? error.message : String(error)}`,
            isError: true,
          },
        ],
      };
    }
  },
};

const removeTracksFromPlaylist: tool<{
  playlistId: z.ZodString;
  uris: z.ZodArray<z.ZodString>;
  snapshotId: z.ZodOptional<z.ZodString>;
}> = {
  name: 'removeTracksFromPlaylist',
  description:
    '--- DANGER: PLAYLIST REMOVE --- Remove specific items from a playlist. 1. ALWAYS confirm item names with the user before deleting. 2. You MUST use URIs obtained from getPlaylistDetails to ensure the correct track is removed.',
  schema: {
    playlistId: z.string().describe('The Spotify ID of the playlist'),
    uris: z
      .array(z.string())
      .min(1)
      .max(100)
      .describe('Array of Spotify URIs to remove (max 100)'),
    snapshotId: z
      .string()
      .optional()
      .describe('The snapshot ID to validate the version'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { playlistId, uris, snapshotId } = args;

    try {
      const accessToken = await getAccessToken();

      const formattedUris = uris.map((uri) => formatSpotifyUri(uri));
      const body: any = { items: formattedUris.map((uri) => ({ uri })) };
      if (snapshotId) {
        body.snapshot_id = snapshotId;
      }

      const response = await fetch(
        `https://api.spotify.com/v1/playlists/${playlistId}/items`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Spotify API error: ${response.status} - ${errText}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: `Successfully removed ${uris.length} items from playlist ${playlistId}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error removing items: ${error instanceof Error ? error.message : String(error)}`,
            isError: true,
          },
        ],
      };
    }
  },
};

const reorderPlaylistItems: tool<{
  playlistId: z.ZodString;
  rangeStart: z.ZodNumber;
  insertBefore: z.ZodNumber;
  rangeLength: z.ZodOptional<z.ZodNumber>;
  snapshotId: z.ZodOptional<z.ZodString>;
}> = {
  name: 'reorderPlaylistItems',
  description:
    '--- PLAYLIST REORDER / SORT --- Reorder items in a playlist. Use this to: 1. Swap two songs (two calls or range move). 2. Organize the playlist by ALPHABETICAL order, DURATION, or ARTIST by calculating the moves after calling getPlaylistDetails. 3. Responding to requests like "move the first song to the end" or "sort this playlist by name".',
  schema: {
    playlistId: z.string().describe('The Spotify ID of the playlist'),
    rangeStart: z.number().describe('Index of the first item to move'),
    insertBefore: z.number().describe('Index where items should be inserted'),
    rangeLength: z
      .number()
      .optional()
      .describe('How many items to move (default 1)'),
    snapshotId: z
      .string()
      .optional()
      .describe('Snapshot ID of the playlist version'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const {
      playlistId,
      rangeStart,
      insertBefore,
      rangeLength = 1,
      snapshotId,
    } = args;

    try {
      const accessToken = await getAccessToken();

      const body: any = {
        range_start: rangeStart,
        range_length: rangeLength,
        insert_before: insertBefore,
      };
      if (snapshotId) {
        body.snapshot_id = snapshotId;
      }

      const response = await fetch(
        `https://api.spotify.com/v1/playlists/${playlistId}/items`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Spotify API error: ${response.status} - ${errText}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: `Successfully reordered items in playlist ${playlistId}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error reordering items: ${error instanceof Error ? error.message : String(error)}`,
            isError: true,
          },
        ],
      };
    }
  },
};

const resumePlayback: tool<{
  deviceId: z.ZodOptional<z.ZodString>;
}> = {
  name: 'resumePlayback',
  description: 'Resume Spotify playback on the active device',
  schema: {
    deviceId: z
      .string()
      .optional()
      .describe('The Spotify device ID to resume playback on'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { deviceId } = args;

    await handleSpotifyRequest(async (spotifyApi) => {
      const playback = await spotifyApi.player.getPlaybackState();
      if (playback?.is_playing) {
        return;
      }

      await spotifyApi.player.startResumePlayback(deviceId || '');
    });

    return {
      content: [
        {
          type: 'text',
          text: 'Playback resumed or already playing',
        },
      ],
    };
  },
};

const addToQueue: tool<{
  uri: z.ZodOptional<z.ZodString>;
  type: z.ZodOptional<z.ZodEnum<['track', 'episode']>>;
  id: z.ZodOptional<z.ZodString>;
  deviceId: z.ZodOptional<z.ZodString>;
}> = {
  name: 'addToQueue',
  description:
    'Adds a track or episode to the playback queue. Spotify queue does not accept albums, artists, or playlists.',
  schema: {
    uri: z
      .string()
      .optional()
      .describe('The Spotify URI to play (overrides type and id)'),
    type: z
      .enum(['track', 'episode'])
      .optional()
      .describe('The type of item to add to the queue'),
    id: z.string().optional().describe('The Spotify ID of the item to play'),
    deviceId: z
      .string()
      .optional()
      .describe('The Spotify device ID to add the track to'),
  },
  handler: async (args) => {
    const { uri, type, id, deviceId } = args;

    let spotifyUri = uri;
    if (!spotifyUri && type && id) {
      spotifyUri = `spotify:${type}:${id}`;
    }

    if (!spotifyUri) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: Must provide either a URI or both a type and ID',
            isError: true,
          },
        ],
      };
    }

    await handleSpotifyRequest(async (spotifyApi) => {
      await spotifyApi.player.addItemToPlaybackQueue(
        spotifyUri,
        deviceId || '',
      );
    });

    return {
      content: [
        {
          type: 'text',
          text: `Added item ${spotifyUri} to queue`,
        },
      ],
    };
  },
};

export const RAMP_MS = 4000;
const MIN_STEP_MS = 250;

// ponytail: rampa linear; trocar por curva log se o ouvido reclamar
export function volumeSteps(from: number, to: number): number[] {
  const target = Math.round(Math.min(100, Math.max(0, to)));
  const start = Math.round(Math.min(100, Math.max(0, from)));
  const delta = target - start;
  const count = Math.min(Math.round(RAMP_MS / MIN_STEP_MS), Math.abs(delta));

  if (count <= 1) return [target];
  return Array.from({ length: count }, (_, i) =>
    Math.round(start + (delta * (i + 1)) / count),
  );
}

async function getCurrentVolume(): Promise<number | null> {
  const playback = await handleSpotifyRequest(async (spotifyApi) => {
    return await spotifyApi.player.getPlaybackState();
  });
  return playback?.device?.volume_percent ?? null;
}

async function rampVolume(
  from: number,
  to: number,
  deviceId: string,
): Promise<number> {
  const steps = volumeSteps(from, to);
  const wait = RAMP_MS / steps.length;

  for (const [i, step] of steps.entries()) {
    await handleSpotifyRequest(async (spotifyApi) => {
      await spotifyApi.player.setPlaybackVolume(step, deviceId);
    });
    if (i < steps.length - 1) await new Promise((r) => setTimeout(r, wait));
  }
  return steps[steps.length - 1];
}

const setVolume: tool<{
  volumePercent: z.ZodNumber;
  deviceId: z.ZodOptional<z.ZodString>;
}> = {
  name: 'setVolume',
  description:
    'Set the playback volume to a specific percentage (0-100), fading gradually over ~4 seconds. Requires Spotify Premium.',
  schema: {
    volumePercent: z
      .number()
      .min(0)
      .max(100)
      .describe('The volume to set (0-100)'),
    deviceId: z
      .string()
      .optional()
      .describe('The Spotify device ID to set volume on'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { volumePercent, deviceId } = args;

    try {
      const currentVolume = await getCurrentVolume();
      const target = await rampVolume(
        currentVolume ?? Math.round(volumePercent),
        volumePercent,
        deviceId || '',
      );

      return {
        content: [
          {
            type: 'text',
            text:
              currentVolume === null
                ? `Volume set to ${target}%`
                : `Volume faded from ${currentVolume}% to ${target}%`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error setting volume: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const adjustVolume: tool<{
  adjustment: z.ZodNumber;
  deviceId: z.ZodOptional<z.ZodString>;
}> = {
  name: 'adjustVolume',
  description:
    'Adjust the playback volume up or down by a relative amount, fading gradually over ~4 seconds. Use positive values to increase, negative to decrease. Requires Spotify Premium.',
  schema: {
    adjustment: z
      .number()
      .min(-100)
      .max(100)
      .describe(
        'The amount to adjust volume by (-100 to 100). Positive increases, negative decreases.',
      ),
    deviceId: z
      .string()
      .optional()
      .describe('The Spotify device ID to adjust volume on'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { adjustment, deviceId } = args;

    try {
      const playback = await handleSpotifyRequest(async (spotifyApi) => {
        return await spotifyApi.player.getPlaybackState();
      });

      if (!playback?.device) {
        return {
          content: [
            {
              type: 'text',
              text: 'No active device found. Make sure Spotify is open and playing on a device.',
            },
          ],
        };
      }

      const currentVolume = playback.device.volume_percent;
      if (currentVolume === null || currentVolume === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: 'Unable to get current volume from device.',
            },
          ],
        };
      }

      const newVolume = await rampVolume(
        currentVolume,
        currentVolume + adjustment,
        deviceId || '',
      );

      const direction =
        adjustment > 0
          ? 'increased'
          : adjustment < 0
            ? 'decreased'
            : 'unchanged';
      return {
        content: [
          {
            type: 'text',
            text: `Volume ${direction} from ${currentVolume}% to ${newVolume}%`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error adjusting volume: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const setRepeatMode: tool<{
  mode: z.ZodEnum<['track', 'context', 'off']>;
  deviceId: z.ZodOptional<z.ZodString>;
}> = {
  name: 'setRepeatMode',
  description:
    'Set the repeat mode for Spotify playback (track, context, or off)',
  schema: {
    mode: z.enum(['track', 'context', 'off']).describe('The repeat mode'),
    deviceId: z
      .string()
      .optional()
      .describe('The Spotify device ID to set repeat mode on'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { mode, deviceId } = args;

    await handleSpotifyRequest(async (spotifyApi) => {
      await spotifyApi.player.setRepeatMode(mode, deviceId || '');
    });

    return {
      content: [
        {
          type: 'text',
          text: `Repeat mode set to ${mode}`,
        },
      ],
    };
  },
};

const setShuffle: tool<{
  state: z.ZodBoolean;
  deviceId: z.ZodOptional<z.ZodString>;
}> = {
  name: 'setShuffle',
  description: 'Toggle shuffle on or off for Spotify playback',
  schema: {
    state: z
      .boolean()
      .describe('The shuffle state (true for on, false for off)'),
    deviceId: z
      .string()
      .optional()
      .describe('The Spotify device ID to set shuffle on'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { state, deviceId } = args;

    await handleSpotifyRequest(async (spotifyApi) => {
      await spotifyApi.player.togglePlaybackShuffle(state, deviceId || '');
    });

    return {
      content: [
        {
          type: 'text',
          text: `Shuffle ${state ? 'enabled' : 'disabled'}`,
        },
      ],
    };
  },
};

export const playTools = [
  playMusic,
  pausePlayback,
  skipToNext,
  skipToPrevious,
  createPlaylist,
  addTracksToPlaylist,
  removeTracksFromPlaylist,
  reorderPlaylistItems,
  resumePlayback,
  addToQueue,
  setVolume,
  adjustVolume,
  setRepeatMode,
  setShuffle,
];
