# Privacy Policy for Lyric Overlay

**Last updated:** 13 August 2026

Lyric Overlay ("the app") is a Windows application that displays beat-synced
lyrics and a music visualizer for whatever is playing on your PC. This policy
explains what the app does with your information. It is written to meet the
Microsoft Store privacy-policy requirement and the disclosure expectations of
the GDPR (EU/UK), the CCPA/CPRA (California), and comparable laws.

**Developer / data controller:** Dhruv Choudhary ("we", "us")
**Contact:** dhruvchoudhary306@gmail.com

## The short version

- The app runs on your device. There is **no Lyric Overlay account, server, or
  login**, and we operate **no backend** that receives your data.
- We do **not** run analytics, advertising, or tracking of any kind, and we do
  **not** sell or share personal information.
- The audio the app listens to for the visualizer is processed **live on your
  device and is never recorded, saved, or transmitted**.
- To fetch lyrics, album art, and optional AI translation, the app sends the
  **currently playing song's title and artist** (and, for AI features, the
  **lyric text**) directly from your device to the third-party services listed
  below. It sends nothing that identifies you.

## Information the app processes

The app processes the following on your device to do its job. Except where the
next section says data is sent to a third party, all of this stays local.

| Category | What it is | Why | Leaves your device? |
| --- | --- | --- | --- |
| Now-playing metadata | The title and artist of the track your media player reports to Windows (via System Media Transport Controls) | To find matching lyrics and artwork | Title + artist only, to the providers below |
| System audio | The audio signal currently playing on your PC, captured via WASAPI loopback | To drive the real-time visualizer and beat detection | **No.** Analyzed live in memory; never recorded or sent |
| Lyric text | Lyrics fetched or transcribed for the current song | To display and, optionally, translate/transliterate lyrics | Only when you use an AI feature (see below) |
| Your API keys | Keys you paste for optional AI providers | To authenticate your own requests to those providers | Stored locally; sent only to the provider that key belongs to |
| App settings & caches | Preferences, cached lyrics, artwork, and beat maps | To remember your setup and avoid re-downloading | **No.** Stored in your local app-data folder |

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

**Optional AI translation, transliteration, and mood (receive: lyric text +
song title/artist). These run only when you enable an AI feature and provide
your own API key:**
- Google Gemini — <https://policies.google.com/privacy>
- Groq — <https://groq.com/privacy-policy/>
- Hugging Face — <https://huggingface.co/privacy>

**Software updates (standalone build only):**
- GitHub — <https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement>. The
  Microsoft Store version does not self-update; the Store delivers updates.

Because these providers are based in different countries (including the United
States and China), using a given feature may transfer your song title/artist and
lyric text to servers in those countries. Choose which features to use
accordingly.

## On-device auto-transcription (Whisper)

If you turn on automatic lyric transcription, speech recognition runs **entirely
on your device** using a bundled local model. The audio and the resulting
transcript are **not uploaded** anywhere.

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

- Local caches, settings, and API keys remain on your device until you clear the
  app's cache or uninstall the app.
- We retain nothing, because we receive nothing.
- Third-party providers retain data per their own policies.

## Your rights

You control your data directly:
- **Access/erase local data:** clear the app's cache from within the app, or
  uninstall it to remove its local data folder.
- **Stop all third-party requests:** disable the corresponding features (lyrics
  lookup, artwork, AI translation) and remove your API keys.

Depending on where you live (for example, the EU/UK under the GDPR or California
under the CCPA/CPRA), you may have rights to access, correct, delete, or port
personal data, and to object to or restrict processing. Because we hold no data
about you on any server, exercise these rights against your local data as above,
and against a third-party provider directly for data it holds. We do not sell or
"share" personal information as those terms are defined by the CCPA/CPRA, and we
do not discriminate against anyone for exercising a privacy right. For questions,
contact us at the address above.

## Children's privacy

The app is not directed to children under 13 (or under 16 in the EU/UK), and we
do not knowingly collect personal information from them. Because we operate no
account system or server, we do not knowingly hold any such data.

## Security

Requests to third-party services are made over encrypted HTTPS connections. Your
settings and API keys are stored in your Windows user profile and are protected
by your operating system's account security. No method of transmission or storage
is completely secure, so we cannot guarantee absolute security.

## Changes to this policy

We may update this policy as the app changes. Material changes will be reflected
by a new "Last updated" date at the top. Continued use of the app after an update
means you accept the revised policy.

## Contact

Questions or requests about this policy or your data:

**Dhruv Choudhary** — dhruvchoudhary306@gmail.com
