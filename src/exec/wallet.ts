import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

export type Wallet = {
  connection: Connection;
  keypair: Keypair | null;
  publicKey: string | null;
  invalidSecret: boolean;
};

function parseSecret(raw: string): Uint8Array {
  if (raw.startsWith("[")) return Uint8Array.from(JSON.parse(raw) as number[]);
  return bs58.decode(raw);
}

export function loadWallet(secret: string, rpcUrl: string): Wallet {
  const connection = new Connection(rpcUrl, "confirmed");
  if (!secret || secret.includes("...")) {
    return { connection, keypair: null, publicKey: null, invalidSecret: false };
  }
  try {
    const keypair = Keypair.fromSecretKey(parseSecret(secret));
    return {
      connection,
      keypair,
      publicKey: keypair.publicKey.toBase58(),
      invalidSecret: false,
    };
  } catch {
    return { connection, keypair: null, publicKey: null, invalidSecret: true };
  }
}

export async function solBalance(connection: Connection, publicKey: string): Promise<number | null> {
  try {
    const lamports = await connection.getBalance(new PublicKey(publicKey), "confirmed");
    return lamports / 1e9;
  } catch {
    return null;
  }
}
