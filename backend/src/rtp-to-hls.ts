import { types } from "mediasoup";
import { spawn } from "child_process";
import { config } from "./config";
import fs from "fs";

export const startRtpToHlsConverter = async (
  router: types.Router,
  videoProducer: types.Producer,
  audioProducer: types.Producer
) => {
  const hlsDir = "./public/hls";
  if (!fs.existsSync(hlsDir)) {
    fs.mkdirSync(hlsDir, { recursive: true });
  }

  // --- CHANGED: Enabled rtcpMux ---
  const videoTransport = await router.createPlainTransport({
    listenIp: config.hls.listenIp,
    rtcpMux: true, // Use the same port for RTP and RTCP
    comedia: false,
    port: config.hls.videoPort,
  });

  // --- CHANGED: Enabled rtcpMux ---
  const audioTransport = await router.createPlainTransport({
    listenIp: config.hls.listenIp,
    rtcpMux: true, // Use the same port for RTP and RTCP
    comedia: false,
    port: config.hls.audioPort,
  });

  console.log("HLS: Video and Audio PlainTransports created with RTCP Mux");

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

  console.log("HLS: Video and Audio consumers created");

  const sdpString = createSdpString(
    videoTransport,
    audioTransport,
    videoConsumer,
    audioConsumer
  );
  fs.writeFileSync(`${hlsDir}/stream.sdp`, sdpString);

  runFfmpeg();

  setTimeout(async () => {
    await videoConsumer.resume();
    await audioConsumer.resume();
    console.log("HLS: Resumed consumers");
  }, 1000);
};

// --- CHANGED: Removed the a=rtcp line ---
const createSdpString = (
  vTransport: types.PlainTransport,
  aTransport: types.PlainTransport,
  vConsumer: types.Consumer,
  aConsumer: types.Consumer
): string => {
  const { ip: transportIp, port: videoPort } = vTransport.tuple! as any;
  const { port: audioPort } = aTransport.tuple! as any;

  const videoCodec = vConsumer.rtpParameters.codecs[0];
  const audioCodec = aConsumer.rtpParameters.codecs[0];

  const formatParams = (params: any) =>
    Object.keys(params)
      .map((key) => `${key}=${params[key]}`)
      .join(";");

  return `
v=0
o=- 0 0 IN IP4 127.0.0.1
s=Mediasoup Stream
c=IN IP4 127.0.0.1
t=0 0
m=video ${videoPort} RTP/AVP ${videoCodec.payloadType}
a=rtpmap:${videoCodec.payloadType} ${videoCodec.mimeType.split("/")[1]}/${
    videoCodec.clockRate
  }
a=fmtp:${videoCodec.payloadType} ${formatParams(videoCodec.parameters)}
a=sendonly
m=audio ${audioPort} RTP/AVP ${audioCodec.payloadType}
a=rtpmap:${audioCodec.payloadType} ${audioCodec.mimeType.split("/")[1]}/${
    audioCodec.clockRate
  }/${audioCodec.channels}
a=fmtp:${audioCodec.payloadType} ${formatParams(audioCodec.parameters)}
a=sendonly
  `;
};

const runFfmpeg = () => {
  const sdpFilePath = "./public/hls/stream.sdp";
  const hlsOutputPath = "./public/hls/stream.m3u8";

  const options = [
    "-protocol_whitelist",
    "file,udp,rtp",
    // ADD THESE FLAGS to solve the race condition
    "-analyzeduration",
    "5000000", // Analyze for 5 seconds
    "-probesize",
    "10000000", // Buffer 10MB for analysis
    "-re",
    "-i",
    sdpFilePath,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-tune",
    "zerolatency",
    "-c:a",
    "aac",
    "-hls_time",
    "2",
    "-hls_list_size",
    "5",
    "-hls_flags",
    "delete_segments",
    hlsOutputPath,
  ].join(" ");

  console.log(`HLS: Spawning FFmpeg with command: ffmpeg ${options}`);

  const ffmpegProcess = spawn("ffmpeg", options.split(" "));

  ffmpegProcess.stderr.on("data", (data: Buffer) => {
    // We can keep this off unless we need to debug again
    console.log(`HLS-FFmpeg: ${data.toString()}`);
  });

  ffmpegProcess.on("close", (code: number) => {
    console.log(`HLS: FFmpeg process closed with code ${code}`);
  });
};
