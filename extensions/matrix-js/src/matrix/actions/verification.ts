import { resolveActionClient } from "./client.js";
import type { MatrixActionClientOpts } from "./types.js";

function requireCrypto(
  client: import("../sdk.js").MatrixClient,
): NonNullable<import("../sdk.js").MatrixClient["crypto"]> {
  if (!client.crypto) {
    throw new Error(
      "Matrix encryption is not available (enable channels.matrix-js.encryption=true)",
    );
  }
  return client.crypto;
}

async function stopActionClient(params: {
  client: import("../sdk.js").MatrixClient;
  stopOnDone: boolean;
}): Promise<void> {
  if (!params.stopOnDone) {
    return;
  }
  await params.client.stopAndPersist();
}

function resolveVerificationId(input: string): string {
  const normalized = input.trim();
  if (!normalized) {
    throw new Error("Matrix verification request id is required");
  }
  return normalized;
}

export async function listMatrixVerifications(opts: MatrixActionClientOpts = {}) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const crypto = requireCrypto(client);
    return await crypto.listVerifications();
  } finally {
    await stopActionClient({ client, stopOnDone });
  }
}

export async function requestMatrixVerification(
  params: MatrixActionClientOpts & {
    ownUser?: boolean;
    userId?: string;
    deviceId?: string;
    roomId?: string;
  } = {},
) {
  const { client, stopOnDone } = await resolveActionClient(params);
  try {
    const crypto = requireCrypto(client);
    const ownUser = params.ownUser ?? (!params.userId && !params.deviceId && !params.roomId);
    return await crypto.requestVerification({
      ownUser,
      userId: params.userId?.trim() || undefined,
      deviceId: params.deviceId?.trim() || undefined,
      roomId: params.roomId?.trim() || undefined,
    });
  } finally {
    await stopActionClient({ client, stopOnDone });
  }
}

export async function acceptMatrixVerification(
  requestId: string,
  opts: MatrixActionClientOpts = {},
) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const crypto = requireCrypto(client);
    return await crypto.acceptVerification(resolveVerificationId(requestId));
  } finally {
    await stopActionClient({ client, stopOnDone });
  }
}

export async function cancelMatrixVerification(
  requestId: string,
  opts: MatrixActionClientOpts & { reason?: string; code?: string } = {},
) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const crypto = requireCrypto(client);
    return await crypto.cancelVerification(resolveVerificationId(requestId), {
      reason: opts.reason?.trim() || undefined,
      code: opts.code?.trim() || undefined,
    });
  } finally {
    await stopActionClient({ client, stopOnDone });
  }
}

export async function startMatrixVerification(
  requestId: string,
  opts: MatrixActionClientOpts & { method?: "sas" } = {},
) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const crypto = requireCrypto(client);
    return await crypto.startVerification(resolveVerificationId(requestId), opts.method ?? "sas");
  } finally {
    await stopActionClient({ client, stopOnDone });
  }
}

export async function generateMatrixVerificationQr(
  requestId: string,
  opts: MatrixActionClientOpts = {},
) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const crypto = requireCrypto(client);
    return await crypto.generateVerificationQr(resolveVerificationId(requestId));
  } finally {
    await stopActionClient({ client, stopOnDone });
  }
}

export async function scanMatrixVerificationQr(
  requestId: string,
  qrDataBase64: string,
  opts: MatrixActionClientOpts = {},
) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const crypto = requireCrypto(client);
    const payload = qrDataBase64.trim();
    if (!payload) {
      throw new Error("Matrix QR data is required");
    }
    return await crypto.scanVerificationQr(resolveVerificationId(requestId), payload);
  } finally {
    await stopActionClient({ client, stopOnDone });
  }
}

export async function getMatrixVerificationSas(
  requestId: string,
  opts: MatrixActionClientOpts = {},
) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const crypto = requireCrypto(client);
    return await crypto.getVerificationSas(resolveVerificationId(requestId));
  } finally {
    await stopActionClient({ client, stopOnDone });
  }
}

export async function confirmMatrixVerificationSas(
  requestId: string,
  opts: MatrixActionClientOpts = {},
) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const crypto = requireCrypto(client);
    return await crypto.confirmVerificationSas(resolveVerificationId(requestId));
  } finally {
    await stopActionClient({ client, stopOnDone });
  }
}

export async function mismatchMatrixVerificationSas(
  requestId: string,
  opts: MatrixActionClientOpts = {},
) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const crypto = requireCrypto(client);
    return await crypto.mismatchVerificationSas(resolveVerificationId(requestId));
  } finally {
    await stopActionClient({ client, stopOnDone });
  }
}

export async function confirmMatrixVerificationReciprocateQr(
  requestId: string,
  opts: MatrixActionClientOpts = {},
) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const crypto = requireCrypto(client);
    return await crypto.confirmVerificationReciprocateQr(resolveVerificationId(requestId));
  } finally {
    await stopActionClient({ client, stopOnDone });
  }
}

export async function getMatrixEncryptionStatus(
  opts: MatrixActionClientOpts & { includeRecoveryKey?: boolean } = {},
) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const crypto = requireCrypto(client);
    const recoveryKey = await crypto.getRecoveryKey();
    return {
      encryptionEnabled: true,
      recoveryKeyStored: Boolean(recoveryKey),
      recoveryKeyCreatedAt: recoveryKey?.createdAt ?? null,
      ...(opts.includeRecoveryKey ? { recoveryKey: recoveryKey?.encodedPrivateKey ?? null } : {}),
      pendingVerifications: (await crypto.listVerifications()).length,
    };
  } finally {
    await stopActionClient({ client, stopOnDone });
  }
}

export async function getMatrixVerificationStatus(
  opts: MatrixActionClientOpts & { includeRecoveryKey?: boolean } = {},
) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const status = await client.getOwnDeviceVerificationStatus();
    const payload = {
      ...status,
      pendingVerifications: client.crypto ? (await client.crypto.listVerifications()).length : 0,
    };
    if (!opts.includeRecoveryKey) {
      return payload;
    }
    const recoveryKey = client.crypto ? await client.crypto.getRecoveryKey() : null;
    return {
      ...payload,
      recoveryKey: recoveryKey?.encodedPrivateKey ?? null,
    };
  } finally {
    await stopActionClient({ client, stopOnDone });
  }
}

export async function getMatrixRoomKeyBackupStatus(opts: MatrixActionClientOpts = {}) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    return await client.getRoomKeyBackupStatus();
  } finally {
    await stopActionClient({ client, stopOnDone });
  }
}

export async function verifyMatrixRecoveryKey(
  recoveryKey: string,
  opts: MatrixActionClientOpts = {},
) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    return await client.verifyWithRecoveryKey(recoveryKey);
  } finally {
    await stopActionClient({ client, stopOnDone });
  }
}

export async function restoreMatrixRoomKeyBackup(
  opts: MatrixActionClientOpts & {
    recoveryKey?: string;
  } = {},
) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    return await client.restoreRoomKeyBackup({
      recoveryKey: opts.recoveryKey?.trim() || undefined,
    });
  } finally {
    await stopActionClient({ client, stopOnDone });
  }
}

export async function bootstrapMatrixVerification(
  opts: MatrixActionClientOpts & {
    recoveryKey?: string;
    forceResetCrossSigning?: boolean;
  } = {},
) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    return await client.bootstrapOwnDeviceVerification({
      recoveryKey: opts.recoveryKey?.trim() || undefined,
      forceResetCrossSigning: opts.forceResetCrossSigning === true,
    });
  } finally {
    await stopActionClient({ client, stopOnDone });
  }
}
