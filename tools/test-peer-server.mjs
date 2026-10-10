import { PeerServer } from "peer";
// Test signaling stays on loopback; gameplay still uses real WebRTC data channels.
PeerServer({ host: "127.0.0.1", port: 9001, path: "/" });
