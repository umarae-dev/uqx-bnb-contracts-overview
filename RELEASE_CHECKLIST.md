# Release / Reviewer Verification Checklist

Use this before a public release or external technical review.

## Reproducibility

- [ ] Node.js 20+
- [ ] `npm install`
- [ ] `npm run check:public`
- [ ] `npm audit --omit=dev --audit-level=high`
- [ ] `npm run compile`
- [ ] `npm test`
- [ ] Fresh clone succeeds without any production credential

## Source integrity

- [ ] `contracts/UqxToken.sol` matches the production-safe UQX token source
- [ ] `contracts/UqxVesting.sol` matches the production-safe UQX vesting source
- [ ] `contracts/UqxPresale.sol` matches the production-safe UQX presale source
- [ ] Production-derived UQX tests/helpers remain present under `test/uqx/`
- [ ] Deployment/Merkle/inspection utilities contain no secret values

## Public-source safety

- [ ] No real `.env`
- [ ] No private key, seed phrase or keystore
- [ ] No private RPC/API/database credential
- [ ] No service-account credential
- [ ] No user database dump, backup or unpublished allocation dataset
- [ ] No private incident/governance runbook containing operational secrets
- [ ] `.env.example` contains placeholders only

## Dependency boundary

- [ ] Runtime dependency audit passes at high severity
- [ ] Hardhat-2 development-tool advisories are reviewed and remain accurately documented in `SECURITY.md`
- [ ] No unused toolbox/coverage/gas-reporting/Ignition/TypeChain packages are reintroduced without need

## BNB Chain evidence

- [ ] `DEPLOYMENTS.md` addresses are current for the reviewed release
- [ ] Public contract addresses/transactions can be independently verified on-chain
- [ ] Any claim about funded pools/root/governance state matches current chain state or is clearly timestamped

## Documentation

- [ ] README quick start works
- [ ] `PUBLIC_PRIVATE_BOUNDARY.md` matches what is actually published
- [ ] `PROVENANCE.md` distinguishes private development history from public extraction history
- [ ] `SECURITY.md` avoids unsupported audit/security claims
- [ ] CI status for the exact reviewed commit is green before showing a passing badge
