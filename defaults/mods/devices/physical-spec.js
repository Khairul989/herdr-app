// Pin the optional physical-device transport independently of the simulator hub.
export const PHYSICAL_VERSION = "a03b9e9-1";
export const SOURCE_REVISION = "7ea9a42c713117464a36c2f4ebde424b13059bb7";
export const SOURCE_SHA256 = "d30b64b1863a0613fabd6974eddf1fb39dfb26107b4bc59f1073df0ed1ccbd58";
export const PATCH_SHA256 = "d1d09ad23560466b43a9ec737f6f795eb027a8e3263933aa22742159d7ce072c";
export const physicalRoot = toolsRoot => `${toolsRoot}/physical-ios/${PHYSICAL_VERSION}`;

export function physicalDevice(id) {
  if (typeof id !== "string" || !/^(?:[0-9a-f]{8}-[0-9a-f]{16}|[0-9a-f]{40})$/i.test(id)) throw new Error("An exact physical iPhone UDID is required.");
  return id;
}
