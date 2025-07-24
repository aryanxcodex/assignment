import { types } from "mediasoup";
import os from "os";

export const config = {
  // Server configuration
  server: {
    port: 3001,
    listenIp: "0.0.0.0", // Server can listen on all interfaces
  },

  // Mediasoup configuration
  mediasoup: {
    // Number of mediasoup workers to launch
    numWorkers: Object.keys(os.cpus()).length,

    workerSettings: {
      logLevel: "warn" as types.WorkerLogLevel,
      logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"],
      rtcMinPort: 10000,
      rtcMaxPort: 10200, // Increased range for multiple connections
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
        // Add H.264 support for better HLS compatibility
        {
          kind: "video",
          mimeType: "video/H264",
          clockRate: 90000,
          parameters: {
            "packetization-mode": 1,
            "profile-level-id": "4d0032",
            "level-asymmetry-allowed": 1,
          },
        },
      ] as types.RtpCodecCapability[],
    },

    // WebRTC transport settings
    webRtcTransport: {
      listenIps: [
        {
          // For local development, use localhost
          ip: "127.0.0.1",
          announcedIp: undefined,
        },
        // Uncomment below for deployment with public IP
        // {
        //   ip: "0.0.0.0",
        //   announcedIp: process.env.WEBRTC_ANNOUNCED_IP || "YOUR_PUBLIC_IP",
        // },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1000000,
      minimumAvailableOutgoingBitrate: 600000,
      maxSctpMessageSize: 262144,
      maxIncomingBitrate: 1500000,
    },
  },

  // HLS configuration
  hls: {
    // Use localhost for local development
    listenIp: "127.0.0.1",
    // Use different ports for video and audio RTP streams
    videoPort: 5004,
    audioPort: 5006,
    // HLS segment configuration
    segmentDuration: 2, // seconds
    playlistSize: 5, // number of segments to keep
  },
} as const;

// Helper function to get the correct announced IP for deployment
export const getAnnouncedIp = (): string | undefined => {
  // For local development
  if (process.env.NODE_ENV !== "production") {
    return undefined;
  }

  // For production, you should set this environment variable
  return process.env.WEBRTC_ANNOUNCED_IP;
};

// Validate configuration
export const validateConfig = () => {
  const errors: string[] = [];

  if (
    config.mediasoup.workerSettings.rtcMinPort >=
    config.mediasoup.workerSettings.rtcMaxPort
  ) {
    errors.push("RTC min port must be less than max port");
  }

  if ((config.hls.videoPort as number) === (config.hls.audioPort as number)) {
    errors.push("Video and audio ports must be different");
  }

  if (config.hls.segmentDuration < 1 || config.hls.segmentDuration > 10) {
    errors.push("HLS segment duration should be between 1-10 seconds");
  }

  if (errors.length > 0) {
    throw new Error(`Configuration errors: ${errors.join(", ")}`);
  }

  console.log("✅ Configuration validated successfully");
};
