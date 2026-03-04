"use client";

import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/use-toast";
import Confetti from "react-confetti";
import { Loader2 } from "lucide-react";
import algosdk from "algosdk";

import { type NftData } from "@/lib/nftService";
import { fromMicroAlgos, getAlgodClient, toMicroAlgos } from "@/lib/algorand";
import { peraWallet, reconnectOnce } from "@/lib/peraWallet";
import { usePeraAccount } from "@/hooks/usePeraAccount";

interface NFTCardProps {
  nft: NftData;
  onDelete?: (tokenId: number) => void;
  /** Called IMMEDIATELY after tx submission for optimistic UI update */
  onDonation?: (payload: { donor: string; amount: bigint; tokenId: number }) => void;
  /** Called AFTER on-chain confirmation — triggers hard refetch */
  onTotalsChange?: () => void;
}

export default function NFTCard({ nft, onDelete, onDonation, onTotalsChange }: NFTCardProps) {
  const { tokenId, metadata, owner, totalDonations } = nft;
  const [donationAmount, setDonationAmount] = useState("");
  const [showConfetti, setShowConfetti] = useState(false);
  const [events, setEvents] = useState<any[]>([]);
  const [isDonating, setIsDonating] = useState(false);
  const { account } = usePeraAccount();
  const { toast } = useToast();
  const donateClickedRef = useRef(false); // double-click protection

  useEffect(() => {
    void reconnectOnce();
  }, []);

  const handleDonate = async () => {
    // ── 🛡 Double-click protection ──
    if (donateClickedRef.current) {
      console.warn("[NFTCard] Double-click blocked");
      return;
    }
    donateClickedRef.current = true;

    // ── 🛡 Input validation ──
    const parsed = Number(donationAmount);
    if (!donationAmount || !Number.isFinite(parsed) || parsed <= 0) {
      toast({
        title: "Invalid Amount",
        description: "Please enter a valid positive fan donation amount.",
        variant: "destructive",
      });
      donateClickedRef.current = false;
      return;
    }
    if (!owner || typeof owner !== "string") {
      toast({
        title: "Error",
        description: "Donation receiver address is missing.",
        variant: "destructive",
      });
      donateClickedRef.current = false;
      return;
    }
    if (!account) {
      toast({
        title: "Wallet Not Connected",
        description: "Please connect Pera Wallet first.",
        variant: "destructive",
      });
      donateClickedRef.current = false;
      return;
    }

    // ── 🛡 Convert microAlgos safely ──
    const amountMicro = toMicroAlgos(parsed);
    if (amountMicro <= 0n) {
      toast({
        title: "Invalid Amount",
        description: "Donation amount must be greater than zero.",
        variant: "destructive",
      });
      donateClickedRef.current = false;
      return;
    }

    try {
      setIsDonating(true);

      // ── 7️⃣ DIAGNOSTIC: Funding initiated ──
      console.log("[NFTCard] === FUNDING INITIATED ===");
      console.log("[NFTCard] Asset ID:", tokenId);
      console.log("[NFTCard] Amount (ALGO):", parsed);
      console.log("[NFTCard] Amount (microAlgos):", amountMicro.toString());
      console.log("[NFTCard] Sender:", account);
      console.log("[NFTCard] Receiver:", owner);

      toast({
        title: "Preparing donation...",
        description: "Building your ALGO payment transaction.",
      });

      const algodClient = getAlgodClient();
      const params = await algodClient.getTransactionParams().do();

      const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: account,
        receiver: owner,
        amount: amountMicro,
        note: new Uint8Array(Buffer.from(`FanFunding donation for ${tokenId}`)),
        suggestedParams: params,
      });

      toast({
        title: "Waiting for wallet signature...",
        description: "Approve the donation in Pera Wallet to continue.",
      });

      const txnGroup = [{ txn, signers: [account] }];
      const signedTxns = await peraWallet.signTransaction([txnGroup]);
      if (!signedTxns?.[0]) throw new Error("Transaction signing was cancelled or failed.");

      // ── 1️⃣ SUBMIT TRANSACTION ──
      const sendRes = await algodClient.sendRawTransaction(signedTxns[0]).do();
      const txId = (sendRes as any).txId ?? (sendRes as any).txid;
      console.log("[NFTCard] TxID:", txId);

      toast({
        title: "Donation submitted",
        description: `TxID: ${txId}. Waiting for confirmation...`,
      });

      // ── 4️⃣ OPTIMISTIC UPDATE: fire immediately BEFORE confirmation ──
      if (onDonation) {
        console.log("[NFTCard] Firing optimistic update");
        onDonation({ donor: account, amount: amountMicro, tokenId });
      }

      // ── 1️⃣ WAIT FOR CONFIRMATION ──
      const confirmedTxn = await algosdk.waitForConfirmation(algodClient, txId, 4);
      const confirmedRound =
        (confirmedTxn as any)?.["confirmed-round"] ?? (confirmedTxn as any)?.confirmedRound;
      console.log("[NFTCard] === TRANSACTION CONFIRMED ===");
      console.log("[NFTCard] Confirmed Round:", confirmedRound);
      console.log("[NFTCard] TxID:", txId);

      toast({
        title: "Fan Donation Successful!",
        description: `Confirmed in round ${confirmedRound}. Thank you for your support!`,
      });

      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 5000);
      setDonationAmount("");

      // Track local recent events
      setEvents((prev) => [
        { donor: account, amount: amountMicro, txId, confirmedRound },
        ...prev,
      ]);

      // ── 5️⃣ HARD REFETCH after confirmation for eventual consistency ──
      console.log("[NFTCard] Triggering post-confirmation hard refetch...");
      // Small delay for indexer propagation
      await new Promise((r) => setTimeout(r, 2000));

      if (onTotalsChange) {
        console.log("[NFTCard] Calling onTotalsChange (hard refetch)");
        onTotalsChange();
      }

      console.log("[NFTCard] === FUNDING COMPLETE ===");
    } catch (err) {
      console.error("[NFTCard] === FUNDING FAILED ===", err);
      toast({
        title: "Donation Failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
      // DO NOT update UI on failure
    } finally {
      setIsDonating(false);
      donateClickedRef.current = false;
    }
  };

  const shortenedAddress = (address: string) =>
    `${address.slice(0, 6)}...${address.slice(-4)}`;

  // 9️⃣ Immutable derived value
  const computedTotalDonations = totalDonations ?? 0n;

  return (
    <>
      {showConfetti && <Confetti />}
      <Card className="overflow-hidden">
        <CardHeader className="p-0">
          <div className="relative w-full h-64">
            {metadata?.image ? (
              <Image
                src={metadata.image}
                alt={metadata.name || ""}
                fill
                className="object-cover"
              />
            ) : (
              <div className="w-full h-full bg-secondary rounded-t-lg animate-pulse" />
            )}
          </div>
        </CardHeader>
        <CardContent className="p-4 space-y-2">
          <CardTitle>{metadata?.name || `NFT #${tokenId}`}</CardTitle>
          <p className="text-sm text-muted-foreground truncate">
            {metadata?.description}
          </p>
          {typeof owner === "string" && (
            <p className="text-xs">Owned by: {shortenedAddress(owner)}</p>
          )}
        </CardContent>
        <CardFooter className="flex justify-between items-center p-4 bg-muted/50">
          <div>
            <p className="text-sm font-bold">{`${fromMicroAlgos(computedTotalDonations)} ALGO`}</p>
            <p className="text-xs text-muted-foreground">Total Fan Donations</p>
          </div>
          <Dialog>
            <DialogTrigger asChild>
              <Button disabled={isDonating}>Fan Donate</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  Fan Donate to {metadata?.name || `NFT #${tokenId}`}
                </DialogTitle>
                <DialogDescription>
                  Your support helps the creator. Enter the amount of ALGO
                  you&apos;d like to donate.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <Input
                    type="number"
                    min="0.001"
                    step="0.1"
                    placeholder="1 ALGO"
                    value={donationAmount}
                    onChange={(e) => setDonationAmount(e.target.value)}
                    disabled={isDonating}
                  />
                </div>
                <Button
                  onClick={handleDonate}
                  disabled={isDonating}
                  className="w-full"
                >
                  {isDonating ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />{" "}
                      Submitting...
                    </>
                  ) : (
                    "Confirm Fan Donation"
                  )}
                </Button>
                <div className="space-y-2">
                  <h4 className="text-sm font-semibold">Recent Fan Donations</h4>
                  <div className="max-h-32 overflow-y-auto space-y-1 pr-2">
                    {events.length > 0 ? (
                      events.map((event, index) => (
                        <div
                          key={index}
                          className="text-xs text-muted-foreground flex justify-between"
                        >
                          <span>{shortenedAddress(event.donor)}</span>
                          <span>
                            {fromMicroAlgos(
                              typeof event.amount === "bigint"
                                ? event.amount
                                : BigInt(event.amount ?? 0)
                            )}{" "}
                            ALGO
                          </span>
                        </div>
                      ))
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        No fan donations yet.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </CardFooter>
      </Card>
    </>
  );
}
