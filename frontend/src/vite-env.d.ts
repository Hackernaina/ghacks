/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_MOCK_A_URL?: string;
  readonly VITE_MOCK_B_URL?: string;
  readonly VITE_MOCK_BANK_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
