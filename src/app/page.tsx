"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import NFTCard from "@/components/NFTCard";
import SkeletonCard from "@/components/SkeletonCard";
import { Button } from "@/components/ui/button";
import { fromMicroAlgos } from "@/lib/algorand";
import { useToast } from "@/components/ui/use-toast";
import { usePeraAccount } from "@/hooks/usePeraAccount";
import { fetchAllNFTsWithFundingData, type NftData } from "@/lib/nftService";

// Re-export NftData so existing imports from "@/app/page" keep working.
export type { NftData };

export default function Home() {
  const [nfts, setNfts] = useState<NftData[]>([]);
  const [hiddenTokenIds, setHiddenTokenIds] = useState<number[]>([]);
  const { toast } = useToast();
  const { account } = usePeraAccount();
  const [isLoading, setIsLoading] = useState(false);
  const fetchIdRef = useRef(0); // guards against stale closures / race conditions

  // ── 🔟 WALLET SWITCH / MOUNT: fetch via single source of truth ──
  const loadNFTs = useCallback(
    async (addr: string) => {
      const id = ++fetchIdRef.current;
      setIsLoading(true);
      console.log("[Home] loadNFTs triggered for:", addr, "fetchId:", id);

      try {
        const result = await fetchAllNFTsWithFundingData(addr);
        if (fetchIdRef.current !== id) {
          console.log("[Home] Stale fetch ignored (id mismatch)");
          return;
        }
        setNfts(result);
        console.log("[Home] NFT state set:", result.length, "items");
        toast({
          title: "NFTs loaded",
          description: `Loaded ${result.length} NFTs with funding data.`,
        });
      } catch (e) {
        if (fetchIdRef.current !== id) return;
        console.error("[Home] loadNFTs failed:", e);
        toast({
          title: "Failed to load NFTs",
          description: e instanceof Error ? e.message : String(e),
          variant: "destructive",
        });
        setNfts([]);
      } finally {
        if (fetchIdRef.current === id) setIsLoading(false);
      }
    },
    [toast]
  );

  useEffect(() => {
    if (!account) {
      console.warn("[Home] Account null — clearing NFTs");
      setNfts([]);
      return;
    }
    void loadNFTs(account);
  }, [account, loadNFTs]);

  // ── Derived state: ALWAYS recomputed when nfts change ──
  const visibleNfts = useMemo(
    () => nfts.filter((nft) => !hiddenTokenIds.includes(nft.tokenId)),
    [nfts, hiddenTokenIds]
  );

  // 3️⃣ Total depends on nfts state — NOT computed once
  const totalDonationsAll = useMemo(
    () => visibleNfts.reduce((sum, nft) => sum + (nft.totalDonations ?? 0n), 0n),
    [visibleNfts]
  );

  const topDonatedNfts = useMemo(
    () =>
      [...visibleNfts]
        .sort((a, b) => Number(b.totalDonations) - Number(a.totalDonations))
        .slice(0, 10),
    [visibleNfts]
  );

  const topSupportedNames = useMemo(() => {
    if (topDonatedNfts.length === 0) return "No support yet";
    return topDonatedNfts
      .slice(0, 3)
      .map((nft) => nft.metadata?.name || `NFT #${nft.tokenId}`)
      .join(", ");
  }, [topDonatedNfts]);

  const handleDeleteNft = useCallback((tokenId: number) => {
    setHiddenTokenIds((prev) =>
      prev.includes(tokenId) ? prev : [...prev, tokenId]
    );
  }, []);

  // ── 4️⃣ OPTIMISTIC UPDATE: bump funded amount instantly, then hard refetch ──
  const handleDonationOptimistic = useCallback(
    ({ donor, amount, tokenId }: { donor: string; amount: bigint; tokenId: number }) => {
      console.log("[Home] Optimistic update — tokenId:", tokenId, "amount:", amount.toString());

      // 8️⃣ Functional update — no stale closure on `nfts`
      // 9️⃣ State immutability — spread, never mutate
      setNfts((prev) =>
        prev.map((nft) =>
          nft.tokenId === tokenId
            ? { ...nft, totalDonations: (nft.totalDonations ?? 0n) + amount }
            : nft
        )
      );

      console.log("[Home] Updated Total (optimistic):", "recomputed via useMemo");
    },
    []
  );

  // Called by NFTCard AFTER on-chain confirmation — hard refetch for consistency
  const handleDonationConfirmed = useCallback(async () => {
    if (!account) return;
    console.log("[Home] Post-confirmation hard refetch triggered");
    await loadNFTs(account);
  }, [account, loadNFTs]);

  const isPageLoading = !!account && isLoading;

  return (
    <main className="container mx-auto px-4 py-10 space-y-10">
      {/* 🧪 DEBUG PANEL — remove after validation */}
      <pre className="text-xs opacity-70 whitespace-pre-wrap break-words bg-muted/30 rounded p-2">
        Account: {String(account)}
        {"\n"}NFT Count: {nfts.length}
        {"\n"}Total Fan Funds: {fromMicroAlgos(totalDonationsAll)} ALGO
      </pre>

      <section className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-3">
            Explore impact NFTs
          </h1>
          <p className="text-muted-foreground max-w-xl text-sm md:text-base">
            Discover NFTs, support creators, and track the most supported drops
            in the community.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-3 text-center text-sm">
          <div className="rounded-xl border bg-card dark:bg-gradient-to-br dark:from-slate-900/60 dark:to-slate-800/60 px-4 py-3">
            <p className="text-xs text-muted-foreground">NFTs</p>
            <p className="text-lg font-semibold">{visibleNfts.length}</p>
          </div>
          <div className="rounded-xl border bg-card dark:bg-gradient-to-br dark:from-slate-900/60 dark:to-emerald-900/40 px-4 py-3">
            <p className="text-xs text-muted-foreground">Total fan donations</p>
            <p className="text-lg font-semibold">
              {fromMicroAlgos(totalDonationsAll)} ALGO
            </p>
          </div>
          <div className="rounded-xl border bg-card dark:bg-gradient-to-br dark:from-slate-900/60 dark:to-indigo-900/40 px-4 py-3">
            <p className="text-xs text-muted-foreground">Top supported</p>
            <p className="text-sm font-semibold truncate">
              {topSupportedNames}
            </p>
          </div>
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-semibold">All NFTs</h2>
          <Button asChild>
            <Link href="/mint">Mint NFT</Link>
          </Button>
        </div>

        {isPageLoading ? (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, idx) => (
              <SkeletonCard key={idx} />
            ))}
          </div>
        ) : visibleNfts.length > 0 ? (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {visibleNfts.map((nft) => (
              <NFTCard
                key={nft.tokenId}
                nft={nft}
                onDelete={handleDeleteNft}
                onDonation={handleDonationOptimistic}
                onTotalsChange={handleDonationConfirmed}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-xl border bg-card p-10 text-center">
            <h3 className="text-lg font-semibold">No NFTs yet</h3>
            <p className="text-muted-foreground text-sm mt-2">
              Be the first to mint an impact NFT and start building your fan
              funding journey.
            </p>
            <Button className="mt-6" asChild>
              <Link href="/mint">Mint your first NFT</Link>
            </Button>
          </div>
        )}
      </section>
    </main>
  );
}
