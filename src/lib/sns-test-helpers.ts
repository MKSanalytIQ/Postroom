import { createSign, generateKeyPairSync, type KeyObject } from "crypto";
import { snsStringToSign, type SnsVerifyOptions } from "./sns";

// Test support: signs SNS-shaped messages with a throwaway RSA key and serves its public key through the
// injectable certificate fetcher, so signature checks run for real without AWS or the network.

export const TEST_CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem";

export type SnsKit = {
  options: SnsVerifyOptions;
  fetches: string[];
  privateKey: KeyObject;
  /** Adds SignatureVersion, SigningCertURL, and a real Signature to a message. */
  sign(message: Record<string, string>, version?: "1" | "2", certUrl?: string): Record<string, string>;
  notification(message: string, subject?: string): Record<string, string>;
  subscription(subscribeUrl: string): Record<string, string>;
};

export function makeSnsKit(): SnsKit {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const fetches: string[] = [];
  const base = (type: string) => ({
    Type: type,
    MessageId: "22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324",
    TopicArn: "arn:aws:sns:us-east-1:123456789012:postroom-bounces",
    Timestamp: "2026-10-03T08:00:00.000Z",
  });
  const kit: SnsKit = {
    fetches,
    privateKey,
    options: {
      fetchCert: async (url) => {
        fetches.push(url);
        return pem;
      },
    },
    sign(message, version = "2", certUrl = TEST_CERT_URL) {
      const unsigned = { ...message, SignatureVersion: version, SigningCertURL: certUrl };
      const text = snsStringToSign(unsigned);
      if (text === null) throw new Error("Message is missing signed fields.");
      const signer = createSign(version === "1" ? "RSA-SHA1" : "RSA-SHA256");
      signer.update(text, "utf8");
      return { ...unsigned, Signature: signer.sign(privateKey, "base64") };
    },
    notification(message, subject) {
      return kit.sign({ ...base("Notification"), Message: message, ...(subject ? { Subject: subject } : {}) });
    },
    subscription(subscribeUrl) {
      return kit.sign({ ...base("SubscriptionConfirmation"), Message: "You have chosen to subscribe.", SubscribeURL: subscribeUrl, Token: "2336412f37fb687f5d51e6e2" });
    },
  };
  return kit;
}
