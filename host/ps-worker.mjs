// Runs one guest PowerShell call on a worker thread, so the main thread's event loop (for example
// the setup web server the guest is about to fetch from) stays responsive while it waits.
import { parentPort, workerData } from "node:worker_threads";
import * as G from "./guest.mjs";

G.useBackend(workerData.cfg);
parentPort.postMessage(G.ps(workerData.name, workerData.script, workerData.opts));
