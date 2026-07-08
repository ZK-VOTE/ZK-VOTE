// Deployed contract addresses and network configuration
// Auto-generated on Fri  3 Apr 2026 00:43:03 BST

export const CONTRACTS = {
  REGISTRY_ID: "CBGK5YFR5544QNHUNR4WKB5ECL75DAY3R4M5UNALA42ZBPKOFNL5RM43",
  SBT_ID: "CCHLRCF47DJFQY6AR2PE3WRDRT7SDKSQJSJUGU77COW7GZMY5YTEUWYX",
  TREE_ID: "CAZC3WSRGE3PI6AZ3NHRKIZFVBEOOLFDP7RD6BMHIMRYV4VEYC42ARQZ",
  VOTING_ID: "CCYGWEUNWOBHJ6JIHDMTK2XSSDVMQ7ZGBJQE6QR2VYD4FRQGZR5EYKJ2",
  COMMENTS_ID: "CCUZNVADC24GEOPRD5A6PBCZGOQ6QOKJU6E5UBXI6RKDC7AWN5ATXNFF",
} as const;

export const NETWORK_CONFIG = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  networkName: "testnet",
} as const;

// Deployment version - changes on each deployment
// Used for cache invalidation in frontend
export const DEPLOY_VERSION = "1775173273";

// Contract method names for type safety
export const CONTRACT_METHODS = {
  REGISTRY: {
    CREATE_DAO: "create_dao",
    GET_DAO: "get_dao",
    CREATE_AND_INIT_DAO: "create_and_init_dao",
    CREATE_AND_INIT_DAO_NO_REG: "create_and_init_dao_no_reg",
  },
  SBT: {
    MINT: "mint",
    MINT_FROM_REGISTRY: "mint_from_registry",
    HAS: "has",
  },
  TREE: {
    INIT_TREE: "init_tree",
    REGISTER_WITH_CALLER: "register_with_caller",
    GET_ROOT: "get_root",
  },
  VOTING: {
    SET_VK: "set_vk",
    CREATE_PROPOSAL: "create_proposal",
    VOTE: "vote",
    GET_PROPOSAL: "get_proposal",
    GET_RESULTS: "get_results",
  },
} as const;
