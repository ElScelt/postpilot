import { Receiver } from "@upstash/qstash";
import { required } from "../env";
import { constantTimeEqual } from "./compare";
import { errorMessage } from "../errors";

export type SignatureVerifier = (request: Request, body: string) => Promise<boolean>;

export function isQStashSigned(request: Request) {
  return request.headers.has("upstash-signature");
}

// QStash signs every delivery it makes: the morning publish and the scheduled run.
export async function authorizeQStashRequest(
  request: Request,
  body: string,
  verifySignature: SignatureVerifier = verifyQStashSignature,
) {
  if (!isQStashSigned(request)) return false;
  try {
    return await verifySignature(request, body);
  } catch (error) {
    // The subject check fails when APP_URL is not the exact host QStash dialled; without
    // this line every delivery is a silent 401.
    console.error("QStash signature rejected:", errorMessage(error));
    return false;
  }
}

// QStash-signed firings are the normal path; a bearer secret lets a person trigger a
// run by hand. A request that carries a signature is judged by the signature alone.
export async function authorizeRunRequest(
  request: Request,
  body: string,
  verifySignature?: SignatureVerifier,
) {
  if (isQStashSigned(request)) return authorizeQStashRequest(request, body, verifySignature);
  const secret = process.env.AUTOMATION_SECRET;
  return Boolean(secret) && constantTimeEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`);
}

async function verifyQStashSignature(request: Request, body: string) {
  const receiver = new Receiver({
    currentSigningKey: required("QSTASH_CURRENT_SIGNING_KEY"),
    nextSigningKey: required("QSTASH_NEXT_SIGNING_KEY"),
  });
  return receiver.verify({
    signature: request.headers.get("upstash-signature") ?? "",
    body,
    url: request.url,
  });
}
