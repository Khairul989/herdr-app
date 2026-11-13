import { chooseDevice } from "./device.js";

export async function connectGlobal(tools, devices, request, app) {
  const device = chooseDevice(devices, request.device, request.platform);
  if (tools.opened) {
    if (tools.device.id !== device.id || tools.device.platform !== device.platform || request.app && request.app !== app) {
      const error = new Error("A different device or app is connected globally. Disconnect it explicitly before switching.");
      error.code = "GLOBAL_CONNECTED";
      throw error;
    }
    return tools.capture();
  }
  return tools.connect(devices, device.id, device.platform, request.app || "");
}
