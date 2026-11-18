# Mix Clips

A Spicetify extension that records vertical 2K clips (1440×2560) of your songs and of the mixes in your playlists, with the lyrics, the colours of each cover and the real beat. Ready for TikTok, Reels or Shorts.

[OBS Studio](https://obsproject.com) does the recording with Spotify's own sound. Mix Clips sets OBS up, starts and stops it, and leaves it as it was.

![Mix Clips](https://raw.githubusercontent.com/SrPictus/mix-clips/main/preview.webp)

## Styles

![Clip styles: Orbit, Waveform and Kinetic](https://raw.githubusercontent.com/SrPictus/mix-clips/main/screenshots/clips.png)

Each style has a live preview in the panel, and you pick one every time you record.

- **Orbit:** each song is a small 3D space (its cover, its colours, its title and its lyrics) and a camera floats through it, pulsing on the beat. When the mix starts, the camera pulls back until both songs are in the shot, holds them while they play together, then flies down to the new one.
- **Waveform:** the song's waveform, built from its real loudness, seen in 3D while the camera drifts around it. The lyrics are written on the waveform itself, each word filling with light as it's sung. On the mix both waveforms meet in the middle, one slightly in front of the other, and their colours blend where they overlap.
- **Aura:** a liquid gradient made from the cover's colours, the cover floating above it, and the lyrics coming in word by word. On the mix the screen splits along a liquid wave: the outgoing song on top, the incoming one below.
- **Kinetic:** the word being sung fills the screen, each one arriving with its own motion. On the mix the screen splits in two and both songs sing at once.

Everything comes from real data: the lyrics with each word's timing (from [Spicy Lyrics](https://github.com/Spikerko/spicy-lyrics)' saved copy, or Spotify's), each song's beat and loudness, and the exact moment and length of the mix.

## How to use it

![The Mix Clips panel](https://raw.githubusercontent.com/SrPictus/mix-clips/main/screenshots/clip-panel.png)

1. Open OBS (it can stay minimised). The first time, connect it as explained below.
2. In Spotify, click the **Mix Clips** button in the player bar (a vertical frame with a dot).
3. Pick a style and what to record:
   - **Next mix:** waits for the next transition in a mixed playlist and records it, from six seconds before it starts to just after it ends.
   - **15 s, 30 s or 60 s:** records from now.
4. Click **Record**. After a 3-2-1 countdown OBS records, and it stops by itself. Spotify tells you where the MP4 was saved.

The clip comes out at a true 2K (1440×2560) and 60 fps, because OBS draws it itself at full size, and it's encoded at OBS's highest quality. It doesn't depend on how big your screen is, and it still looks sharp after TikTok, Instagram or YouTube compress it.

## Connecting OBS (once)

![How to get the OBS WebSocket password](https://raw.githubusercontent.com/SrPictus/mix-clips/main/screenshots/obs-password.webp)

1. Install [OBS Studio](https://obsproject.com) (version 28 or newer) and open it.
2. In OBS, open **Tools → WebSocket Server Settings** and tick **Enable WebSocket server**.
3. Click **Show Connect Info** and copy the **Server Password**.
4. In Spotify, open **Mix Clips** and paste it in **OBS password**. It's saved only on your computer, so you only do this once.

You don't have to set anything else up in OBS. The first time you record, Mix Clips creates its own profile and scene, both called **Mix Clip**, with the clip and Spotify's sound already in place, so your usual profile, scenes and settings are never changed. While recording it shows only the clip, records only Spotify's sound, and mutes your desktop audio and microphone. When it finishes, it switches everything back.

### Is it safe?

- **It stays inside your computer.** Mix Clips talks to OBS at `127.0.0.1`, which is your own PC. Your password and your clips never go online.
- **The password stays with you.** It's saved only in Spotify on your PC. It's what stops other devices on your network from controlling OBS, so don't share it, and don't open port 4455 on your router.
- **It only touches its own setup.** In OBS it uses only its own **Mix Clip** profile and scene, and records only the clip and Spotify's sound. It doesn't change your other scenes or settings.
- **You can switch it off.** If you stop using Mix Clips, untick **Enable WebSocket server** in OBS.

## If something goes wrong

- **"OBS isn't open, or its WebSocket server is off":** open OBS, and check that **Enable WebSocket server** is ticked (step 2 above).
- **"Wrong OBS password":** copy it again from **Show Connect Info**. If you click **Generate Password** in OBS, the old one stops working.
- **"No mix to the next song yet":** the playlist needs mixing turned on (the **Mix** button on the playlist), and the next song must be part of the mix. Or record 15, 30 or 60 seconds instead.
- **The recording waits and doesn't start:** Spotify is muted or at volume 0. Turn it up and it starts.
- **Where are my clips?** In OBS's recordings folder (by default, your Videos folder). You can change it in OBS under **Settings → Output → Recording Path**.
- **The clip looks soft:** your OBS has no browser source, so Mix Clips captures Spotify's window instead and stretches it to 2K. Install OBS from [obsproject.com](https://obsproject.com), which includes it.
- **TikTok or Instagram muted my video:** platforms may mute clips with copyrighted music. Add the song from the app's own music library instead.

## Requirements

- Windows (Mix Clips uses OBS's per-app audio capture, which only exists on Windows)
- [Spicetify](https://spicetify.app)
- [OBS Studio](https://obsproject.com) 28 or newer
- For mix clips: a Spotify version with mixed playlists (the **Mix** button on your playlists)

It works with any theme. It also pairs with [Mix Lyrics](https://github.com/SrPictus/mix-lyrics), which shows both songs' lyrics during a mix inside Spotify, and with the [Vitral](https://github.com/SrPictus/vitral) theme. Neither is required.

## Install

### Marketplace (recommended)

Open the **Marketplace** in Spotify, go to the **Extensions** tab, search for **Mix Clips** and click **Install**. It updates on its own.

### Manual

In PowerShell:

```powershell
Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/SrPictus/mix-clips/main/mix-clips.js" -OutFile "$env:APPDATA\spicetify\Extensions\mix-clips.js"
```

```powershell
spicetify config extensions mix-clips.js
```

```powershell
spicetify apply
```

### Uninstall

From the Marketplace, click **Uninstall** on Mix Clips. If you installed it by hand:

```powershell
spicetify config extensions mix-clips.js-
```

```powershell
spicetify apply
```

## Known limits

- It uses Spotify's internal mixing functions, so a Spotify update can break mix clips.
- Clips sound as loud as Spotify is playing.
- Tested on Windows with Spotify 1.3.10 and OBS 32.

## License

[MIT](LICENSE)
