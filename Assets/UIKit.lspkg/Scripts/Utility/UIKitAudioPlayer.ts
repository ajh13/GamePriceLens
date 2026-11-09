import {Singleton} from "InteractionKit.lspkg/Decorators/Singleton"

/**
 * Maximum number of AudioComponents kept alive per distinct audio track. This
 * bounds how many concurrent "voices" a single sound can have: up to this many
 * plays can overlap and be heard at once before the oldest is retriggered.
 */
const MAX_VOICES_PER_TRACK = 4

/**
 * Plays short UI sounds (button / keyboard pokes) by reusing a small, bounded
 * set of AudioComponents per audio track.
 *
 * Each AudioComponent is created once for a given track and never has its
 * `audioTrack` reassigned, so the underlying playback stream stays stable across
 * plays and can be reused instead of being recreated on every interaction.
 *
 * Voice selection is a plain round-robin: ramp up to MAX_VOICES_PER_TRACK fresh
 * voices, then cycle through them. Consecutive plays therefore land on
 * *different* voices, so overlapping pokes (fast typing) are actually audible
 * up to the cap. We intentionally do NOT try to pick an "idle" voice via
 * `isPlaying()` — a stream starts asynchronously, so `isPlaying()` reports false
 * for a short window after `play()`, which made rapid plays collapse onto a
 * single voice (monophonic, no overlap).
 */
@Singleton
export class UIKitAudioPlayer {
  public static getInstance: () => UIKitAudioPlayer

  // One bounded set of reusable voices per audio track.
  private voicesByTrack: Map<AudioTrackAsset, AudioComponent[]>
  // Round-robin cursor per track (which voice to reuse once the pool is full).
  private nextVoiceByTrack: Map<AudioTrackAsset, number>

  public constructor() {
    this.voicesByTrack = new Map<AudioTrackAsset, AudioComponent[]>()
    this.nextVoiceByTrack = new Map<AudioTrackAsset, number>()
  }

  public play(audioTrack: AudioTrackAsset, volume: number) {
    if (!audioTrack) {
      return
    }
    const voice = this.acquireVoice(audioTrack)
    voice.volume = volume
    // Restart from the beginning, reusing this voice's existing stream handle
    // rather than allocating a new sound. If the voice is still mid-playback
    // (we cycled back to it), this retriggers it in place.
    voice.position = 0
    voice.play(1)
  }

  /**
   * Returns the next voice for the given track: a newly created one until the
   * per-track cap is reached, then the voices in round-robin order.
   */
  private acquireVoice(audioTrack: AudioTrackAsset): AudioComponent {
    let voices = this.voicesByTrack.get(audioTrack)
    if (!voices) {
      voices = []
      this.voicesByTrack.set(audioTrack, voices)
      this.nextVoiceByTrack.set(audioTrack, 0)
    }

    // Ramp up: create a fresh voice per concurrent sound until we hit the cap.
    if (voices.length < MAX_VOICES_PER_TRACK) {
      const voice = this.createAudioComponent(audioTrack)
      voices.push(voice)
      return voice
    }

    // Pool full: cycle through the existing voices. `?? 0` keeps this safe under
    // strictNullChecks (Map.get is V | undefined).
    const index = this.nextVoiceByTrack.get(audioTrack) ?? 0
    this.nextVoiceByTrack.set(audioTrack, (index + 1) % voices.length)
    return voices[index]
  }

  private createAudioComponent(audioTrack: AudioTrackAsset): AudioComponent {
    const audioObject = global.scene.createSceneObject("UIKitAudioPlayer")
    const audioComponent = audioObject.createComponent("Component.AudioComponent")
    audioComponent.playbackMode = Audio.PlaybackMode.LowPower
    // Assign the track exactly once for this voice; it is never reassigned, so
    // the underlying playback stream stays stable and reusable.
    audioComponent.audioTrack = audioTrack
    return audioComponent
  }
}
