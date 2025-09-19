/*
 * Vencord userplugin native helper for vc-catbox
 * Runs in Electron (main/IPC), so no CORS; uses undici fetch/FormData/Blob.
 */

import type { IpcMainInvokeEvent } from "electron";

export async function uploadFileToCatboxNative(
  _: IpcMainInvokeEvent,
  url: string,
  fileBuffer: ArrayBuffer,
  fileName: string,
  fileType: string,
  userHash?: string,
): Promise<string> {
  const form = new FormData();
  form.append("reqtype", "fileupload");

  if (userHash && userHash.trim().length > 0) {
    form.append("userhash", userHash.trim());
  }

  const blob = new Blob([fileBuffer], {
    type: fileType || "application/octet-stream",
  });
  const file = new File([blob], fileName, { type: blob.type });
  form.append("fileToUpload", file);

  const res = await fetch(url, { method: "POST", body: form });
  const text = await res.text();
  return text;
}
