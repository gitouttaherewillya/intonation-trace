# Intonation Trace

A real-time intonation display for violin, viola and cello practice. Play into your device's microphone and see:

- **Tuner needle**: how far the current note is from the nearest note, moving left when flat and right when sharp, with the in-tune zone shaded green.
- **Pitch trace**: your pitch over time against the open strings, in green when in tune, red when flat and blue when sharp. The ribbon gets thicker as you play louder.
- **Cents chart**: the same deviation over time, from −50 to +50 cents, so you can see habits such as always landing flat on a particular note.

Colours, the needle and the cents number follow the centre of your vibrato (averaged over about two cycles). The trace still shows the vibrato itself.

It runs entirely in the browser. Audio never leaves your device.

## Use it

Open the GitHub Pages site, press **Start listening** and allow microphone access. **Watch a demo** plays a short tune through the display, with notes that land out of tune and are then corrected, so you can see how it works without an instrument. The demo starts muted. Tap **Sound off** to hear it through a simple synthesised violin-family voice.

- **Instrument** sets the open-string reference lines and the lowest pitch the detector looks for.
- **A4** sets the reference pitch (e.g. 442).
- **Pause** (or the space bar) freezes the display so you can look at a passage.
- **Playback** (optional, off by default): tick *Record this session so I can play it back* on the start screen, or *Record sessions for playback* in Settings. A red **● Rec** badge shows while recording. Press **Stop** and a playback bar appears. Play it back to hear yourself with the trace and charts scrolling in sync, drag the slider to any moment, or **Save** the recording as an audio file. Recordings stay in your browser, are visible only to you, and are never uploaded. They are cleared when you close the page or record again, and ✕ discards one straight away.
- **Settings**
  - *Open strings*: draw the string lines in pure 3:2 fifths tuned from the A string, which is how string players tune, or in equal temperament.
  - *Green (in-tune) zone*: how many cents either side of a note counts as in tune (default ±5, about the smallest difference most people can hear on a sustained note).
  - *Time window*: how many seconds of history are shown.
  - *Mic sensitivity*: the level below which sound is ignored. Play a note and watch the meter. The marker should sit below your playing level and above the room noise.
  - *Stop listening after*: switch the microphone off after this many minutes without playing (default 10).

The microphone is always switched off as soon as you leave the page, for example when you switch apps, lock the phone or change tab.

Tips: put the phone or laptop on your music stand, about a metre away. The screen stays awake while the display is listening, in browsers that support it. Cents are always measured against equal temperament at your chosen A4.

## How it works

- `pitch.js`: a [YIN](http://audition.ens.fr/adc/pdf/2002_JASA_YIN.pdf) fundamental-frequency detector. It uses parabolic interpolation, and high notes are measured across several periods for sub-cent accuracy.
- `app.js`: microphone capture (echo cancellation, noise suppression and auto-gain are turned off), median smoothing, and the canvas drawing. The first ~45 ms of each note are held back until the analysis window holds only that note, because a window straddling the onset reads several cents sharp. Recording uses `MediaRecorder`.
- No build step and no dependencies. It is a static site.

## Develop

```sh
python -m http.server 8000   # then open http://localhost:8000 (localhost counts as secure, so the mic works)
node test/pitch.test.mjs     # detector accuracy checks from cello C2 to violin C7
```

Add `?demo` to the URL to start the demo straight away.
