"use client";

import algosdk from "algosdk";

import { getAlgodClient, getIndexerClient } from "./algorand";

// ─── Types ────────────────────────────────────────────────────────────
export interface NftData {
  tokenId: number;
  metadata: any;
  owner: string;
  /** Total fan donations received (microAlgos) */
  totalDonations: bigint;
}

// ─── Helpers ──────────────────────────────────────────────────────────
function normalizeIpfsUrl(url?: string): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("ipfs://")) {
    return trimmed.replace("ipfs://", "https://gateway.pinata.cloud/ipfs/");
  }
  if (/^[a-zA-Z0-9]{46,}$/.test(trimmed) && !trimmed.startsWith("http")) {
    return `https://gateway.pinata.cloud/ipfs/${trimmed}`;
  }
  return trimmed;
}

async function safeFetchJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Fetch on-chain donation total for an NFT owner address.
 *
 * Donations are plain ALGO payment txns sent TO the owner with a note
 * containing "FanFunding donation for <tokenId>".
 *
 * We query the Indexer for pay txns received by the owner and sum the
 * amounts whose note matches the tokenId.
 */
async function fetchDonationTotalForToken(
  owner: string,
  tokenId: number
): Promise<bigint> {
  const indexer = getIndexerClient();
  const notePrefix = `FanFunding donation for ${tokenId}`;

  try {
    // Search pay txns to the owner with matching note-prefix
    const res = await indexer
      .searchForTransactions()
      .address(owner)
      .txType("pay")
      .notePrefix(new TextEncoder().encode(notePrefix))
      .limit(200)
      .do();

    const txns = ((res as any)?.transactions ?? []) as any[];

    let total = 0n;
    for (const t of txns) {
      // Payment receiver must be the owner
      const payReceiver =
        t?.["payment-transaction"]?.receiver ?? t?.paymentTransaction?.receiver;
      if (payReceiver !== owner) continue;

      const rawAmt =
        t?.["payment-transaction"]?.amount ?? t?.paymentTransaction?.amount ?? 0;
      const amt = typeof rawAmt === "bigint" ? rawAmt : BigInt(rawAmt);
      total += amt;
    }

    console.log(
      `[nftService] Donation total for token ${tokenId}: ${total} microAlgos`
    );
    return total;
  } catch (err) {
    console.warn(
      `[nftService] Failed to fetch donation total for token ${tokenId}:`,
      err
    );
    return 0n;
  }
}

// ─── Main fetch function: SINGLE SOURCE OF TRUTH ─────────────────────
/**
 * Fetches ALL NFTs held by `account` from the Algorand Indexer, resolves
 * their metadata from IPFS, and computes on-chain donation totals.
 *
 * This is the ONLY function that should be called to get NFT+funding data.
 */
export async function fetchAllNFTsWithFundingData(
  account: string
): Promise<NftData[]> {
  console.log("=== [nftService] fetchAllNFTsWithFundingData START ===");
  console.log("[nftService] Account:", account);

  const algod = getAlgodClient();
  const indexer = getIndexerClient();

  // 1. Network health check
  try {
    const status = await algod.status().do();
    console.log("[nftService] Algod last round:", (status as any)?.["last-round"]);
  } catch (err) {
    console.warn("[nftService] Algod status check failed (non-fatal):", err);
  }

  // 2. Fetch account assets
  const res = await indexer.lookupAccountAssets(account).do();
  const assets = (res as any)?.assets ?? [];
  console.log("[nftService] Total assets returned:", assets.length);

  // 3. Log raw holdings
  assets.forEach((a: any, idx: number) => {
    console.log(`[nftService] Holding[${idx}]:`, {
      assetId: a?.["asset-id"] ?? a?.assetId,
      amount: a?.amount,
      frozen: a?.["is-frozen"] ?? a?.isFrozen,
    });
  });

  // 4. Resolve each holding → NftData
  const detailed = await Promise.all(
    assets.map(async (holding: any): Promise<NftData | null> => {
      // ── Resolve asset ID (camelCase bigint or kebab-case) ──
      const rawAssetId = holding?.["asset-id"] ?? holding?.assetId;
      const assetId =
        typeof rawAssetId === "bigint" ? Number(rawAssetId) : Number(rawAssetId);

      if (!Number.isFinite(assetId) || assetId <= 0) {
        console.error(
          "[nftService] Invalid assetId, skipping:",
          rawAssetId,
          "keys:",
          holding && typeof holding === "object"
            ? Object.keys(holding)
            : holding
        );
        return null;
      }

      // ── Fetch asset params ──
      let params: any = {};
      try {
        const assetInfo = await indexer.lookupAssetByID(assetId).do();
        params = (assetInfo as any)?.asset?.params ?? {};
      } catch (err) {
        console.warn(
          `[nftService] lookupAssetByID(${assetId}) failed:`,
          err
        );
        return null;
      }

      // ── Skip non-NFT assets (decimals !== 0) ──
      if (params?.decimals !== 0) {
        console.log(
          `[nftService] Skipping asset ${assetId}: decimals=${params?.decimals}`
        );
        return null;
      }

      // ── Resolve metadata from IPFS ──
      const metaUrl = normalizeIpfsUrl(params?.url);
      console.log(`[nftService] Asset ${assetId} metadata URL:`, metaUrl);

      let metadata: any = null;
      if (metaUrl) {
        metadata = await safeFetchJson(metaUrl);
      }

      // ── Fetch on-chain donation total ──
      const totalDonations = await fetchDonationTotalForToken(account, assetId);
      console.log(
        `[nftService] Asset ${assetId} totalDonations:`,
        totalDonations.toString(),
        "microAlgos"
      );

      return {
        tokenId: assetId,
        metadata: metadata ?? { name: params?.name, image: params?.url },
        owner: account,
        totalDonations,
      };
    })
  );

  const cleaned = detailed.filter(Boolean) as NftData[];
  console.log(
    `[nftService] fetchAllNFTsWithFundingData END — ${cleaned.length} NFTs`
  );
  return cleaned;
}
