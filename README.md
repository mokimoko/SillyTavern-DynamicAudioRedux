# Dynamic Audio Redux

A [SillyTavern](https://github.com/SillyTavern/SillyTavern) extension for background music that reacts to what's going on in your chat. Pick tracks by emotion, tag your library with AI, build playlists from your conversations, or just let it shuffle through whatever you've got.

Based on the original [Dynamic Audio](https://github.com/SillyTavern/Extension-DynamicAudio) extension by the SillyTavern team — rebuilt around a single tabbed modal, AI tagging, and smarter playlist tools.

<p align="center">
  <img src="https://files.catbox.moe/cpxnnr.png" width="200" />
  <img src="https://files.catbox.moe/4gd79z.png" width="200" />
</p>

## Features

**Three Playback Modes** — Instrumental (emotion-matched background music), Songs (any music, optionally filtered by emotion), or Playlist (smart tag-based or hand-picked manual playlists).

**AI Auto-Tagging** — Point it at your untagged tracks and let an LLM tag them with emotions and metadata. Bulk-tag 10/15/20 tracks at a time, or click the wand icon on any single row for a one-off tag. Preview and edit before saving.

**Playlist From Chat** — Generate a smart playlist based on the current scene. The AI reads recent messages and either picks tracks from your library or generates a tag-based playlist that pulls in whatever fits the mood.

**Draggable Miniplayer** — Compact floating widget you can drop anywhere on screen. Snap-to-edges optional. Stays out of the way of ST drawers and popups.

**Audio Library Modal** — The main UI. One tabbed modal with live now-playing controls, your full track library with search and filters, playlist management with a two-column drag-to-reorder editor, and preferences.

## Installation

Use SillyTavern's built-in extension installer:

1. Open **Extensions** → **Install Extension**
2. Paste this URL:
   ```
   https://github.com/chatelainedev/SillyTavern-DynamicAudioRedux
   ```
3. Click **Install** and reload if prompted

## Setup

1. Add music files to:
   - `data/<your-user>/assets/bgm/` — global tracks (available everywhere)
   - `data/<your-user>/characters/<name>/bgm/` — character-specific tracks
2. Open the **Audio Library** from the extensions menu (🎧 icon) and click **Scan**
3. Tag your tracks — manually (pencil icon on any row) or hit **Auto-Tag** for bulk AI tagging
4. Turn audio on in the Playback tab and pick a mode

## Tagging Tracks

Click the edit icon on any track to set:

- **Title** — auto-cleans junk like "Official Music Video" from filenames
- **Instrumental** flag — separates vocal tracks from background-only
- **Emotions** — joy, sadness, anger, etc. (drives emotion-matched playback)
- **Custom tags** — anything you want, freeform. Used by smart playlists.

## Playlists

**Smart Playlists** — Tag-based. Add any combination of emotion tags, character names, arc tags (`arc:revenge`), or freeform descriptors. Tracks matching the tags get pulled in automatically.

**Manual Playlists** — Hand-picked. Two-column editor: available tracks on the left, your selections on the right. Click to move between columns, drag the grip handle to reorder.

**From Chat** — AI-generated based on the current conversation. Choose how many recent messages to include and let it pick tracks or generate fitting tags.

## Slash Commands

```
/d-audio on / off              # Enable or disable
/d-audio skip / prev           # Transport
/d-audio library               # Open the Audio Library modal
/d-audio scan                  # Rescan for new tracks
/d-audio migrate               # Re-link metadata after renaming files
/d-audio status                # Print all current settings
/d-audio nowplaying            # Print the current track name

/d-audio mode=instrumental     # Switch modes (instrumental / songs / playlist)
/d-audio playlist="Chill"      # Switch to a specific playlist
/d-audio autoswitch=on         # Auto-switch on emotion changes
/d-audio shuffle=on
/d-audio loop=on
/d-audio volume=75

/d-audio "track name" playlist="Favorites"   # Add a track to a manual playlist
```

Get the current value of any setting by leaving it empty: `/d-audio mode=`, `/d-audio volume=`, etc.

## Notes

- Tag matching is fuzzy, so casual tags like `Alice` or `revenge` will pick up tracks tagged with those terms whether they were set manually or by auto-tag.
- The `migrate` command is useful when you rename audio files outside SillyTavern — it re-links the old metadata to new filenames wherever it can.
- Debug mode (Preferences tab) logs detection info to the browser console.

## Credits

Original [Dynamic Audio](https://github.com/SillyTavern/Extension-DynamicAudio) extension by the SillyTavern team.
