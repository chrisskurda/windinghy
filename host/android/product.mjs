// host/android/product.mjs — RoboDinghy identity (codename). Every product-specific name, path and
// port lives here and nowhere else, so a real product name is a one-file change on the Node side
// (the Swift side keeps its own copy in host/menubar-android/Product.swift).
//
// Exports: constants only (no logic beyond path joins).

import os from "node:os";
import path from "node:path";

export const VERSION = "0.1.0";                      // RoboDinghy release; compat.json "robodinghy" tracks it
export const NAME = "RoboDinghy";                     // display name (dialogs, notifications, about)
export const CLI = "robodinghy";                      // command name shown in hints ("Run: robodinghy sync")
export const LOG_PREFIX = `${NAME}:`;                 // config repair notes, dialog titles
export const CONFIG_DIR = path.join(os.homedir(), ".config", "robodinghy");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
export const LOG_DIR = path.join(CONFIG_DIR, "logs");
export const APPS_DIR = path.join(os.homedir(), "Applications", NAME);   // generated launchers
export const VM_DIR = path.join(os.homedir(), "Library", "Application Support", NAME);   // default vmDir
export const OWN_SDK_DIR = path.join(VM_DIR, "sdk");  // SDK we install ourselves when none is found
export const BUNDLE_ID_PREFIX = "app.robodinghy.";    // launcher bundle ids: app.robodinghy.<slug>
export const KEYCHAIN_SERVICE = "robodinghy";         // (unused for now: the VM needs no credentials)
export const ENV_PATH = "ROBODINGHY_PATH";            // override for where the Swift app finds this CLI
export const AVD_NAME = "RoboDinghy";
export const CONSOLE_PORT = 5580;                     // adb port = console + 1; serial emulator-<console>
export const GRPC_PORT = 8580;
export const DEFAULT_API = "37.0";                    // Android 17, both editions (see docs/design)
export const HELPER_PKG = "app.robodinghy.helper";
export const HELPER_APK = "robodinghy-helper.apk";
export const SUSPEND_SNAPSHOT = "robodinghy-suspend"; // the emulator snapshot `vm save` writes
export const DESKTOP_NAME = "Android Desktop";        // the full-screen mirror launcher
export const BUNDLE_EXT = ".robodinghyvm";            // vm export folder suffix
// F-Droid (AOSP edition): official client + repo, and the client's signing-certificate SHA-256.
export const FDROID_PKG = "org.fdroid.fdroid";
export const FDROID_APK_URL = "https://f-droid.org/F-Droid.apk";
export const FDROID_REPO = "https://f-droid.org/repo";
export const FDROID_SIGNER_SHA256 = "43238d512c1e5eb2d6569f4a3afbf5523418b82e0a3ed1552770abb9a9c9ccab";
// SHA-256 of the certificate that signs the repo index (entry.jar), the fingerprint F-Droid publishes for
// https://f-droid.org/repo. (Same key as the client's today; kept separate because they're different roles.)
export const FDROID_REPO_CERT_SHA256 = "43238d512c1e5eb2d6569f4a3afbf5523418b82e0a3ed1552770abb9a9c9ccab";
