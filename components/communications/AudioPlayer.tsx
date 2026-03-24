"use client";

import { useState, useRef, useEffect } from "react";
import { Play, Pause, Volume2, VolumeX } from "lucide-react";

interface AudioPlayerProps {
  src: string;
  duration?: number;
  compact?: boolean;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function AudioPlayer({ src, duration: initialDuration, compact = false }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(initialDuration || 0);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onLoadedMetadata = () => {
      if (audio.duration && isFinite(audio.duration)) {
        setDuration(audio.duration);
      }
    };
    const onEnded = () => setPlaying(false);

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("ended", onEnded);

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("ended", onEnded);
    };
  }, []);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
    } else {
      audio.play();
    }
    setPlaying(!playing);
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    audio.currentTime = percent * duration;
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className={`flex items-center gap-2 ${compact ? "gap-1.5" : "gap-3"}`}>
      <audio ref={audioRef} src={src} muted={muted} preload="metadata" />
      <button
        onClick={togglePlay}
        className={`flex-shrink-0 flex items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-700 transition-colors ${
          compact ? "w-7 h-7" : "w-9 h-9"
        }`}
      >
        {playing ? (
          <Pause className={compact ? "w-3 h-3" : "w-4 h-4"} />
        ) : (
          <Play className={`${compact ? "w-3 h-3" : "w-4 h-4"} ml-0.5`} />
        )}
      </button>
      <div className="flex-1 min-w-0">
        <div
          className={`w-full bg-gray-200 rounded-full cursor-pointer ${compact ? "h-1" : "h-1.5"}`}
          onClick={seek}
        >
          <div
            className="bg-blue-600 rounded-full h-full transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
      <span className={`text-gray-500 flex-shrink-0 font-mono ${compact ? "text-[10px]" : "text-xs"}`}>
        {formatTime(currentTime)} / {formatTime(duration)}
      </span>
      {!compact && (
        <button
          onClick={() => setMuted(!muted)}
          className="flex-shrink-0 p-1 text-gray-400 hover:text-gray-600 transition-colors"
        >
          {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
        </button>
      )}
    </div>
  );
}
