# Privacy Policy for Lyric Overlay

**Last updated:** 20 November 2026

Lyric Overlay ("the app") is a Windows application that displays beat-synced
lyrics and a music visualizer for whatever is playing on your PC. This policy
explains what the app does with your information. It is written to meet the
Microsoft Store privacy-policy requirement and the disclosure expectations of
the GDPR (EU/UK), the CCPA/CPRA (California), and comparable laws.

**Developer / data controller:** Dhruv Choudhary ("we", "us")
**Contact:** dhruvchoudhary306@gmail.com

## The short version

- The app runs on your device. There is **no Lyric Overlay account or login**.
  The only server we run receives data **only if you turn on "Send crash
  reports"** (off by default), or when you play a YouTube video in the app
  (see "YouTube music videos" below).
- We do **not** run analytics, advertising, or tracking of any kind in the
  app, and we do **not** sell or share personal information.
- The audio the app listens to for the visualizer is processed **live on your
  device and is never transmitted**. It is saved to disk only temporarily, and
  only when you use on-device transcription (see below).
- To fetch lyrics, album art, song info, and optional AI features, the app
  sends the **currently playing song's title and artist** (and, for AI
  features, the **lyric text**) directly from your device to the third-party
  services listed below. It sends nothing that identifies you, though, as with
  any internet request, those services see your IP address.
- **Settings → Privacy → Erase everything** deletes all of the app's local
  data in one step.

## Information the app processes

The app processes the following on your device to do its job. Except where the
next section says data is sent to a third party, all of this stays local.

| Category | What it is | Why | Leaves your device? |
| --- | --- | --- | --- |
| Now-playing metadata | The title and artist of the track your media player reports to Windows (via System Media Transport Controls) | To find matching lyrics and artwork | Title + artist only, to the providers below |
| System audio | The audio signal currently playing on your PC, captured via WASAPI loopback | To drive the real-time visualizer and beat detection | **No.** Analyzed live in memory; never recorded or sent |
| Lyric text | Lyrics fetched or transcribed for the current song | To display and, optionally, translate/transliterate lyrics | Only when you use an AI feature (see below) |
| Your API keys | Keys you paste for optional AI providers | To authenticate your own requests to those providers | Stored locally; sent only to the provider that key belongs to |
| Audio fingerprint | A compact acoustic fingerprint (Chromaprint) of the playing song, plus its length | To identify a song whose title your player reports wrongly | Only if you add your own AcoustID key; sent to AcoustID |
| Listening history | Which songs you played and when | For the Insights panel, "Similar songs" and next-track prediction | **No.** Local only; Settings → "Clear my history" erases it |
| Crash/error log | Error messages and app version | To help diagnose bugs | Local by default; sent to us only if you turn on crash reports |
| Music video links and files | The YouTube video or local video file you link to a song | To play the video under the visuals | Only the YouTube video ID, when you play it (see below) |
| App settings & caches | Preferences, cached lyrics, artwork, beat maps, previews, and downloaded models | To remember your setup and avoid re-downloading | **No.** Stored in your local app-data folder |

The app does **not** collect your name, email, precise location, contacts,
browsing history, or any government or financial identifiers.

## Third-party services the app contacts

When you use the relevant feature, the app makes a direct request from your
device to these services. Your data is handled under **their** privacy policies,
not ours. We have no control over and take no responsibility for their practices.

**Lyrics (receive: song title + artist; some return by matching text):**
- LRCLIB — <https://lrclib.net>
- NetEase Cloud Music — <https://music.163.com>
- KuGou — <https://www.kugou.com>

**Album artwork (receive: song title + artist):**
- Apple iTunes Search API — <https://www.apple.com/legal/privacy/>
- Deezer — <https://www.deezer.com/legal/personal-datas>
- MusicBrainz / Cover Art Archive (MetaBrainz) — <https://metabrainz.org/privacy>

**Song identification and info (receive: song title + artist):**
- MusicBrainz (MetaBrainz) — <https://metabrainz.org/privacy> — also used to
  confirm the artist and title
- Wikipedia (Wikimedia Foundation), only when you open "About this song" —
  <https://foundation.wikimedia.org/wiki/Policy:Privacy_policy>

**Optional song recognition (receives: an audio fingerprint + song length;
only if you add your own AcoustID key):**
- AcoustID — <https://acoustid.org/privacy>

**Optional AI translation, mood, and lyric correction (receive: lyric text +
song title/artist). These run only when you enable an AI feature and either
provide your own API key or connect a command-line AI tool you have installed.
Devanagari transliteration (अ) runs on your device and sends nothing:**
- Google Gemini — <https://policies.google.com/privacy>
- Anthropic Claude — <https://www.anthropic.com/legal/privacy>
- Groq — <https://groq.com/privacy-policy/>
- Hugging Face — <https://huggingface.co/privacy>
- A command-line tool you installed and signed in to yourself (Claude Code,
  Gemini CLI, GitHub Copilot CLI, or Antigravity). The app hands it the prompt;
  the tool sends it to its own provider under **your** account and that
  provider's terms. Ollama runs models on your own machine and sends nothing.

**YouTube music videos (optional; only when you use ▶ Video):**
- With your own YouTube Data API key, the app searches YouTube for the song's
  video (receives: song title + artist) — <https://policies.google.com/privacy>
- Playing a video loads YouTube's official embedded player inside a small
  relay page on our website (lyricoverlay.dhruvchoudhary.com, hosted on
  GitHub Pages). That page receives the video ID and your IP address as part
  of the normal page request. We do not log or keep either; GitHub, as host,
  may log requests under
  <https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement>. YouTube then serves
  the video under Google's privacy policy, which may include its own cookies.
- If you installed yt-dlp yourself, the app can run it to save a video to
  your disk. yt-dlp contacts YouTube directly; the app ships no downloader.

**Model downloads (one-time, only after you agree to each; receive nothing
about you or your music):**
- Hugging Face — the on-device speech model (Whisper), vocal-isolation model
  (Demucs), and speaker model used by on-device transcription

**Optional Hindi pack (a one-time file download, only if you choose it;
receives nothing about you or your music):**
- Hugging Face, hosting AI4Bharat's Aksharantar word list — <https://huggingface.co/privacy>

**Software updates (receive: a request for the latest release, nothing about
you or your music; at launch and every 6 hours):**
- GitHub — <https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement>. The
  Microsoft Store version does not self-update; the Store delivers updates.

Because these providers are based in different countries (including the United
States and China), using a given feature may transfer your song title/artist and
lyric text to servers in those countries. Choose which features to use
accordingly.

## On-device auto-transcription (Whisper)

If you turn on automatic lyric transcription, speech recognition runs **entirely
on your device** using a downloaded local model. To do this the app briefly
writes the song's audio to a temporary file on your device, which it deletes
when the transcription finishes (or at next launch, if the app was closed
mid-way). The audio and the resulting transcript are **not uploaded** anywhere.

## Optional crash reports

Every error is written to a local crash log you can open from Settings. If you
turn on **Settings → Send crash reports** (off by default), each new entry is
also sent to a server we run (a Cloudflare Worker). A report contains only the error message,
the app version, and your operating system's name. Before it is sent, the app
removes your user-folder path, your account name, and the names of any media
files. It never includes song titles, artists, or lyrics. We keep reports for
90 days, then they are deleted automatically, and we use them only to fix
bugs. Cloudflare, as our host, processes the request (including your IP
address) under <https://www.cloudflare.com/privacypolicy/>. We do not store
the IP address with the report.

## Legal bases (GDPR/UK GDPR)

Where the GDPR applies, we rely on:
- **Legitimate interests** to process now-playing metadata and audio locally so
  the app can function as you expect.
- **Your consent**, given by choosing to enable a feature, for each request the
  app sends to a third-party lyrics, artwork, or AI provider. You can withhold
  it by not using that feature.

We are not the controller for how the third-party services above process the
data they receive; each is an independent controller under its own policy.

## Data retention

- Local caches, settings, history, and API keys remain on your device until you
  erase them (Settings → Privacy → Erase everything) or uninstall the app.
- Crash reports, if you turned them on, are kept for 90 days. We receive and
  keep nothing else.
- Third-party providers retain data per their own policies.

## Your rights

You control your data directly:
- **Erase local data:** Settings → Privacy → **Erase everything** deletes every
  cache, setting, API key, history, preview, and downloaded model, then
  restarts the app. "Clear my history" erases just the listening history.
  Uninstalling also removes the app's data folder.
- **Stop third-party requests:** disable the corresponding features (lyrics
  lookup, artwork, AI features, music videos) and remove your API keys.
- **Crash reports:** turn the setting off at any time. To have reports already
  sent deleted early, email us with the approximate date. Reports carry no
  identifier, so we may not be able to tell which ones are yours.

Depending on where you live (for example, the EU/UK under the GDPR or California
under the CCPA/CPRA), you may have rights to access, correct, delete, or port
personal data, and to object to or restrict processing. Because we hold no data
about you on any server apart from anonymous crash reports, exercise these rights against your local data as above,
and against a third-party provider directly for data it holds. We do not sell or
"share" personal information as those terms are defined by the CCPA/CPRA, and we
do not discriminate against anyone for exercising a privacy right. For questions,
contact us at the address above.

## Children's privacy

The app is not directed to children under 13 (or under 16 in the EU/UK), and we
do not knowingly collect personal information from them. Because we operate no
account system, we do not knowingly hold any such data.

## Security

Requests to third-party services are made over encrypted HTTPS connections. Your
settings and API keys are stored in a file in your Windows user profile. They
are protected by your operating system's account security but are not
separately encrypted, so anyone with access to your Windows account can read
them. No method of transmission or storage
is completely secure, so we cannot guarantee absolute security.

## Changes to this policy

We may update this policy as the app changes. Material changes will be reflected
by a new "Last updated" date at the top. Continued use of the app after an update
means you accept the revised policy.

## Contact

Questions or requests about this policy or your data:

**Dhruv Choudhary** — dhruvchoudhary306@gmail.com
