import test from "node:test";
import assert from "node:assert/strict";
import {ForegroundRecording} from "../lib/auto-dvi/staff/foreground-recording";

test("foreground capture persists before claiming stopped and releases tracks on interruption", async () => {
  const originals = Object.fromEntries(["document", "navigator", "MediaRecorder"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let visibility: (() => void) | undefined, stopped = 0;
  const track = {stop: () => {stopped++;}, onended: null};
  const document = {visibilityState: "visible", addEventListener: (_: string, fn: () => void) => {visibility = fn;},
    removeEventListener: () => {visibility = undefined;}};
  class Recorder {
    static instances: Recorder[] = [];
    static isTypeSupported() {return true;}
    state = "inactive";
    mimeType = "video/webm";
    ondataavailable?: (event: {data: Blob}) => void;
    onstop?: () => void;
    onerror?: () => void;
    constructor() {Recorder.instances.push(this);}
    start() {this.state = "recording";}
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({data: new Blob(["fixture media"])});
      this.onstop?.();
    }
  }
  Object.defineProperty(globalThis, "document", {value: document, configurable: true});
  Object.defineProperty(globalThis, "navigator", {value: {mediaDevices: {
    getUserMedia: async () => ({getTracks: () => [track]}),
  }}, configurable: true});
  Object.defineProperty(globalThis, "MediaRecorder", {value: Recorder, configurable: true});
  const states: string[] = [], segments: unknown[] = [];
  let resolve!: () => void;
  const persisted = new Promise<void>(r => {resolve = r;});
  const capture = new ForegroundRecording({
    state: state => states.push(state),
    persist: async segment => {segments.push(segment); await persisted;},
  });
  try {
    await capture.start("video");
    await assert.rejects(capture.start("video"), /already active/);
    document.visibilityState = "hidden"; visibility!();
    assert.equal(segments.length, 1);
    assert.equal(states.includes("interrupted"), true);
    assert.equal(states.at(-1), "saving-segment");
    assert.equal(states.includes("stopped"), false);
    resolve(); await new Promise(r => setTimeout(r, 0));
    assert.equal(states.at(-1), "stopped");
    assert.equal(stopped, 1);
    assert.equal(Recorder.instances.length, 1);
    assert.equal(visibility, undefined);
  } finally {
    capture.stop();
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
