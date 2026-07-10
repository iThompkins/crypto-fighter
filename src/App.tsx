import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Peer, { type DataConnection } from "peerjs";
import { createSessionWallet, hashFrameFields, hashJson, hashPacketFields, makeMatchId, signDigest, verifyPacket, ZERO32 } from "./crypto";
import { encodeInputMask, FLOOR_Y, FPS, getAttackRect, HEIGHT, initialState, MAX_HP, ROUND_FRAMES, transition, WIDTH } from "./game";
import { short } from "./format";
import { arena, connectWallet, outcomeFromWinner, rulesHash, stakeWei } from "./chain";
import type { Signer } from "ethers";
import type { TranscriptVerificationResult } from "./verifier";
import { verifyTranscript } from "./verifier";
import type { CanonicalFrame, GameState, MatchTranscript, NetEnvelope, PlayerSlot, SessionWallet, SignedInputPacket } from "./types";

export default function App() {
  const [state, setState] = useState<GameState>(initialState());
  const [matchId, setMatchId] = useState(makeMatchId);
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
  const [finalFrameHash, setFinalFrameHash] = useState(ZERO32);
  const [transcriptInput, setTranscriptInput] = useState("");
  const [importedTranscript, setImportedTranscript] = useState<MatchTranscript | null>(null);
  const [replayResult, setReplayResult] = useState<TranscriptVerificationResult | null>(null);
  const [replayFrame, setReplayFrame] = useState(0);
  const [isReplayPlaying, setIsReplayPlaying] = useState(false);

  // On-chain settlement (MetaMask main wallet).
  const [mainWalletAddress, setMainWalletAddress] = useState("");
  const [chainLabel, setChainLabel] = useState("");
  const [arenaAddress, setArenaAddress] = useState("");
  const [stakeEth, setStakeEth] = useState("0.01");
  const [responseWindowSec, setResponseWindowSec] = useState("0");
  const [expectedOpponent, setExpectedOpponent] = useState("");
  const [onchainChallengeId, setOnchainChallengeId] = useState("");
  const mainSignerRef = useRef<Signer | null>(null);

  const matchIdRef = useRef(matchId);
  const stateRef = useRef(state);
  const localSlotRef = useRef<PlayerSlot>(localSlot);
  const remoteWalletPubKeyRef = useRef(remoteWalletPubKey);

  const peerRef = useRef<Peer | null>(null);
  const connRef = useRef<DataConnection | null>(null);
  const intervalRef = useRef<number | null>(null);
  const keyState = useRef<Record<string, boolean>>({});
  const pendingInputsRef = useRef<Record<number, Partial<Record<PlayerSlot, SignedInputPacket>>>>({});
  const packetHeadsRef = useRef<{ 1: string; 2: string }>({ 1: ZERO32, 2: ZERO32 });
  const frameHeadRef = useRef(ZERO32);
  const sentFramesRef = useRef<Set<number>>(new Set());
  const tickInFlightRef = useRef(false);

  // Perf instrumentation: game advance rate + crypto op timing.
  const advTimesRef = useRef<number[]>([]);
  const signMsRef = useRef(0);
  const verifyMsRef = useRef(0);
  const [gameFps, setGameFps] = useState(0);
  const [perf, setPerf] = useState({ sign: 0, verify: 0 });

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
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    localSlotRef.current = localSlot;
  }, [localSlot]);

  useEffect(() => {
    remoteWalletPubKeyRef.current = remoteWalletPubKey;
  }, [remoteWalletPubKey]);

  useEffect(() => {
    return () => {
      if (intervalRef.current) window.clearInterval(intervalRef.current);
      connRef.current?.close?.();
      peerRef.current?.destroy?.();
    };
  }, []);

  function updateMatchId(nextMatchId: string) {
    matchIdRef.current = nextMatchId;
    setMatchId(nextMatchId);
  }

  function updateLocalSlot(nextSlot: PlayerSlot) {
    localSlotRef.current = nextSlot;
    setLocalSlot(nextSlot);
  }

  function updateRemoteWalletPubKey(nextPubKey: string) {
    remoteWalletPubKeyRef.current = nextPubKey;
    setRemoteWalletPubKey(nextPubKey);
  }

  const log = useCallback((line: string) => {
    setLogs((prev) => [line, ...prev].slice(0, 100));
  }, []);

  async function initPeer(as: "host" | "joiner") {
    try {
      setLastError("");
      peerRef.current?.destroy?.();
      connRef.current?.close?.();

      const peer = new Peer();
      peerRef.current = peer;
      setRole(as);
      updateLocalSlot(as === "host" ? 1 : 2);

      peer.on("open", (id: string) => {
        setPeerId(id);
        log(`peer open: ${id}`);
      });

      peer.on("connection", (conn) => {
        if (as !== "host") return;
        connRef.current = conn;
        bindConnection(conn, 1);
      });

      peer.on("error", (err) => {
        setLastError(String(err));
        log(`peer error: ${String(err)}`);
      });
    } catch (e) {
      setLastError(String(e));
    }
  }

  function bindConnection(conn: DataConnection, slotForLocal: PlayerSlot) {
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

    conn.on("data", (raw: unknown) => {
      void handleNetMessage(raw as NetEnvelope);
    });

    conn.on("close", () => {
      setIsConnected(false);
      log("connection closed");
    });

    conn.on("error", (err) => {
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

  const maybeAdvanceFrame = useCallback(async (frame: number) => {
    const pair = pendingInputsRef.current[frame];
    if (!pair?.[1] || !pair?.[2]) return;
    if (frame !== stateRef.current.frame + 1) return;

    const p1Packet = pair[1]!;
    const p2Packet = pair[2]!;

    packetHeadsRef.current[1] = p1Packet.hash;
    packetHeadsRef.current[2] = p2Packet.hash;

    const prevFrameHash = frameHeadRef.current;
    const frameHash = hashFrameFields(
      matchIdRef.current,
      frame,
      p1Packet.inputMask,
      p2Packet.inputMask,
      prevFrameHash
    );

    frameHeadRef.current = frameHash;
    setFinalFrameHash(frameHash);

    const canonical: CanonicalFrame = {
      matchId: matchIdRef.current,
      frame,
      p1InputMask: p1Packet.inputMask,
      p2InputMask: p2Packet.inputMask,
      prevFrameHash,
      frameHash,
    };

    const nextState = transition(stateRef.current, p1Packet.inputMask, p2Packet.inputMask);

    delete pendingInputsRef.current[frame];
    sentFramesRef.current.delete(frame);
    setCanonicalFrames((prev) => [...prev, canonical]);
    stateRef.current = nextState;
    setState(nextState);
    if (nextState.roundOver) setIsRunning(false);

    // Measure real game advance rate over a ~2s sliding window.
    const now = performance.now();
    const times = advTimesRef.current;
    times.push(now);
    while (times.length && now - times[0] > 2000) times.shift();
    if (times.length >= 2) {
      const span = (times[times.length - 1] - times[0]) / 1000;
      setGameFps(span > 0 ? (times.length - 1) / span : 0);
    }
    setPerf({ sign: signMsRef.current, verify: verifyMsRef.current });

    log(`frame ${frame}: canonicalized + advanced`);
  }, [log]);

  async function handleNetMessage(msg: NetEnvelope) {
    if (msg.type === "HELLO") {
      setRemoteWalletAddress(msg.walletAddress);
      updateRemoteWalletPubKey(msg.publicKey);

      if (msg.fromSlot === 1) {
        updateMatchId(msg.matchId);
        log(`adopted host match context: ${msg.matchId}`);
      }

      log(`HELLO from P${msg.fromSlot} ${short(msg.walletAddress, 14)}`);
      return;
    }

    if (msg.type === "START_MATCH") {
      updateMatchId(msg.matchId);
      log(`remote started match: ${msg.matchId}`);
      setIsRunning(true);
      return;
    }

    if (msg.type === "RESET_MATCH") {
      log("remote requested reset");
      await resetLocal(false);
      updateMatchId(msg.matchId);
      return;
    }

    if (msg.type === "INPUT_PACKET") {
      const rejection = await validateRemotePacket(msg.packet);
      if (rejection) {
        log(`frame ${msg.packet.frame}: rejected remote packet: ${rejection}`);
        return;
      }

      log(`frame ${msg.packet.frame}: accepted remote packet`);
      await storeIncomingPacket(msg.packet);
    }
  }

  async function validateRemotePacket(packet: SignedInputPacket) {
    const currentSlot = localSlotRef.current;
    const currentState = stateRef.current;
    const expectedRemoteSlot: PlayerSlot = currentSlot === 1 ? 2 : 1;

    if (packet.player !== expectedRemoteSlot) return `expected P${expectedRemoteSlot}, got P${packet.player}`;
    if (packet.matchId !== matchIdRef.current) return `wrong match context ${packet.matchId}`;
    if (packet.frame <= currentState.frame) return `stale frame ${packet.frame}`;
    if (packet.frame > currentState.frame + 1) return `future frame ${packet.frame} exceeds one-frame window`;
    if (remoteWalletPubKeyRef.current && packet.publicKey !== remoteWalletPubKeyRef.current) return "public key changed after HELLO";

    const hash = hashPacketFields(
      packet.matchId,
      packet.frame,
      packet.player,
      packet.inputMask,
      packet.prevSelfHash,
      packet.prevOppHash
    );
    if (hash !== packet.hash) return "packet hash does not match canonical payload";

    if (packet.prevSelfHash !== packetHeadsRef.current[packet.player]) {
      return `broken self hash chain for P${packet.player}`;
    }

    if (packet.prevOppHash !== packetHeadsRef.current[currentSlot]) {
      return `broken opponent hash link for P${packet.player}`;
    }

    const existing = pendingInputsRef.current[packet.frame]?.[packet.player];
    if (existing && existing.hash !== packet.hash) return "conflicting packet for frame/player";

    const vStart = performance.now();
    const signatureOk = await verifyPacket(packet);
    const vDt = performance.now() - vStart;
    verifyMsRef.current = verifyMsRef.current === 0 ? vDt : verifyMsRef.current * 0.8 + vDt * 0.2;
    if (!signatureOk) return "signature verification failed";

    return null;
  }

  async function storeIncomingPacket(packet: SignedInputPacket) {
    const frame = packet.frame;
    if (!pendingInputsRef.current[frame]) pendingInputsRef.current[frame] = {};
    pendingInputsRef.current[frame][packet.player] = packet;

    setPackets((prev) => [...prev, packet]);

    await maybeAdvanceFrame(frame);
  }

  const currentLocalInputMask = useCallback((slot = localSlotRef.current) => {
    if (slot === 1) {
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
  }, []);

  const buildSignedPacket = useCallback(async (frame: number, inputMask: number) => {
    if (!wallet) throw new Error("Missing wallet");

    const slot = localSlotRef.current;
    const prevSelfHash = packetHeadsRef.current[slot];
    const prevOppHash = packetHeadsRef.current[slot === 1 ? 2 : 1];

    const hash = hashPacketFields(
      matchIdRef.current,
      frame,
      slot,
      inputMask,
      prevSelfHash,
      prevOppHash
    );

    const sStart = performance.now();
    const signature = await signDigest(wallet.privateKey, hash);
    const sDt = performance.now() - sStart;
    signMsRef.current = signMsRef.current === 0 ? sDt : signMsRef.current * 0.8 + sDt * 0.2;

    return {
      matchId: matchIdRef.current,
      frame,
      player: slot,
      inputMask,
      prevSelfHash,
      prevOppHash,
      publicKey: wallet.publicKey,
      signature,
      hash,
    } satisfies SignedInputPacket;
  }, [wallet]);

  const tick = useCallback(async () => {
    if (tickInFlightRef.current) return;
    tickInFlightRef.current = true;

    try {
      if (!connRef.current || !wallet || stateRef.current.roundOver) return;

      const nextFrame = stateRef.current.frame + 1;

      if (sentFramesRef.current.has(nextFrame)) {
        await maybeAdvanceFrame(nextFrame);
        return;
      }

      const slot = localSlotRef.current;
      const inputMask = currentLocalInputMask(slot);
      const packet = await buildSignedPacket(nextFrame, inputMask);

      if (!pendingInputsRef.current[nextFrame]) pendingInputsRef.current[nextFrame] = {};
      pendingInputsRef.current[nextFrame][slot] = packet;

      sentFramesRef.current.add(nextFrame);

      setPackets((prev) => [...prev, packet]);
      connRef.current.send({ type: "INPUT_PACKET", packet } satisfies NetEnvelope);
      log(`frame ${nextFrame}: sent local packet`);

      await maybeAdvanceFrame(nextFrame);
    } finally {
      tickInFlightRef.current = false;
    }
  }, [buildSignedPacket, currentLocalInputMask, log, maybeAdvanceFrame, wallet]);



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
  }, [isConnected, isRunning, state.roundOver, tick]);

  useEffect(() => {
    if (!state.roundOver) return;

    let cancelled = false;
    void (async () => {
      const stateHash = hashJson(state);
      if (!cancelled) setFinalStateHash(stateHash);
    })();

    return () => {
      cancelled = true;
    };
  }, [state]);

  useEffect(() => {
    if (!isReplayPlaying || !replayResult) return;

    const id = window.setInterval(() => {
      setReplayFrame((current) => {
        const next = current + 1;
        if (next >= replayResult.states.length - 1) {
          setIsReplayPlaying(false);
          return replayResult.states.length - 1;
        }
        return next;
      });
    }, 1000 / FPS);

    return () => window.clearInterval(id);
  }, [isReplayPlaying, replayResult]);

  async function importTranscriptJson(json: string) {
    try {
      setLastError("");
      const parsed = JSON.parse(json) as MatchTranscript;
      const result = await verifyTranscript(parsed);
      setImportedTranscript(parsed);
      setReplayResult(result);
      setReplayFrame(0);
      setIsReplayPlaying(false);
      log(`imported transcript ${parsed.matchId}: verifier ${result.ok ? "ok" : "failed"}`);
    } catch (e) {
      setLastError(`Transcript import failed: ${String(e)}`);
      setImportedTranscript(null);
      setReplayResult(null);
      setIsReplayPlaying(false);
    }
  }

  async function importTranscriptFile(file: File | null) {
    if (!file) return;
    const json = await file.text();
    setTranscriptInput(json);
    await importTranscriptJson(json);
  }

  function clearReplay() {
    setImportedTranscript(null);
    setReplayResult(null);
    setReplayFrame(0);
    setIsReplayPlaying(false);
  }

  async function resetLocal(pushRemote = true) {
    const newWallet = await createSessionWallet();
    setWallet(newWallet);
    setState(initialState());
    setPackets([]);
    setCanonicalFrames([]);
    setLogs([]);
    setFinalFrameHash(ZERO32);
    setFinalStateHash("");
    setRemoteWalletAddress("");
    setRemoteWalletPubKey("");
    setLastError("");

    pendingInputsRef.current = {};
    packetHeadsRef.current = { 1: ZERO32, 2: ZERO32 };
    frameHeadRef.current = ZERO32;
    sentFramesRef.current = new Set();
    setIsRunning(false);

    const nextMatchId = makeMatchId();
    updateMatchId(nextMatchId);

    if (pushRemote && connRef.current?.open) {
      connRef.current.send({ type: "RESET_MATCH", matchId: nextMatchId } satisfies NetEnvelope);
    }
  }

  function startMatch() {
    if (!isConnected) return;
    sentFramesRef.current = new Set();
    setIsRunning(true);
    connRef.current?.send({ type: "START_MATCH", matchId: matchIdRef.current } satisfies NetEnvelope);
  }

  async function connectMainWallet() {
    try {
      setLastError("");
      const c = await connectWallet();
      mainSignerRef.current = c.signer;
      setMainWalletAddress(c.address);
      setChainLabel(`chain ${c.chainId}`);
      log(`wallet connected: ${short(c.address, 14)} (chain ${c.chainId})`);
    } catch (e) {
      setLastError(String(e));
    }
  }

  function requireArena() {
    if (!mainSignerRef.current) throw new Error("Connect wallet first.");
    if (!arenaAddress.trim()) throw new Error("Set the Arena contract address.");
    return arena(arenaAddress.trim(), mainSignerRef.current);
  }

  async function onchainChallenge() {
    try {
      setLastError("");
      if (!wallet) throw new Error("Session wallet not ready.");
      const contract = requireArena();
      const rHash = rulesHash({ fps: FPS, roundFrames: ROUND_FRAMES, maxHp: MAX_HP, oneOutstandingPacket: true });
      const opp = expectedOpponent.trim() || "0x0000000000000000000000000000000000000000";
      const windowSec = Number(responseWindowSec) || 0;
      const tx = await contract.challenge(matchIdRef.current, rHash, wallet.address, opp, windowSec, { value: stakeWei(stakeEth) });
      log(`challenge tx: ${short(tx.hash, 14)}`);
      const rc = await tx.wait();
      let id = "";
      for (const lg of rc.logs) {
        try {
          const parsed = contract.interface.parseLog(lg);
          if (parsed?.name === "ChallengeCreated") id = parsed.args.challengeId.toString();
        } catch { /* not our event */ }
      }
      if (id) setOnchainChallengeId(id);
      log(`challenge created: id ${id || "?"} stake ${stakeEth}`);
    } catch (e) {
      setLastError(String(e));
    }
  }

  async function onchainJoin() {
    try {
      setLastError("");
      if (!wallet) throw new Error("Session wallet not ready.");
      const contract = requireArena();
      const id = onchainChallengeId.trim();
      if (!id) throw new Error("Enter the challenge id to join.");
      const tx = await contract.join(id, wallet.address, { value: stakeWei(stakeEth) });
      log(`join tx: ${short(tx.hash, 14)}`);
      await tx.wait();
      log(`joined challenge ${id}`);
    } catch (e) {
      setLastError(String(e));
    }
  }

  async function onchainClaim() {
    try {
      setLastError("");
      const contract = requireArena();
      const id = onchainChallengeId.trim();
      if (!id) throw new Error("No challenge id.");
      if (!state.roundOver) throw new Error("Round is not over yet.");
      const outcome = outcomeFromWinner(state.winner);
      const tx = await contract.claimResult(
        id,
        outcome,
        state.frame,
        frameHeadRef.current,
        packetHeadsRef.current[1],
        packetHeadsRef.current[2]
      );
      log(`claimResult tx: ${short(tx.hash, 14)}`);
      await tx.wait();
      log(`result claimed for ${id}: outcome ${outcome}`);
    } catch (e) {
      setLastError(String(e));
    }
  }

  async function onchainFinalize() {
    try {
      setLastError("");
      const contract = requireArena();
      const id = onchainChallengeId.trim();
      if (!id) throw new Error("No challenge id.");
      const tx = await contract.finalizeResult(id);
      log(`finalizeResult tx: ${short(tx.hash, 14)}`);
      await tx.wait();
      log(`finalized ${id}`);
    } catch (e) {
      setLastError(String(e));
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      setLastError(`Clipboard copy failed: ${String(e)}`);
    }
  }

  function downloadText(filename: string, text: string) {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  const displayState = replayResult?.states[replayFrame] ?? state;
  const displayFrameHash = importedTranscript
    ? importedTranscript.canonicalFrames[replayFrame - 1]?.frameHash ?? ZERO32
    : finalFrameHash;
  const displayStateHash = replayResult && replayFrame === replayResult.states.length - 1
    ? replayResult.replay.stateHash
    : finalStateHash;
  const p1AttackRect = getAttackRect(displayState.p1);
  const p2AttackRect = getAttackRect(displayState.p2);

  const outcomeText =
    displayState.winner === "P1"
      ? "P1 wins"
      : displayState.winner === "P2"
      ? "P2 wins"
      : displayState.winner === "TIE_BOTH_LOSE"
      ? "Tie: both lose ante"
      : "In progress";

  const nextFrame = state.frame + 1;
  const pendingNext = pendingInputsRef.current[nextFrame] ?? {};
  const localPending = !!pendingNext[localSlot];
  const remoteSlot: PlayerSlot = localSlot === 1 ? 2 : 1;
  const remotePending = !!pendingNext[remoteSlot];
  const syncText = state.roundOver
    ? "Round complete"
    : !isRunning
    ? "Idle"
    : localPending && remotePending
    ? `Ready to advance frame ${nextFrame}`
    : localPending
    ? `Waiting for P${remoteSlot} packet ${nextFrame}`
    : `Ready to sign packet ${nextFrame}`;

  // Build the transcript on demand (Copy/Download) instead of every frame.
  // Serializing the whole growing transcript per frame was O(n^2) and the main
  // source of the slowdown as a match progressed.
  const buildTranscript = useCallback((): MatchTranscript => {
    const byKey = new Map<string, SignedInputPacket>();
    for (const packet of packets) byKey.set(`${packet.frame}:${packet.player}`, packet);
    const uniquePackets = [...byKey.values()].sort((a, b) => a.frame - b.frame || a.player - b.player);
    const p1Local = localSlot === 1;
    return {
      version: 1,
      matchId,
      rules: { fps: FPS, roundFrames: ROUND_FRAMES, maxHp: MAX_HP, oneOutstandingPacket: true },
      players: {
        p1: { slot: 1, address: p1Local ? wallet?.address ?? "" : remoteWalletAddress, publicKey: p1Local ? wallet?.publicKey ?? "" : remoteWalletPubKey },
        p2: { slot: 2, address: !p1Local ? wallet?.address ?? "" : remoteWalletAddress, publicKey: !p1Local ? wallet?.publicKey ?? "" : remoteWalletPubKey },
      },
      packets: uniquePackets,
      canonicalFrames,
      final: { frame: state.frame, frameHash: finalFrameHash, stateHash: finalStateHash, p1Hp: state.p1.hp, p2Hp: state.p2.hp, winner: state.winner, roundOver: state.roundOver },
    };
  }, [packets, canonicalFrames, localSlot, matchId, wallet?.address, wallet?.publicKey, remoteWalletAddress, remoteWalletPubKey, finalFrameHash, finalStateHash, state]);

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
              <Stat title="Frame" value={`${displayState.frame} / ${ROUND_FRAMES}`} />
              <Stat title="Timer" value={`${(displayState.timerFramesLeft / FPS).toFixed(2)}s`} />
              <Stat title="Sync" value={replayResult ? `Replay ${replayFrame}/${replayResult.states.length - 1}` : syncText} />
              <Stat title="Game FPS" value={gameFps.toFixed(1)} />
              <Stat title="Crypto ms" value={`sign ${perf.sign.toFixed(1)} · verify ${perf.verify.toFixed(1)}`} />
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
              hp={displayState.p1.hp}
              maxHp={MAX_HP}
              address={localSlot === 1 ? wallet?.address ?? "generating..." : remoteWalletAddress || "waiting..."}
              publicKey={localSlot === 1 ? wallet?.publicKey ?? "generating..." : remoteWalletPubKey || "waiting..."}
              onCopy={copy}
            />
            <PlayerCard
              title="Player 2"
              controls="← / → / /"
              hp={displayState.p2.hp}
              maxHp={MAX_HP}
              address={localSlot === 2 ? wallet?.address ?? "generating..." : remoteWalletAddress || "waiting..."}
              publicKey={localSlot === 2 ? wallet?.publicKey ?? "generating..." : remoteWalletPubKey || "waiting..."}
              onCopy={copy}
            />
          </section>

          <section style={styles.panel}>
            {displayState.roundOver ? (
              <div style={styles.endBanner}>
                {outcomeText} · frame {displayState.frame} · HP {displayState.p1.hp}–{displayState.p2.hp}
              </div>
            ) : null}
            <div style={styles.arena}>
              <div style={{ ...styles.floor, top: FLOOR_Y }} />
              <div
                style={{
                  ...styles.p1,
                  left: displayState.p1.x,
                  top: displayState.p1.y,
                  width: displayState.p1.w,
                  height: displayState.p1.h,
                }}
              />
              <div
                style={{
                  ...styles.p2,
                  left: displayState.p2.x,
                  top: displayState.p2.y,
                  width: displayState.p2.w,
                  height: displayState.p2.h,
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
              <Stat title="Canonical head" value={short(displayFrameHash, 24)} />
              <Stat title="Final state hash" value={displayStateHash ? short(displayStateHash, 24) : "pending"} />
            </div>
          </section>
        </div>

        <div style={styles.rightCol}>
          <section style={styles.panel}>
            <h2 style={styles.h2}>Transcript replay</h2>
            <div style={styles.sub}>Paste or import a transcript JSON to verify and replay it locally.</div>
            <div style={styles.row}>
              <input
                type="file"
                accept="application/json,.json"
                onChange={(e) => void importTranscriptFile(e.currentTarget.files?.[0] ?? null)}
              />
            </div>
            <textarea
              style={styles.textarea}
              value={transcriptInput}
              onChange={(e) => setTranscriptInput(e.target.value)}
              placeholder="Paste transcript JSON here..."
            />
            <div style={styles.row}>
              <button style={styles.smallButton} onClick={() => void importTranscriptJson(transcriptInput)} disabled={!transcriptInput.trim()}>
                Verify + Load
              </button>
              <button style={styles.smallButton} onClick={() => setIsReplayPlaying((v) => !v)} disabled={!replayResult}>
                {isReplayPlaying ? "Pause" : "Play"}
              </button>
              <button style={styles.smallButton} onClick={() => setReplayFrame(0)} disabled={!replayResult}>
                Restart
              </button>
              <button style={styles.smallButton} onClick={clearReplay} disabled={!replayResult}>
                Clear
              </button>
            </div>
            {replayResult ? (
              <>
                <div style={{ color: replayResult.ok ? "#4ade80" : "#f43f5e", marginTop: 10 }}>
                  Verifier: {replayResult.ok ? "ok" : "failed"} | frame {replayFrame}/{replayResult.states.length - 1}
                </div>
                <input
                  style={{ width: "100%", marginTop: 8 }}
                  type="range"
                  min={0}
                  max={replayResult.states.length - 1}
                  value={replayFrame}
                  onChange={(e) => {
                    setIsReplayPlaying(false);
                    setReplayFrame(Number(e.target.value));
                  }}
                />
                <div style={styles.packetBox}>
                  <div>match: {importedTranscript?.matchId}</div>
                  <div>winner: {replayResult.replay.winner ?? "pending"}</div>
                  <div>final frame hash: {short(replayResult.replay.frameHash, 28)}</div>
                  <div>final state hash: {short(replayResult.replay.stateHash, 28)}</div>
                  {replayResult.errors.length ? <div>errors: {replayResult.errors.slice(0, 3).join(" | ")}</div> : null}
                </div>
              </>
            ) : null}
          </section>

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
                packets.slice(-8).reverse().map((p, idx) => (
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
                canonicalFrames.slice(-8).reverse().map((f) => (
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
            <h2 style={styles.h2}>Transcript export</h2>
            <div style={styles.sub}>
              {packets.length} packets · {canonicalFrames.length} canonical frames · head {short(finalFrameHash, 18)}
            </div>
            <div style={styles.row}>
              <button style={styles.smallButton} onClick={() => void copy(JSON.stringify(buildTranscript(), null, 2))}>
                Copy Transcript
              </button>
              <button
                style={styles.smallButton}
                onClick={() => downloadText(`transcript-${matchId.slice(0, 10)}.json`, JSON.stringify(buildTranscript(), null, 2))}
              >
                Download JSON
              </button>
            </div>
          </section>

          <section style={styles.panel}>
            <h2 style={styles.h2}>On-chain settlement</h2>
            <div style={styles.sub}>
              Main wallet (MetaMask) pays the ante and delegates the session key. Session address:{" "}
              {short(wallet?.address ?? "", 18) || "generating..."}
            </div>
            <div style={styles.row}>
              <button style={styles.button} onClick={() => void connectMainWallet()}>
                {mainWalletAddress ? "Wallet Connected" : "Connect Wallet"}
              </button>
              <div style={{ fontSize: 12, color: "#a1a1aa" }}>
                {mainWalletAddress ? `${short(mainWalletAddress, 16)} · ${chainLabel}` : "not connected"}
              </div>
            </div>
            <div style={styles.row}>
              <input
                style={styles.input}
                value={arenaAddress}
                onChange={(e) => setArenaAddress(e.target.value)}
                placeholder="Arena contract address (0x...)"
              />
            </div>
            <div style={styles.row}>
              <input
                style={styles.input}
                value={stakeEth}
                onChange={(e) => setStakeEth(e.target.value)}
                placeholder="Stake (ETH)"
              />
              <input
                style={styles.input}
                value={onchainChallengeId}
                onChange={(e) => setOnchainChallengeId(e.target.value)}
                placeholder="Challenge id"
              />
            </div>
            <div style={styles.row}>
              <input
                style={styles.input}
                value={responseWindowSec}
                onChange={(e) => setResponseWindowSec(e.target.value)}
                placeholder="Dispute window (seconds, 0 = instant finalize)"
              />
            </div>
            <div style={styles.row}>
              <input
                style={styles.input}
                value={expectedOpponent}
                onChange={(e) => setExpectedOpponent(e.target.value)}
                placeholder="Opponent main wallet (optional lock)"
              />
            </div>
            <div style={styles.row}>
              <button style={styles.button} onClick={() => void onchainChallenge()} disabled={!mainWalletAddress}>
                Challenge (P1)
              </button>
              <button style={styles.buttonSecondary} onClick={() => void onchainJoin()} disabled={!mainWalletAddress}>
                Join (P2)
              </button>
            </div>
            <div style={styles.row}>
              <button style={styles.button} onClick={() => void onchainClaim()} disabled={!mainWalletAddress || !state.roundOver}>
                Claim Result
              </button>
              <button style={styles.buttonSecondary} onClick={() => void onchainFinalize()} disabled={!mainWalletAddress}>
                Finalize
              </button>
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
    height: "100vh",
    overflow: "hidden",
    background: "#0a0a0a",
    color: "#f4f4f5",
    padding: 20,
  },
  wrap: {
    maxWidth: 1400,
    height: "100%",
    margin: "0 auto",
    display: "grid",
    gridTemplateColumns: "1.2fr 0.8fr",
    gap: 20,
    minHeight: 0,
  },
  leftCol: {
    display: "grid",
    gap: 16,
    alignContent: "start",
    minHeight: 0,
    overflowY: "auto",
    paddingRight: 6,
  },
  rightCol: {
    display: "grid",
    gap: 16,
    alignContent: "start",
    minHeight: 0,
    overflowY: "auto",
    paddingRight: 6,
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
  textarea: {
    width: "100%",
    minHeight: 120,
    marginTop: 12,
    background: "#09090b",
    color: "#f4f4f5",
    border: "1px solid #3f3f46",
    borderRadius: 10,
    padding: "10px 12px",
    fontFamily: "monospace",
    fontSize: 12,
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
  endBanner: {
    marginBottom: 12,
    padding: "10px 14px",
    borderRadius: 12,
    textAlign: "center",
    fontWeight: 700,
    fontSize: 18,
    color: "#052e16",
    background: "#4ade80",
    border: "1px solid #22c55e",
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
    maxHeight: 240,
    overflow: "auto",
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
