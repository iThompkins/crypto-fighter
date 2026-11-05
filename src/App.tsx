import React, { useCallback, useEffect, useRef, useState } from "react";
import Peer, { type DataConnection } from "peerjs";
import { addressFromPublicKey, createSessionWallet, makeMatchId, ZERO32 } from "./crypto";
import { toDisplayUnits, FIGHTER_W, FIGHTER_H, encodeInputMask, FLOOR_Y, FPS, getAttackRect, HEIGHT, initialState, MAX_HP, ROUND_FRAMES, WIDTH } from "./game";
import { short } from "./format";
import { connectWallet } from "./chain";
import { CANONICAL_RULES_HASH } from "./protocol.ts";
import type { Signer } from "ethers";
import type { TranscriptVerificationResult } from "./verifier";
import { verifyTranscript } from "./verifier";
import { hashTraceState } from "./protocol.ts";
import { LiveMatch, configHash, hex, object, verifyReady, type LiveConfig } from "./live-match";
import { BrowserEvidenceStore } from "./evidence-store";
import { reconstructEvidence, canonicalJson, type EvidenceArchive } from "./evidence-archive";
import { buildEvidenceBundle } from "./evidence-trace";
import { prepareAdjudicationWitness, prepareMidpointOpening, prepareTraceClaim, type AdjudicationComparison } from "./onchain-dispute";
import { hello, verifyHello } from "./live-discovery";
import { createGenesisSession, hashGenesisBinding, verifyGenesisConsent, readGenesisRecord, type GenesisAuthorization, type GenesisRecord } from "./genesis";
import type { CanonicalFrame, GameState, MatchTranscript, PlayerSlot, SessionWallet, SignedInputPacket } from "./types";

// Keys the game consumes; preventDefault so arrows/space don't scroll the page.
const GAME_KEYS = new Set(["a", "d", "w", "arrowleft", "arrowright", "arrowup", " ", "f", "j", "k", "/"]);

function createPeer() {
  const host = import.meta.env.VITE_PEER_HOST;
  if (!host) return new Peer();

  return new Peer({
    host,
    port: Number(import.meta.env.VITE_PEER_PORT || 9000),
    path: import.meta.env.VITE_PEER_PATH || "/",
    secure: import.meta.env.VITE_PEER_SECURE === "true",
    ...(import.meta.env.VITE_PEER_NO_STUN === "true" ? { config: { iceServers: [] } } : {}),
  });
}

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
  const [allowPartialReplay, setAllowPartialReplay] = useState(false);
  const [importedTranscript, setImportedTranscript] = useState<MatchTranscript | null>(null);
  const [replayResult, setReplayResult] = useState<TranscriptVerificationResult | null>(null);
  const [replayFrame, setReplayFrame] = useState(0);
  const [isReplayPlaying, setIsReplayPlaying] = useState(false);
  const [devMode, setDevMode] = useState(false);
  const [arenaScale, setArenaScale] = useState(1);

  // Main-wallet access is read-only evidence admission; this client sends no transactions.
  const [mainWalletAddress, setMainWalletAddress] = useState("");
  const [chainLabel, setChainLabel] = useState("");
  const [arenaAddress, setArenaAddress] = useState("");
  const [onchainChallengeId, setOnchainChallengeId] = useState("");
  const mainSignerRef = useRef<Signer | null>(null);

  const matchIdRef = useRef(matchId);
  const stateRef = useRef(state);
  const walletRef = useRef<SessionWallet | null>(wallet);
  const localSlotRef = useRef<PlayerSlot>(localSlot);
  const remoteWalletPubKeyRef = useRef(remoteWalletPubKey);

  const arenaWrapRef = useRef<HTMLDivElement>(null);
  const peerRef = useRef<Peer | null>(null);
  const connRef = useRef<DataConnection | null>(null);
  const challengeRef = useRef(makeMatchId());
  const authenticatedConnRef = useRef<DataConnection | null>(null);
  const intervalRef = useRef<number | null>(null);
  const keyState = useRef<Record<string, boolean>>({});
  const liveRef = useRef<LiveMatch | null>(null);
  const storeRef = useRef<BrowserEvidenceStore | null>(null);
  const generationRef = useRef(0);
  const preparationRef = useRef<symbol | null>(null);
  const admissionRef = useRef<Promise<void>>(Promise.resolve());
  const tickInFlightRef = useRef(false);
  const frameHeadRef = useRef(ZERO32);
  const genesisSessionRef = useRef<ReturnType<typeof createGenesisSession> | null>(null);
  const escrowRef = useRef<{ config: LiveConfig; record: GenesisRecord } | null>(null);
  const [authorizationInput, setAuthorizationInput] = useState("");
  const [disputeBundleInput, setDisputeBundleInput] = useState("");
  const [disputeComparisonInput, setDisputeComparisonInput] = useState("");
  const [disputeFrame, setDisputeFrame] = useState("1");
  const [disputeWitnessOutput, setDisputeWitnessOutput] = useState("");
  const [liveStatus, setLiveStatus] = useState("practice discovery");
  const [savedContexts, setSavedContexts] = useState<string[]>([]);
  const retryRef = useRef(0);
  function evidenceStore() { return storeRef.current ??= new BrowserEvidenceStore(); }
  const syncLive = useCallback((live: LiveMatch) => {
    if (liveRef.current !== live) return;
    const snapshot = live.snapshot();
    setLiveStatus(`${snapshot.config.mode}: ${snapshot.status}`);
    stateRef.current = snapshot.state; setState(snapshot.state);
    setPackets(snapshot.packets); setCanonicalFrames(snapshot.frames);
    frameHeadRef.current = snapshot.frameHead; setFinalFrameHash(snapshot.frameHead);
    setIsRunning(snapshot.status === "running");
  }, []);

  useEffect(() => { void evidenceStore().contexts().then(setSavedContexts).catch(e => setLastError(String(e))); }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const w = await createSessionWallet();
      if (mounted) {
        updateWallet(w);
        sendHello();
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (GAME_KEYS.has(key)) e.preventDefault();
      keyState.current[key] = true;
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
      // This is a generation counter, not a DOM ref; invalidate current work on cleanup.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generationRef.current++;
      liveRef.current?.close();
      connRef.current?.close?.();
      peerRef.current?.destroy?.();
    };
  }, []);

  // Scale the fixed 720x360 stage to fill its container (internal coordinates
  // stay the same, so game logic/verification are unaffected).
  useEffect(() => {
    const el = arenaWrapRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      if (w > 0) setArenaScale(Math.min(1.7, Math.max(0.4, w / toDisplayUnits(WIDTH))));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  function updateMatchId(nextMatchId: string) {
    matchIdRef.current = nextMatchId;
    setMatchId(nextMatchId);
  }

  function updateWallet(nextWallet: SessionWallet) {
    walletRef.current = nextWallet;
    setWallet(nextWallet);
  }

  function updateLocalSlot(nextSlot: PlayerSlot) {
    localSlotRef.current = nextSlot;
    setLocalSlot(nextSlot);
  }

  function updateRemoteWalletPubKey(nextPubKey: string) {
    remoteWalletPubKeyRef.current = nextPubKey;
    setRemoteWalletPubKey(nextPubKey);
  }

  function sendHello(conn = connRef.current) {
    if (conn?.open) conn.send({ type: "CHALLENGE", nonce: challengeRef.current });
  }

  const log = useCallback((line: string) => {
    setLogs((prev) => [line, ...prev].slice(0, 100));
  }, []);

  async function initPeer(as: "host" | "joiner") {
    try {
      setLastError("");
      if (liveRef.current || genesisSessionRef.current || preparationRef.current) throw new Error("Reset locally before changing role.");
      generationRef.current++;
      peerRef.current?.destroy?.();
      connRef.current?.close?.();

      const peer = createPeer();
      peerRef.current = peer;
      setRole(as);
      updateLocalSlot(as === "host" ? 1 : 2);

      peer.on("open", (id: string) => {
        if (peerRef.current !== peer) return;
        setPeerId(id);
        log(`peer open: ${id}`);
      });

      peer.on("connection", (conn) => {
        if (peerRef.current !== peer || as !== "host" || connRef.current?.open) { conn.close(); return; }
        connRef.current = conn;
        bindConnection(conn, 1);
      });

      peer.on("error", (err) => {
        if (peerRef.current !== peer) return;
        setLastError(String(err));
        log(`peer error: ${String(err)}`);
      });
    } catch (e) {
      setLastError(String(e));
    }
  }

  function bindConnection(conn: DataConnection, slotForLocal: PlayerSlot) {
    const generation = ++generationRef.current;
    const live = liveRef.current;
    live?.attach();
    authenticatedConnRef.current = null;
    challengeRef.current = makeMatchId();
    let queued = 0;
    const current = () => generationRef.current === generation && connRef.current === conn;
    conn.on("open", () => {
      if (!current()) return;
      updateLocalSlot(slotForLocal);
      sendHello(conn);
    });
    conn.on("data", (raw: unknown) => {
      if (!current()) return;
      // Bound the wire payload before cloning and expensive cryptography.
      try { if (JSON.stringify(raw).length > 16000) throw new Error("Message too large"); }
      catch { return; }
      if (queued >= 128) return;
      queued++;
      const value = structuredClone(raw);
      admissionRef.current = admissionRef.current.then(async () => {
        if (!current()) return;
        await handleNetMessage(value, current);
      }).catch(e => { if (current()) { setLastError(String(e)); if (liveRef.current) syncLive(liveRef.current); } }).finally(() => { queued--; });
    });
    conn.on("close", () => {
      if (!current()) return;
      generationRef.current++;
      setIsConnected(false); setIsRunning(false);
      const active = liveRef.current;
      if (active) { const token = active.attach(); void active.transport(false, token).then(() => syncLive(active)).catch(e => setLastError(String(e))); }
      log("connection closed; evidence retained");
    });
    conn.on("error", (err) => { if (current()) setLastError(String(err)); });
  }

  async function connectToHost() {
    try {
      if (!peerRef.current) {
        setLastError("Initialize as joiner first.");
        return;
      }
      if (connRef.current?.open) throw new Error("Already connected");
      const conn = peerRef.current.connect(remotePeerId.trim());
      connRef.current = conn;
      bindConnection(conn, 2);
    } catch (e) {
      setLastError(String(e));
    }
  }

  async function handleNetMessage(raw: unknown, current: () => boolean) {
    if (!object(raw) || typeof raw.type !== "string") throw new Error("Invalid envelope");
    if (raw.type === "CHALLENGE") {
      if (Object.keys(raw).sort().join() !== "nonce,type" || !hex(raw.nonce, 32)) throw new Error("Invalid discovery challenge");
      const key = walletRef.current;
      if (!key) return;
      const message = await hello(key, matchIdRef.current, localSlotRef.current, raw.nonce);
      if (current()) connRef.current?.send(message);
      return;
    }
    if (raw.type === "HELLO") {
      const msg = verifyHello(raw, challengeRef.current);
      if (!current()) return;
      if (msg.slot === localSlotRef.current) throw new Error("Wrong discovery slot");
      const live = liveRef.current;
      const bound = live?.config ?? escrowRef.current?.config;
      const pinnedKey = bound ? (msg.slot === 1 ? bound.p1PublicKey : bound.p2PublicKey) : remoteWalletPubKeyRef.current;
      if (pinnedKey && msg.publicKey !== pinnedKey) throw new Error("Peer identity changed; reset locally for a new match");
      if (bound && msg.matchId !== bound.matchId) throw new Error("Wrong reconnect genesis");
      setRemoteWalletAddress(addressFromPublicKey(msg.publicKey)); updateRemoteWalletPubKey(msg.publicKey);
      if (msg.slot === 1 && !live) updateMatchId(msg.matchId);
      if (live) {
        await live.transport(true); if (!current()) return;
        if (localSlotRef.current === 1) {
          const ready = await live.consent(); if (!current()) return;
          connRef.current?.send({ type: "OFFER", config: live.config, ready });
        } else for (const message of live.retransmit()) connRef.current?.send(message);
        syncLive(live);
      }
      authenticatedConnRef.current = connRef.current;
      setIsConnected(true);
      log(`authenticated discovery from P${msg.slot}`);
      return;
    }
    if (authenticatedConnRef.current !== connRef.current) throw new Error("Authenticate discovery first");
    if (raw.type === "OFFER") {
      if (preparationRef.current) throw new Error("Finish local match preparation before accepting an offer");
      if (Object.keys(raw).sort().join() !== "config,ready,type" || localSlotRef.current !== 2 || !walletRef.current || !remoteWalletPubKeyRef.current) throw new Error("Unexpected offer");
      const config = raw.config as LiveConfig;
      const context = configHash(config);
      verifyReady(config, raw.ready, 1);
      if (config.matchId !== matchIdRef.current || config.p1PublicKey !== remoteWalletPubKeyRef.current || config.p2PublicKey !== walletRef.current.publicKey) throw new Error("Offer identity mismatch");
      if (config.mode === "escrow" && (!escrowRef.current || configHash(escrowRef.current.config) !== context)) throw new Error("Load authoritative escrow locally first");
      if (config.mode === "practice" && (escrowRef.current || genesisSessionRef.current)) throw new Error("Cannot downgrade escrow to practice");
      let live = liveRef.current;
      if (live && live.context !== context) throw new Error("Cannot replace active genesis");
      if (!live) {
        live = await LiveMatch.create(config, evidenceStore(), 2, walletRef.current, escrowRef.current?.record);
        if (!current()) { live.close(); return; }
        liveRef.current = live;
      }
      await live.receive(raw.ready); if (!current()) return;
      const ready = await live.consent(); if (!current()) return;
      connRef.current?.send(ready); syncLive(live);
      return;
    }
    const live = liveRef.current;
    if (!live) throw new Error("No admitted live match");
    const outbound = await live.receive(raw);
    if (!current()) return;
    outbound.forEach(message => connRef.current?.send(message)); syncLive(live);
  }

  // Symmetric controls: every player uses the same keys for their own fighter
  // (each runs in their own tab/browser, so there is no shared keyboard).
  const currentLocalInputMask = useCallback(() => {
    const k = keyState.current;
    return encodeInputMask({
      left: !!(k["a"] || k["arrowleft"]),
      right: !!(k["d"] || k["arrowright"]),
      up: !!(k["w"] || k["arrowup"]),
      attack: !!(k[" "] || k["f"] || k["j"] || k["k"] || k["/"]),
    });
  }, []);

  const tick = useCallback(async () => {
    if (tickInFlightRef.current) return;
    const live = liveRef.current, conn = connRef.current, generation = generationRef.current;
    if (!live || !conn?.open) return;
    tickInFlightRef.current = true;
    try {
      const outbound = await live.tick(currentLocalInputMask());
      if (generation !== generationRef.current || liveRef.current !== live || connRef.current !== conn) return;
      outbound.forEach(message => conn.send(message));
      if (Date.now() - retryRef.current > 500) {
        retryRef.current = Date.now();
        const request = await live.requestMissing();
        if (generation !== generationRef.current || liveRef.current !== live) return;
        if (request) conn.send(request);
      }
      syncLive(live);
    } catch (error) { if (generation === generationRef.current) { setLastError(String(error)); syncLive(live); } }
    finally { tickInFlightRef.current = false; }
  }, [currentLocalInputMask, syncLive]);

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
      const stateHash = hashTraceState(state);
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
      const result = await verifyTranscript(parsed, { allowPartial: allowPartialReplay });
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

  async function resetLocal() {
    const generation = ++generationRef.current;
    preparationRef.current = null;
    liveRef.current?.close(); liveRef.current = null; escrowRef.current = null; genesisSessionRef.current = null;
    connRef.current?.close(); connRef.current = null;
    setIsConnected(false); setIsRunning(false);
    const newWallet = await createSessionWallet();
    if (generation !== generationRef.current) return;
    updateWallet(newWallet); updateMatchId(makeMatchId());
    stateRef.current = initialState(); setState(stateRef.current);
    setPackets([]); setCanonicalFrames([]); setFinalFrameHash(ZERO32); setFinalStateHash("");
    setRemoteWalletAddress(""); updateRemoteWalletPubKey(""); setLastError(""); setLiveStatus("practice discovery");
    setSavedContexts(await evidenceStore().contexts());
  }

  async function startMatch() {
    const generation = generationRef.current, conn = connRef.current, key = walletRef.current;
    if (!isConnected || !conn?.open || !key || localSlotRef.current !== 1) return;
    const preparation = Symbol("match preparation");
    try {
      if (preparationRef.current) throw new Error("Match preparation already in progress");
      preparationRef.current = preparation;
      if (genesisSessionRef.current && !escrowRef.current) throw new Error("This key adopted an escrow binding; load its activation or reset locally.");
      const config: LiveConfig = escrowRef.current?.config ?? { version: 1, mode: "practice", matchId: matchIdRef.current, rulesHash: CANONICAL_RULES_HASH, p1PublicKey: key.publicKey, p2PublicKey: remoteWalletPubKeyRef.current };
      let live = liveRef.current;
      if (!live) {
        live = await LiveMatch.create(config, evidenceStore(), 1, key, escrowRef.current?.record);
        if (generation !== generationRef.current) { live.close(); return; }
        liveRef.current = live;
      }
      const ready = await live.consent();
      if (generation !== generationRef.current) return;
      conn.send({ type: "OFFER", config: live.config, ready }); syncLive(live);
    } catch (error) { if (generation === generationRef.current) setLastError(String(error)); }
    finally { if (preparationRef.current === preparation) preparationRef.current = null; }
  }

  async function exportGenesisConsent() {
    const generation = generationRef.current, key = walletRef.current, signer = mainSignerRef.current;
    const preparation = Symbol("match preparation");
    try {
      if (preparationRef.current) throw new Error("Match preparation already in progress");
      preparationRef.current = preparation;
      if (!key || !signer?.provider || liveRef.current) throw new Error("Connect main wallet before signing genesis consent");
      const chainId = (await signer.provider.getNetwork()).chainId.toString();
      const record = await readGenesisRecord(signer.provider, { chainId, arena: arenaAddress.trim(), challengeId: onchainChallengeId.trim() });
      if (generation !== generationRef.current) return;
      const player = await signer.getAddress();
      if (generation !== generationRef.current || liveRef.current) return;
      const session = genesisSessionRef.current ??= createGenesisSession(key, localSlotRef.current, player);
      const signature = await session.authorize(record);
      if (generation !== generationRef.current || liveRef.current) return;
      const consent = { binding: record.binding, slot: localSlotRef.current, publicKey: key.publicKey, signature };
      const context = `consent:${hashGenesisBinding(record.binding)}:${localSlotRef.current}`;
      const existing = await evidenceStore().read(context);
      if (!existing.length) await evidenceStore().initialize(context, { kind: "genesis-consent", consent, lookup: record.lookup });
      else if (!verifyGenesisConsent(existing[0].consent) || JSON.stringify(existing[0].consent) !== JSON.stringify(consent)) throw new Error("Conflicting saved genesis consent");
      if (generation !== generationRef.current || liveRef.current) return;
      downloadText("genesis-consent.json", JSON.stringify(consent, null, 2));
    } catch (error) { if (generation === generationRef.current) setLastError(String(error)); }
    finally { if (preparationRef.current === preparation) preparationRef.current = null; }
  }

  async function loadEscrow() {
    const generation = generationRef.current;
    const preparation = Symbol("match preparation");
    try {
      if (preparationRef.current) throw new Error("Match preparation already in progress");
      preparationRef.current = preparation;
      if (liveRef.current || !walletRef.current || !mainSignerRef.current?.provider) throw new Error("Connect main wallet and discover peer before loading a match");
      const signer = mainSignerRef.current, provider = signer.provider!;
      const chainId = (await provider.getNetwork()).chainId.toString();
      const record = await readGenesisRecord(provider, { chainId, arena: arenaAddress.trim(), challengeId: onchainChallengeId.trim() });
      if (generation !== generationRef.current || liveRef.current) return;
      const key = walletRef.current;
      const authorization = JSON.parse(authorizationInput) as GenesisAuthorization;
      const player = await signer.getAddress();
      if (generation !== generationRef.current || liveRef.current) return;
      const session = genesisSessionRef.current ??= createGenesisSession(key, localSlotRef.current, player);
      await session.authorize(record); session.activate(authorization, record);
      if (generation !== generationRef.current || liveRef.current) return;
      const config: LiveConfig = { version: 1, mode: "escrow", matchId: record.binding.genesis, rulesHash: CANONICAL_RULES_HASH,
        p1PublicKey: localSlotRef.current === 1 ? key.publicKey : remoteWalletPubKeyRef.current,
        p2PublicKey: localSlotRef.current === 2 ? key.publicKey : remoteWalletPubKeyRef.current, authorization };
      configHash(config);
      escrowRef.current = { config, record }; updateMatchId(config.matchId); setLiveStatus("escrow authorized; ready to start");
    } catch (error) { if (generation === generationRef.current) setLastError(String(error)); }
    finally { if (preparationRef.current === preparation) preparationRef.current = null; }
  }

  async function inspectEvidence(context: string) {
    try {
      if (context.startsWith("consent:")) {
        const events = await evidenceStore().read(context);
        if (events.length !== 1 || events[0].kind !== "genesis-consent" || !verifyGenesisConsent(events[0].consent)) throw new Error("Invalid saved genesis consent");
        downloadText("recovered-genesis-consent.json", JSON.stringify(events[0], null, 2));
        return;
      }
      const archive: EvidenceArchive = { format: "phase-b-journal-v1", journal: await evidenceStore().read(context) };
      const bundle = await buildEvidenceBundle(archive);
      downloadText(`evidence-${context.slice(2, 10)}.json`, canonicalJson(bundle));
      log(`Recovered evidence: ${bundle.reconstruction.status}; inspection only, signing remains unavailable.`);
    } catch (error) { setLastError(String(error)); }
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

  async function copy(text: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
      // Fallback for non-secure contexts (plain http): the Clipboard API is
      // unavailable, so use a temporary textarea + execCommand.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (!ok) throw new Error("copy command rejected");
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
      ? "Draw"
      : "In progress";

  const nextFrame = state.frame + 1;
  const localPending = packets.some(p => p.frame === nextFrame && p.player === localSlot);
  const remoteSlot: PlayerSlot = localSlot === 1 ? 2 : 1;
  const remotePending = packets.some(p => p.frame === nextFrame && p.player === remoteSlot);
  const syncText = state.roundOver
    ? "Round complete"
    : !isRunning
    ? "Idle"
    : localPending && remotePending
    ? `Ready to advance frame ${nextFrame}`
    : localPending
    ? `Waiting for P${remoteSlot} packet ${nextFrame}`
    : `Ready to sign packet ${nextFrame}`;

  async function exportTranscript(copyOnly = false) {
    try {
      const live = liveRef.current;
      if (!live) throw new Error("No durable live evidence; use saved evidence inspection after reload.");
      const result = await reconstructEvidence(await live.exportEvidence());
      if (result.status !== "complete" || !result.transcript) throw new Error(`Evidence is ${result.status}; export the evidence bundle for inspection.`);
      const json = canonicalJson(result.transcript);
      if (copyOnly) await copy(json);
      else downloadText(`transcript-${result.config.matchId.slice(0, 10)}.json`, json);
    } catch (error) { setLastError(String(error)); }
  }

  async function exportDisputeEvidence() {
    try {
      const live = liveRef.current;
      if (!live) throw new Error("No live evidence; use a saved evidence entry after reload.");
      const bundle = await buildEvidenceBundle(await live.exportEvidence());
      downloadText(`dispute-evidence-${bundle.reconstruction.context.slice(2, 10)}.json`, canonicalJson(bundle));
      log(`Exported ${bundle.reconstruction.status} evidence (${bundle.authority}).`);
    } catch (error) { setLastError(String(error)); }
  }

  async function exportTraceClaimWitness() {
    try {
      const live = liveRef.current, escrow = escrowRef.current;
      if (!live || !escrow) throw new Error("Load an activated escrow match before preparing a trace claim.");
      const bundle = await buildEvidenceBundle(await live.exportEvidence(), escrow.record);
      const witness = await prepareTraceClaim(bundle, escrow.record);
      downloadText(`trace-claim-${bundle.reconstruction.context.slice(2, 10)}.json`, canonicalJson(witness));
      log("Exported an independently authorized trace-claim witness; settlement remains disabled.");
    } catch (error) { setLastError(String(error)); }
  }

  async function prepareDisputeWitness(kind: "claim" | "midpoint" | "step") {
    try {
      const escrow = escrowRef.current;
      if (!escrow) throw new Error("Load a freshly verified activated escrow record first.");
      let archive: unknown;
      if (disputeBundleInput.trim()) {
        const supplied = JSON.parse(disputeBundleInput) as { archive?: unknown };
        archive = supplied.archive ?? supplied;
      } else {
        if (!liveRef.current) throw new Error("Paste an evidence bundle or keep the live match open.");
        archive = await liveRef.current.exportEvidence();
      }
      const bundle = await buildEvidenceBundle(archive, escrow.record);
      const frame = Number(disputeFrame);
      const result = kind === "claim" ? await prepareTraceClaim(bundle, escrow.record)
        : kind === "midpoint" ? await prepareMidpointOpening(bundle, frame, escrow.record)
        : await prepareAdjudicationWitness(bundle, frame, JSON.parse(disputeComparisonInput) as AdjudicationComparison, escrow.record);
      setDisputeWitnessOutput(canonicalJson(result));
    } catch (error) { setLastError(String(error)); }
  }

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
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <h1 style={styles.h1}>Crypto Fighter</h1>
              <button style={styles.buttonSecondary} onClick={() => setDevMode((v) => !v)}>
                {devMode ? "Dev mode" : "Regular mode"}
              </button>
            </div>
            <div style={styles.sub}>
              Controls — Move: A/D or ←/→ · Jump: W/↑ · Attack: Space (or F/J/K)
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
                disabled={!isConnected || isRunning || localSlot !== 1 || state.roundOver}
              >
                Start Match
              </button>
              <button style={styles.buttonSecondary} onClick={() => void resetLocal()}>
                New Match
              </button>
            </div>

            <div style={styles.grid4}>
              <Stat title="Live mode" value={liveStatus} />
              <Stat title="Match ID" value={short(matchId, 14)} />
              <Stat title="Role / Slot" value={`${role} / P${localSlot}`} />
              <Stat title="Frame" value={`${displayState.frame} / ${ROUND_FRAMES}`} />
              <Stat title="Timer" value={`${(displayState.timerFramesLeft / FPS).toFixed(2)}s`} />
              <Stat title="Sync" value={replayResult ? `Replay ${replayFrame}/${replayResult.states.length - 1}` : syncText} />
            </div>
          </section>

          <section style={styles.panel}>
            <h2 style={styles.h2}>Peer connection</h2>
            <div style={styles.rowWrap}>
              <div>
                <div style={styles.label}>Your Peer ID</div>
                <div data-testid="peer-id" style={styles.codeBox}>{peerId || "initialize first"}</div>
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
            <div style={styles.sub}>Practice discovery proves session-key possession; it does not authorize escrow.</div>
            <button style={styles.smallButton} onClick={() => { connRef.current?.close(); }}>Disconnect</button>
            <button style={styles.smallButton} onClick={() => void exportDisputeEvidence()}>Export dispute evidence</button>
            <button style={styles.smallButton} onClick={() => void evidenceStore().contexts().then(setSavedContexts).catch(e => setLastError(String(e)))}>Refresh saved evidence</button>
            {savedContexts.map(context => <button key={context} style={styles.smallButton} onClick={() => void inspectEvidence(context)}>Inspect {short(context, 16)}</button>)}
            {lastError ? <div style={styles.error}>{lastError}</div> : null}
          </section>

          <section style={styles.grid2}>
            <PlayerCard
              title="Player 1"
              controls="A/D · W · Space"
              hp={displayState.p1.hp}
              maxHp={MAX_HP}
              address={localSlot === 1 ? wallet?.address ?? "generating..." : remoteWalletAddress || "waiting..."}
              publicKey={localSlot === 1 ? wallet?.publicKey ?? "generating..." : remoteWalletPubKey || "waiting..."}
              onCopy={copy}
            />
            <PlayerCard
              title="Player 2"
              controls="A/D · W · Space"
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
            <div ref={arenaWrapRef} style={{ width: "100%" }}>
              <div aria-label="Game arena" style={{ ...styles.arena, width: toDisplayUnits(WIDTH) * arenaScale, height: toDisplayUnits(HEIGHT) * arenaScale, margin: "0 auto" }}>
              <div style={{ ...styles.floor, top: toDisplayUnits(FLOOR_Y) * arenaScale }} />
              <div
                aria-label="Player 1 fighter"
                style={{
                  ...styles.p1,
                  left: toDisplayUnits(displayState.p1.x) * arenaScale,
                  top: toDisplayUnits(displayState.p1.y) * arenaScale,
                  width: toDisplayUnits(FIGHTER_W) * arenaScale,
                  height: toDisplayUnits(FIGHTER_H) * arenaScale,
                }}
              />
              <div
                aria-label="Player 2 fighter"
                style={{
                  ...styles.p2,
                  left: toDisplayUnits(displayState.p2.x) * arenaScale,
                  top: toDisplayUnits(displayState.p2.y) * arenaScale,
                  width: toDisplayUnits(FIGHTER_W) * arenaScale,
                  height: toDisplayUnits(FIGHTER_H) * arenaScale,
                }}
              />

              {p1AttackRect && (
                <div aria-label="Player 1 attack"
                  style={{
                    ...styles.p1Attack,
                    left: toDisplayUnits(p1AttackRect.x) * arenaScale,
                    top: toDisplayUnits(p1AttackRect.y) * arenaScale,
                    width: toDisplayUnits(p1AttackRect.w) * arenaScale,
                    height: toDisplayUnits(p1AttackRect.h) * arenaScale,
                  }}
                />
              )}
              {p2AttackRect && (
                <div aria-label="Player 2 attack"
                  style={{
                    ...styles.p2Attack,
                    left: toDisplayUnits(p2AttackRect.x) * arenaScale,
                    top: toDisplayUnits(p2AttackRect.y) * arenaScale,
                    width: toDisplayUnits(p2AttackRect.w) * arenaScale,
                    height: toDisplayUnits(p2AttackRect.h) * arenaScale,
                  }}
                />
              )}
              </div>
            </div>

            <div style={styles.grid3}>
              <Stat title="Outcome" value={outcomeText} />
              {devMode && <Stat title="Canonical head" value={short(displayFrameHash, 24)} />}
              {devMode && <Stat title="Final state hash" value={displayStateHash ? short(displayStateHash, 24) : "pending"} />}
            </div>
          </section>
        </div>

        <div style={styles.rightCol}>
          {devMode && (
            <>
          <section style={styles.panel}>
            <h2 style={styles.h2}>Transcript replay</h2>
            <div style={styles.sub}>Paste or import a transcript JSON to verify and replay it locally.</div>
            <label>
              <input type="checkbox" checked={allowPartialReplay} onChange={(event) => setAllowPartialReplay(event.target.checked)} />
              Allow partial replay (never payout evidence)
            </label>
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
                  {replayResult.ok && !replayResult.complete ? " | partial replay only" : ""}
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
              <button style={styles.smallButton} onClick={() => void exportTranscript(true)}>
                Copy Transcript
              </button>
              <button
                style={styles.smallButton}
                onClick={() => void exportTranscript()}
              >
                Download JSON
              </button>
            </div>
          </section>
            </>
          )}

          <section style={styles.panel}>
            <h2 style={styles.h2}>Escrow evidence</h2>
            <div style={styles.sub}>
              Practice games never touch a contract. For an escrow game, connect the main wallet only to load and verify an already activated local-chain match. This client sends no transactions. Session address:{" "}
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
                value={onchainChallengeId}
                onChange={(e) => setOnchainChallengeId(e.target.value)}
                placeholder="Challenge id"
              />
            </div>
            <textarea aria-label="Genesis authorization" placeholder="Activated genesis authorization JSON" value={authorizationInput} onChange={event => setAuthorizationInput(event.target.value)} />
            <button style={styles.smallButton} onClick={() => void exportGenesisConsent()}>Export genesis consent</button>
            <button style={styles.smallButton} onClick={() => void loadEscrow()}>Load activated escrow match</button>
            <button style={styles.smallButton} onClick={() => void exportTraceClaimWitness()} disabled={!state.roundOver || !escrowRef.current}>
              Export trace-claim witness
            </button>
          </section>

          {devMode && (
          <section style={styles.panel}>
            <h2 style={styles.h2}>Dispute witness preparation</h2>
            <div style={styles.sub}>Uses a freshly loaded escrow record and rebuilds supplied Phase C evidence. It prepares calldata only and sends no transaction.</div>
            <textarea aria-label="Phase C dispute bundle" style={styles.textarea} value={disputeBundleInput} onChange={event => setDisputeBundleInput(event.target.value)} placeholder="Phase C bundle JSON (optional while live match is open)" />
            <input style={styles.input} value={disputeFrame} onChange={event => setDisputeFrame(event.target.value)} placeholder="Midpoint or isolated frame" />
            <textarea aria-label="Adjudication comparison" style={styles.textarea} value={disputeComparisonInput} onChange={event => setDisputeComparisonInput(event.target.value)} placeholder="Committed roots and claimant/challenger openings for an isolated step" />
            <div style={styles.row}>
              <button style={styles.smallButton} onClick={() => void prepareDisputeWitness("claim")}>Prepare claim</button>
              <button style={styles.smallButton} onClick={() => void prepareDisputeWitness("midpoint")}>Prepare midpoint</button>
              <button style={styles.smallButton} onClick={() => void prepareDisputeWitness("step")}>Prepare isolated step</button>
            </div>
            <pre style={styles.pre}>{disputeWitnessOutput || "No witness prepared."}</pre>
          </section>
          )}

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
    // minmax(0, ...) lets columns shrink below their content instead of
    // overflowing/clipping the page on narrower windows.
    gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 0.8fr)",
    gap: 20,
    minHeight: 0,
  },
  leftCol: {
    display: "grid",
    gap: 16,
    alignContent: "start",
    minWidth: 0,
    minHeight: 0,
    overflowY: "auto",
    paddingRight: 6,
  },
  rightCol: {
    display: "grid",
    gap: 16,
    alignContent: "start",
    minWidth: 0,
    minHeight: 0,
    overflowY: "auto",
    paddingRight: 6,
  },
  panel: {
    border: "1px solid #27272a",
    background: "#111113",
    borderRadius: 16,
    padding: 16,
    minWidth: 0,
    overflowX: "auto",
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
    width: toDisplayUnits(WIDTH),
    height: toDisplayUnits(HEIGHT),
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
