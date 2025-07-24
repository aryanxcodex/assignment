import express from "express";
import http from "http";
import { Server } from "socket.io";
import * as mediasoup from "mediasoup";
import { types } from "mediasoup";
import { config, validateConfig } from "./config";
import fs from "fs";
import { startRtpToHlsConverter, stopHlsConverter } from "./rtp-to-hls";
import cors from "cors";

// Global state
let worker: mediasoup.types.Worker;
let router: mediasoup.types.Router;

// Maps to hold transports, producers, and consumers
const transports: Map<string, mediasoup.types.WebRtcTransport> = new Map();
const producers: Map<string, mediasoup.types.Producer> = new Map();
const consumers: Map<string, mediasoup.types.Consumer> = new Map();

// Global HLS state management
class HLSManager {
  private static instance: HLSManager;
  private isConverterRunning = false;
  private videoProducer: mediasoup.types.Producer | null = null;
  private audioProducer: mediasoup.types.Producer | null = null;
  private converterStartPromise: Promise<void> | null = null;
  private restartTimeout: NodeJS.Timeout | null = null;

  static getInstance(): HLSManager {
    if (!HLSManager.instance) {
      HLSManager.instance = new HLSManager();
    }
    return HLSManager.instance;
  }

  async setProducer(
    kind: "video" | "audio",
    producer: mediasoup.types.Producer
  ): Promise<void> {
    console.log(`HLS Manager: Setting ${kind} producer:`, producer.id);

    // Clear any pending restart
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }

    if (kind === "video") {
      // If we already have a video producer, close the old HLS first
      if (this.videoProducer && this.videoProducer.id !== producer.id) {
        await this.stopConverter();
      }
      this.videoProducer = producer;
    } else {
      // If we already have an audio producer, close the old HLS first
      if (this.audioProducer && this.audioProducer.id !== producer.id) {
        await this.stopConverter();
      }
      this.audioProducer = producer;
    }

    // Set up cleanup when producer is closed
    producer.on("transportclose", () => {
      console.log(`HLS Manager: Producer ${producer.id} transport closed`);
      if (kind === "video" && this.videoProducer?.id === producer.id) {
        this.videoProducer = null;
      } else if (kind === "audio" && this.audioProducer?.id === producer.id) {
        this.audioProducer = null;
      }

      // Stop converter if no producers left
      if (!this.videoProducer && !this.audioProducer) {
        this.stopConverter();
      }
    });

    // Debounce the start to avoid rapid restarts
    this.restartTimeout = setTimeout(() => {
      this.tryStartConverter();
    }, 500);
  }

  private async tryStartConverter(): Promise<void> {
    // Don't start if already running or if we don't have both producers
    if (this.isConverterRunning || !this.videoProducer || !this.audioProducer) {
      console.log(
        `HLS Manager: Not starting converter. Running: ${
          this.isConverterRunning
        }, Video: ${!!this.videoProducer}, Audio: ${!!this.audioProducer}`
      );
      return;
    }

    // Don't start if already starting
    if (this.converterStartPromise) {
      console.log("HLS Manager: Converter start already in progress");
      return this.converterStartPromise;
    }

    console.log("HLS Manager: Starting converter...");
    this.isConverterRunning = true;

    this.converterStartPromise = this.startConverterInternal();

    try {
      await this.converterStartPromise;
      console.log("HLS Manager: Converter started successfully");
    } catch (error) {
      console.error("HLS Manager: Failed to start converter:", error);
      this.isConverterRunning = false;
    } finally {
      this.converterStartPromise = null;
    }
  }

  private async startConverterInternal(): Promise<void> {
    if (!this.videoProducer || !this.audioProducer) {
      throw new Error("Missing video or audio producer");
    }

    console.log("HLS Manager: Video producer ID:", this.videoProducer.id);
    console.log("HLS Manager: Audio producer ID:", this.audioProducer.id);

    // Stop any existing converter first with longer wait
    await this.forceStopConverter();

    // Wait longer for ports to be released
    await new Promise((resolve) => setTimeout(resolve, 3000));

    await startRtpToHlsConverter(
      router,
      this.videoProducer,
      this.audioProducer
    );
  }

  private async forceStopConverter(): Promise<void> {
    console.log("HLS Manager: Force stopping converter");
    this.isConverterRunning = false;
    try {
      await stopHlsConverter();
    } catch (error) {
      console.error("HLS Manager: Error stopping converter:", error);
    }
  }

  async stopConverter(): Promise<void> {
    if (!this.isConverterRunning && !this.converterStartPromise) {
      return;
    }

    console.log("HLS Manager: Stopping converter");
    this.isConverterRunning = false;

    // Clear any pending restart
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }

    // Wait for any ongoing start to complete
    if (this.converterStartPromise) {
      try {
        await this.converterStartPromise;
      } catch (error) {
        // Ignore errors from interrupted starts
      }
      this.converterStartPromise = null;
    }

    try {
      await stopHlsConverter();
    } catch (error) {
      console.error("HLS Manager: Error stopping converter:", error);
    }
  }

  // Public method to force restart
  async restartConverter(): Promise<void> {
    console.log("HLS Manager: Restarting converter");
    await this.stopConverter();
    // Wait a bit longer before restart
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await this.tryStartConverter();
  }

  // Get current state
  getState() {
    return {
      isConverterRunning: this.isConverterRunning,
      hasVideoProducer: !!this.videoProducer,
      hasAudioProducer: !!this.audioProducer,
      videoProducerId: this.videoProducer?.id,
      audioProducerId: this.audioProducer?.id,
    };
  }

  // Reset everything
  async reset(): Promise<void> {
    console.log("HLS Manager: Resetting all state");
    this.videoProducer = null;
    this.audioProducer = null;
    await this.stopConverter();
  }
}

// Get the singleton instance
const hlsManager = HLSManager.getInstance();

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
  // Validate configuration first
  validateConfig();

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
  console.log(
    `RTC Ports: ${config.mediasoup.workerSettings.rtcMinPort}-${config.mediasoup.workerSettings.rtcMaxPort}`
  );
  console.log(
    `HLS Ports: Video=${config.hls.videoPort}, Audio=${config.hls.audioPort}`
  );
};

const createWebRtcTransport = async (callback: (data: any) => void) => {
  try {
    const transport = await router.createWebRtcTransport({
      listenIps: Array.from(config.mediasoup.webRtcTransport.listenIps),
      enableUdp: config.mediasoup.webRtcTransport.enableUdp,
      enableTcp: config.mediasoup.webRtcTransport.enableTcp,
      preferUdp: config.mediasoup.webRtcTransport.preferUdp,
      initialAvailableOutgoingBitrate:
        config.mediasoup.webRtcTransport.initialAvailableOutgoingBitrate,
      maxSctpMessageSize: config.mediasoup.webRtcTransport.maxSctpMessageSize,
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
    // Clean up any resources associated with this client
    // Note: We don't reset HLS here since it should continue for other viewers
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

      console.log(`Producer created: ${kind} - ${producer.id}`);

      // Use HLS Manager for video/audio producers
      if (kind === "video" || kind === "audio") {
        try {
          await hlsManager.setProducer(kind, producer);
        } catch (error) {
          console.error(`Failed to set ${kind} producer for HLS:`, error);
        }
      }

      // Inform other clients that a new producer is available
      socket.broadcast.emit("new-producer", { producerId: producer.id });

      producer.on("transportclose", () => {
        producers.delete(producer.id);
        console.log(`Producer ${producer.id} transport closed`);
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
      if (typeof callback === "function") {
        callback({ error: "Consumer not found" });
      }
      return;
    }
    await consumer.resume();
    if (typeof callback === "function") {
      callback({});
    }
  });
});

// Debug endpoints
app.get("/hls-status", (req, res) => {
  res.json(hlsManager.getState());
});

app.post("/hls-restart", async (req, res) => {
  try {
    await hlsManager.restartConverter();
    res.json({ success: true, message: "HLS converter restarted" });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

app.post("/hls-reset", async (req, res) => {
  try {
    await hlsManager.reset();
    res.json({ success: true, message: "HLS manager reset" });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// Kill any processes using HLS ports on startup
app.get("/kill-ports", (req, res) => {
  const { spawn } = require("child_process");

  const killPort = (port: number) => {
    return new Promise((resolve) => {
      const process = spawn("fuser", ["-k", `${port}/udp`]);
      process.on("close", () => resolve(null));
      process.on("error", () => resolve(null)); // Ignore errors
    });
  };

  Promise.all([
    killPort(5004),
    killPort(5006),
    killPort(5008),
    killPort(5010),
    killPort(5012),
    killPort(5014),
    killPort(5016),
    killPort(5018),
    killPort(5020),
    killPort(5022),
    killPort(5024),
  ]).then(() => {
    res.json({ success: true, message: "Port cleanup attempted" });
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
      console.log(`🔧 Debug endpoints:`);
      console.log(`   GET /hls-status - Check HLS status`);
      console.log(`   POST /hls-restart - Restart HLS converter`);
      console.log(`   POST /hls-reset - Reset HLS manager`);
      console.log(`   GET /kill-ports - Kill processes using HLS ports`);
    });

    // Graceful shutdown
    process.on("SIGINT", async () => {
      console.log("Shutting down gracefully...");
      await hlsManager.stopConverter();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      console.log("Shutting down gracefully...");
      await hlsManager.stopConverter();
      process.exit(0);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
})();
