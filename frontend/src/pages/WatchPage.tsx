import { useEffect, useRef } from "react";
import Hls from "hls.js";

function WatchPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsUrl = "http://localhost:3001/hls/stream.m3u8";

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch((e) => console.error("Autoplay was prevented:", e));
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Native HLS support (e.g., Safari)
      video.src = hlsUrl;
      video.addEventListener("loadedmetadata", () => {
        video.play().catch((e) => console.error("Autoplay was prevented:", e));
      });
    }
  }, []);

  return (
    <div style={{ padding: "20px" }}>
      <h1>Watching Live Stream</h1>
      <video
        ref={videoRef}
        controls
        style={{ width: "80%", maxWidth: "800px", backgroundColor: "black" }}
      />
    </div>
  );
}

export default WatchPage;
