# Intonation Trace

A real-time intonation display for violin, viola and cello practice. Play into your device's microphone and see:

- **Pitch trace**: your pitch over time against the open strings, in red when flat, blue when sharp, and plain when in tune. The ribbon gets thicker as you play louder.
- **Cents chart**: how far you are from the nearest note, from −50 to +50 cents, with the in-tune zone shaded.

It runs entirely in the browser. Audio is analysed on your device and is never recorded or uploaded.

## Use it

Open the GitHub Pages site, press **Start listening** and allow microphone access. **Watch a demo** plays a silent synthetic scale through the display so you can see how it works without an instrument.

- **Instrument** sets the open-string reference lines and the lowest pitch the detector looks for.
- **A4** sets the reference pitch (e.g. 442).
- **Pause** (or the space bar) freezes the display so you can look at a passage.
- **Settings**
  - *Open strings*: draw the string lines in pure 3:2 fifths tuned from the A string, which is how string players tune, or in equal temperament.
  - *In-tune zone*: how many cents either side of a note counts as in tune.
  - *Time window*: how many seconds of history are shown.
  - *Mic sensitivity*: the level below which sound is ignored. Play a note and watch the meter. The marker should sit below your playing level and above the room noise.

Tips: put the phone or laptop on your music stand, about a metre away. The screen stays awake while the display is listening, in browsers that support it. Cents are always measured against equal temperament at your chosen A4.

## How it works

- `pitch.js`: a [YIN](http://audition.ens.fr/adc/pdf/2002_JASA_YIN.pdf) fundamental-frequency detector. It uses parabolic interpolation, and high notes are measured across several periods for sub-cent accuracy.
- `app.js`: microphone capture (echo cancellation, noise suppression and auto-gain are turned off), median smoothing, and the canvas drawing.
- No build step and no dependencies. It is a static site.

## Develop

```sh
python -m http.server 8000   # then open http://localhost:8000 (localhost counts as secure, so the mic works)
node test/pitch.test.mjs     # detector accuracy checks from cello C2 to violin C7
```

Add `?demo` to the URL to start the demo straight away.
