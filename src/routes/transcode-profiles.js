'use strict';

/**
 * Transcode Profiles
 *
 * Named FFmpeg profiles that can be assigned to a source or individual channel.
 * When a stream request hits /stream/:id, the stream router looks up the
 * channel's profile (or its source's profile) and uses those FFmpeg args.
 *
 * DB table: transcode_profiles
 *   id, name, video_codec, audio_codec, video_bitrate, audio_bitrate,
 *   resolution, extra_args, created
 *
 * Assignment:
 *   channels.transcode_profile_id  (per-channel override)
 *   sources.transcode_profile_id   (per-source default)
 */

const express   = require('express');
const router    = express.Router();
const { getDb } = require('../db');
const { requireAuth } = require('./auth');

// ── Built-in presets ──────────────────────────────────────────────────────────
const PRESETS = [
  {
    name:          'passthrough',
    video_codec:   'copy',
    audio_codec:   'copy',
    video_bitrate: null,
    audio_bitrate: null,
    resolution:    null,
    extra_args:    '',
    description:   'No transcoding -- pass stream through unchanged',
  },
  {
    name:          'h264-nvenc-1080p',
    video_codec:   'h264_nvenc',
    audio_codec:   'aac',
    video_bitrate: '4000k',
    audio_bitrate: '192k',
    resolution:    '1920x1080',
    extra_args:    '-preset p4 -rc cbr',
    description:   'NVIDIA GPU encode -- 1080p @ ~4 Mbps',
  },
  {
    name:          'h264-nvenc-720p',
    video_codec:   'h264_nvenc',
    audio_codec:   'aac',
    video_bitrate: '2500k',
    audio_bitrate: '128k',
    resolution:    '1280x720',
    extra_args:    '-preset p4 -rc cbr',
    description:   'NVIDIA GPU encode -- 720p @ ~2.5 Mbps',
  },
  {
    name:          'h264-cpu-720p',
    video_codec:   'libx264',
    audio_codec:   'aac',
    video_bitrate: '2500k',
    audio_bitrate: '128k',
    resolution:    '1280x720',
    extra_args:    '-preset veryfast -crf 23',
    description:   'CPU encode -- 720p @ ~2.5 Mbps (slower)',
  },
  {
    name:          'h264-qsv-1080p',
    video_codec:   'h264_qsv',
    audio_codec:   'aac',
    video_bitrate: '4000k',
    audio_bitrate: '192k',
    resolution:    '1920x1080',
    extra_args:    '-global_quality 25',
    description:   'Intel QSV GPU encode -- 1080p',
  },
];

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/transcode-profiles -- list all saved profiles + built-in presets
router.get('/', (req, res) => {
  const profiles = getDb().prepare('SELECT * FROM transcode_profiles ORDER BY id').all();
  res.json({ profiles, presets: PRESETS });
});

// GET /api/transcode-profiles/:id
router.get('/:id', (req, res) => {
  const row = getDb().prepare('SELECT * FROM transcode_profiles WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// POST /api/transcode-profiles
router.post('/', requireAuth('admin'), (req, res) => {
  const { name, video_codec, audio_codec, video_bitrate, audio_bitrate, resolution, extra_args, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const result = getDb().prepare(`
    INSERT INTO transcode_profiles (name, video_codec, audio_codec, video_bitrate, audio_bitrate, resolution, extra_args, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, video_codec || 'copy', audio_codec || 'copy', video_bitrate || null, audio_bitrate || null, resolution || null, extra_args || '', description || '');
  res.json({ ok: true, id: result.lastInsertRowid });
});

// POST /api/transcode-profiles/from-preset -- create a profile from a preset name
router.post('/from-preset', requireAuth('admin'), (req, res) => {
  const { preset_name, name } = req.body;
  const preset = PRESETS.find(p => p.name === preset_name);
  if (!preset) return res.status(404).json({ error: 'Preset not found' });
  const finalName = name || preset.name;
  const result = getDb().prepare(`
    INSERT INTO transcode_profiles (name, video_codec, audio_codec, video_bitrate, audio_bitrate, resolution, extra_args, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(finalName, preset.video_codec, preset.audio_codec, preset.video_bitrate, preset.audio_bitrate, preset.resolution, preset.extra_args, preset.description || '');
  res.json({ ok: true, id: result.lastInsertRowid });
});

// PUT /api/transcode-profiles/:id
router.put('/:id', requireAuth('admin'), (req, res) => {
  const { name, video_codec, audio_codec, video_bitrate, audio_bitrate, resolution, extra_args, description } = req.body;
  getDb().prepare(`
    UPDATE transcode_profiles SET
      name          = COALESCE(?, name),
      video_codec   = COALESCE(?, video_codec),
      audio_codec   = COALESCE(?, audio_codec),
      video_bitrate = COALESCE(?, video_bitrate),
      audio_bitrate = COALESCE(?, audio_bitrate),
      resolution    = COALESCE(?, resolution),
      extra_args    = COALESCE(?, extra_args),
      description   = COALESCE(?, description)
    WHERE id = ?
  `).run(name||null, video_codec||null, audio_codec||null, video_bitrate||null, audio_bitrate||null, resolution||null, extra_args??null, description||null, req.params.id);
  res.json({ ok: true });
});

// DELETE /api/transcode-profiles/:id
router.delete('/:id', requireAuth('admin'), (req, res) => {
  getDb().prepare('DELETE FROM transcode_profiles WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// GET /api/transcode-profiles/resolve/:channelId
// Returns the effective profile for a channel (channel override -> source default -> null)
router.get('/resolve/:channelId', (req, res) => {
  const db = getDb();
  const ch = db.prepare('SELECT * FROM channels WHERE id=?').get(req.params.channelId);
  if (!ch) return res.status(404).json({ error: 'Channel not found' });

  if (ch.transcode_profile_id) {
    const p = db.prepare('SELECT * FROM transcode_profiles WHERE id=?').get(ch.transcode_profile_id);
    if (p) return res.json({ ...p, source: 'channel' });
  }

  const src = db.prepare('SELECT * FROM sources WHERE id=?').get(ch.source_id);
  if (src?.transcode_profile_id) {
    const p = db.prepare('SELECT * FROM transcode_profiles WHERE id=?').get(src.transcode_profile_id);
    if (p) return res.json({ ...p, source: 'source' });
  }

  res.json(null); // no profile -> use server default / env vars
});

/**
 * buildFfmpegArgs(profile) -- convert a profile row into FFmpeg codec args array
 * Returns array of strings to splice into the FFmpeg spawn args.
 */
function buildFfmpegArgs(profile) {
  if (!profile || profile.video_codec === 'copy') {
    return ['-c:v', 'copy', '-c:a', 'copy'];
  }
  const args = ['-c:v', profile.video_codec];
  if (profile.video_bitrate) args.push('-b:v', profile.video_bitrate);
  if (profile.resolution)    args.push('-vf', `scale=${profile.resolution.replace('x', ':')}`);
  args.push('-c:a', profile.audio_codec || 'aac');
  if (profile.audio_bitrate) args.push('-b:a', profile.audio_bitrate);
  if (profile.extra_args) {
    args.push(...profile.extra_args.trim().split(/\s+/).filter(Boolean));
  }
  return args;
}

module.exports = router;
module.exports.buildFfmpegArgs = buildFfmpegArgs;
module.exports.PRESETS = PRESETS;
