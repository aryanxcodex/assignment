import { types } from "mediasoup";
import { spawn, ChildProcess } from "child_process";
import { config } from "./config";
import fs from "fs";

// Global state for HLS converter
let ffmpegProcess: ChildProcess | null = null;
let hlsTransports: {
  video: types.PlainTransport | null;
  audio: types.PlainTransport | null;
} = {
  video: null,
  audio: null,
};

let hlsConsumers: {
  video: types.Consumer | null;
  audio: types.Consumer | null;
} = {
  video: null,
  audio: null,
};

export const startRtpToHlsConverter = async (
  router: types.Router,
  videoProducer: types.Producer,
  audioProducer: types.Producer
) => {
  console.log("HLS: Starting RTP to HLS converter...");

  // Force cleanup everything first
  await stopHlsConverter();

  // Wait for ports to be fully released
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const hlsDir = "./public/hls";
  if (!fs.existsSync(hlsDir)) {
    fs.mkdirSync(hlsDir, { recursive: true });
  }

  // Clear existing HLS files
  try {
    const files = fs.readdirSync(hlsDir);
    files.forEach((file) => {
      if (
        file.endsWith(".ts") ||
        file.endsWith(".m3u8") ||
        file.endsWith(".sdp")
      ) {
        fs.unlinkSync(`${hlsDir}/${file}`);
      }
    });
    console.log("HLS: Cleared existing files");
  } catch (error) {
    console.log("HLS: No existing files to clear");
  }

  try {
    // Use a simple approach - let mediasoup assign ports automatically
    console.log("HLS: Creating video transport (auto port assignment)");
    const videoTransport = await router.createPlainTransport({
      listenIp: {
        ip: "127.0.0.1",
        announcedIp: undefined,
      },
      rtcpMux: false,
      comedia: true,
      // Don't specify port - let mediasoup choose
    });

    console.log("HLS: Creating audio transport (auto port assignment)");
    const audioTransport = await router.createPlainTransport({
      listenIp: {
        ip: "127.0.0.1",
        announcedIp: undefined,
      },
      rtcpMux: false,
      comedia: true,
      // Don't specify port - let mediasoup choose
    });

    hlsTransports.video = videoTransport;
    hlsTransports.audio = audioTransport;

    console.log("HLS: Video and Audio PlainTransports created");
    console.log(
      `Video transport: ${videoTransport.tuple.localIp}:${videoTransport.tuple.localPort}`
    );
    console.log(
      `Audio transport: ${audioTransport.tuple.localIp}:${audioTransport.tuple.localPort}`
    );

    // Create consumers
    const videoConsumer = await videoTransport.consume({
      producerId: videoProducer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: true,
    });

    const audioConsumer = await audioTransport.consume({
      producerId: audioProducer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: true,
    });

    hlsConsumers.video = videoConsumer;
    hlsConsumers.audio = audioConsumer;

    console.log("HLS: Video and Audio consumers created");
    console.log("Video consumer codec:", videoConsumer.rtpParameters.codecs[0]);
    console.log("Audio consumer codec:", audioConsumer.rtpParameters.codecs[0]);

    // Create SDP with actual payload types and ports
    const sdpString = createSdpString(
      videoTransport,
      audioTransport,
      videoConsumer,
      audioConsumer
    );

    const sdpPath = `${hlsDir}/stream.sdp`;
    fs.writeFileSync(sdpPath, sdpString);
    console.log("HLS: SDP file written:", sdpPath);
    console.log("SDP Content:\n", sdpString);

    // Start FFmpeg process
    ffmpegProcess = runFfmpeg();

    if (!ffmpegProcess) {
      throw new Error("Failed to start FFmpeg process");
    }

    // Wait for FFmpeg to start, then resume consumers
    setTimeout(async () => {
      try {
        if (hlsConsumers.video && hlsConsumers.audio) {
          await hlsConsumers.video.resume();
          await hlsConsumers.audio.resume();
          console.log("HLS: Resumed consumers");
        }
      } catch (error) {
        console.error("HLS: Error resuming consumers:", error);
      }
    }, 3000);
  } catch (error) {
    console.error("HLS: Error starting converter:", error);
    await stopHlsConverter(); // Cleanup on failure
    throw error;
  }
};

const createSdpString = (
  vTransport: types.PlainTransport,
  aTransport: types.PlainTransport,
  vConsumer: types.Consumer,
  aConsumer: types.Consumer
): string => {
  const videoTuple = vTransport.tuple;
  const audioTuple = aTransport.tuple;

  // Use the actual payload types from the consumer
  const videoCodec = vConsumer.rtpParameters.codecs[0];
  const audioCodec = aConsumer.rtpParameters.codecs[0];

  console.log(`HLS: Using video payload type: ${videoCodec.payloadType}`);
  console.log(`HLS: Using audio payload type: ${audioCodec.payloadType}`);

  const formatParams = (params: any) => {
    if (!params || Object.keys(params).length === 0) return "";
    return Object.keys(params)
      .map((key) => `${key}=${params[key]}`)
      .join(";");
  };

  // Build SDP with proper line endings and actual payload types
  const sdpLines = [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=Mediasoup Stream",
    "c=IN IP4 127.0.0.1",
    "t=0 0",
    `m=video ${videoTuple.localPort} RTP/AVP ${videoCodec.payloadType}`,
    `a=rtpmap:${videoCodec.payloadType} ${videoCodec.mimeType.split("/")[1]}/${
      videoCodec.clockRate
    }`,
  ];

  // Add video fmtp if parameters exist
  const videoParams = formatParams(videoCodec.parameters);
  if (videoParams) {
    sdpLines.push(`a=fmtp:${videoCodec.payloadType} ${videoParams}`);
  }

  sdpLines.push("a=sendonly");

  // Audio section
  sdpLines.push(
    `m=audio ${audioTuple.localPort} RTP/AVP ${audioCodec.payloadType}`
  );
  sdpLines.push(
    `a=rtpmap:${audioCodec.payloadType} ${audioCodec.mimeType.split("/")[1]}/${
      audioCodec.clockRate
    }/${audioCodec.channels || 2}`
  );

  // Add audio fmtp if parameters exist
  const audioParams = formatParams(audioCodec.parameters);
  if (audioParams) {
    sdpLines.push(`a=fmtp:${audioCodec.payloadType} ${audioParams}`);
  }

  sdpLines.push("a=sendonly");

  return sdpLines.join("\r\n") + "\r\n";
};

const runFfmpeg = (): ChildProcess | null => {
  const sdpFilePath = "./public/hls/stream.sdp";
  const hlsOutputPath = "./public/hls/stream.m3u8";

  const ffmpegArgs = [
    "-y", // Overwrite output files
    "-protocol_whitelist",
    "file,udp,rtp",
    "-fflags",
    "+genpts+igndts",
    "-analyzeduration",
    "1000000",
    "-probesize",
    "1000000",
    "-f",
    "sdp",
    "-i",
    sdpFilePath,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-profile:v",
    "baseline",
    "-level",
    "3.0",
    "-g",
    "60",
    "-keyint_min",
    "60",
    "-sc_threshold",
    "0",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-f",
    "hls",
    "-hls_time",
    "2",
    "-hls_list_size",
    "5",
    "-hls_flags",
    "delete_segments+round_durations+independent_segments",
    "-hls_segment_type",
    "mpegts",
    "-hls_segment_filename",
    "./public/hls/segment_%03d.ts",
    "-start_number",
    "0",
    "-loglevel",
    "warning", // Reduce noise
    hlsOutputPath,
  ];

  console.log(`HLS: Starting FFmpeg with args:`, ffmpegArgs.join(" "));

  const process = spawn("ffmpeg", ffmpegArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  process.stdout.on("data", (data: Buffer) => {
    const output = data.toString().trim();
    if (output) {
      console.log(`HLS-FFmpeg stdout: ${output}`);
    }
  });

  process.stderr.on("data", (data: Buffer) => {
    const output = data.toString().trim();
    if (output && !output.includes("Non-monotonous DTS")) {
      // Filter out common noise
      console.log(`HLS-FFmpeg stderr: ${output}`);
    }
  });

  process.on("close", (code: number) => {
    console.log(`HLS: FFmpeg process closed with code ${code}`);
    ffmpegProcess = null;
  });

  process.on("error", (error: Error) => {
    console.error(`HLS: FFmpeg process error:`, error);
    ffmpegProcess = null;
  });

  return process;
};

// Improved cleanup function
export const stopHlsConverter = async () => {
  if (ffmpegProcess) {
    ffmpegProcess.kill();
    ffmpegProcess = null;
  }

  if (hlsTransports.video) {
    await hlsTransports.video.close();
    hlsTransports.video = null;
  }

  if (hlsTransports.audio) {
    await hlsTransports.audio.close();
    hlsTransports.audio = null;
  }

  if (hlsConsumers.video) {
    await hlsConsumers.video.close();
    hlsConsumers.video = null;
  }

  if (hlsConsumers.audio) {
    await hlsConsumers.audio.close();
    hlsConsumers.audio = null;
  }

  console.log("HLS: Converter stopped and resources cleaned up");
};
