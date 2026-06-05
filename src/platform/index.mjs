import { createHttpApi } from "./http-api.mjs";
import { createLocalApi } from "./local-api.mjs";

function isNativeCapacitor() {
  const capacitor = window.Capacitor;
  if (!capacitor) return false;
  if (typeof capacitor.isNativePlatform === "function") return capacitor.isNativePlatform();
  return Boolean(capacitor.getPlatform && capacitor.getPlatform() !== "web");
}

export function createPlatformApi() {
  return isNativeCapacitor() ? createLocalApi() : createHttpApi();
}
