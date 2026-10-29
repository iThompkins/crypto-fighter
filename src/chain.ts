import { BrowserProvider, type Eip1193Provider, type Signer } from "ethers";

function injected(): Eip1193Provider {
  const eth = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  if (!eth) throw new Error("No injected wallet (install MetaMask).");
  return eth;
}

export type WalletConnection = {
  provider: BrowserProvider;
  signer: Signer;
  address: string;
  chainId: bigint;
};

export async function connectWallet(): Promise<WalletConnection> {
  const provider = new BrowserProvider(injected());
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  const address = await signer.getAddress();
  const net = await provider.getNetwork();
  return { provider, signer, address, chainId: net.chainId };
}
