/**
 * generate-vectors.ts
 *
 * Writes scripts/python-quickstart/vectors.json: the expected values the Python
 * quickstart (guides/quickstarts/python.mdx) must reproduce, computed with the
 * pinned @wraith-protocol/sdk Stellar primitives.
 *
 *   tsx scripts/python-quickstart/generate-vectors.ts           # write vectors.json
 *   tsx scripts/python-quickstart/generate-vectors.ts --check   # fail if it is stale
 *
 * The announcement events use the stealth-announcer v2 layout
 * (wraith-protocol/contracts stellar/stealth-announcer): topics
 * ("announce", scheme_id, view_tag_bucket, metadata_kind) and value
 * (stealth_address, ephemeral_pub_key, metadata). View tags use the v2
 * derivation SHA-256("wraith:stellar:view-tag:v2:" || R || V)[0]
 * (architecture/view-tag-scanner.mdx).
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Address, Keypair, xdr } from "@stellar/stellar-sdk";
import {
  STEALTH_SIGNING_MESSAGE,
  bytesToHex,
  deriveStealthKeys,
  deriveStealthPrivateScalar,
  encodeStealthMetaAddress,
  generateStealthAddress,
  hexToBytes,
  signWithScalar,
} from "@wraith-protocol/sdk/chains/stellar";

const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(here, "vectors.json");

const ANNOUNCER_CONTRACT_ID = "CCJLJ2QRBJAAKIG6ELNQVXLLWMKKWVN5O2FKWUETHZGMPAD4MHK7WVWL";
const SCHEME_ID = 2;
const METADATA_KIND_VIEW_TAG = 1;
const LATEST_LEDGER = 1_990_000;

const sha256 = (...parts: Array<string | Uint8Array>) => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
};

const seed = (label: string) => sha256(`wraith:docs:python-quickstart:${label}`);

/** The v2 view tag the stealth-announcer v2 contract indexes by. */
function viewTagV2(ephemeralPubKey: Uint8Array, viewingPubKey: Uint8Array) {
  return sha256("wraith:stellar:view-tag:v2:", ephemeralPubKey, viewingPubKey)[0];
}

/** A Stellar account and the stealth keys derived from its signature. */
function identity(label: string) {
  const keypair = Keypair.fromRawEd25519Seed(Buffer.from(seed(label)));
  const signature = new Uint8Array(keypair.sign(Buffer.from(STEALTH_SIGNING_MESSAGE)));
  const keys = deriveStealthKeys(signature);
  return { keypair, signature, keys };
}

/** Pays `recipient` through a fresh stealth address, as the SDK builders do. */
function pay(recipient: ReturnType<typeof identity>, ephemeralLabel: string) {
  const ephemeralSeed = seed(ephemeralLabel);
  const generated = generateStealthAddress(
    recipient.keys.spendingPubKey,
    recipient.keys.viewingPubKey,
    ephemeralSeed,
  );
  const viewTag = viewTagV2(generated.ephemeralPubKey, recipient.keys.viewingPubKey);
  return { ephemeralSeed, ...generated, viewTag };
}

function announcementEvent(
  index: number,
  stealthAddress: string,
  ephemeralPubKey: Uint8Array,
  metadata: Uint8Array,
) {
  const ledger = LATEST_LEDGER - 100 + index;
  const topic = [
    xdr.ScVal.scvSymbol("announce"),
    xdr.ScVal.scvU32(SCHEME_ID),
    xdr.ScVal.scvU32(metadata[0]),
    xdr.ScVal.scvU32(METADATA_KIND_VIEW_TAG),
  ];
  const value = xdr.ScVal.scvVec([
    new Address(stealthAddress).toScVal(),
    xdr.ScVal.scvBytes(Buffer.from(ephemeralPubKey)),
    xdr.ScVal.scvBytes(Buffer.from(metadata)),
  ]);

  return {
    type: "contract",
    ledger,
    ledgerClosedAt: new Date(Date.UTC(2026, 9, 1, 12, 0, index * 5)).toISOString(),
    contractId: ANNOUNCER_CONTRACT_ID,
    id: `${(BigInt(ledger) << 32n).toString().padStart(19, "0")}-${String(index).padStart(10, "0")}`,
    txHash: bytesToHex(sha256(`tx:${index}`)),
    inSuccessfulContractCall: true,
    topic: topic.map((entry) => entry.toXDR("base64")),
    value: value.toXDR("base64"),
  };
}

function buildVectors() {
  const owner = identity("owner");
  const other = identity("other-recipient");

  // Announcements 0 and 2 pay the owner. 1 and 4 pay someone else. 3 is a decoy:
  // it carries the owner's view tag for its ephemeral key but another stealth
  // address, so it passes the view-tag prefilter and must fail the address check.
  const toOwner = [pay(owner, "ephemeral:0"), pay(owner, "ephemeral:2")];
  const toOther = [pay(other, "ephemeral:1"), pay(other, "ephemeral:4")];
  const decoy = pay(other, "ephemeral:3");
  const decoyTag = viewTagV2(decoy.ephemeralPubKey, owner.keys.viewingPubKey);

  const announcements = [
    { payment: toOwner[0], viewTag: toOwner[0].viewTag },
    { payment: toOther[0], viewTag: toOther[0].viewTag },
    { payment: toOwner[1], viewTag: toOwner[1].viewTag },
    { payment: decoy, viewTag: decoyTag },
    { payment: toOther[1], viewTag: toOther[1].viewTag },
  ];

  const events = announcements.map(({ payment, viewTag }, index) =>
    announcementEvent(
      index,
      payment.stealthAddress,
      payment.ephemeralPubKey,
      Uint8Array.of(viewTag),
    ),
  );

  const matches = [0, 2].map((index) => {
    const payment = announcements[index].payment;
    const scalar = deriveStealthPrivateScalar(
      owner.keys.spendingScalar,
      owner.keys.viewingKey,
      payment.ephemeralPubKey,
    );
    const stealthPubKey = Keypair.fromPublicKey(payment.stealthAddress).rawPublicKey();
    return {
      index,
      stealthAddress: payment.stealthAddress,
      stealthPrivateScalar: scalar.toString(),
      stealthPubKey: bytesToHex(new Uint8Array(stealthPubKey)),
    };
  });

  const message = sha256("message");
  const signature = signWithScalar(
    message,
    BigInt(matches[0].stealthPrivateScalar),
    hexToBytes(matches[0].stealthPubKey),
  );

  return {
    $comment:
      "Generated by scripts/python-quickstart/generate-vectors.ts from the pinned " +
      "@wraith-protocol/sdk Stellar primitives. Do not edit by hand; run `pnpm run " +
      "generate:python-quickstart-vectors`.",
    stealthSigningMessage: STEALTH_SIGNING_MESSAGE,
    owner: {
      secret: owner.keypair.secret(),
      publicKey: owner.keypair.publicKey(),
      signature: bytesToHex(owner.signature),
      spendingKey: bytesToHex(owner.keys.spendingKey),
      viewingKey: bytesToHex(owner.keys.viewingKey),
      spendingScalar: owner.keys.spendingScalar.toString(),
      viewingScalar: owner.keys.viewingScalar.toString(),
      spendingPubKey: bytesToHex(owner.keys.spendingPubKey),
      viewingPubKey: bytesToHex(owner.keys.viewingPubKey),
      metaAddress: encodeStealthMetaAddress(owner.keys.spendingPubKey, owner.keys.viewingPubKey),
    },
    stealthAddresses: toOwner.map((payment) => ({
      ephemeralSeed: bytesToHex(payment.ephemeralSeed),
      ephemeralPubKey: bytesToHex(payment.ephemeralPubKey),
      stealthAddress: payment.stealthAddress,
      viewTag: payment.viewTag,
    })),
    rpc: {
      announcerContractId: ANNOUNCER_CONTRACT_ID,
      latestLedger: LATEST_LEDGER,
      events,
    },
    announcements: announcements.map(({ payment, viewTag }) => ({
      scheme_id: SCHEME_ID,
      stealth_address: payment.stealthAddress,
      ephemeral_pub_key: bytesToHex(payment.ephemeralPubKey),
      metadata: bytesToHex(Uint8Array.of(viewTag)),
    })),
    matches,
    scalarSignature: {
      message: bytesToHex(message),
      scalar: matches[0].stealthPrivateScalar,
      publicKey: matches[0].stealthPubKey,
      signature: bytesToHex(signature),
    },
  };
}

async function main() {
  const content = `${JSON.stringify(buildVectors(), null, 2)}\n`;

  if (process.argv.includes("--check")) {
    const current = await readFile(outFile, "utf8").catch(() => null);
    if (current !== content) {
      console.error(
        "scripts/python-quickstart/vectors.json is out of date. " +
          "Run `pnpm run generate:python-quickstart-vectors` and commit the result.",
      );
      process.exit(1);
    }
    console.log("Python quickstart vectors are in sync with the pinned SDK.");
    return;
  }

  await writeFile(outFile, content, "utf8");
  console.log(`Wrote ${path.relative(process.cwd(), outFile)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
