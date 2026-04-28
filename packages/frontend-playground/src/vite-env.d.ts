/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RPC_URL?: string;
  readonly VITE_JITO_VAULT_PROGRAM?: string;
  readonly VITE_CSSOL_VAULT?: string;
  readonly VITE_CSSOL_VRT_MINT?: string;
  readonly VITE_CSSOL_VAULT_ST_TOKEN_ACCOUNT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
