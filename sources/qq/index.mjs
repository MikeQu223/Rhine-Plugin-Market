import legacy from './legacy.cjs';
import { wrapCreate } from './artist-songs.cjs';

export const create = wrapCreate(legacy.create, legacy.__rhine.singerSongs, legacy.__rhine.songItem);
