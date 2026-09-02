# SafeCore V4.2 Relayer — Production Runbook

The relayer is an **untrusted gas sponsor**, not a wallet custodian. It receives already-signed SafeCore calldata, simulates the exact call, verifies the target is the configured factory or a factory-registered SafeCore account, then pays BNB gas. It must never receive a wallet mnemonic/private key. Emergency rescue calldata necessarily contains the one-time paper secret, so request bodies must never be logged.

## Security boundary

- The SafeCore account/factory contracts enforce authorization; the relayer has no account authority.
- `SAFECORE_RELAYER_PRIVATE_KEY` is only the gas-paying key. Keep only the BNB needed for bounded operations in it.
- The server accepts only the allow-listed SafeCore selectors.
- Account targets must resolve through `factory.accountOf(identity)`.
- Every relay is simulated with `eth_call` before gas is spent.
- Gas estimates above `SAFECORE_RELAYER_MAX_GAS` are rejected.
- Relay transaction nonces are serialized to prevent concurrent nonce collisions.
- Request size, request/header/keep-alive timeouts, per-IP rate limiting and pending-queue limits are enforced.
- `SAFECORE_TRUST_PROXY=false` is the safe default. Enable it only behind a reverse proxy that strips client-supplied forwarding headers and writes its own.

## Required private runtime values

Copy `relayer/.env.example` to a private environment/secret manager. Never commit the real file.

Required:

- `SAFECORE_CHAIN_ID=56` for BNB Smart Chain mainnet (use 97 only for an isolated testnet deployment)
- `SAFECORE_RPC_URL=<trusted HTTPS BSC RPC>`
- `SAFECORE_FACTORY_ADDRESS=<deployed factory>`
- `SAFECORE_RELAYER_PRIVATE_KEY=<dedicated gas wallet key>`

The process fails closed at startup if the factory address or relayer private key is malformed, and `/health` reports readiness only when the configured factory has bytecode on the configured chain.

## Container build

From the repository root:

```bash
docker build -f relayer/Dockerfile -t uqx-safecore-relayer:4.2 .
```

Run with a private env file outside the repository:

```bash
docker run -d \
  --name uqx-safecore-relayer \
  --restart unless-stopped \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --env-file /secure/path/safecore-relayer.env \
  -p 127.0.0.1:8787:8787 \
  uqx-safecore-relayer:4.2
```

Bind only to localhost at the host boundary and expose the service publicly through a hardened HTTPS reverse proxy/load balancer.

## HTTPS reverse proxy requirements

Production Android builds require an `https://` relayer base URL. At the public edge:

- TLS 1.2+ only; use a valid publicly trusted certificate.
- Redirect/reject plain HTTP; do not forward it to the relayer.
- Do **not** log `/relay` request bodies or query data.
- Apply a second independent rate limit at the edge.
- Restrict request body size to <=64 KiB.
- Strip inbound `X-Forwarded-For`, `Forwarded` and similar headers before setting trusted proxy headers.
- Add normal DDoS/WAF protections, but never rewrite request JSON/calldata.
- Keep `/health` available for readiness monitoring; it contains public addresses only.

## Relayer gas wallet

Use a dedicated key that has **no SafeCore authority** and no other production role. Keep a small operational BNB balance, monitor it, and replenish from a separate treasury process. A relayer key compromise can waste its gas balance but must not authorize SafeCore account actions.

Never use:

- a user wallet key
- a treasury key
- a presale/vesting owner key
- a SafeCore Device Key
- a Recovery Card secret

## Monitoring

Alert on:

- `/health` not `ready`
- chain/factory mismatch
- rapid `rate_limited` or `relayer_overloaded` growth
- gas-wallet balance below the operational threshold
- repeated simulation failures
- unexpected process restarts
- RPC latency/error spikes

Do not include raw calldata in logs/metrics/traces. Log only coarse error codes, transaction hashes, public target address, timing and aggregate counters where needed.

## Key rotation

Because the relayer has no on-chain authority, the gas wallet can be rotated operationally:

1. Provision a new dedicated gas wallet and fund it with a small amount of BNB.
2. Replace the private runtime secret.
3. Restart one instance and verify `/health` reports the new public relayer address and the same factory/chain/protocol.
4. Roll the remaining instances.
5. Sweep any remaining BNB from the old gas wallet after traffic has moved.

No Android update or SafeCore contract migration is required for a relayer gas-key rotation.

## Mainnet release gate

Do not deploy SafeCore mainnet simply because CI is green. Before significant real funds are protected by it, complete:

- independent smart-contract security review/audit
- Android wallet security review/pentest
- BSC testnet two-device authorization/revocation/recovery acceptance
- testnet relayer failure/rate-limit/queue tests
- tiny-funds mainnet smoke test after audited deployment

The repository deployment script intentionally blocks BSC mainnet unless the operator explicitly acknowledges that an external audit has been completed.
