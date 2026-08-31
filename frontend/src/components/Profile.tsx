import { useState, useRef } from "react";
import { useReceipts, type VoterReceipt } from "../hooks/useReceipts";
import { Button } from "./ui/Button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "./ui/Card";
import { getZkVoteClient } from "../lib/client";
import { truncateAddress } from "../lib/utils";
import { CheckCircle, XCircle, Loader2, Download, Upload } from "lucide-react";
import Alert from "./ui/Alert";

interface ProfileProps {
  publicKey: string | null;
  isConnected: boolean;
}

export default function Profile({ publicKey, isConnected }: ProfileProps) {
  const { receipts, importReceipts } = useReceipts();
  const [verifying, setVerifying] = useState<Record<string, boolean>>({});
  const [verificationResult, setVerificationResult] = useState<
    Record<string, boolean>
  >({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleVerify = async (receipt: VoterReceipt) => {
    if (!publicKey) return;
    setVerifying((prev) => ({ ...prev, [receipt.id]: true }));

    try {
      const clients = getZkVoteClient(publicKey);

      // We convert hex string to bigint since U256 in JS bindings is usually bigint
      // Actually Soroban U256 is expected as bigint or string in generated bindings
      // The receipt.nullifier might not have '0x' prefix depending on toHexBE implementation
      const nullifierHex = receipt.nullifier.startsWith("0x")
        ? receipt.nullifier
        : `0x${receipt.nullifier}`;
      const nullifierBigInt = BigInt(nullifierHex);

      const result = await clients.voting.is_nullifier_used({
        dao_id: BigInt(receipt.daoId),
        proposal_id: BigInt(receipt.proposalId),
        nullifier: nullifierBigInt,
      });

      setVerificationResult((prev) => ({
        ...prev,
        [receipt.id]: result.result,
      }));
    } catch (err) {
      console.error("Verification failed:", err);
      setVerificationResult((prev) => ({ ...prev, [receipt.id]: false }));
    } finally {
      setVerifying((prev) => ({ ...prev, [receipt.id]: false }));
    }
  };

  const handleExport = () => {
    const dataStr =
      "data:text/json;charset=utf-8," +
      encodeURIComponent(JSON.stringify(receipts, null, 2));
    const downloadAnchorNode = document.createElement("a");
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", "zk-vote-receipts.json");
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  };

  const handleImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const imported = JSON.parse(e.target?.result as string);
        if (Array.isArray(imported)) {
          importReceipts(imported);
          alert("Receipts imported successfully!");
        }
      } catch (err) {
        alert("Invalid receipt file format.");
      }
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="space-y-8 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Your Profile</h1>
          <p className="text-muted-foreground mt-2">
            Manage your voting receipts. Receipts prove that your vote was
            included in the tally without revealing your choice.
          </p>
        </div>
        <div className="flex gap-2">
          <input
            type="file"
            accept=".json"
            className="hidden"
            ref={fileInputRef}
            onChange={handleImport}
          />
          <Button
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="mr-2 h-4 w-4" />
            Import
          </Button>
          <Button
            variant="outline"
            onClick={handleExport}
            disabled={receipts.length === 0}
          >
            <Download className="mr-2 h-4 w-4" />
            Export
          </Button>
        </div>
      </div>

      {!isConnected && (
        <Alert variant="warning">
          Please connect your wallet to verify your receipts against the
          blockchain.
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Voting Receipts</CardTitle>
          <CardDescription>
            You have {receipts.length} receipt{receipts.length !== 1 && "s"}.
            These receipts do not contain any information about which candidate
            you voted for.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {receipts.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No voting receipts found. When you cast a vote, a receipt will be
              saved here automatically.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs uppercase bg-muted/50">
                  <tr>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">DAO ID</th>
                    <th className="px-4 py-3">Proposal ID</th>
                    <th className="px-4 py-3">Tx Hash</th>
                    <th className="px-4 py-3 text-right">Verification</th>
                  </tr>
                </thead>
                <tbody>
                  {receipts.map((receipt) => (
                    <tr key={receipt.id} className="border-b last:border-0">
                      <td className="px-4 py-3 whitespace-nowrap">
                        {new Date(receipt.timestamp).toLocaleString()}
                      </td>
                      <td className="px-4 py-3">{receipt.daoId}</td>
                      <td className="px-4 py-3">{receipt.proposalId}</td>
                      <td className="px-4 py-3 font-mono text-xs">
                        <a
                          href={`https://stellar.expert/explorer/testnet/tx/${receipt.txHash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline"
                        >
                          {truncateAddress(receipt.txHash, 6, 6)}
                        </a>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {verificationResult[receipt.id] === true ? (
                          <span className="inline-flex items-center text-green-600 dark:text-green-400">
                            <CheckCircle className="mr-1 h-4 w-4" /> Verified
                          </span>
                        ) : verificationResult[receipt.id] === false ? (
                          <span className="inline-flex items-center text-destructive">
                            <XCircle className="mr-1 h-4 w-4" /> Failed
                          </span>
                        ) : (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={!isConnected || verifying[receipt.id]}
                            onClick={() => handleVerify(receipt)}
                          >
                            {verifying[receipt.id] ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              "Verify on-chain"
                            )}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
