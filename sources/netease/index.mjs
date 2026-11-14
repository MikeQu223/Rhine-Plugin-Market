import legacy from './legacy.cjs';
import artistSongs from '@neteasecloudmusicapienhanced/api/module/artist_songs.js';
import { wrapCreate } from './artist-songs.cjs';

export const create = wrapCreate(legacy.create, artistSongs, legacy.__rhine.request, legacy.__rhine.songItem);
