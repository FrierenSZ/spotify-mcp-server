import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type IndexedTrack,
  matchIndexedTracks,
  normalizeTrackSearch,
} from './read.js';

// The getPlaylistDetails 'query' filter is normalize(name + artists).includes(normalize(query)).
const matches = (haystack: string, query: string) =>
  normalizeTrackSearch(haystack).includes(normalizeTrackSearch(query));

test('query filter ignores case, accents and extra spaces', () => {
  assert.ok(matches('Não Vou Me Adaptar Titãs', 'nao vou me adaptar'));
  assert.ok(matches('Bohemian Rhapsody Queen', '  QUEEN  '));
  assert.ok(matches('Evidências Chitãozinho & Xororó', 'evidencias'));
  assert.ok(!matches('Bohemian Rhapsody Queen', 'nirvana'));
});

let nextPosition = 0;
function indexed(
  name: string,
  artists: string,
  playlistName = 'Playlist',
  id = `id-${++nextPosition}`,
): IndexedTrack {
  return {
    name,
    artists,
    id,
    playlistName,
    playlistId: 'pl-1',
    position: nextPosition,
    nameKey: normalizeTrackSearch(name),
    haystack: normalizeTrackSearch(`${name} ${artists}`),
  };
}

const library = [
  indexed('Evidências - Ao Vivo', 'Jorge & Mateus'),
  indexed('Evidências', 'Chitãozinho & Xororó'),
  indexed('Bohemian Rhapsody', 'Queen'),
  indexed('Não Vou Me Adaptar', 'Titãs'),
];

test('exact title outranks the live cover', () => {
  const { matches, total } = matchIndexedTracks(library, 'evidencias', 8);
  assert.equal(total, 2);
  assert.equal(matches[0].name, 'Evidências');
  assert.equal(matches[1].name, 'Evidências - Ao Vivo');
});

test('matches on artist name alone', () => {
  const { matches } = matchIndexedTracks(library, 'queen', 8);
  assert.deepEqual(
    matches.map((m) => m.name),
    ['Bohemian Rhapsody'],
  );
});

test('accents and case in the query are ignored', () => {
  const { matches } = matchIndexedTracks(library, 'NÃO VOU ME ADAPTAR', 8);
  assert.equal(matches[0].artists, 'Titãs');
});

test('a track in several playlists is returned once', () => {
  const duplicated = [
    indexed('Bohemian Rhapsody', 'Queen', 'Rock', 'same-id'),
    indexed('Bohemian Rhapsody', 'Queen', 'Favoritas', 'same-id'),
  ];
  const { matches, total } = matchIndexedTracks(duplicated, 'bohemian', 8);
  assert.equal(total, 1);
  assert.equal(matches.length, 1);
});

test('limit truncates matches but total reports everything found', () => {
  const { matches, total } = matchIndexedTracks(library, 'evidencias', 1);
  assert.equal(matches.length, 1);
  assert.equal(total, 2);
});

test('stylized letters fold to ascii', () => {
  // Real case: "REVIVƎЯ" (Ǝ U+018E, Я U+042F) has to answer to "reviver".
  assert.equal(normalizeTrackSearch('REVIVƎЯ'), 'reviver');
  assert.equal(normalizeTrackSearch('MØØN'), 'moon');
  const stylized = [indexed('REVIVƎЯ', 'Sawano Hiroyuki, SennaRin')];
  assert.equal(matchIndexedTracks(stylized, 'reviver', 8).matches.length, 1);
});

test('extra words in the title still match', () => {
  const shelf = [indexed('The Reviver', 'Someone')];
  assert.equal(matchIndexedTracks(shelf, 'reviver', 8).matches.length, 1);
});

test('typos in the query are forgiven', () => {
  assert.equal(matchIndexedTracks(library, 'reviverr', 8).matches.length, 0);
  const shelf = [indexed('Reviver', 'Someone')];
  assert.equal(matchIndexedTracks(shelf, 'reviverr', 8).matches.length, 1);
  assert.equal(matchIndexedTracks(shelf, 'revvier', 8).matches.length, 1);
  // Typo tolerance must not turn one real song into another.
  assert.equal(matchIndexedTracks(library, 'green', 8).matches.length, 0);
});

test('short queries get no typo budget', () => {
  // Four letters and two edits would match half the library.
  const shelf = [indexed('Calm', 'Someone')];
  assert.equal(matchIndexedTracks(shelf, 'palm', 8).matches.length, 0);
});

test('an exact hit still outranks a fuzzy one', () => {
  const shelf = [indexed('Reviver', 'A'), indexed('Revived', 'B')];
  const { matches } = matchIndexedTracks(shelf, 'reviver', 8);
  assert.equal(matches[0].name, 'Reviver');
});

test('no match returns empty instead of junk', () => {
  const { matches, total } = matchIndexedTracks(library, 'nirvana', 8);
  assert.equal(matches.length, 0);
  assert.equal(total, 0);
});
