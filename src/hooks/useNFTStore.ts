"use client";

import { useCallback, useSyncExternalStore } from "react";

import { fetchAllNFTsWithFundingData, type NftData } from "@/lib/nftService";

type StoreState = {
  nfts: NftData[];
  isLoading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
};

let state: StoreState = {
  nfts: [],
  isLoading: false,
  error: null,
  lastFetchedAt: null,
};

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function setState(patch: Partial<StoreState>) {
  state = { ...state, ...patch };
  emit();
}

function getSnapshot() {
  return state;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Fetch NFTs via the single-source-of-truth service and store in global state.
 * Used by the mint page to trigger a refresh after minting.
 */
export async function fetchUserNFTs(account: string): Promise<NftData[]> {
  setState({ isLoading: true, error: null });

  try {
    const nfts = await fetchAllNFTsWithFundingData(account);
    setState({ nfts, isLoading: false, lastFetchedAt: Date.now() });
    return nfts;
  } catch (e) {
    setState({
      isLoading: false,
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

export function useNFTStore() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const refreshNFTs = useCallback(async (account: string) => {
    return fetchUserNFTs(account);
  }, []);

  return {
    ...snapshot,
    refreshNFTs,
    fetchUserNFTs,
  };
}
