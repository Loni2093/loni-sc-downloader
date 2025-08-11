import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import mkdirp from 'mkdirp';
import sanitize from 'sanitize-filename';

const CLIENT_ID = process.env.CLIENT_ID;
const PROFILE_URL = process.env.PROFILE_URL || 'https://soundcloud.com/loni-gojani';
const OUT_DIR = process.env.OUT_DIR || 'downloads';
const AUDIO_DIR = path.join(OUT_DIR, 'audio');
const ART_DIR = path.join(OUT_DIR, 'artwork');

if (!CLIENT_ID) throw new Error('Missing CLIENT_ID in .env');
if (!PROFILE_URL) throw new Error('Missing PROFILE_URL in .env');

const http = axios.create({ timeout: 30000, headers: { 'User-Agent': 'loni-downloader/1.0' } });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function resolveUser(url) {
  const { data } = await http.get('https://api-v2.soundcloud.com/resolve', { params: { url, client_id: CLIENT_ID } });
  if (!data?.id) throw new Error('Could not resolve user');
  return data;
}

async function listTracks(userId) {
  let offset = 0; const limit = 200; const all = [];
  while (true) {
    const { data } = await http.get(`https://api-v2.soundcloud.com/users/${userId}/tracks`, {
      params: { client_id: CLIENT_ID, limit, offset }
    });
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data); offset += data.length; await sleep(300);
  }
  return all;
}

function bestArtworkUrl(track) {
  const u = track?.artwork_url || track?.user?.avatar_url;
  if (!u) return null;
  return u.replace('-large.jpg','-t500x500.jpg').replace('-large.png','-t500x500.png');
}

async function downloadTo(url, filepath) {
  const res = await http.get(url, { responseType: 'stream' });
  await mkdirp(path.dirname(filepath));
  const writer = fs.createWriteStream(filepath);
  await new Promise((resolve, reject) => { res.data.pipe(writer); writer.on('finish', resolve); writer.on('error', reject); });
}

async function progressiveMp3Url(transcodings) {
  if (!Array.isArray(transcodings)) return null;
  const t = transcodings.find(x => x?.format?.protocol === 'progressive' && x?.format?.mime_type?.includes('audio/mpeg'));
  if (!t?.url) return null;
  const { data } = await http.get(t.url, { params: { client_id: CLIENT_ID } });
  return data?.url || null;
}

function safeName(track) {
  const base = `${track.title || 'untitled'} - ${track.id}`;
  return sanitize(base).slice(0, 120);
}

async function run() {
  console.log('Resolving user…', PROFILE_URL);
  const user = await resolveUser(PROFILE_URL);
  console.log(`User: ${user.username} (#${user.id})`);

  console.log('Fetching tracks…');
  const tracks = await listTracks(user.id);
  console.log(`Found ${tracks.length} tracks`);

  let artCount = 0, audioCount = 0;

  for (const track of tracks) {
    const name = safeName(track);

    const artUrl = bestArtworkUrl(track);
    if (artUrl) {
      const ext = artUrl.endsWith('.png') ? 'png' : 'jpg';
      const artPath = path.join(ART_DIR, `${name}.${ext}`);
      if (!fs.existsSync(artPath)) {
        try { console.log('Artwork ↓', name); await downloadTo(artUrl, artPath); artCount++; }
        catch (e) { console.warn('Artwork failed', name, e.message); }
        await sleep(200);
      }
    }

    let audioUrl = null;
    if (track?.downloadable && track?.download_url) {
      audioUrl = `${track.download_url}?client_id=${CLIENT_ID}`;
    } else {
      audioUrl = await progressiveMp3Url(track?.media?.transcodings);
    }

    if (audioUrl) {
      const audioPath = path.join(AUDIO_DIR, `${name}.mp3`);
      if (!fs.existsSync(audioPath)) {
        try { console.log('Audio ↓', name); await downloadTo(audioUrl, audioPath); audioCount++; }
        catch (e) { console.warn('Audio failed', name, e.message); }
        await sleep(400);
      }
    } else {
      console.log('No downloadable/progressive audio for', name);
    }
  }

  console.log(`Done. Saved ${artCount} artwork and ${audioCount} audio file(s) in ${OUT_DIR}/`);
}

run().catch(err => { console.error('Failed:', err.response?.data || err.message); process.exit(1); });
