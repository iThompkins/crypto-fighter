export type PlayerSlot = 1 | 2;

export type Fighter = {
  x: number;
  y: number;
  w: number;
  h: number;
  hp: number;
  facing: 1 | -1;
  attackCooldown: number;
  attackActive: number;
};

export type GameState = {
  frame: number;
  timerFramesLeft: number;
  p1: Fighter;
  p2: Fighter;
  winner: "P1" | "P2" | "TIE_BOTH_LOSE" | null;
  roundOver: boolean;
};

export type SignedInputPacket = {
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

export type CanonicalFrame = {
  matchId: string;
  frame: number;
  p1InputMask: number;
  p2InputMask: number;
  prevFrameHash: string;
  frameHash: string;
};

export type TranscriptPlayer = {
  slot: PlayerSlot;
  address: string;
  publicKey: string;
};

export type MatchTranscript = {
  version: 1;
  matchId: string;
  rules: {
    fps: number;
    roundFrames: number;
    maxHp: number;
    oneOutstandingPacket: true;
  };
  players: {
    p1: TranscriptPlayer;
    p2: TranscriptPlayer;
  };
  packets: SignedInputPacket[];
  canonicalFrames: CanonicalFrame[];
  final: {
    frame: number;
    frameHash: string;
    stateHash: string;
    p1Hp: number;
    p2Hp: number;
    winner: GameState["winner"];
    roundOver: boolean;
  };
};

export type SessionWallet = {
  address: string;
  // Uncompressed secp256k1 public key (0x04-prefixed hex).
  publicKey: string;
  // secp256k1 private key as 0x-prefixed hex.
  privateKey: string;
};

export type NetEnvelope =
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
