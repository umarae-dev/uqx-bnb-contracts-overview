## Summary

Describe the contract, test, documentation or tooling change.

## Required checks

- [ ] `npm run check:public`
- [ ] `npm run compile`
- [ ] `npm test`
- [ ] No real `.env`, private key, seed phrase, keystore, RPC credential, API key, service-account file, database dump or user allocation data is included.
- [ ] Any production-derived file added here is safe for permanent public disclosure.
- [ ] Mainnet addresses/transaction hashes are included only when intentionally public and independently verifiable.
- [ ] No unrelated private production runbook or infrastructure configuration is exposed.

## Contract safety

If Solidity behavior changes, explain the invariant affected and add/update tests. Do not treat internal tests as a substitute for an independent security audit.
