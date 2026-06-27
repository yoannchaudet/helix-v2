/* The single seam to the Tauri backend. Everything the frontend knows about the native
   core goes through `invoke` (call a Rust #[tauri::command]) and `listen` (subscribe to a
   backend event). Centralized here so the IPC surface is easy to find and stub. */

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

export { invoke, listen };
