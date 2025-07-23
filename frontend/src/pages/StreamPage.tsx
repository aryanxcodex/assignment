import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import * as mediasoupClient from "mediasoup-client";

const BACKEND_URL = "http://localhost:3001";

function StreamPage() {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  // CHANGED: State to manage multiple remote streams
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(
    new Map()
  );

  const socketRef = useRef<Socket | null>(null);
  const deviceRef = useRef<mediasoupClient.Device | null>(null);
  const sendTransportRef = useRef<mediasoupClient.types.Transport | null>(null);
  const recvTransportRef = useRef<mediasoupClient.types.Transport | null>(null);
  // NEW: State to hold producer IDs for cleanup
  const producerRef = useRef<{ video: string | null; audio: string | null }>({
    video: null,
    audio: null,
  });

  const [isConnected, setIsConnected] = useState(false);

  const handleConnect = async () => {
    const socket = io(BACKEND_URL);
    socketRef.current = socket;

    socket.on("connect", async () => {
      setIsConnected(true);
      console.log("Connected to server");

      const routerRtpCapabilities =
        await new Promise<mediasoupClient.types.RtpCapabilities>((resolve) => {
          socket.emit("getRouterRtpCapabilities", resolve);
        });
      const device = new mediasoupClient.Device();
      await device.load({ routerRtpCapabilities });
      deviceRef.current = device;
      console.log("Mediasoup device loaded");

      await createSendTransport();
      await createRecvTransport();

      socket.emit("get-producers", (producerIds: string[]) => {
        console.log("Existing producers:", producerIds);
        for (const id of producerIds) {
          consumeStream(id);
        }
      });

      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      const videoTrack = stream.getVideoTracks()[0];
      const audioTrack = stream.getAudioTracks()[0];
      await produceStream(videoTrack, audioTrack);

      socket.on("new-producer", ({ producerId }) => {
        consumeStream(producerId);
      });

      // NEW: Listen for consumers that have closed
      socket.on("consumer-closed", ({ consumerId }) => {
        // This is a simplified cleanup. A more robust solution would map consumerId to producerId.
        // For this app, we'll just log it. A full implementation would remove the corresponding video element.
        console.log("A remote stream has ended:", consumerId);
      });
    });
  };

  const createSendTransport = async () => {
    const params = await new Promise<any>((resolve) => {
      socketRef.current?.emit(
        "createWebRtcTransport",
        { isProducer: true },
        resolve
      );
    });
    sendTransportRef.current = deviceRef.current!.createSendTransport(params);

    sendTransportRef.current.on(
      "connect",
      ({ dtlsParameters }, callback, errback) => {
        socketRef.current?.emit(
          "connectTransport",
          { transportId: sendTransportRef.current!.id, dtlsParameters },
          () => callback()
        );
      }
    );

    sendTransportRef.current.on(
      "produce",
      async ({ kind, rtpParameters, appData }, callback, errback) => {
        socketRef.current?.emit(
          "produce",
          {
            transportId: sendTransportRef.current!.id,
            kind,
            rtpParameters,
            appData,
          },
          ({ id }: { id: string }) => {
            callback({ id });
          }
        );
      }
    );
  };

  const createRecvTransport = async () => {
    const params = await new Promise<any>((resolve) => {
      socketRef.current?.emit(
        "createWebRtcTransport",
        { isProducer: false },
        resolve
      );
    });
    recvTransportRef.current = deviceRef.current!.createRecvTransport(params);
    recvTransportRef.current.on(
      "connect",
      ({ dtlsParameters }, callback, errback) => {
        socketRef.current?.emit(
          "connectTransport",
          { transportId: recvTransportRef.current!.id, dtlsParameters },
          () => callback()
        );
      }
    );
  };

  const produceStream = async (
    videoTrack: MediaStreamTrack,
    audioTrack: MediaStreamTrack
  ) => {
    if (!sendTransportRef.current) return;
    const videoProducer = await sendTransportRef.current.produce({
      track: videoTrack,
    });
    const audioProducer = await sendTransportRef.current.produce({
      track: audioTrack,
    });
    producerRef.current = { video: videoProducer.id, audio: audioProducer.id };
  };

  const consumeStream = async (producerId: string) => {
    if (!deviceRef.current || !recvTransportRef.current) return;

    const { rtpCapabilities } = deviceRef.current;
    const data = await new Promise<any>((resolve) => {
      socketRef.current?.emit(
        "consume",
        {
          transportId: recvTransportRef.current!.id,
          producerId,
          rtpCapabilities,
        },
        resolve
      );
    });

    if (data.error) {
      console.error("Cannot consume", data.error);
      return;
    }

    const consumer = await recvTransportRef.current.consume(data);
    socketRef.current?.emit("resume", { consumerId: consumer.id });

    const stream = new MediaStream();
    stream.addTrack(consumer.track);

    // CHANGED: Update the state with the new stream
    setRemoteStreams((prev) => new Map(prev).set(producerId, stream));
  };

  // NEW: A component to render a single video stream
  const VideoStream = ({ stream }: { stream: MediaStream }) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    useEffect(() => {
      if (videoRef.current) videoRef.current.srcObject = stream;
    }, [stream]);
    return (
      <video
        ref={videoRef}
        autoPlay
        playsInline
        style={{ width: "400px", backgroundColor: "black", margin: "5px" }}
      />
    );
  };

  return (
    <div style={{ padding: "20px" }}>
      <h1>Stream Page</h1>
      <button onClick={handleConnect} disabled={isConnected}>
        {isConnected ? "Connected" : "Connect and Stream"}
      </button>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "20px",
          marginTop: "20px",
        }}
      >
        <div>
          <h2>Your Video</h2>
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            style={{ width: "400px", backgroundColor: "black" }}
          />
        </div>
        <div>
          <h2>Remote Videos</h2>
          {/* CHANGED: Render a video element for each remote stream */}
          {Array.from(remoteStreams.values()).map((stream, index) => (
            <VideoStream key={index} stream={stream} />
          ))}
        </div>
      </div>
    </div>
  );
}

export default StreamPage;
