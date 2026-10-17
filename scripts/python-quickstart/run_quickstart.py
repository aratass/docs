#!/usr/bin/env python3
"""
run_quickstart.py: runs guides/quickstarts/python.mdx offline.

The guide's Python fences are the fixture. The fence that starts with
`# wraith_crypto.py` becomes that module, fences that start with
`# Add to wraith_crypto.py` are appended to it, and every other Python fence runs
in page order in one namespace, the way a reader pastes the steps into one
session. A Python fence may only be skipped if its info string says both
`no-check` and `pseudocode`.

Network calls go to fakes instead of testnet:
  - httpx.post answers getLatestLedger and serves the announcer events from
    vectors.json, two per getEvents page, so the cursor loop runs.
  - stellar_sdk.Server (Horizon) and stellar_sdk.SorobanServer check each
    transaction's network and signatures and record it.

The results are compared with vectors.json, which generate-vectors.ts computes
with the pinned TypeScript SDK, and with an independent libsodium (PyNaCl)
derivation for the random stealth address in Step 6a.

Installed packages must match requirements.txt exactly. With --bootstrap the
script creates a virtualenv under node_modules/.cache with those pins and
re-runs itself there.

Usage
  python3 scripts/python-quickstart/run_quickstart.py [--bootstrap]
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import traceback
from dataclasses import dataclass
from importlib import metadata
from pathlib import Path
from types import SimpleNamespace
from typing import Any

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
GUIDE = REPO / "guides" / "quickstarts" / "python.mdx"
GUIDE_LABEL = "guides/quickstarts/python.mdx"
VECTORS = HERE / "vectors.json"
REQUIREMENTS = HERE / "requirements.txt"
MODULE = "wraith_crypto"
TESTNET_PASSPHRASE = "Test SDF Network ; September 2015"
EVENTS_PER_PAGE = 2


class QuickstartError(Exception):
    """A check failed; the message says where and why."""


# ---------------------------------------------------------------------------
# Pinned dependencies
# ---------------------------------------------------------------------------

def _normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def pin_mismatches() -> list[str]:
    problems = []
    for raw in REQUIREMENTS.read_text().splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        name, _, version = line.partition("==")
        try:
            installed = metadata.version(name)
        except metadata.PackageNotFoundError:
            problems.append(f"{name}=={version} is not installed")
            continue
        if installed != version:
            problems.append(f"{name}=={version} is pinned, {installed} is installed")
    return problems


def ensure_pinned_environment(argv: list[str]) -> None:
    problems = pin_mismatches()
    if not problems:
        return
    if "--bootstrap" not in argv or os.environ.get("WRAITH_QUICKSTART_VENV"):
        raise SystemExit(
            "Python dependencies do not match scripts/python-quickstart/requirements.txt:\n  "
            + "\n  ".join(problems)
            + "\nInstall them with `python3 -m pip install -r scripts/python-quickstart/requirements.txt`"
            " in a virtualenv, or run with --bootstrap."
        )

    digest = hashlib.sha256(REQUIREMENTS.read_bytes()).hexdigest()[:12]
    venv = REPO / "node_modules" / ".cache" / "python-quickstart" / f"venv-{digest}"
    python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.exists():
        print(f"Creating {venv.relative_to(REPO)} with the pinned dependencies...", flush=True)
        subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True)
        subprocess.run(
            [str(python), "-m", "pip", "install", "--quiet", "--disable-pip-version-check",
             "-r", str(REQUIREMENTS)],
            check=True,
        )
    env = {**os.environ, "WRAITH_QUICKSTART_VENV": "1"}
    args = [arg for arg in argv if arg != "--bootstrap"]
    completed = subprocess.run([str(python), str(Path(__file__).resolve()), *args], env=env)
    raise SystemExit(completed.returncode)


# ---------------------------------------------------------------------------
# Extracting the fixture from the guide
# ---------------------------------------------------------------------------

@dataclass
class Fence:
    lang: str
    info: str
    code: str
    line: int  # 1-based MDX line of the first line inside the fence


def parse_fences(markdown: str) -> list[Fence]:
    fences: list[Fence] = []
    open_fence: dict[str, Any] | None = None
    for index, line in enumerate(markdown.split("\n")):
        if open_fence is None:
            match = re.match(r"^```([A-Za-z0-9_-]*)(.*)$", line)
            if match:
                open_fence = {"lang": match[1].lower(), "info": match[2].strip(),
                              "line": index + 2, "body": []}
            continue
        if line.strip() == "```":
            fences.append(Fence(open_fence["lang"], open_fence["info"],
                                "\n".join(open_fence["body"]), open_fence["line"]))
            open_fence = None
            continue
        open_fence["body"].append(line)
    return fences


@dataclass
class Fixture:
    module_source: str
    module_parts: list[Fence]
    steps: list[Fence]
    pseudocode: list[Fence]


def extract_fixture(markdown: str) -> Fixture:
    module_parts: list[Fence] = []
    steps: list[Fence] = []
    pseudocode: list[Fence] = []

    for fence in parse_fences(markdown):
        if fence.lang not in ("python", "py"):
            continue
        if re.search(r"\bno-check\b", fence.info):
            if not re.search(r"\bpseudocode\b", fence.info, re.IGNORECASE):
                raise QuickstartError(
                    f"{GUIDE_LABEL}:{fence.line - 1}: Python fences run as part of the fixture. "
                    "Remove `no-check`, or mark pseudocode as ```python Pseudocode no-check."
                )
            pseudocode.append(fence)
            continue

        first_line = fence.code.lstrip().split("\n", 1)[0].strip()
        if first_line == f"# {MODULE}.py":
            if module_parts:
                raise QuickstartError(f"{GUIDE_LABEL}:{fence.line}: a second `# {MODULE}.py` fence")
            module_parts.append(fence)
        elif first_line == f"# Add to {MODULE}.py":
            if not module_parts:
                raise QuickstartError(f"{GUIDE_LABEL}:{fence.line}: `# Add to {MODULE}.py` "
                                      f"comes before the `# {MODULE}.py` fence")
            module_parts.append(fence)
        else:
            steps.append(fence)

    if not module_parts:
        raise QuickstartError(f"{GUIDE_LABEL}: no fence starts with `# {MODULE}.py`")
    if not steps:
        raise QuickstartError(f"{GUIDE_LABEL}: no runnable steps found")

    module_source = "\n\n".join(part.code for part in module_parts) + "\n"
    return Fixture(module_source, module_parts, steps, pseudocode)


# ---------------------------------------------------------------------------
# Network fakes
# ---------------------------------------------------------------------------

def _require(condition: bool, message: str) -> None:
    if not condition:
        raise QuickstartError(message)


class FakeRpc:
    """Stands in for httpx.post against the Soroban RPC."""

    def __init__(self, vectors: dict) -> None:
        self.latest = vectors["rpc"]["latestLedger"]
        self.contract_id = vectors["rpc"]["announcerContractId"]
        self.events = vectors["rpc"]["events"]
        self.calls: list[str] = []

    def post(self, url: str, json: dict | None = None, timeout: float | None = None, **_: Any):
        _require(isinstance(json, dict) and json.get("jsonrpc") == "2.0",
                 f"RPC call to {url} is not JSON-RPC 2.0")
        method, params = json.get("method"), json.get("params") or {}
        self.calls.append(method)
        if method == "getLatestLedger":
            result = {"id": "fixture", "protocolVersion": 23, "sequence": self.latest}
        elif method == "getEvents":
            result = self._get_events(params)
        else:
            raise QuickstartError(f"Unexpected RPC method {method!r}")
        return SimpleNamespace(
            status_code=200,
            raise_for_status=lambda: None,
            json=lambda: {"jsonrpc": "2.0", "id": json.get("id"), "result": result},
        )

    def _get_events(self, params: dict) -> dict:
        filters = params.get("filters") or []
        _require(
            len(filters) == 1 and filters[0].get("contractIds") == [self.contract_id],
            f"getEvents must filter on the announcer {self.contract_id}, got {filters}",
        )
        pagination = params.get("pagination") or {}
        cursor = pagination.get("cursor")
        if cursor is None:
            start = params.get("startLedger")
            _require(isinstance(start, int) and 1 <= start <= self.latest,
                     f"getEvents startLedger must be within 1..{self.latest}, got {start!r}")
            offset = 0
        else:
            _require("startLedger" not in params,
                     "getEvents takes either startLedger or a cursor, not both")
            offset = int(cursor)
        page = self.events[offset:offset + EVENTS_PER_PAGE]
        return {
            "events": page,
            "cursor": str(offset + len(page)),
            "latestLedger": self.latest,
            "oldestLedger": self.latest - 17_280,
        }


def _verify_signed(envelope: Any, signer: str, label: str) -> None:
    from stellar_sdk import Keypair

    _require(envelope.network_passphrase == TESTNET_PASSPHRASE,
             f"{label}: built for {envelope.network_passphrase!r}, not testnet")
    keypair = Keypair.from_public_key(signer)
    tx_hash = envelope.hash()
    for decorated in envelope.signatures:
        if decorated.signature_hint != keypair.signature_hint():
            continue
        try:
            keypair.verify(tx_hash, decorated.signature)
            return
        except Exception:
            continue
    raise QuickstartError(f"{label}: no valid signature from {signer}")


class FakeHorizon:
    """Stands in for stellar_sdk.Server against Horizon."""

    instances: list["FakeHorizon"] = []

    def __init__(self, horizon_url: str = "", *_: Any, **__: Any) -> None:
        self.url = horizon_url
        self.sequences: dict[str, int] = {}
        self.submitted: list[Any] = []
        FakeHorizon.instances.append(self)

    def load_account(self, account_id: Any):
        from stellar_sdk import Account

        address = getattr(account_id, "public_key", None) or getattr(account_id, "account_id", None) or account_id
        return Account(address, self.sequences.setdefault(address, 4_200_000_000))

    def submit_transaction(self, envelope: Any, *_: Any, **__: Any) -> dict:
        source = envelope.transaction.source.account_id
        _verify_signed(envelope, source, "Horizon transaction")
        _require(envelope.transaction.sequence == self.sequences.get(source, 4_200_000_000) + 1,
                 f"Horizon transaction from {source} reuses a stale sequence number")
        self.sequences[source] = envelope.transaction.sequence
        self.submitted.append(envelope)
        return {"hash": envelope.hash_hex(), "successful": True}


class FakeSoroban:
    """Stands in for stellar_sdk.SorobanServer."""

    instances: list["FakeSoroban"] = []

    def __init__(self, server_url: str = "", *_: Any, **__: Any) -> None:
        self.url = server_url
        self.prepared: list[Any] = []
        self.sent: list[Any] = []
        FakeSoroban.instances.append(self)

    def prepare_transaction(self, envelope: Any, *_: Any, **__: Any):
        _require(not envelope.signatures, "prepare_transaction must run before signing")
        self.prepared.append(envelope)
        return envelope

    def send_transaction(self, envelope: Any):
        from stellar_sdk.soroban_rpc import SendTransactionStatus

        _require(any(envelope is prepared for prepared in self.prepared),
                 "send_transaction got a transaction that never went through prepare_transaction")
        _verify_signed(envelope, envelope.transaction.source.account_id, "Soroban transaction")
        self.sent.append(envelope)
        return SimpleNamespace(status=SendTransactionStatus.PENDING, hash=envelope.hash_hex())

    def poll_transaction(self, transaction_hash: str, *_: Any, **__: Any):
        from stellar_sdk.soroban_rpc import GetTransactionStatus

        _require(any(env.hash_hex() == transaction_hash for env in self.sent),
                 f"poll_transaction for unknown hash {transaction_hash}")
        return SimpleNamespace(status=GetTransactionStatus.SUCCESS, transaction_hash=transaction_hash)


# ---------------------------------------------------------------------------
# Independent reference (libsodium via PyNaCl)
# ---------------------------------------------------------------------------

L = 2**252 + 27742317777372353535851937790883648493


def reference_stealth_address(ephemeral_pub: bytes, viewing_seed: bytes, spending_pub: bytes) -> str:
    from nacl import bindings
    from stellar_sdk import Keypair

    viewing_pub = Keypair.from_raw_ed25519_seed(viewing_seed).raw_public_key()
    x_priv = bindings.crypto_sign_ed25519_sk_to_curve25519(viewing_seed + viewing_pub)
    x_pub = bindings.crypto_sign_ed25519_pk_to_curve25519(ephemeral_pub)
    shared = bindings.crypto_scalarmult(x_priv, x_pub)
    h = int.from_bytes(hashlib.sha256(b"wraith:scalar:" + shared).digest(), "little") % L
    h_point = bindings.crypto_scalarmult_ed25519_base_noclamp(h.to_bytes(32, "little"))
    return Keypair.from_raw_ed25519_public_key(
        bindings.crypto_core_ed25519_add(spending_pub, h_point)
    ).public_key


def reference_view_tag(ephemeral_pub: bytes, viewing_pub: bytes) -> int:
    return hashlib.sha256(b"wraith:stellar:view-tag:v2:" + ephemeral_pub + viewing_pub).digest()[0]


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

def check_module(module: Any, vectors: dict) -> int:
    """Compares the guide's wraith_crypto.py with the TypeScript SDK vectors."""
    from stellar_sdk import Keypair

    owner = vectors["owner"]
    checks = 0

    def same(actual: Any, expected: Any, what: str) -> None:
        nonlocal checks
        _require(actual == expected, f"{MODULE}.{what}: got {actual!r}, the SDK gives {expected!r}")
        checks += 1

    same(module.STEALTH_SIGNING_MESSAGE, vectors["stealthSigningMessage"], "STEALTH_SIGNING_MESSAGE")

    signature = Keypair.from_secret(owner["secret"]).sign(module.STEALTH_SIGNING_MESSAGE.encode())
    same(signature.hex(), owner["signature"], "STEALTH_SIGNING_MESSAGE signature")
    keys = module.derive_stealth_keys(signature)
    same(keys.spending_key.hex(), owner["spendingKey"], "derive_stealth_keys spending_key")
    same(keys.viewing_key.hex(), owner["viewingKey"], "derive_stealth_keys viewing_key")
    same(str(keys.spending_scalar), owner["spendingScalar"], "derive_stealth_keys spending_scalar")
    same(str(keys.viewing_scalar), owner["viewingScalar"], "derive_stealth_keys viewing_scalar")
    same(keys.spending_pub_key.hex(), owner["spendingPubKey"], "derive_stealth_keys spending_pub_key")
    same(keys.viewing_pub_key.hex(), owner["viewingPubKey"], "derive_stealth_keys viewing_pub_key")
    same(module.encode_meta_address(keys.spending_pub_key, keys.viewing_pub_key),
         owner["metaAddress"], "encode_meta_address")
    same(module.decode_meta_address(owner["metaAddress"]),
         (keys.spending_pub_key, keys.viewing_pub_key), "decode_meta_address")

    for expected in vectors["stealthAddresses"]:
        generated = module.generate_stealth_address(
            keys.spending_pub_key, keys.viewing_pub_key, bytes.fromhex(expected["ephemeralSeed"])
        )
        same(generated.stealth_address, expected["stealthAddress"], "generate_stealth_address address")
        same(generated.ephemeral_pub_key.hex(), expected["ephemeralPubKey"],
             "generate_stealth_address ephemeral_pub_key")
        same(generated.view_tag, expected["viewTag"], "generate_stealth_address view_tag")

    found = module.scan_announcements(
        [dict(item) for item in vectors["announcements"]],
        keys.viewing_key, keys.spending_pub_key, keys.spending_scalar,
    )
    same([(m.stealth_address, str(m.stealth_private_scalar), m.stealth_pub_key_bytes.hex())
          for m in found],
         [(m["stealthAddress"], m["stealthPrivateScalar"], m["stealthPubKey"])
          for m in vectors["matches"]],
         "scan_announcements matches")

    signed = vectors["scalarSignature"]
    signature = module.sign_with_scalar(
        bytes.fromhex(signed["message"]), int(signed["scalar"]), bytes.fromhex(signed["publicKey"])
    )
    same(signature.hex(), signed["signature"], "sign_with_scalar")
    Keypair.from_raw_ed25519_public_key(bytes.fromhex(signed["publicKey"])).verify(
        bytes.fromhex(signed["message"]), signature
    )
    return checks


def check_flow(ns: dict, vectors: dict, rpc: FakeRpc) -> list[str]:
    """Checks what the steps did, using the names the guide defines."""
    from stellar_sdk import Address, scval
    from stellar_sdk.operation import AccountMerge, CreateAccount, InvokeHostFunction

    owner = vectors["owner"]
    results = []

    def need(name: str) -> Any:
        _require(name in ns, f"the guide's steps never define `{name}`")
        return ns[name]

    keys = need("keys")
    _require(keys.spending_pub_key.hex() == owner["spendingPubKey"]
             and keys.viewing_pub_key.hex() == owner["viewingPubKey"],
             "Step 3 derived different keys than the SDK")
    _require(need("meta_address") == owner["metaAddress"], "Step 3 meta_address differs from the SDK")
    results.append("Step 3 keys and meta-address match the SDK")

    _require(need("ANNOUNCER_CONTRACT_ID") == vectors["rpc"]["announcerContractId"],
             "ANNOUNCER_CONTRACT_ID differs from the announcer in vectors.json")
    pages = rpc.calls.count("getEvents")
    _require(pages >= 2, "fetch_announcements stopped before the second getEvents page")
    _require(need("announcements") == vectors["announcements"],
             "Step 4 parsed announcements differ from the events in vectors.json")
    results.append(f"Step 4 parsed {len(vectors['announcements'])} v2 events over {pages} getEvents pages")

    matches = need("matches")
    _require([m.stealth_address for m in matches] == [m["stealthAddress"] for m in vectors["matches"]],
             "Step 5 found different payments than the SDK scanner")
    results.append(f"Step 5 found the {len(matches)} payments the SDK finds, and skipped the decoy")

    stealth = need("stealth")
    spending_pub, viewing_pub = bytes.fromhex(owner["spendingPubKey"]), bytes.fromhex(owner["viewingPubKey"])
    expected_address = reference_stealth_address(
        stealth.ephemeral_pub_key, bytes.fromhex(owner["viewingKey"]), spending_pub
    )
    _require(stealth.stealth_address == expected_address,
             "Step 6a stealth address differs from the libsodium reference derivation")
    _require(stealth.view_tag == reference_view_tag(stealth.ephemeral_pub_key, viewing_pub),
             "Step 6a view tag differs from the v2 derivation")
    results.append("Step 6a stealth address and view tag match an independent libsodium derivation")

    horizon_txs = [env for server in FakeHorizon.instances for env in server.submitted]
    soroban_txs = [env for server in FakeSoroban.instances for env in server.sent]
    sender = need("sender_keypair").public_key
    _require(len(horizon_txs) == 2 and len(soroban_txs) == 1,
             f"expected 2 Horizon and 1 Soroban transactions, got {len(horizon_txs)} and {len(soroban_txs)}")

    activate = horizon_txs[0].transaction
    op = activate.operations[0]
    _require(activate.source.account_id == sender and isinstance(op, CreateAccount)
             and op.destination == stealth.stealth_address,
             "Step 6b createAccount does not fund the Step 6a stealth address from the sender")

    announce = soroban_txs[0].transaction
    op = announce.operations[0]
    _require(isinstance(op, InvokeHostFunction), "Step 6b announcement is not a contract call")
    call = op.host_function.invoke_contract
    _require(Address.from_xdr_sc_address(call.contract_address).address == vectors["rpc"]["announcerContractId"]
             and call.function_name.sc_symbol == b"announce",
             "Step 6b does not call announce on the announcer contract")
    args = [scval.to_native(arg) for arg in call.args]
    _require(len(args) == 4 and args[0] == 2 and args[1].address == stealth.stealth_address
             and args[2] == stealth.ephemeral_pub_key and args[3][:1] == bytes([stealth.view_tag]),
             f"Step 6b announce arguments are wrong: {args!r}")
    results.append("Step 6b createAccount and announce(2, stealth, R, [view tag]) are signed for testnet")

    withdrawal = horizon_txs[1].transaction
    op = withdrawal.operations[0]
    _require(withdrawal.source.account_id == matches[0].stealth_address and isinstance(op, AccountMerge)
             and op.destination.account_id == sender,
             "Step 7 does not merge the matched stealth account into the sender")
    results.append("Step 7 merge is signed by sign_with_scalar and verifies against the stealth key")
    return results


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run(fixture: Fixture, vectors: dict) -> None:
    import httpx
    import stellar_sdk

    workdir = Path(tempfile.mkdtemp(prefix="wraith-python-quickstart-"))
    (workdir / f"{MODULE}.py").write_text(fixture.module_source)
    sys.path.insert(0, str(workdir))
    sys.modules.pop(MODULE, None)

    try:
        module = __import__(MODULE)
    except Exception as error:  # noqa: BLE001
        raise QuickstartError(f"{MODULE}.py from {GUIDE_LABEL} does not import:\n"
                              + "".join(traceback.format_exception(error))) from error
    module_checks = check_module(module, vectors)

    rpc = FakeRpc(vectors)
    httpx.post = rpc.post
    stellar_sdk.Server = FakeHorizon
    stellar_sdk.SorobanServer = FakeSoroban
    os.environ["STELLAR_SECRET"] = vectors["owner"]["secret"]

    ns: dict[str, Any] = {"__name__": "__quickstart__"}
    print(f"Running {len(fixture.steps)} steps from {GUIDE_LABEL} offline")
    for step in fixture.steps:
        # Pad with blank lines so tracebacks point at the real MDX line numbers
        code = compile("\n" * (step.line - 1) + step.code, GUIDE_LABEL, "exec")
        output = io.StringIO()
        try:
            with contextlib.redirect_stdout(output):
                exec(code, ns)  # noqa: S102 - the guide is the code under test
        except QuickstartError as error:
            raise QuickstartError(f"{GUIDE_LABEL}:{step.line}: {error}") from error
        except BaseException as error:  # noqa: BLE001
            raise QuickstartError(
                f"The step at {GUIDE_LABEL}:{step.line} failed:\n"
                + "".join(traceback.format_exception(error))
            ) from error
        printed = output.getvalue().strip()
        print(f"  ok  {GUIDE_LABEL}:{step.line}")
        for line in printed.splitlines():
            print(f"        {line}")

    results = check_flow(ns, vectors, rpc)
    print(f"\n{MODULE}.py matches the TypeScript SDK on {module_checks} checks")
    for result in results:
        print(f"  {result}")
    if fixture.pseudocode:
        lines = ", ".join(str(fence.line) for fence in fixture.pseudocode)
        print(f"Skipped pseudocode fences at lines {lines}")
    print("\nPython quickstart ran offline.")


def main(argv: list[str]) -> int:
    if sys.version_info < (3, 11):
        print("The Python quickstart targets Python 3.11+.", file=sys.stderr)
        return 1
    ensure_pinned_environment(argv)
    try:
        fixture = extract_fixture(GUIDE.read_text())
        vectors = json.loads(VECTORS.read_text())
        run(fixture, vectors)
    except QuickstartError as error:
        print(f"Python quickstart check failed:\n\n{error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
