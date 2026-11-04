# ADR 0024: Speech port and voice in the Orbit Assistant

## Status

Accepted, 2026-11-04. Mario answered D-19 and D-20 on 2026-11-04 ([ADR 0021](0021-agent-platform.md) addendum "Phases 3 and 4"), both as recommended. This ADR records the voice design of the [Phase 4 plan](../plans/agent-platform-phase-4.md) (§2.6). Nothing is live until its work package lands and `ORBIT_VOICE` is switched on. **No live speech call runs without Mario's separate approval:** speech is a new processing purpose with an existing provider.

It extends [ADR 0022](0022-personal-space-assistant.md) (personal assistant, per-user cap) and the provider allow-list of ADR 0021 (D-11).

## Decision

1. **A speech port, not a provider SDK in the call path.** `packages/ai/src/speech.ts` defines `SpeechProvider` with `transcribe` and `synthesize`, both taking an `AbortSignal`. The first adapter is OpenAI. Model ids come from the AI catalogue and routing, never from code constants. A fake adapter proves in contract tests that the provider can be exchanged.
2. **Routing and cost.**
   - The new task classes `speech_to_text` and `text_to_speech` route like other classes.
   - The new budget categories are `speech_stt` and `speech_tts`.
   - `AiModelPrice` gains `unit` (`token | audio_minute | character`) and `unitPriceMicros` (migration). Existing prices keep `unit = token`, so text reservation and settlement are unchanged.
   - **Estimate before reservation:** STT from the server-measured audio duration (container header, with size and duration caps; unreadable input is refused); TTS from the character count.
   - **Settlement** uses actual usage. A transmitted call with an unclear outcome is `outcome_unknown` and is never retried.
   - Voice runs in the personal space within the user's per-member cap (ADR 0022 D-09).
3. **No audio storage (D-19).**
   - Audio is held in memory for the request only. It is never written to the database, platform files or logs.
   - The transcript becomes the user's chat message, editable before sending, with chat retention.
   - TTS audio is generated on demand, streamed and not stored.
   - Voice is personal data, so the data-class allow-list applies (OpenAI only).
4. **Explicit user action only.** There is a push-to-talk microphone button (with a toggle mode for accessibility). The microphone is accessed only after the user presses it, and there is no wake word and no background listening.
   - Limits: at most 60 s and 2 MB, with a MIME allow-list (webm/opus, mp4 for Safari).
   - Transcripts land in the composer for review. Sending automatically is a user setting, off by default (T4-3).
5. **Same principal as text.** A voice turn is an ordinary text turn after transcription: same tools, rights, approvals and limits.
6. **Read aloud.** "Read aloud" per assistant message reads the visible answer text; cards are summarized by their titles. It has a character cap. Reading answers aloud automatically is a user setting, off by default.
7. **Gates.** The flag is `ORBIT_VOICE`, the entitlement is `assistantVoice`, and the personal assistant must be available to the user.
8. **Realtime voice (D-20) is a spike only, after STT/TTS is in use.** Go/no-go criteria:
   - **V-G1:** reserve and settle per session minute, with a hard stop.
   - **V-G2:** every tool call runs through Orbit's capability layer on the server; client-forwarded calls are re-authorized.
   - **V-G3:** no audio stored.
   - **V-G4:** cancel, timeout and interruption handled.
   - **V-G5:** the provider is exchangeable behind a port.
   - **V-G6:** the cost per active minute is measured and accepted by Mario.

   The spike is not merged; its paid minutes need Mario's cost approval.

## Alternatives

- **Browser speech APIs (Web Speech).** Rejected as the primary path: quality and availability vary by browser, and some implementations send audio to a vendor outside Orbit's allow-list and budget.
- **Storing audio for quality review.** Rejected (D-19).
- **Realtime voice first.** Deferred (D-20): it needs per-minute budgets and a server-side tool relay first.

## Consequences

- One additive migration (`AiModelPrice` units). It needs a Coolify-approved schema hash.
- The org catalogue UI shows speech prices per unit.
- A live check of STT and TTS needs Mario's cost approval and is not part of automated tests.
- Rollback: `ORBIT_VOICE=false` hides the controls and the routes answer 404. The columns stay.
