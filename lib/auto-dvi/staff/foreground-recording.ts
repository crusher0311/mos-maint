export type ForegroundCaptureState = "recording" | "saving-segment" | "stopped" | "interrupted";
export interface ForegroundCaptureCallbacks {
  persist(segment: {sequence: number; blob: Blob; durationSeconds: number; mime: string}): Promise<void>;
  state(value: ForegroundCaptureState, message: string): void;
}
/** Independent short containers keep extraction bounded. Camera/microphone stay
 * acquired, but recorder restarts can leave brief gaps between segments. */
export class ForegroundRecording {
  private recorder: MediaRecorder | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopping = false;
  private sequence = 0;
  private stream: MediaStream | null = null;
  private opening = false;
  private visibility = () => {if (document.visibilityState !== "visible") this.stop(true);};
  constructor(private callbacks: ForegroundCaptureCallbacks) {}
  async start(kind: "video" | "audio", nextSequence = 0) {
    if (this.stream || this.opening) throw Error("Recording is already active");
    if (document.visibilityState !== "visible") throw Error("Keep the inspection screen open and the device unlocked");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw Error("Recording is unsupported; use photos and manual findings");
    if (!Number.isInteger(nextSequence) || nextSequence < 0 || nextSequence >= 30) throw Error("Recording segment limit reached");
    this.sequence = nextSequence; this.stopping = false;
    this.opening = true;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({audio: true,
        video: kind === "video" ? {facingMode: {ideal: "environment"}, width: {ideal: 640}, height: {ideal: 480}} : false});
    } finally {this.opening = false;}
    if (this.stopping || document.visibilityState !== "visible") {
      stream.getTracks().forEach(track => track.stop());
      throw Error("Recording interrupted before camera opened");
    }
    this.stream = stream;
    stream.getTracks().forEach(track => {track.onended = () => this.stop(true);});
    document.addEventListener("visibilitychange", this.visibility);
    try {this.segment(kind);}
    catch (error) {this.release(); throw error;}
  }
  private segment(kind: "video" | "audio") {
    if (!this.stream || this.stopping) return;
    const candidates = kind === "video" ? ["video/webm;codecs=vp8,opus", "video/mp4", "video/webm"] :
      ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];
    const mimeType = candidates.find(mime => MediaRecorder.isTypeSupported(mime));
    if (!mimeType) throw Error("No supported recording format; use manual inspection");
    const recorder = new MediaRecorder(this.stream, {mimeType, videoBitsPerSecond: 500_000, audioBitsPerSecond: 48_000});
    this.recorder = recorder;
    const parts: Blob[] = []; let bytes = 0, overflow = false;
    const started = performance.now(), sequence = this.sequence++;
    recorder.ondataavailable = event => {
      if (!event.data.size || overflow) return;
      bytes += event.data.size;
      if (bytes > 4 * 1024 * 1024) {overflow = true; this.stop(true); return;}
      parts.push(event.data);
    };
    recorder.onerror = () => this.stop(true);
    recorder.onstop = () => {
      if (this.timer) clearTimeout(this.timer);
      this.recorder = null;
      const durationSeconds = (performance.now() - started) / 1000;
      if (overflow || !parts.length || durationSeconds > 15) {
        this.callbacks.state("interrupted", "This segment could not be retained within recording limits. Earlier saved segments remain available.");
        this.stopping = true; this.release(); return;
      }
      this.callbacks.state("saving-segment", "Saving this segment on this device. It is not yet server-confirmed.");
      void this.callbacks.persist({sequence, blob: new Blob(parts, {type: recorder.mimeType}),
        durationSeconds, mime: recorder.mimeType.split(";")[0]}).then(() => {
        if (this.stopping || this.sequence >= 30) {
          this.release(); this.callbacks.state("stopped", "Capture stopped. Pending uploads still require confirmation."); return;
        }
        this.segment(kind);
      }).catch(() => {
        this.stopping = true; this.release();
        this.callbacks.state("interrupted", "Device storage failed. The last segment was not confirmed saved; earlier retained footage remains available.");
      });
    };
    recorder.start(500);
    this.callbacks.state("recording", "Keep this screen open and your device unlocked. Brief gaps may occur between saved segments.");
    this.timer = setTimeout(() => {if (recorder.state !== "inactive") recorder.stop();}, 10_000);
  }
  stop(interrupted = false) {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    if (interrupted) this.callbacks.state("interrupted", "Recording interrupted. Saving the available segment; the final moments may be unavailable.");
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    else this.release();
  }
  private release() {
    document.removeEventListener("visibilitychange", this.visibility);
    this.stream?.getTracks().forEach(track => {track.onended = null; track.stop();});
    this.stream = null;
  }
}
