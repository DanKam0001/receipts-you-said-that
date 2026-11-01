# Evaluation audio sources

- Public-domain speech: LibriVox volunteer Kristen McQuillin reading Chapter 1, "Down the Rabbit-Hole," from Lewis Carroll's *Alice's Adventures in Wonderland* (public domain in the United States, per the LibriVox catalog).
- Internet Archive item page: https://archive.org/details/alice_in_wonderland_librivox
- Direct MP3 used by `eval/prepare.py`: https://www.archive.org/download/alice_in_wonderland_librivox/wonderland_ch_01_64kb.mp3
- Text reference used for WER: Project Gutenberg plain text, https://www.gutenberg.org/files/11/11-0.txt
- Synthetic background bed and sparse short game-like chirps are generated locally by `eval/prepare.py` with NumPy (seed `20261101`); no external SFX are included.

The downloaded audio, reference text, generated noise, and mixed replay WAV stay in this ignored folder and are not committed.
