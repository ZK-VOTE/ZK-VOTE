import { CONTRACTS, NETWORK_CONFIG } from "./contracts";

const CONTRACT_ID_REGEX = /^C[A-Z2-7]{55}$/;

export function validateStaticConfig() {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Contract IDs must look like Soroban contract addresses
  Object.entries(CONTRACTS).forEach(([key, value]) => {
    if (!CONTRACT_ID_REGEX.test(value)) {
      errors.push(`${key} is not a valid contract id (got "${value}")`);
    }
  });

  if (!NETWORK_CONFIG.rpcUrl) {
    errors.push("rpcUrl is missing");
  }
  if (!NETWORK_CONFIG.networkPassphrase) {
    errors.push("networkPassphrase is missing");
  }

  // Simple sanity: avoid accidental mainnet use unless explicit
  if (
    NETWORK_CONFIG.networkPassphrase.includes("Public Global Stellar Network")
  ) {
    warnings.push("Config is pointing at mainnet — ensure this is intentional");
  }

  return { errors, warnings };
}
