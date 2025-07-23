// src/index.ts

import express from "express";
import http from "http";
import { Server } from "socket.io";
import * as mediasoup from "mediasoup";
import { types } from "mediasoup";
import { config } from "./config";
import fs from "fs"; // Import fs
import { startRtpToHlsConverter } from "./rtp-to-hls";
import cors from "cors";

// Global state
// This is a simplified approach for a single-room application.
// For a multi-room app, you'd manage workers and routers more dynamically.
let worker: mediasoup.types.Worker;
let router: mediasoup.types.Router;
let producerTransport: mediasoup.types.WebRtcTransport;
let consumerTransport: mediasoup.types.WebRtcTransport;
let producer: mediasoup.types.Producer;
let consumer: mediasoup.types.Consumer;
let hlsProducers = {
  video: null as types.Producer | null,
  audio: null as types.Producer | null,
};
let isHlsConverterStarted = false;

// Maps to hold transports, producers, and consumers
const transports: Map<string, mediasoup.types.WebRtcTransport> = new Map();
const producers: Map<string, mediasoup.types.Producer> = new Map();
const consumers: Map<string, mediasoup.types.Consumer> = new Map();

const app = express();
app.use(cors());
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*", // Be more specific in production!
  },
});

app.use(express.json());
app.use(express.static("public")); // For serving HLS files later

const startMediasoup = async () => {
  worker = await mediasoup.createWorker({
    logLevel: config.mediasoup.workerSettings.logLevel,
    logTags: Array.from(config.mediasoup.workerSettings.logTags),
    rtcMinPort: config.mediasoup.workerSettings.rtcMinPort,
    rtcMaxPort: config.mediasoup.workerSettings.rtcMaxPort,
  });

  worker.on("died", () => {
    console.error("mediasoup worker died, exiting in 2 seconds...");
    setTimeout(() => process.exit(1), 2000);
  });

  router = await worker.createRouter({
    mediaCodecs: config.mediasoup.router.mediaCodecs,
  });

  console.log("Mediasoup worker and router started");
};

const createWebRtcTransport = async (callback: (data: any) => void) => {
  try {
    const transport = await router.createWebRtcTransport({
      listenIps: Array.from(config.mediasoup.webRtcTransport.listenIps),
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    });

    transport.on("dtlsstatechange", (dtlsState) => {
      if (dtlsState === "closed") {
        transport.close();
        transports.delete(transport.id);
      }
    });

    transports.set(transport.id, transport);

    callback({
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    });
  } catch (error) {
    console.error("Failed to create WebRTC transport:", error);
    callback({ error: (error as Error).message });
  }
};

io.on("connection", (socket) => {
  console.log("A client connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    // Here you would clean up any resources associated with this client
  });

  // Get Router RTP Capabilities
  socket.on("getRouterRtpCapabilities", (callback) => {
    callback(router.rtpCapabilities);
  });

  // Create a new WebRTC Transport
  socket.on("createWebRtcTransport", async ({ isProducer }, callback) => {
    await createWebRtcTransport(callback);
  });

  // Connect a transport
  socket.on(
    "connectTransport",
    async ({ transportId, dtlsParameters }, callback) => {
      const transport = transports.get(transportId);
      if (!transport) {
        console.error(`Transport with id ${transportId} not found`);
        return callback({ error: "Transport not found" });
      }
      await transport.connect({ dtlsParameters });
      callback({});
    }
  );

  socket.on("get-producers", (callback) => {
    // Return the producer IDs of all existing producers
    const producerIds = Array.from(producers.keys());
    callback(producerIds);
  });

  // Produce a new stream
  socket.on(
    "produce",
    async ({ transportId, kind, rtpParameters, appData }, callback) => {
      const transport = transports.get(transportId);
      if (!transport) {
        console.error(`Transport with id ${transportId} not found`);
        return callback({ error: "Transport not found" });
      }
      const producer = await transport.produce({
        kind,
        rtpParameters,
        appData,
      });

      producers.set(producer.id, producer);
      if (kind === "video" && !hlsProducers.video) {
        hlsProducers.video = producer;
      }
      if (kind === "audio" && !hlsProducers.audio) {
        hlsProducers.audio = producer;
      }
      if (hlsProducers.video && hlsProducers.audio && !isHlsConverterStarted) {
        console.log(">>> Starting HLS Converter...");
        isHlsConverterStarted = true;
        startRtpToHlsConverter(router, hlsProducers.video, hlsProducers.audio);
      }

      // Inform other clients that a new producer is available
      socket.broadcast.emit("new-producer", { producerId: producer.id });

      producer.on("transportclose", () => {
        producers.delete(producer.id);
      });

      callback({ id: producer.id });
    }
  );

  // Consume a stream
  socket.on(
    "consume",
    async ({ transportId, producerId, rtpCapabilities }, callback) => {
      const transport = transports.get(transportId);
      if (
        !transport ||
        !producers.has(producerId) ||
        !router.canConsume({ producerId, rtpCapabilities })
      ) {
        const errorMsg = `Cannot consume. Transport: ${!!transport}, Producer: ${producers.has(
          producerId
        )}, CanConsume: ${router.canConsume({ producerId, rtpCapabilities })}`;
        console.error(errorMsg);
        return callback({ error: "Cannot consume" });
      }

      try {
        const consumer = await transport.consume({
          producerId,
          rtpCapabilities,
          paused: true, // Start paused
        });
        consumers.set(consumer.id, consumer);

        consumer.on("transportclose", () => {
          consumers.delete(consumer.id);
        });

        consumer.on("producerclose", () => {
          consumers.delete(consumer.id);
          // Optionally, inform the client that this consumer's producer has closed
          socket.emit("consumer-closed", { consumerId: consumer.id });
        });

        callback({
          id: consumer.id,
          producerId: consumer.producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
      } catch (error) {
        console.error("Consume failed:", error);
        callback({ error: (error as Error).message });
      }
    }
  );

  // Resume a consumer
  socket.on("resume", async ({ consumerId }, callback) => {
    const consumer = consumers.get(consumerId);
    if (!consumer) {
      console.error(`Consumer with id ${consumerId} not found`);
      // Check if callback is a function before calling it
      if (typeof callback === "function") {
        callback({ error: "Consumer not found" });
      }
      return;
    }
    await consumer.resume();
    // Also check here
    if (typeof callback === "function") {
      callback({});
    }
  });
});

// --- Start the server ---
(async () => {
  try {
    // Create public/hls directory if it doesn't exist
    if (!fs.existsSync("./public/hls")) {
      fs.mkdirSync("./public/hls", { recursive: true });
    }
    await startMediasoup();
    httpServer.listen(config.server.port, config.server.listenIp, () => {
      console.log(
        `🚀 Server is listening on http://${config.server.listenIp}:${config.server.port}`
      );
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
})();
