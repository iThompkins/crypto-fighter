import React, { useEffect, useMemo, useRef, useState } from "react";
import Peer from "peerjs";

type PlayerSlot = 1 | 2;

type Fighter = {
  x: number;
  y: number;
  w: number;
  h: number;
  hp: number;
  facing: 1 | -1;
  attackCooldown: number;
  attackActive: number;
};

type GameState = {
  frame: number;
  timerFramesLeft: number;
  p1: Fighter;
  p2: Fighter;
  winner: "P1" | "P2" | "TIE_BOTH_LOSE" | null;
  roundOver: boolean;
};

type SignedInputPacket = {
  matchId: string;
  frame: number;
  player: PlayerSlot;
  inputMask: number;
  prevSelfHash: string;
  prevOppHash: string;
  publicKey: string;
  signature: string;
  hash: string;
};

type CanonicalFrame = {
  matchId: string;
  frame: number;
  p1InputMask: number;
  p2InputMask: number;
  prevFrameHash: string;
  frameHash: string;
};

type SessionWallet = {
  address: string;
  publicKey: string;
  privateKey: CryptoKey;
};

type NetEnvelope =
  | {
      type: "HELLO";
      matchId: string;
      fromSlot: PlayerSlot;
      walletAddress: string;
      publicKey: string;
    }
  | {
      type: "INPUT_PACKET";
      packet: SignedInputPacket;
    }
  | {
      type: "START_MATCH";
      matchId: string;
    }
  | {
      type: "RESET_MATCH";
      matchId: string;
    };

const WIDTH = 720;
const HEIGHT = 360;
const FLOOR_Y = 260;
const FPS = 30;
const ROUND_SECONDS = 10;
const ROUND_FRAMES = FPS * ROUND_SECONDS;

const FIGHTER_W = 28;
const FIGHTER_H = 56;
const MOVE_SPEED = 5;

const ATTACK_ACTIVE_FRAMES = 4;
const ATTACK_COOLDOWN_FRAMES = 10;
const ATTACK_W = 18;
const ATTACK_H = 14;
const ATTACK_REACH = 22;
const DAMAGE = 1;
const MAX_HP = 7;

const INPUT = {
  LEFT: 1,
  RIGHT: 2,
  ATTACK: 4,
} as const;

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    out[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }
  return out;
}

async function sha256Hex(input: string) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return "0x" + bytesToHex(new Uint8Array(digest));
}

async function exportSpkiHex(publicKey: CryptoKey) {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  return "0x" + bytesToHex(new Uint8Array(spki));
}

async function deriveAddressFromPublicKey(publicKey: CryptoKey) {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  const digest = await crypto.subtle.digest("SHA-256", spki);
  const hex = bytesToHex(new Uint8Array(digest));
  return "0x" + hex.slice(-40);
}

async function createSessionWallet(): Promise<SessionWallet> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true,
    ["sign", "verify"]
  );

  const publicKey = await exportSpkiHex(pair.publicKey);
  const address = await deriveAddressFromPublicKey(pair.publicKey);

  return {
    address,
    publicKey,
    privateKey: pair.privateKey,
  };
}

function encodeInputMask(input: {
  left: boolean;
  right: boolean;
  attack: boolean;
}) {
  let mask = 0;
  if (input.left) mask |= INPUT.LEFT;
  if (input.right) mask |= INPUT.RIGHT;
  if (input.attack) mask |= INPUT.ATTACK;
  return mask;
}

function decodeInputMask(mask: number) {
  return {
    left: !!(mask & INPUT.LEFT),
    right: !!(mask & INPUT.RIGHT),
    attack: !!(mask & INPUT.ATTACK),
  };
}

function canonicalInputPayload(
  matchId: string,
  frame: number,
  player: PlayerSlot,
  inputMask: number,
  prevSelfHash: string,
  prevOppHash: string
) {
  return JSON.stringify({
    matchId,
    frame,
    player,
    inputMask,
    prevSelfHash,
    prevOppHash,
  });
}

async function signPayload(privateKey: CryptoKey, payload: string) {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(payload)
  );
  return "0x" + bytesToHex(new Uint8Array(signature));
}

async function importVerifyKeyFromSpkiHex(spkiHex: string) {
  return crypto.subtle.importKey(
    "spki",
    hexToBytes(spkiHex),
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"]
  );
}

async function verifyPacket(packet: SignedInputPacket) {
  const key = await importVerifyKeyFromSpkiHex(packet.publicKey);
  const payload = canonicalInputPayload(
    packet.matchId,
    packet.frame,
    packet.player,
    packet.inputMask,
    packet.prevSelfHash,
    packet.prevOppHash
  );

  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    hexToBytes(packet.signature),
    new TextEncoder().encode(payload)
  );
}

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
) {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

function getAttackRect(f: Fighter) {
  if (f.attackActive <= 0) return null;

  const midY = f.y + Math.floor(f.h / 2) - Math.floor(ATTACK_H / 2);

  if (f.facing === 1) {
    return {
      x: f.x + f.w,
      y: midY,
      w: ATTACK_W + ATTACK_REACH,
      h: ATTACK_H,
    };
  }

  return {
    x: f.x - (ATTACK_W + ATTACK_REACH),
    y: midY,
    w: ATTACK_W + ATTACK_REACH,
    h: ATTACK_H,
  };
}

function initialState(): GameState {
  return {
    frame: 0,
    timerFramesLeft: ROUND_FRAMES,
    roundOver: false,
    winner: null,
    p1: {
      x: 120,
      y: FLOOR_Y - FIGHTER_H,
      w: FIGHTER_W,
      h: FIGHTER_H,
      hp: MAX_HP,
      facing: 1,
      attackCooldown: 0,
      attackActive: 0,
    },
    p2: {
      x: WIDTH - 120 - FIGHTER_W,
      y: FLOOR_Y - FIGHTER_H,
      w: FIGHTER_W,
      h: FIGHTER_H,
      hp: MAX_HP,
      facing: -1,
      attackCooldown: 0,
      attackActive: 0,
    },
  };
}

function transition(prev: GameState, p1Mask: number, p2Mask: number): GameState {
  if (prev.roundOver) return prev;

  const s: GameState = JSON.parse(JSON.stringify(prev));
  s.frame += 1;
  s.timerFramesLeft = Math.max(0, s.timerFramesLeft - 1);

  const p1Input = decodeInputMask(p1Mask);
  const p2Input = decodeInputMask(p2Mask);

  s.p1.facing = s.p1.x <= s.p2.x ? 1 : -1;
  s.p2.facing = s.p2.x >= s.p1.x ? -1 : 1;

  if (s.p1.attackCooldown > 0) s.p1.attackCooldown -= 1;
  if (s.p2.attackCooldown > 0) s.p2.attackCooldown -= 1;
  if (s.p1.attackActive > 0) s.p1.attackActive -= 1;
  if (s.p2.attackActive > 0) s.p2.attackActive -= 1;

  const p1Move = (p1Input.left ? -MOVE_SPEED : 0) + (p1Input.right ? MOVE_SPEED : 0);
  const p2Move = (p2Input.left ? -MOVE_SPEED : 0) + (p2Input.right ? MOVE_SPEED : 0);

  s.p1.x = clamp(s.p1.x + p1Move, 0, WIDTH - s.p1.w);
  s.p2.x = clamp(s.p2.x + p2Move, 0, WIDTH - s.p2.w);

  s.p1.facing = s.p1.x <= s.p2.x ? 1 : -1;
  s.p2.facing = s.p2.x >= s.p1.x ? -1 : 1;

  if (p1Input.attack && s.p1.attackCooldown === 0 && s.p1.attackActive === 0) {
    s.p1.attackActive = ATTACK_ACTIVE_FRAMES;
    s.p1.attackCooldown = ATTACK_COOLDOWN_FRAMES;
  }

  if (p2Input.attack && s.p2.attackCooldown === 0 && s.p2.attackActive === 0) {
    s.p2.attackActive = ATTACK_ACTIVE_FRAMES;
    s.p2.attackCooldown = ATTACK_COOLDOWN_FRAMES;
  }

  const p1Attack = getAttackRect(s.p1);
  const p2Attack = getAttackRect(s.p2);

  const p1Body = { x: s.p1.x, y: s.p1.y, w: s.p1.w, h: s.p1.h };
  const p2Body = { x: s.p2.x, y: s.p2.y, w: s.p2.w, h: s.p2.h };

  const p1Hits = !!p1Attack && rectsOverlap(p1Attack, p2Body);
  const p2Hits = !!p2Attack && rectsOverlap(p2Attack, p1Body);

  if (p1Hits) s.p2.hp = Math.max(0, s.p2.hp - DAMAGE);
  if (p2Hits) s.p1.hp = Math.max(0, s.p1.hp - DAMAGE);

  if (s.p1.hp === 0 && s.p2.hp === 0) {
    s.roundOver = true;
    s.winner = "TIE_BOTH_LOSE";
  } else if (s.p1.hp === 0) {
    s.roundOver = true;
    s.winner = "P2";
  } else if (s.p2.hp === 0) {
    s.roundOver = true;
    s.winner = "P1";
  } else if (s.timerFramesLeft === 0) {
    s.roundOver = true;
    if (s.p1.hp > s.p2.hp) s.winner = "P1";
    else if (s.p2.hp > s.p1.hp) s.winner = "P2";
    else s.winner = "TIE_BOTH_LOSE";
  }

  return s;
}

function short(s: string, n = 18) {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n) + "...";
}

export default function App() {
  const [state, setState] = useState<GameState>(initialState());
  const [matchId, setMatchId] = useState(`match-${Math.random().toString(36).slice(2, 10)}`);
  const [wallet, setWallet] = useState<SessionWallet | null>(null);

  const [role, setRole] = useState<"unassigned" | "host" | "joiner">("unassigned");
  const [localSlot, setLocalSlot] = useState<PlayerSlot>(1);

  const [peerId, setPeerId] = useState("");
  const [remotePeerId, setRemotePeerId] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const [isRunning, setIsRunning] = useState(false);

  const [remoteWalletAddress, setRemoteWalletAddress] = useState("");
  const [remoteWalletPubKey, setRemoteWalletPubKey] = useState("");

  const [packets, setPackets] = useState<SignedInputPacket[]>([]);
  const [canonicalFrames, setCanonicalFrames] = useState<CanonicalFrame[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [lastError, setLastError] = useState("");
  const [finalStateHash, setFinalStateHash] = useState("");
  const [finalFrameHash, setFinalFrameHash] = useState("0x00");

  const peerRef = useRef<any>(null);
  const connRef = useRef<any>(null);
  const intervalRef = useRef<number | null>(null);
  const keyState = useRef<Record<string, boolean>>({});
  const pendingInputsRef = useRef<Record<number, Partial<Record<PlayerSlot, SignedInputPacket>>>>({});
  const latestPrevSelf = useRef<{ 1: string; 2: string }>({ 1: "0x00", 2: "0x00" });
  const latestSeenOpp = useRef<{ 1: string; 2: string }>({ 1: "0x00", 2: "0x00" });
  const frameHeadRef = useRef("0x00");
  const sentFramesRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    let mounted = true;
    (async () => {
      const w = await createSessionWallet();
      if (mounted) setWallet(w);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      keyState.current[e.key.toLowerCase()] = true;
    };
    const up = (e: KeyboardEvent) => {
      keyState.current[e.key.toLowerCase()] = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (intervalRef.current) window.clearInterval(intervalRef.current);
      connRef.current?.close?.();
      peerRef.current?.destroy?.();
    };
  }, []);

  useEffect(() => {
    if (!isConnected || !isRunning || state.roundOver) {
      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    intervalRef.current = window.setInterval(() => {
      void tick();
    }, 1000 / FPS);

    return () => {
      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isConnected, isRunning, state.roundOver, state.frame, localSlot, wallet]);

  useEffect(() => {
    if (state.roundOver) {
      setIsRunning(false);
      void finalizeHashes();
    }
  }, [state.roundOver]);

  function log(line: string) {
    setLogs((prev) => [line, ...prev].slice(0, 100));
  }

  async function initPeer(as: "host" | "joiner") {
    try {
      setLastError("");
      peerRef.current?.destroy?.();
      connRef.current?.close?.();

      const peer = new Peer();
      peerRef.current = peer;
      setRole(as);
      setLocalSlot(as === "host" ? 1 : 2);

      peer.on("open", (id: string) => {
        setPeerId(id);
        log(`peer open: ${id}`);
      });

      peer.on("connection", (conn: any) => {
        if (as !== "host") return;
        connRef.current = conn;
        bindConnection(conn, 1);
      });

      peer.on("error", (err: any) => {
        setLastError(String(err));
        log(`peer error: ${String(err)}`);
      });
    } catch (e) {
      setLastError(String(e));
    }
  }

  function bindConnection(conn: any, slotForLocal: PlayerSlot) {
    conn.on("open", () => {
      setIsConnected(true);
      log(`connection open to ${conn.peer}`);

      if (wallet) {
        const hello: NetEnvelope = {
          type: "HELLO",
          matchId,
          fromSlot: slotForLocal,
          walletAddress: wallet.address,
          publicKey: wallet.publicKey,
        };
        conn.send(hello);
      }
    });

    conn.on("data", (raw: NetEnvelope) => {
      void handleNetMessage(raw);
    });

    conn.on("close", () => {
      setIsConnected(false);
      log("connection closed");
    });

    conn.on("error", (err: any) => {
      setLastError(String(err));
      log(`connection error: ${String(err)}`);
    });
  }

  async function connectToHost() {
    try {
      if (!peerRef.current) {
        setLastError("Initialize as joiner first.");
        return;
      }
      const conn = peerRef.current.connect(remotePeerId.trim());
      connRef.current = conn;
      bindConnection(conn, 2);
    } catch (e) {
      setLastError(String(e));
    }
  }

  async function handleNetMessage(msg: NetEnvelope) {
    if (msg.type === "HELLO") {
      setRemoteWalletAddress(msg.walletAddress);
      setRemoteWalletPubKey(msg.publicKey);
      log(`HELLO from P${msg.fromSlot} ${short(msg.walletAddress, 14)}`);
      return;
    }

    if (msg.type === "START_MATCH") {
      log("remote started match");
      setIsRunning(true);
      return;
    }

    if (msg.type === "RESET_MATCH") {
      log("remote requested reset");
      await resetLocal(false);
      setMatchId(msg.matchId);
      return;
    }

    if (msg.type === "INPUT_PACKET") {
      const ok = await verifyPacket(msg.packet);
      if (!ok) {
        log(`frame ${msg.packet.frame}: remote signature verification failed`);
        return;
      }
      log(`frame ${msg.packet.frame}: verified remote packet`);
      await storeIncomingPacket(msg.packet);
    }
  }

  async function storeIncomingPacket(packet: SignedInputPacket) {
    const frame = packet.frame;
    if (!pendingInputsRef.current[frame]) pendingInputsRef.current[frame] = {};
    pendingInputsRef.current[frame][packet.player] = packet;

    latestSeenOpp.current[localSlot] = packet.hash;
    setPackets((prev) => [...prev, packet]);

    await maybeAdvanceFrame(frame);
  }

  function currentLocalInputMask() {
    if (localSlot === 1) {
      return encodeInputMask({
        left: !!keyState.current["a"],
        right: !!keyState.current["d"],
        attack: !!keyState.current["f"],
      });
    }

    return encodeInputMask({
      left: !!keyState.current["arrowleft"],
      right: !!keyState.current["arrowright"],
      attack: !!keyState.current["/"],
    });
  }

  async function buildSignedPacket(frame: number, inputMask: number) {
    if (!wallet) throw new Error("Missing wallet");

    const payload = canonicalInputPayload(
      matchId,
      frame,
      localSlot,
      inputMask,
      latestPrevSelf.current[localSlot],
      latestSeenOpp.current[localSlot]
    );

    const hash = await sha256Hex(payload);
    const signature = await signPayload(wallet.privateKey, payload);

    return {
      matchId,
      frame,
      player: localSlot,
      inputMask,
      prevSelfHash: latestPrevSelf.current[localSlot],
      prevOppHash: latestSeenOpp.current[localSlot],
      publicKey: wallet.publicKey,
      signature,
      hash,
    } satisfies SignedInputPacket;
  }

  async function tick() {
    if (!connRef.current || !wallet || state.roundOver) return;

    const nextFrame = state.frame + 1;

    if (sentFramesRef.current.has(nextFrame)) {
      await maybeAdvanceFrame(nextFrame);
      return;
    }

    const inputMask = currentLocalInputMask();
    const packet = await buildSignedPacket(nextFrame, inputMask);

    if (!pendingInputsRef.current[nextFrame]) pendingInputsRef.current[nextFrame] = {};
    pendingInputsRef.current[nextFrame][localSlot] = packet;

    latestPrevSelf.current[localSlot] = packet.hash;
    sentFramesRef.current.add(nextFrame);

    setPackets((prev) => [...prev, packet]);
    connRef.current.send({ type: "INPUT_PACKET", packet } satisfies NetEnvelope);
    log(`frame ${nextFrame}: sent local packet`);

    await maybeAdvanceFrame(nextFrame);
  }

  async function maybeAdvanceFrame(frame: number) {
    const pair = pendingInputsRef.current[frame];
    if (!pair?.[1] || !pair?.[2]) return;
    if (frame !== state.frame + 1) return;

    const p1Packet = pair[1]!;
    const p2Packet = pair[2]!;

    latestSeenOpp.current[1] = p2Packet.hash;
    latestSeenOpp.current[2] = p1Packet.hash;

    const prevFrameHash = frameHeadRef.current;
    const frameHash = await sha256Hex(
      JSON.stringify({
        matchId,
        frame,
        p1InputMask: p1Packet.inputMask,
        p2InputMask: p2Packet.inputMask,
        prevFrameHash,
      })
    );

    frameHeadRef.current = frameHash;
    setFinalFrameHash(frameHash);

    const canonical: CanonicalFrame = {
      matchId,
      frame,
      p1InputMask: p1Packet.inputMask,
      p2InputMask: p2Packet.inputMask,
      prevFrameHash,
      frameHash,
    };

    const nextState = transition(state, p1Packet.inputMask, p2Packet.inputMask);

    delete pendingInputsRef.current[frame];
    setCanonicalFrames((prev) => [...prev, canonical]);
    setState(nextState);

    log(`frame ${frame}: canonicalized + advanced`);
  }

  async function finalizeHashes() {
    const stateHash = await sha256Hex(JSON.stringify(state));
    setFinalStateHash(stateHash);
  }

  async function resetLocal(pushRemote = true) {
    const newWallet = await createSessionWallet();
    setWallet(newWallet);
    setState(initialState());
    setPackets([]);
    setCanonicalFrames([]);
    setLogs([]);
    setFinalFrameHash("0x00");
    setFinalStateHash("");
    setRemoteWalletAddress("");
    setRemoteWalletPubKey("");
    setLastError("");

    pendingInputsRef.current = {};
    latestPrevSelf.current = { 1: "0x00", 2: "0x00" };
    latestSeenOpp.current = { 1: "0x00", 2: "0x00" };
    frameHeadRef.current = "0x00";
    sentFramesRef.current = new Set();
    setIsRunning(false);

    const nextMatchId = `match-${Math.random().toString(36).slice(2, 10)}`;
    setMatchId(nextMatchId);

    if (pushRemote && connRef.current?.open) {
      connRef.current.send({ type: "RESET_MATCH", matchId: nextMatchId } satisfies NetEnvelope);
    }
  }

  function startMatch() {
    if (!isConnected) return;
    sentFramesRef.current = new Set();
    setIsRunning(true);
    connRef.current?.send({ type: "START_MATCH", matchId } satisfies NetEnvelope);
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {}
  }

  const p1AttackRect = getAttackRect(state.p1);
  const p2AttackRect = getAttackRect(state.p2);

  const outcomeText =
    state.winner === "P1"
      ? "P1 wins"
      : state.winner === "P2"
      ? "P2 wins"
      : state.winner === "TIE_BOTH_LOSE"
      ? "Tie: both lose ante"
      : "In progress";

  const finalSettlementPayload = useMemo(() => {
    if (!state.roundOver || !finalStateHash) return "";
    return JSON.stringify(
      {
        matchId,
        finalFrame: state.frame,
        finalFrameHash,
        finalStateHash,
        p1Hp: state.p1.hp,
        p2Hp: state.p2.hp,
        outcome: state.winner,
      },
      null,
      2
    );
  }, [
    state.roundOver,
    finalStateHash,
    matchId,
    state.frame,
    finalFrameHash,
    state.p1.hp,
    state.p2.hp,
    state.winner,
  ]);

  return (
    <div style={styles.page}>
      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; background: #0a0a0a; color: #f4f4f5; font-family: Arial, sans-serif; }
        button, input { font: inherit; }
      `}</style>

      <div style={styles.wrap}>
        <div style={styles.leftCol}>
          <section style={styles.panel}>
            <h1 style={styles.h1}>Crypto Fighter MVP</h1>
            <div style={styles.sub}>
              Two-tab PeerJS demo. Pure React DOM rendering. No HTML canvas.
            </div>

            <div style={styles.row}>
              <button style={styles.button} onClick={() => void initPeer("host")}>
                Host Tab
              </button>
              <button style={styles.buttonSecondary} onClick={() => void initPeer("joiner")}>
                Joiner Tab
              </button>
              <button
                style={styles.button}
                onClick={startMatch}
                disabled={!isConnected || isRunning}
              >
                Start Match
              </button>
              <button style={styles.buttonSecondary} onClick={() => void resetLocal(true)}>
                New Match
              </button>
            </div>

            <div style={styles.grid4}>
              <Stat title="Match ID" value={matchId} />
              <Stat title="Role / Slot" value={`${role} / P${localSlot}`} />
              <Stat title="Frame" value={`${state.frame} / ${ROUND_FRAMES}`} />
              <Stat title="Timer" value={`${(state.timerFramesLeft / FPS).toFixed(2)}s`} />
            </div>
          </section>

          <section style={styles.panel}>
            <h2 style={styles.h2}>Peer connection</h2>
            <div style={styles.rowWrap}>
              <div>
                <div style={styles.label}>Your Peer ID</div>
                <div style={styles.codeBox}>{peerId || "initialize first"}</div>
              </div>
              <button style={styles.smallButton} onClick={() => void copy(peerId)} disabled={!peerId}>
                Copy
              </button>
            </div>

            <div style={styles.row}>
              <input
                style={styles.input}
                value={remotePeerId}
                onChange={(e) => setRemotePeerId(e.target.value)}
                placeholder="Paste host peer ID in joiner tab"
              />
              <button
                style={styles.button}
                onClick={connectToHost}
                disabled={role !== "joiner" || !peerId}
              >
                Connect
              </button>
            </div>

            <div style={{ color: isConnected ? "#4ade80" : "#f59e0b", fontSize: 14 }}>
              {isConnected ? "Connected" : "Not connected"}
            </div>
            {lastError ? <div style={styles.error}>{lastError}</div> : null}
          </section>

          <section style={styles.grid2}>
            <PlayerCard
              title="Player 1"
              controls="A / D / F"
              hp={state.p1.hp}
              maxHp={MAX_HP}
              address={localSlot === 1 ? wallet?.address ?? "generating..." : remoteWalletAddress || "waiting..."}
              publicKey={localSlot === 1 ? wallet?.publicKey ?? "generating..." : remoteWalletPubKey || "waiting..."}
              onCopy={copy}
            />
            <PlayerCard
              title="Player 2"
              controls="← / → / /"
              hp={state.p2.hp}
              maxHp={MAX_HP}
              address={localSlot === 2 ? wallet?.address ?? "generating..." : remoteWalletAddress || "waiting..."}
              publicKey={localSlot === 2 ? wallet?.publicKey ?? "generating..." : remoteWalletPubKey || "waiting..."}
              onCopy={copy}
            />
          </section>

          <section style={styles.panel}>
            <div style={styles.arena}>
              <div style={{ ...styles.floor, top: FLOOR_Y }} />
              <div
                style={{
                  ...styles.p1,
                  left: state.p1.x,
                  top: state.p1.y,
                  width: state.p1.w,
                  height: state.p1.h,
                }}
              />
              <div
                style={{
                  ...styles.p2,
                  left: state.p2.x,
                  top: state.p2.y,
                  width: state.p2.w,
                  height: state.p2.h,
                }}
              />

              {p1AttackRect && (
                <div
                  style={{
                    ...styles.p1Attack,
                    left: p1AttackRect.x,
                    top: p1AttackRect.y,
                    width: p1AttackRect.w,
                    height: p1AttackRect.h,
                  }}
                />
              )}
              {p2AttackRect && (
                <div
                  style={{
                    ...styles.p2Attack,
                    left: p2AttackRect.x,
                    top: p2AttackRect.y,
                    width: p2AttackRect.w,
                    height: p2AttackRect.h,
                  }}
                />
              )}
            </div>

            <div style={styles.grid3}>
              <Stat title="Outcome" value={outcomeText} />
              <Stat title="Canonical head" value={short(finalFrameHash, 24)} />
              <Stat title="Final state hash" value={finalStateHash ? short(finalStateHash, 24) : "pending"} />
            </div>
          </section>
        </div>

        <div style={styles.rightCol}>
          <section style={styles.panel}>
            <h2 style={styles.h2}>Verification log</h2>
            <div style={styles.scroll}>
              {logs.length === 0 ? <div>No events yet.</div> : logs.map((line, i) => <div key={i}>{line}</div>)}
            </div>
          </section>

          <section style={styles.panel}>
            <h2 style={styles.h2}>Last packets</h2>
            <div style={styles.scrollTall}>
              {packets.length === 0 ? (
                <div>No packets yet.</div>
              ) : (
                [...packets].slice(-8).reverse().map((p, idx) => (
                  <div key={`${p.player}-${p.frame}-${idx}`} style={styles.packetBox}>
                    <div>player: P{p.player} | frame: {p.frame} | mask: {p.inputMask}</div>
                    <div>prevSelfHash: {short(p.prevSelfHash)}</div>
                    <div>prevOppHash: {short(p.prevOppHash)}</div>
                    <div>hash: {short(p.hash)}</div>
                    <div>sig: {short(p.signature)}</div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section style={styles.panel}>
            <h2 style={styles.h2}>Canonical frames</h2>
            <div style={styles.scrollTall}>
              {canonicalFrames.length === 0 ? (
                <div>No canonical frames yet.</div>
              ) : (
                [...canonicalFrames].slice(-8).reverse().map((f) => (
                  <div key={f.frame} style={styles.packetBox}>
                    <div>frame {f.frame}</div>
                    <div>p1InputMask: {f.p1InputMask}</div>
                    <div>p2InputMask: {f.p2InputMask}</div>
                    <div>prevFrameHash: {short(f.prevFrameHash)}</div>
                    <div>frameHash: {short(f.frameHash)}</div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section style={styles.panel}>
            <h2 style={styles.h2}>Final settlement payload</h2>
            <pre style={styles.pre}>
              {state.roundOver
                ? finalSettlementPayload
                : "Available when the match ends."}
            </pre>
          </section>
        </div>
      </div>
    </div>
  );
}

function PlayerCard(props: {
  title: string;
  controls: string;
  hp: number;
  maxHp: number;
  address: string;
  publicKey: string;
  onCopy: (s: string) => void;
}) {
  const hpPct = (props.hp / props.maxHp) * 100;
  const hpColor = props.hp >= 5 ? "#10b981" : props.hp >= 3 ? "#f59e0b" : "#f43f5e";

  return (
    <section style={styles.panel}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <strong>{props.title}</strong>
        <span style={styles.badge}>{props.controls}</span>
      </div>

      <div style={{ fontSize: 12, color: "#a1a1aa", marginBottom: 6 }}>
        HP {props.hp} / {props.maxHp}
      </div>
      <div style={styles.hpOuter}>
        <div style={{ ...styles.hpInner, width: `${hpPct}%`, background: hpColor }} />
      </div>

      <div style={{ marginTop: 10 }}>
        <div style={styles.label}>Session Address</div>
        <div style={styles.codeRow}>
          <div style={styles.codeText}>{props.address}</div>
          <button style={styles.smallButton} onClick={() => props.onCopy(props.address)}>
            Copy
          </button>
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <div style={styles.label}>Public Key</div>
        <div style={styles.codeRow}>
          <div style={styles.codeText}>{short(props.publicKey, 42)}</div>
          <button style={styles.smallButton} onClick={() => props.onCopy(props.publicKey)}>
            Copy
          </button>
        </div>
      </div>
    </section>
  );
}

function Stat({ title, value }: { title: string; value: string }) {
  return (
    <div style={styles.stat}>
      <div style={styles.statTitle}>{title}</div>
      <div>{value}</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#0a0a0a",
    color: "#f4f4f5",
    padding: 20,
  },
  wrap: {
    maxWidth: 1400,
    margin: "0 auto",
    display: "grid",
    gridTemplateColumns: "1.2fr 0.8fr",
    gap: 20,
  },
  leftCol: {
    display: "grid",
    gap: 16,
  },
  rightCol: {
    display: "grid",
    gap: 16,
  },
  panel: {
    border: "1px solid #27272a",
    background: "#111113",
    borderRadius: 16,
    padding: 16,
  },
  h1: {
    margin: 0,
    fontSize: 28,
  },
  h2: {
    margin: "0 0 12px 0",
    fontSize: 20,
  },
  sub: {
    color: "#a1a1aa",
    marginTop: 6,
    fontSize: 14,
  },
  row: {
    display: "flex",
    gap: 8,
    marginTop: 12,
    alignItems: "center",
  },
  rowWrap: {
    display: "flex",
    gap: 8,
    justifyContent: "space-between",
    alignItems: "end",
    flexWrap: "wrap",
  },
  grid2: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 16,
  },
  grid3: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr",
    gap: 12,
    marginTop: 16,
  },
  grid4: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr 1fr",
    gap: 12,
    marginTop: 16,
  },
  button: {
    background: "#2563eb",
    color: "white",
    border: "none",
    borderRadius: 10,
    padding: "10px 14px",
    cursor: "pointer",
  },
  buttonSecondary: {
    background: "#27272a",
    color: "#f4f4f5",
    border: "1px solid #3f3f46",
    borderRadius: 10,
    padding: "10px 14px",
    cursor: "pointer",
  },
  smallButton: {
    background: "#27272a",
    color: "#f4f4f5",
    border: "1px solid #3f3f46",
    borderRadius: 8,
    padding: "6px 10px",
    cursor: "pointer",
    flexShrink: 0,
  },
  input: {
    flex: 1,
    minWidth: 0,
    background: "#09090b",
    color: "#f4f4f5",
    border: "1px solid #3f3f46",
    borderRadius: 10,
    padding: "10px 12px",
  },
  label: {
    fontSize: 11,
    color: "#a1a1aa",
    textTransform: "uppercase",
    marginBottom: 4,
  },
  badge: {
    background: "#27272a",
    border: "1px solid #3f3f46",
    borderRadius: 999,
    padding: "4px 8px",
    fontSize: 12,
  },
  stat: {
    border: "1px solid #27272a",
    background: "#09090b",
    borderRadius: 12,
    padding: 12,
  },
  statTitle: {
    fontSize: 11,
    textTransform: "uppercase",
    color: "#71717a",
    marginBottom: 6,
  },
  arena: {
    position: "relative",
    width: WIDTH,
    height: HEIGHT,
    margin: "0 auto",
    border: "1px solid #27272a",
    borderRadius: 16,
    background: "#18181b",
    overflow: "hidden",
  },
  floor: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 2,
    background: "#52525b",
  },
  p1: {
    position: "absolute",
    background: "#22d3ee",
    borderRadius: 4,
  },
  p2: {
    position: "absolute",
    background: "#e879f9",
    borderRadius: 4,
  },
  p1Attack: {
    position: "absolute",
    background: "#cffafe",
    borderRadius: 4,
  },
  p2Attack: {
    position: "absolute",
    background: "#f5d0fe",
    borderRadius: 4,
  },
  hpOuter: {
    height: 12,
    borderRadius: 999,
    background: "#27272a",
    overflow: "hidden",
  },
  hpInner: {
    height: "100%",
  },
  codeBox: {
    border: "1px solid #27272a",
    background: "#09090b",
    borderRadius: 10,
    padding: 10,
    fontFamily: "monospace",
    fontSize: 12,
    wordBreak: "break-all",
  },
  codeRow: {
    display: "flex",
    gap: 8,
    alignItems: "center",
  },
  codeText: {
    flex: 1,
    border: "1px solid #27272a",
    background: "#09090b",
    borderRadius: 10,
    padding: 10,
    fontFamily: "monospace",
    fontSize: 12,
    wordBreak: "break-all",
  },
  scroll: {
    maxHeight: 220,
    overflowY: "auto",
    border: "1px solid #27272a",
    background: "#09090b",
    borderRadius: 10,
    padding: 10,
    fontFamily: "monospace",
    fontSize: 12,
    whiteSpace: "pre-wrap",
  },
  scrollTall: {
    maxHeight: 320,
    overflowY: "auto",
    border: "1px solid #27272a",
    background: "#09090b",
    borderRadius: 10,
    padding: 10,
    fontFamily: "monospace",
    fontSize: 12,
  },
  packetBox: {
    border: "1px solid #27272a",
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
  },
  pre: {
    margin: 0,
    border: "1px solid #27272a",
    background: "#09090b",
    borderRadius: 10,
    padding: 10,
    overflowX: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    fontFamily: "monospace",
    fontSize: 12,
  },
  error: {
    color: "#fb7185",
    marginTop: 8,
    fontFamily: "monospace",
    fontSize: 12,
    whiteSpace: "pre-wrap",
  },
};
