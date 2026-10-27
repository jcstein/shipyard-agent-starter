/** Eden mainnet, Celestia's native EVM chain. Gas and escrow deposits are real TIA. */
export const EDEN_CHAIN_ID = 714;
export const EDEN_NETWORK = "eip155:714";
/** Public Eden RPC. `eth_chainId` returns 0x2ca (714). */
export const EDEN_RPC_URL = "https://rpc.eden.gateway.fm/";
export const NATIVE_ESCROW = "0x65d77c98E73DFbEA91eCb72B27c9753e186a94c8";
export const EXPLORER = "https://eden.blockscout.com";
export const HOUSTON_INFERENCE = "https://inference.bot.fun/v1";

/** Blockscout transaction page for an Eden deposit. */
export function edenTxUrl(txHash: string): string {
  return `${EXPLORER}/tx/${txHash}`;
}

/** Mocha-5 testnet. Blobs posted here are logs, not revenue and not Eden payments. */
export const MOCHA_CHAIN = "mocha-5";
/** Public DA JSON-RPC. Reads only. The helper uses this to fetch blobs. */
export const MOCHA_PUBLIC_RPC = "https://public-endpoint.celestia-mocha.quiknode.pro";
/** Public consensus gRPC. The helper submits PayForBlobs here over TLS. */
export const MOCHA_PUBLIC_CORE_GRPC = "public-endpoint.celestia-mocha.quiknode.pro:9090";
export const MOCHA_EXPLORER = "https://mocha.celenium.io";
export const MOCHA_FAUCET = `${MOCHA_EXPLORER}/faucet`;

/** 10-byte v0 namespace id. The same id is used by every team that keeps the default. */
export const APP_NAMESPACE_ID = "shipyardmm";
