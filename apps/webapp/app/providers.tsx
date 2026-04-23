"use client";

import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  isConnected as freighterIsConnected,
  getAddress as freighterGetAddress,
  requestAccess,
} from "@stellar/freighter-api";

// ─── constants ───────────────────────────────────────────────────────────────

const STORAGE_KEY = "lumenpulse_wallet_previously_connected";
/** Key name matches the spec requirement exactly */
const LAST_WALLET_KEY = "lastUsedWallet";

// ─── types ───────────────────────────────────────────────────────────────────

export type WalletId = "freighter" | "braavos" | "argent";

export type WalletStatus =
  | "idle"          // initial — no attempt yet
  | "reconnecting"  // silently restoring a previous session on mount
  | "connecting"    // user-initiated connection in progress
  | "connected"     // wallet connected and address available
  | "rejected"      // user denied the connection request
  | "disconnected"; // explicitly disconnected or failed

export interface WalletInstallState {
  freighter: boolean;
  braavos: boolean;
  argent: boolean;
}

interface StellarWalletState {
  publicKey: string | null;
  status: WalletStatus;
  activeWallet: WalletId | null;
  installState: WalletInstallState;
  connect: (walletId: WalletId) => Promise<void>;
  disconnect: () => void;
  error: string | null;
  wasPreviouslyConnected: boolean;
  lastWallet: WalletId | null;
}

// ─── context ─────────────────────────────────────────────────────────────────

const StellarWalletContext = createContext<StellarWalletState>({
  publicKey: null,
  status: "idle",
  activeWallet: null,
  installState: { freighter: false, braavos: false, argent: false },
  connect: async () => {},
  disconnect: () => {},
  error: null,
  wasPreviouslyConnected: false,
  lastWallet: null,
});

export function useStellarWallet() {
  return useContext(StellarWalletContext);
}

// ─── extension detection ─────────────────────────────────────────────────────

/**
 * Detect which wallet extensions are present in the browser.
 *
 * Freighter detection strategy (in order of reliability):
 *  1. Check window.freighter — Freighter injects this object when installed.
 *     We verify it's an object (not just a truthy primitive) to avoid false
 *     positives from other scripts that might set window.freighter.
 *  2. Call freighterIsConnected() and check the boolean result.
 *     IMPORTANT: this API does NOT throw when the extension is absent —
 *     it resolves with { isConnected: false }. We must read the value,
 *     not just check whether the call succeeded.
 *  3. If both checks return false → extension is not installed.
 */
async function detectInstalledWallets(): Promise<WalletInstallState> {
  if (typeof window === "undefined") {
    return { freighter: false, braavos: false, argent: false };
  }

  // ── Freighter ──────────────────────────────────────────────────────────────
  // Primary: window.freighter is an object injected by the extension.
  const win = window as unknown as Record<string, unknown>;
  let freighter =
    "freighter" in window &&
    typeof win["freighter"] === "object" &&
    win["freighter"] !== null;

  if (!freighter) {
    // Secondary: freighterIsConnected resolves (not throws) when absent,
    // returning { isConnected: false }. Only mark as installed when the
    // extension actually reports a connected or connectable state.
    // We use a short timeout so a missing extension doesn't stall the UI.
    try {
      const result = await Promise.race([
        freighterIsConnected(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 1500)
        ),
      ]);
      // result.isConnected is true only when the extension is present AND
      // the user has already granted access. But the extension can also be
      // present with isConnected: false (installed, not yet connected).
      // Freighter v6 sets result.isConnected to false when not connected,
      // so we can't use it alone. Instead, check if the API object itself
      // is reachable — if the call resolves without timeout, the extension
      // is installed (the API is a no-op stub in the npm package that only
      // works when the extension is present to handle the messages).
      //
      // The key insight: the @stellar/freighter-api package sends a message
      // to the extension and awaits a response. If the extension is absent,
      // the message goes unanswered and the promise either hangs or the
      // package returns a default. In practice with v6, it resolves quickly
      // with isConnected: false even without the extension — so we cannot
      // rely on this call alone.
      //
      // Therefore: only trust this fallback when isConnected is explicitly
      // true (meaning the extension is definitely present and connected).
      freighter = result.isConnected === true;
    } catch {
      // Timeout or error → extension absent
      freighter = false;
    }
  }

  // ── Braavos ────────────────────────────────────────────────────────────────
  const braavos =
    "starknet_braavos" in window &&
    typeof win["starknet_braavos"] === "object" &&
    win["starknet_braavos"] !== null;

  // ── Argent ─────────────────────────────────────────────────────────────────
  const argent =
    ("argentX" in window &&
      typeof win["argentX"] === "object" &&
      win["argentX"] !== null) ||
    ("starknet" in window &&
      typeof win["starknet"] === "object" &&
      win["starknet"] !== null);

  return { freighter, braavos, argent };
}

// ─── provider ────────────────────────────────────────────────────────────────

export function StellarProvider({ children }: { children: ReactNode }) {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [status, setStatus] = useState<WalletStatus>("idle");
  const [activeWallet, setActiveWallet] = useState<WalletId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wasPreviouslyConnected, setWasPreviouslyConnected] = useState(false);
  const [lastWallet, setLastWallet] = useState<WalletId | null>(null);
  const [installState, setInstallState] = useState<WalletInstallState>({
    freighter: false,
    braavos: false,
    argent: false,
  });

  // On mount: detect extensions and silently restore previous session
  useEffect(() => {
    const previouslyConnected =
      typeof window !== "undefined" &&
      localStorage.getItem(STORAGE_KEY) === "true";
    const storedWallet = (
      typeof window !== "undefined"
        ? localStorage.getItem(LAST_WALLET_KEY)
        : null
    ) as WalletId | null;

    setWasPreviouslyConnected(previouslyConnected);
    setLastWallet(storedWallet);

    async function init() {
      const detected = await detectInstalledWallets();
      setInstallState(detected);

      // Attempt silent reconnect only when:
      //  1. We have a stored lastUsedWallet
      //  2. That extension is currently detected in the browser
      //  3. The user had previously connected (STORAGE_KEY flag is set)
      if (previouslyConnected && storedWallet && detected[storedWallet]) {
        setStatus("reconnecting");

        try {
          if (storedWallet === "freighter") {
            const { isConnected } = await freighterIsConnected();
            if (isConnected) {
              const { address } = await freighterGetAddress();
              if (address) {
                setPublicKey(address);
                setActiveWallet("freighter");
                setStatus("connected");
                localStorage.setItem(STORAGE_KEY, "true");
                return;
              }
            }
          }

          // Braavos / Argent: check the injected provider's selected address.
          // When @starknet-react/core is integrated this can call the real SDK;
          // for now we read the provider's selectedAddress directly so the
          // silent-restore path is already wired up and ready.
          // Cast through unknown first to satisfy strict TypeScript.
          const win = window as unknown as Record<string, { selectedAddress?: string } | undefined>;

          if (storedWallet === "braavos") {
            const provider = win["starknet_braavos"];
            if (provider?.selectedAddress) {
              setPublicKey(provider.selectedAddress);
              setActiveWallet("braavos");
              setStatus("connected");
              localStorage.setItem(STORAGE_KEY, "true");
              return;
            }
          }

          if (storedWallet === "argent") {
            const provider = win["argentX"] ?? win["starknet"];
            if (provider?.selectedAddress) {
              setPublicKey(provider.selectedAddress);
              setActiveWallet("argent");
              setStatus("connected");
              localStorage.setItem(STORAGE_KEY, "true");
              return;
            }
          }
        } catch {
          // Silent fail — extension present but session expired or locked
        }
      }

      setStatus("idle");
    }

    init();
  }, []);

  const connect = useCallback(async (walletId: WalletId) => {
    setError(null);
    setStatus("connecting");
    setActiveWallet(walletId);

    try {
      if (walletId === "freighter") {
        const result = await requestAccess();

        if (result.error) {
          const msg = result.error.toLowerCase();
          if (
            msg.includes("user") ||
            msg.includes("denied") ||
            msg.includes("reject") ||
            msg.includes("cancel")
          ) {
            setStatus("rejected");
            setError("Connection request was rejected.");
            setActiveWallet(null);
            return;
          }
          throw new Error(result.error);
        }

        if (!result.address) {
          throw new Error("No address returned from Freighter.");
        }

        setPublicKey(result.address);
        setStatus("connected");
        setActiveWallet("freighter");
        // Persist for auto-detection on next page load
        localStorage.setItem(STORAGE_KEY, "true");
        localStorage.setItem(LAST_WALLET_KEY, "freighter");
        setLastWallet("freighter");
        return;
      }

      // Braavos / Argent — Starknet wallets, not yet integrated at SDK level.
      // Save lastUsedWallet now so the UI priority + auto-detection are ready
      // the moment @starknet-react/core is wired up.
      // For now, surface a clear "coming soon" error rather than silently failing.
      localStorage.setItem(LAST_WALLET_KEY, walletId);
      setLastWallet(walletId);
      throw new Error(
        `${walletId.charAt(0).toUpperCase() + walletId.slice(1)} integration coming soon.`
      );
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to connect wallet.";
      setError(message);
      setStatus("disconnected");
      setActiveWallet(null);
    }
  }, []);

  const disconnect = useCallback(() => {
    setPublicKey(null);
    setStatus("disconnected");
    setError(null);
    setActiveWallet(null);
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LAST_WALLET_KEY);
    setWasPreviouslyConnected(false);
    setLastWallet(null);
  }, []);

  return (
    <StellarWalletContext.Provider
      value={{
        publicKey,
        status,
        activeWallet,
        installState,
        connect,
        disconnect,
        error,
        wasPreviouslyConnected,
        lastWallet,
      }}
    >
      {children}
    </StellarWalletContext.Provider>
  );
}
