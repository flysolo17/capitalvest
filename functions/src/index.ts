import { setGlobalOptions } from "firebase-functions";
import {
  onDocumentCreated,
  onDocumentUpdated,
} from "firebase-functions/firestore";

import * as logger from "firebase-functions/logger";

import * as admin from "firebase-admin";
import { Assets } from "./models/Assets";
setGlobalOptions({ maxInstances: 10 });

admin.initializeApp();

export const addClaims = onDocumentCreated(
  {
    document: "users/{docId}",
    region: "asia-east1",
  },
  async (event) => {
    try {
      const userId = event.params.docId;
      const data = event.data?.data();

      if (!data) return;
      const claims = {
        role: data.role || "user",
      };

      await admin.auth().setCustomUserClaims(userId, claims);

      logger.info(`✅ Claims added for user: ${userId}`, claims);
    } catch (error) {
      logger.error("❌ Error adding claims:", error);
    }
  },
);

export const updateClaims = onDocumentUpdated(
  {
    document: "users/{docId}",
    region: "asia-east1",
  },
  async (event) => {
    try {
      const userId = event.params.docId;
      const before = event.data?.before.data();
      const after = event.data?.after.data();
      if (!after) return;
      if (before?.role === after.role) {
        return;
      }
      const claims = {
        role: after.role || "user",
      };
      await admin.auth().setCustomUserClaims(userId, claims);

      logger.info(`🔄 Claims updated for user: ${userId}`, claims);
    } catch (error) {
      logger.error("❌ Error updating claims:", error);
    }
  },
);

export const onTransactionCreated = onDocumentUpdated(
  {
    document: "transactions/{docId}",
    region: "asia-east1",
  },
  async (event) => {
    logger.info("OnTransactionCreated Called");
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (before?.status === "PENDING" && after?.status !== before?.status) {
      const currentStatus = after?.status;
      const uid = after?.userInfo.uid;
      const network = after?.network.symbol;
      const type = after?.type;
      const amount = after?.total;

      if (!uid || !network || !type || !amount) {
        logger.error("Missing required transaction fields", {
          uid,
          network,
          type,
          amount,
        });
        return;
      }

      const parsedAmount = amount;
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        logger.error("Invalid transaction amount", { amount });
        return;
      }

      if (currentStatus === "CONFIRMED") {
        await onUpdateAsset(uid, network, amount, type);
        logger.info("Asset updated successfully", {
          uid,
          network,
          type,
          parsedAmount,
        });
      } else if (currentStatus === "REJECTED") {
        logger.warn("Transaction rejected", {
          transactionId: event.params.docId,
        });
      }
    }
  },
);

export const onUpdateAsset = async (
  uid: string,
  network: string,
  totalAmount: number,
  type: "WITHDRAW" | "DEPOSIT",
) => {
  const db = admin.firestore();
  const assetID = `${network.toUpperCase()}-${uid}`;
  const assetRef = db.collection("assets").doc(assetID);

  const snap = await assetRef.get();
  const delta = totalAmount;

  if (isNaN(delta)) {
    logger.error("Invalid amount provided", {
      uid,
      network,
      type,
      totalAmount,
    });
    return { status: "error", reason: "invalid_amount" };
  }

  if (!snap.exists) {
    const newAsset: Assets = {
      id: assetID,
      network,
      uid,
      address: "",
      amount: totalAmount,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await assetRef.set(newAsset);
    logger.info("Created new asset", {
      assetID,
      uid,
      network,
      type,
      amount: newAsset.amount,
    });
    return { status: "created", asset: newAsset };
  } else {
    const existing = snap.data()!;
    let newAmount = existing.amount;

    if (type === "DEPOSIT") {
      newAmount += delta;
    } else if (type === "WITHDRAW") {
      newAmount -= delta;
    }

    if (newAmount < 0) {
      logger.warn("Attempted withdrawal exceeds balance, clamping to zero", {
        assetID,
        uid,
        network,
        attemptedDelta: delta,
        previousAmount: existing.amount,
      });
      newAmount = 0;
    }

    const updatedAsset: Partial<Assets> = {
      amount: newAmount,
      updatedAt: new Date(),
    };

    await assetRef.update(updatedAsset);
    logger.info("Updated asset balance", {
      assetID,
      uid,
      network,
      type,
      previousAmount: existing.amount,
      newAmount,
    });
    return { status: "updated", asset: { ...existing, ...updatedAsset } };
  }
};

const telegram = process.env.TELEGRAM_BOT;
const chatId = process.env.CHAT_ID;

export const onLogCreated = onDocumentCreated(
  {
    document: "auditlog/{docId}",
    region: "asia-east1",
  },
  async (event) => {
    try {
      const data = event.data?.data();
      if (!data || !telegram || !chatId) return;

      const action = data?.type ?? "N/A";
      const device = data?.device ?? "N/A";
      const ip = data?.ip ?? "N/A";
      const location = data?.location ?? "N/A";
      const email = data?.payload?.email ?? data.payload.userInfo.email;
      const amount = data?.payload?.amount?.value ?? "0";
      const currency = "USD";
      const description = data?.description ?? "N/A";

      const message = `
📢 *${action}*

👤 User: ${email}

💰 Amount: ${amount} ${currency}  
📝 Description: ${description}

🌍 Location: ${location}  
💻 Device: ${device}  
🌐 IP Address: ${ip}


`.trim();

      const url = `https://api.telegram.org/bot${telegram}/sendMessage`;

      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "Markdown",
        }),
      });
    } catch (error) {
      console.error("Telegram notification failed:", error);
    }
  },
);
