import { types } from "mediasoup";
import os from "os";

export const config = {
  // Server configuration
  server: {
    port: 3001,
    // Use an environment variable or a default for the listen IP
    listenIp: "0.0.0.0",
  },
  // Mediasoup configuration
  mediasoup: {
    // Number of mediasoup workers to launch
    numWorkers: Object.keys(os.cpus()).length,
    workerSettings: {
      logLevel: "warn" as types.WorkerLogLevel,
      logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"],
      rtcMinPort: 10000,
      rtcMaxPort: 10100,
    },
    // Router settings
    router: {
      mediaCodecs: [
        {
          kind: "audio",
          mimeType: "audio/opus",
          clockRate: 48000,
          channels: 2,
        },
        {
          kind: "video",
          mimeType: "video/VP8",
          clockRate: 90000,
          parameters: {
            "x-google-start-bitrate": 1000,
          },
        },
      ] as types.RtpCodecCapability[],
    },
    // WebRTC transport settings
    webRtcTransport: {
      listenIps: [
        {
          ip: process.env.WEBRTC_LISTEN_IP || "127.0.0.1",
          announcedIp: process.env.WEBRTC_ANNOUNCED_IP || undefined,
        },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    },
  },

  hls: {
    listenIp: "0.0.0.0",
    // We'll use different ports for the raw RTP streams
    videoPort: 5004,
    audioPort: 5006,
  },
} as const;
