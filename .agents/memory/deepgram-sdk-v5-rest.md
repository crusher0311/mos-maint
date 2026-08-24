---
name: Deepgram SDK v5 has no createClient
description: Installed @deepgram/sdk v5 dropped the classic createClient/prerecorded surface; use the REST API directly.
---
The repo pins @deepgram/sdk ^5.0.0, a Fern-generated client (`DeepgramClient` class, `listen.v1.media`) — `createClient` and `deepgram.listen.prerecorded.transcribeFile` from all common docs/examples do not exist and fail at runtime under webpack with "createClient is not a function".

**Why:** v5 is a full rewrite; nearly all online examples target v3/v4.

**How to apply:** for pre-recorded transcription just POST the audio bytes to `https://api.deepgram.com/v1/listen?model=nova-2&detect_language=true&smart_format=true` with `Authorization: Token <DEEPGRAM_API_KEY>` and Content-Type = the audio mimetype (see lib/auto-dvi/voice.ts). Multilingual detection works well; response shape `results.channels[0].alternatives[0].transcript` + `channels[0].detected_language`.
